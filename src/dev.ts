/**
 * dev 启动器（issue 21 §1/§5，npm run dev）：隔离开发实例 + 源码监听自动重载。
 *
 * - 开发档案固定在仓库外：~/.ruukoto-dev/<仓库名>-<realpath hash8>/，含
 *   data/ agent/ control/ pending/ logs/；不落在受保护根 CODE_ROOT 内
 *   （dirname(dataDir)/qq-work 也因此留在档案里）；
 * - 子进程环境清洗：绝不继承生产拥有者令牌与受保护执行账户配置
 *   （RUUKOTO_OWNER_TOKEN*、RUUKOTO_EXECUTION_BACKEND、RUUKOTO_EXEC_*、
 *   RUUKOTO_CONTAINER_*、RUUKOTO_WORKER_IMAGE），固定注入 RUUKOTO_DISABLE_QQ=1 与 RUUKOTO_DISABLE_TELEGRAM=1
 *   （复用档案数据库也不会连接真实 QQ / Telegram 通道）；
 * - 模型门禁：probeModelConfig 不可用 → 普通启动直接报错并提示 --config；
 *   --config 先开离线配置中心，退出后复探，通过才启动后台并开在线配置中心；
 * - 已在运行检查：控制面 socket 可连且认证通过即报错退出，绝不接管、重启或
 *   停止外来进程；
 * - 监听矩阵（仅 src/ 下的 .ts，~300ms 防抖合并突发）：
 *     src/tui/**（除 config-tui）                → 重启任务界面前端（若在跑）
 *     src/config-tui/**                          → 重启配置前端（若在跑）
 *     src/cli.ts、src/runtime|agent|qq|telegram/** → 只重启后台（前端自动重连）
 *     src/control|core/** 与 src 下其他          → 后台 + 前端都重启
 *     src/dev.ts                                 → 提示手动重启（不自我重启）
 * - 生命周期：前端退出或 dev 收到 SIGINT/SIGTERM/SIGHUP（关终端 = SIGHUP）→
 *   停后台（SIGTERM，10s 升级 SIGKILL）、关监听、退出并提示日志位置；后台
 *   日志只写 logs/backend.log（有前端时绝不上屏），此时 dev 诊断只进
 *   logs/dev.log（无前端时输出到终端）。
 */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { probeControlPlane } from "./control/ensure-backend.ts";
import { readOwnerToken } from "./control/owner-token.ts";
import { probeModelConfig } from "./agent/model-config.ts";
import { RELOAD_STATE_ENV } from "./tui/reload-state.ts";

// ---------- 纯辅助（导出供单元测试） ----------

export interface DevProfile {
  root: string;
  dataDir: string;
  agentDir: string;
  controlDir: string;
  pendingDir: string;
  logsDir: string;
  reloadStateFile: string;
}

/** 开发档案路径：稳定可复用、按仓库区分（realpath 哈希）、基于 homedir（测试可覆盖 HOME）。 */
export function devProfileFor(repoRootDir: string, homeDir: string = os.homedir()): DevProfile {
  let real: string;
  try {
    real = fs.realpathSync(repoRootDir);
  } catch {
    real = path.resolve(repoRootDir);
  }
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 8);
  const slug = path.basename(real).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const root = path.join(homeDir, ".ruukoto-dev", `${slug}-${hash}`);
  return {
    root,
    dataDir: path.join(root, "data"),
    agentDir: path.join(root, "agent"),
    controlDir: path.join(root, "control"),
    pendingDir: path.join(root, "pending"),
    logsDir: path.join(root, "logs"),
    reloadStateFile: path.join(root, "reload-state.json"),
  };
}

/** 绝不继承的生产配置（拥有者令牌、受保护执行账户环境与产品身份）。 */
const SCRUB_EXACT = new Set([
  "RUUKOTO_OWNER_TOKEN",
  "RUUKOTO_OWNER_TOKEN_FILE",
  "RUUKOTO_EXECUTION_BACKEND",
  "RUUKOTO_WORKER_IMAGE",
  // 产品身份（issue 01）：开发实例固定为默认产品 ruukoto，不继承 ruukoto-dev 入口身份
  "RUUKOTO_PRODUCT",
  RELOAD_STATE_ENV,
]);
const SCRUB_PREFIXES = ["RUUKOTO_EXEC_", "RUUKOTO_CONTAINER_", "RUUKOTO_DEV_"];

/** 子进程环境：洗掉生产令牌/执行账户配置，注入档案目录与 QQ 停用标记。 */
export function buildChildEnv(base: NodeJS.ProcessEnv, profile: DevProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SCRUB_EXACT.has(key)) continue;
    if (SCRUB_PREFIXES.some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }
  env.RUUKOTO_DATA_DIR = profile.dataDir;
  env.RUUKOTO_AGENT_DIR = profile.agentDir;
  env.RUUKOTO_CONTROL_DIR = profile.controlDir;
  env.RUUKOTO_PENDING_DIR = profile.pendingDir;
  env.RUUKOTO_DISABLE_QQ = "1";
  env.RUUKOTO_DISABLE_TELEGRAM = "1";
  return env;
}

/** 监听分类：决定一次源码变更要重启谁。返回 null 表示不处理。 */
export type WatchAction = "tui" | "config-tui" | "backend" | "both" | "self";

export function classifyWatchPath(repoRelPath: string): WatchAction | null {
  const p = repoRelPath.split(path.sep).join("/");
  if (p === "src/dev.ts") return "self";
  if (!p.endsWith(".ts")) return null;
  if (p.startsWith("src/config-tui/")) return "config-tui";
  // reload-state.ts 被任务界面、配置界面与 dev 共享，按共享模块处理
  if (p === "src/tui/reload-state.ts") return "both";
  if (p.startsWith("src/tui/")) return "tui";
  if (
    p === "src/cli.ts" ||
    p.startsWith("src/runtime/") ||
    p.startsWith("src/agent/") ||
    p.startsWith("src/qq/") ||
    p.startsWith("src/telegram/")
  ) {
    return "backend";
  }
  if (p.startsWith("src/")) return "both"; // src/control/**、src/core/** 与 src 下其他
  return null;
}

/**
 * 一批监听动作 → 重启谁。任务界面经 ControlConnection 自动重连，后台重启不必
 * 重启它；配置中心用一次性连接、不重连（且直接引用 src/agent 下的配置模块），
 * 后台重启时一并重载（重载状态恢复所在分区）。
 */
export function planWatchRestart(actions: WatchAction[], frontend: "tui" | "config" | null): { backend: boolean; frontend: boolean } {
  const backend = actions.includes("backend") || actions.includes("both");
  const restartFrontend =
    frontend !== null &&
    (actions.includes("both") ||
      (actions.includes("tui") && frontend === "tui") ||
      (actions.includes("config-tui") && frontend === "config") ||
      (backend && frontend === "config"));
  return { backend, frontend: restartFrontend };
}

export interface DevArgs {
  tui: boolean;
  config: boolean;
  importModels?: string;
}

/** 严格解析；--tui 与 --config 同用直接抛错（调用方在建目录/spawn 前校验）。 */
export function parseDevArgs(argv: string[]): DevArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      tui: { type: "boolean" },
      config: { type: "boolean" },
      "import-models": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`不接受位置参数：${positionals.join(" ")}`);
  if (values.tui && values.config) throw new Error("--tui 与 --config 不能同时使用");
  return { tui: values.tui ?? false, config: values.config ?? false, importModels: values["import-models"] };
}

/** 显式导入模型配置：只复制 models.json/auth.json（0600），绝不碰 credentials.json。 */
export function importModelConfigs(sourceDir: string, agentDir: string): string[] {
  const copied: string[] = [];
  for (const name of ["models.json", "auth.json"]) {
    const from = path.join(sourceDir, name);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const to = path.join(agentDir, name);
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o600);
    copied.push(name);
  }
  return copied;
}

// 控制面探测归入 src/control/ensure-backend.ts（issue 02 按需拉起复用），此处再导出保持既有测试接缝
export { probeControlPlane };

// ---------- dev 会话 ----------

const BACKEND_KILL_GRACE_MS = 10_000;
const WATCH_DEBOUNCE_MS = 300;

class DevSession {
  private readonly childEnv: NodeJS.ProcessEnv;
  private frontendKind: "tui" | "config" | null = null;
  private backend: childProcess.ChildProcess | null = null;
  private frontend: childProcess.ChildProcess | null = null;
  /** 有意停止标记：重启/收尾期间子进程退出不触发级联处理。 */
  private backendStopping = false;
  private frontendStopping = false;
  private stopping = false;
  private backendOp: Promise<void> | null = null;
  private frontendOp: Promise<void> | null = null;
  private watchers: fs.FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;
  private pendingWatch = new Set<WatchAction>();
  private backendLog: fs.WriteStream | null = null;
  private exitResolve: ((code: number) => void) | null = null;
  private readonly exitPromise: Promise<number>;

  constructor(
    private readonly repoRootDir: string,
    private readonly profile: DevProfile,
    private readonly args: DevArgs,
  ) {
    this.childEnv = buildChildEnv(process.env, profile);
    this.exitPromise = new Promise<number>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  private get backendLogPath(): string {
    return path.join(this.profile.logsDir, "backend.log");
  }

  private get devLogPath(): string {
    return path.join(this.profile.logsDir, "dev.log");
  }

  private get socketPath(): string {
    return path.join(this.profile.controlDir, "control.sock");
  }

  /** dev 诊断：有前端在跑时只进 dev.log（绝不上屏打乱绘制），否则到终端。 */
  private log(msg: string): void {
    const line = `[dev] ${msg}`;
    if (this.frontend && !this.frontendStopping) {
      try {
        fs.appendFileSync(this.devLogPath, `${line}\n`);
        return;
      } catch {
        // 写日志失败退回终端
      }
    }
    console.error(line);
  }

  /** 主流程：已在运行检查 → 清旧重载记录 → 模型门禁 → 后台 → 前端 → 监听。 */
  async run(): Promise<number> {
    // 信号与兜底钩子最先装好：启动窗口内被打断也不许留下持锁子进程
    this.installSignalHandlers();
    if (await probeControlPlane(this.socketPath, readOwnerToken(this.profile.controlDir))) {
      console.error(`开发实例已在运行（${this.profile.root}）；不会启动第二个实例或接管既有进程`);
      return 1;
    }
    // 新一轮 dev 启动：清除上一轮的重载恢复记录（run 内的重载才复用它）
    fs.rmSync(this.profile.reloadStateFile, { force: true });

    // 模型门禁
    let probe = await probeModelConfig(this.profile.agentDir);
    if (!probe.ok && !this.args.config) {
      console.error(`未配置有效模型：${probe.detail}\n请先 npm run dev -- --config`);
      return 1;
    }
    if (!probe.ok && this.args.config) {
      console.error(`未配置有效模型：${probe.detail}；先打开离线配置中心（保存后自动继续）`);
      await this.runOfflineConfigChild();
      probe = await probeModelConfig(this.profile.agentDir);
      if (!probe.ok) {
        console.error(`模型配置仍不可用：${probe.detail}；未启动后台`);
        return 1;
      }
    }

    // 后台（初始启动失败：清干净、非零退出、指出日志）
    this.backendLog = fs.createWriteStream(this.backendLogPath, { flags: "a" });
    try {
      await this.startBackend();
    } catch (err) {
      if (this.stopping) return await this.exitPromise; // 收尾在途：子进程被有意停止，不算启动失败
      console.error(`后台启动失败：${(err as Error).message}\n日志见 ${this.backendLogPath}`);
      await this.killAllChildren();
      this.backendLog.end();
      return 1;
    }
    console.error(`开发实例后台已就绪：${this.socketPath}（日志 ${this.backendLogPath}）`);

    if (this.stopping) return await this.exitPromise; // 就绪等待期间被打断
    // 前端（独占终端；dev 诊断此后转入 dev.log）
    if (this.args.tui || this.args.config) {
      this.spawnFrontend(this.args.config ? "config" : "tui");
    }

    this.startWatchers();
    if (!this.frontendKind) {
      console.error("监听 src/ 变更中；Ctrl+C 退出（--tui 任务界面 / --config 配置中心）");
    }
    return await this.exitPromise;
  }

  private spawnChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...this.childEnv, ...extra, [RELOAD_STATE_ENV]: this.profile.reloadStateFile };
  }

  private nodeCliArgs(cliArgs: string[]): string[] {
    return ["--import", "tsx", path.join(this.repoRootDir, "src", "cli.ts"), ...cliArgs];
  }

  /** 离线配置中心（一次性子进程：跑完即走，不是受管前端）。 */
  private runOfflineConfigChild(): Promise<void> {
    return new Promise((resolve) => {
      const child = childProcess.spawn(process.execPath, this.nodeCliArgs(["config", "--offline"]), {
        cwd: this.repoRootDir,
        env: this.spawnChildEnv(),
        stdio: "inherit",
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve()); // spawn 失败交由复探报错
    });
  }

  // ---------- 后台子进程 ----------

  private spawnBackend(): void {
    const child = childProcess.spawn(
      process.execPath,
      this.nodeCliArgs(["server", "--data-dir", this.profile.dataDir, "--agent-dir", this.profile.agentDir]),
      { cwd: this.repoRootDir, env: this.spawnChildEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    // 后台输出只进日志文件：与前端同屏会打乱界面绘制
    child.stdout?.on("data", (chunk: Buffer) => this.backendLog?.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.backendLog?.write(chunk));
    this.backend = child;
    child.on("error", () => this.onBackendExit());
    child.on("exit", (code, signal) => this.onBackendExit(code, signal));
  }

  private onBackendExit(code?: number | null, signal?: string | null): void {
    if (this.backendStopping || this.stopping) return;
    this.backend = null;
    this.log(`后台进程意外退出（code=${code ?? "error"} signal=${signal ?? "-"}）；继续监听，下一次相关源码变更将重试启动`);
  }

  /** 启动后台并等待控制面就绪；失败抛错由调用方处理。 */
  private async startBackend(): Promise<void> {
    const child = (() => {
      this.spawnBackend();
      return this.backend!;
    })();
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`后台进程提前退出（code=${child.exitCode ?? child.signalCode}）`);
      }
      if (await probeControlPlane(this.socketPath, readOwnerToken(this.profile.controlDir), 1000)) return;
      if (Date.now() > deadline) throw new Error("等待后台就绪超时（60s）");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** 重启后台：SIGTERM → 10s 升级 SIGKILL → 等实例锁释放 → 重启 → 就绪等待。 */
  private restartBackend(): Promise<void> {
    // 串行化：防抖后的连续变更不得叠出两个后台
    const op = (this.backendOp ?? Promise.resolve()).then(() => this.restartBackendInner());
    this.backendOp = op.catch(() => {});
    return op;
  }

  private async restartBackendInner(): Promise<void> {
    if (this.stopping) return;
    this.log("重启后台（源码变更）…");
    this.backendStopping = true;
    await this.killChild(this.backend);
    this.backend = null;
    this.backendStopping = false;
    if (this.stopping) return;
    // 等实例锁释放：正常停止时旧后台自行删锁；若旧进程已确认退出（killChild
    // 返回即已退出）而锁目录残留，属崩溃遗留锁，Runtime.start 会按 owner.json
    // 核实接管——此时不启动替代进程才是 bug
    const lockDir = path.join(this.profile.dataDir, "runtime.lock");
    const deadline = Date.now() + 15_000;
    while (fs.existsSync(lockDir) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (fs.existsSync(lockDir)) {
      this.log("实例锁目录残留（旧进程已退出，按遗留锁接管继续）");
    }
    try {
      await this.startBackend();
      this.log("后台已重启并就绪");
    } catch (err) {
      if (this.stopping) return; // 收尾在途：子进程被有意停止
      this.log(`后台重启失败：${(err as Error).message}；继续监听，下一次相关变更将重试`);
    }
  }

  // ---------- 前端子进程 ----------

  private spawnFrontend(kind: "tui" | "config"): void {
    this.frontendKind = kind;
    // 任务界面 = 无参入口；配置中心 = config 子命令
    const cliArgs = kind === "config" ? ["config"] : [];
    const child = childProcess.spawn(process.execPath, this.nodeCliArgs(cliArgs), {
      cwd: this.repoRootDir,
      env: this.spawnChildEnv(),
      stdio: "inherit", // 只有前端碰 stdin/raw mode/屏幕
    });
    this.frontend = child;
    child.on("error", () => this.onFrontendExit());
    child.on("exit", (code, signal) => this.onFrontendExit(code, signal));
  }

  private onFrontendExit(code?: number | null, signal?: string | null): void {
    this.frontend = null;
    if (this.frontendStopping || this.stopping) return;
    console.error(`前端已退出（code=${code ?? "error"} signal=${signal ?? "-"}），正在停止后台…`);
    void this.shutdown(0);
  }

  private restartFrontend(): Promise<void> {
    const op = (this.frontendOp ?? Promise.resolve()).then(() => this.restartFrontendInner());
    this.frontendOp = op.catch(() => {});
    return op;
  }

  private async restartFrontendInner(): Promise<void> {
    if (this.stopping || !this.frontendKind) return;
    const kind = this.frontendKind;
    this.log("重启前端（源码变更；会话/草稿/继续意图经重载状态恢复）…");
    this.frontendStopping = true;
    await this.killChild(this.frontend);
    this.frontend = null;
    this.frontendStopping = false;
    if (this.stopping) return;
    this.spawnFrontend(kind);
  }

  // ---------- 监听 ----------

  private startWatchers(): void {
    const srcRoot = path.join(this.repoRootDir, "src");
    const dirs: string[] = [];
    const walk = (dir: string): void => {
      dirs.push(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
      }
    };
    try {
      walk(srcRoot);
    } catch (err) {
      this.log(`源码目录不可读，监听未启动：${(err as Error).message}`);
      return;
    }
    // 只盯源码目录：档案、node_modules、test、日志写入都不触发重载
    for (const dir of dirs) {
      try {
        const watcher = fs.watch(dir, (_event, filename) => this.onFsEvent(dir, filename));
        watcher.on("error", (err) => this.log(`监听失败（${dir}）：${err.message}`));
        this.watchers.push(watcher);
      } catch (err) {
        this.log(`无法监听 ${dir}：${(err as Error).message}`);
      }
    }
  }

  private onFsEvent(dir: string, filename: string | null): void {
    if (this.stopping || !filename) return;
    const rel = path.relative(this.repoRootDir, path.join(dir, filename));
    const action = classifyWatchPath(rel);
    if (action === null) return;
    if (action === "self") {
      this.log("dev.ts 已变更，请重启 npm run dev（不自动自我重启）");
      return;
    }
    this.pendingWatch.add(action);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => void this.flushWatch(), WATCH_DEBOUNCE_MS);
  }

  private async flushWatch(): Promise<void> {
    this.watchTimer = null;
    const actions = [...this.pendingWatch];
    this.pendingWatch.clear();
    if (this.stopping) return;
    const plan = planWatchRestart(actions, this.frontendKind);
    if (plan.backend) await this.restartBackend();
    if (plan.frontend) await this.restartFrontend();
  }

  private closeWatchers(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // 已关闭
      }
    }
    this.watchers = [];
  }

  // ---------- 生命周期 ----------

  private installSignalHandlers(): void {
    const onSignal = () => void this.shutdown(0);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal); // 关闭终端也走完整清理
    // 兜底：dev 以任何方式退出都不留下持锁后台
    process.on("exit", () => {
      for (const child of [this.frontend, this.backend]) {
        try {
          if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
    });
  }

  private async killChild(child: childProcess.ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + BACKEND_KILL_GRACE_MS;
    while (child.exitCode === null && child.signalCode === null) {
      if (Date.now() > deadline) {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // 等 exit 落账（SIGKILL 后也应很快到达）
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 5000);
      });
    }
  }

  private async killAllChildren(): Promise<void> {
    this.frontendStopping = true;
    this.backendStopping = true;
    await this.killChild(this.frontend);
    this.frontend = null;
    await this.killChild(this.backend);
    this.backend = null;
  }

  /** 收尾：关监听 → 停前端 → 停后台（SIGTERM，10s 升级 SIGKILL）→ 退出并提示日志。 */
  private async shutdown(code: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.closeWatchers();
    await this.killAllChildren();
    this.backendLog?.end();
    console.error(`dev 已退出。日志：${this.backendLogPath}${this.frontendKind ? `、${this.devLogPath}` : ""}`);
    this.exitResolve?.(code);
  }
}

// ---------- 入口 ----------

async function main(): Promise<number> {
  let args: DevArgs;
  try {
    args = parseDevArgs(process.argv.slice(2));
  } catch (err) {
    // 参数错误：在建目录、起进程之前失败退出
    console.error(`参数错误：${(err as Error).message}\n用法：npm run dev -- [--tui | --config] [--import-models <目录>]`);
    return 1;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const profile = devProfileFor(root);
  for (const dir of [profile.dataDir, profile.agentDir, profile.controlDir, profile.pendingDir, profile.logsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (args.importModels) {
    const copied = importModelConfigs(args.importModels, profile.agentDir);
    console.error(
      copied.length > 0
        ? `已导入模型配置：${copied.join("、")} → ${profile.agentDir}（credentials.json 绝不导入）`
        : `${args.importModels} 中没有 models.json/auth.json，未导入任何文件`,
    );
  }
  const session = new DevSession(root, profile, args);
  return await session.run();
}

// 仅作为进程入口时执行 main（测试导入纯辅助函数不得启动启动器）
const invokedAsEntry = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedAsEntry) {
  process.exitCode = await main();
}
