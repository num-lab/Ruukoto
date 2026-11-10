/** Development owns its backend and frontend processes under one isolated raw profile selection. */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { probeControlPlane, socketConnectable } from "@ruukoto/control/ensure-backend.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { probeModelConfig } from "@ruukoto/agent/model-config.ts";
import { RELOAD_STATE_ENV } from "./tui/reload-state.ts";
import { bootstrapProfile, profileChildEnv, selectProfile, type ProfilePaths, type ProfileSelection } from "@ruukoto/core/profile.ts";

// ---------- 纯辅助（导出供单元测试） ----------


/** Stable checkout identity; core resolves these raw directories into the current layout. */
export function devProfileFor(repoRootDir: string, homeDir: string = os.homedir()): ProfileSelection {
  const real = fs.realpathSync(repoRootDir);
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 8);
  const slug = path.basename(real).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const root = path.join(homeDir, ".ruukoto-dev", `${slug}-${hash}`);
  return selectProfile({
    dataDir: path.join(root, "data"),
    agentDir: path.join(root, "agent"),
    controlDir: path.join(root, "control"),
    pendingDir: path.join(root, "pending"),
  }, {}, homeDir);
}

/** 绝不继承的生产配置（拥有者令牌与产品身份）。 */
const SCRUB_EXACT = new Set([
  "RUUKOTO_OWNER_TOKEN",
  "RUUKOTO_OWNER_TOKEN_FILE",
  "RUUKOTO_EXECUTION_BACKEND",
  // 产品身份与路径由开发入口固定，不继承日常实例。
  "RUUKOTO_DATA_DIR",
  "RUUKOTO_AGENT_DIR",
  "RUUKOTO_CONTROL_DIR",
  "RUUKOTO_PENDING_DIR",
  RELOAD_STATE_ENV,
]);
const SCRUB_PREFIXES = ["RUUKOTO_SERVICE_", "RUUKOTO_DESKTOP_"];

/** Children receive the complete raw tuple, without daily tokens or host overrides. */
export function buildChildEnv(base: NodeJS.ProcessEnv, profile: ProfilePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SCRUB_EXACT.has(key)) continue;
    if (SCRUB_PREFIXES.some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }
  return profileChildEnv(profile.selection, env);
}

/** 监听分类：决定一次源码变更要重启谁。返回 null 表示不处理。 */
export type WatchAction = "tui" | "config-tui" | "backend" | "both" | "self";

export function classifyWatchPath(repoRelPath: string): WatchAction | null {
  const p = repoRelPath.split(path.sep).join("/");
  if (p.startsWith("apps/desktop/")) return null;
  if (p === "packages/tui/src/dev.ts" || /^apps\/[^/]+\/src\/dev\.ts$/.test(p)) return "self";
  if (!p.endsWith(".ts")) return null;
  if (p.startsWith("packages/tui/src/config-tui/")) return "config-tui";
  // reload-state.ts 被任务界面、配置界面与 dev 共享，按共享模块处理
  if (p === "packages/tui/src/tui/reload-state.ts") return "both";
  if (p.startsWith("packages/tui/src/tui/") || p.startsWith("packages/view/src/")) return "tui";
  if (
    p === "packages/tui/src/cli.ts" ||
    /^packages\/(runtime|agent|channels)\/src\//.test(p) ||
    /^apps\/[^/]+\/src\//.test(p)
  ) {
    return "backend";
  }
  if (/^packages\/(control|core|tui)\/src\//.test(p)) return "both";
  return null;
}

type FrontendKind = "tui" | "config" | "desktop";

/**
 * 一批监听动作 → 重启谁。任务界面经 ControlConnection 自动重连，后台重启不必
 * 重启它；配置中心用一次性连接、不重连（且直接引用 agent 的配置模块），
 * 后台重启时一并重载（重载状态恢复所在分区）。桌面前端由 electron-vite 重载。
 */
export function planWatchRestart(actions: WatchAction[], frontend: FrontendKind | null): { backend: boolean; frontend: boolean } {
  const backend = actions.includes("backend") || actions.includes("both");
  const restartFrontend =
    frontend !== null && frontend !== "desktop" &&
    (actions.includes("both") ||
      (actions.includes("tui") && frontend === "tui") ||
      (actions.includes("config-tui") && frontend === "config") ||
      (backend && frontend === "config"));
  return { backend, frontend: restartFrontend };
}

export interface DevArgs {
  tui: boolean;
  config: boolean;
  desktop: boolean;
  workspacePath?: string;
}

/** Strict argument parsing occurs before profile activation. */
export function parseDevArgs(argv: string[]): DevArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "boolean" },
      desktop: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.desktop && values.config) throw new Error("--desktop 不能与 --config 同用");
  if (positionals.length > 1) throw new Error("工作区入口只接受一个路径");
  if (values.config && positionals.length > 0) throw new Error("--config 不能与工作区路径同用");
  if (values.desktop && positionals.length > 0) throw new Error("--desktop 不能与工作区路径同用");
  return {
    tui: !values.config && !values.desktop,
    config: values.config ?? false,
    desktop: values.desktop ?? false,
    workspacePath: positionals[0],
  };
}


// ---------- dev 会话 ----------

const BACKEND_KILL_GRACE_MS = 10_000;
const WATCH_DEBOUNCE_MS = 300;

class DevSession {
  private readonly childEnv: NodeJS.ProcessEnv;
  private frontendKind: FrontendKind | null = null;
  private backend: childProcess.ChildProcess | null = null;
  private frontend: childProcess.ChildProcess | null = null;
  private frontendGroupPid: number | null = null;
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
    private readonly profile: ProfilePaths,
    private readonly args: DevArgs,
  ) {
    this.childEnv = buildChildEnv(process.env, profile);
    this.exitPromise = new Promise<number>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  private get backendLogPath(): string {
    return this.profile.backendLogPath;
  }

  private get devLogPath(): string {
    return this.profile.devLogPath;
  }

  private get socketPath(): string {
    return this.profile.socketPath;
  }

  private get command(): string {
    return "npm run dev";
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
    const running = await socketConnectable(this.socketPath);
    if (this.stopping) return await this.exitPromise;
    if (running) {
      console.error(`开发实例已在运行（${this.profile.rootDir}）；不会启动第二个实例或接管既有进程`);
      return 1;
    }
    // 新一轮 dev 启动：清除上一轮的重载恢复记录（run 内的重载才复用它）
    fs.rmSync(this.profile.reloadStatePath, { force: true });

    // 模型门禁
    let probe = await probeModelConfig(this.profile.agentDir);
    if (this.stopping) return await this.exitPromise;
    if (!probe.ok && !this.args.config) {
      console.error(`未配置有效模型：${probe.detail}\n请先 ${this.command} -- --config`);
      return 1;
    }
    if (!probe.ok && this.args.config) {
      console.error(`未配置有效模型：${probe.detail}；先打开离线配置中心（保存后自动继续）`);
      await this.runOfflineConfigChild();
      if (this.stopping) return await this.exitPromise;
      probe = await probeModelConfig(this.profile.agentDir);
      if (this.stopping) return await this.exitPromise;
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
    if (this.args.tui || this.args.config || this.args.desktop) {
      this.spawnFrontend(this.args.desktop ? "desktop" : this.args.config ? "config" : "tui");
    }

    this.startWatchers();
    if (!this.frontendKind) {
      console.error(`监听 packages/ 与 apps/ 源码变更中；Ctrl+C 退出（${this.command} -- --config 打开配置中心）`);
    }
    return await this.exitPromise;
  }

  private spawnChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...this.childEnv, ...extra, [RELOAD_STATE_ENV]: "1" };
  }

  private nodeCliArgs(cliArgs: string[]): string[] {
    return [path.join(this.repoRootDir, "apps", "ruukoto", "bin", "ruukoto.mjs"), ...cliArgs];
  }

  /** 离线配置中心（一次性子进程：跑完即走，不是受管前端）。 */
  private runOfflineConfigChild(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = childProcess.spawn(process.execPath, this.nodeCliArgs(["config", "--offline"]), {
        cwd: this.repoRootDir,
        env: this.spawnChildEnv(),
        stdio: "inherit",
      });
      this.frontend = child;
      child.once("exit", (code, signal) => {
        if (this.frontend === child) this.frontend = null;
        if (code === 0) resolve();
        else reject(new Error(`离线配置未完成（${signal ?? code}）；未启动后台`));
      });
      child.once("error", error => {
        if (this.frontend === child) this.frontend = null;
        reject(error);
      });
    });
  }

  // ---------- 后台子进程 ----------

  private spawnBackend(): void {
    const child = childProcess.spawn(
      process.execPath,
      this.nodeCliArgs(["server"]),
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
      if (await probeControlPlane(this.profile, readOwnerToken(this.profile.controlDir), 1000)) return;
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

  private spawnFrontend(kind: FrontendKind): void {
    const cliArgs = kind === "config" ? ["config"] : [];
    // 路径只用于首次工作区入口；重载走无参 TUI 恢复原会话，避免再次创建。
    if (kind === "tui" && this.frontendKind === null && this.args.workspacePath !== undefined) {
      cliArgs.push("--", path.resolve(this.args.workspacePath));
    }
    this.frontendKind = kind;
    // Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
    const desktop = kind === "desktop";
    const child = childProcess.spawn(desktop ? "electron-vite" : process.execPath, desktop ? ["dev", "--watch"] : this.nodeCliArgs(cliArgs), {
      cwd: desktop ? path.join(this.repoRootDir, "apps", "desktop") : this.repoRootDir,
      env: this.spawnChildEnv(desktop ? {
        RUUKOTO_DESKTOP_MANAGED: "1",
        RUUKOTO_DESKTOP_DEV_NONCE: crypto.randomBytes(24).toString("base64url"),
      } : {}),
      detached: desktop,
      stdio: "inherit", // 只有前端碰 stdin/raw mode/屏幕
    });
    this.frontend = child;
    this.frontendGroupPid = desktop ? child.pid ?? null : null;
    child.on("error", () => this.onFrontendExit());
    child.on("exit", (code, signal) => this.onFrontendExit(code, signal));
  }

  private onFrontendExit(code?: number | null, signal?: string | null): void {
    this.frontend = null;
    if (this.frontendStopping || this.stopping) return;
    console.error(`前端已退出（code=${code ?? "error"} signal=${signal ?? "-"}），正在停止后台…`);
    void this.shutdown(code ?? 1);
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
    await this.killChild(this.frontend, this.frontendGroupPid);
    this.frontend = null;
    this.frontendGroupPid = null;
    this.frontendStopping = false;
    if (this.stopping) return;
    this.spawnFrontend(kind);
  }

  // ---------- 监听 ----------

  private startWatchers(): void {
    const dirs: string[] = [];
    const walk = (dir: string): void => {
      dirs.push(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
      }
    };
    try {
      for (const base of ["packages", "apps"]) {
        for (const entry of fs.readdirSync(path.join(this.repoRootDir, base))) {
          walk(path.join(this.repoRootDir, base, entry, "src"));
        }
      }
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
      this.log(`${rel} 已变更，请重启 ${this.command}（不自动自我重启）`);
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
      if (this.frontendGroupPid !== null) this.signalProcessGroup(this.frontendGroupPid, "SIGKILL");
      for (const child of [this.frontend, this.backend]) {
        try {
          if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
    });
  }

  private signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
      return process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  private async killChild(child: childProcess.ChildProcess | null, groupPid: number | null = null): Promise<void> {
    // electron-vite 可能先退出，仍要清理它启动的 Electron 进程组。
    if (groupPid !== null) {
      if (!this.signalProcessGroup(groupPid, "SIGTERM")) return;
      const deadline = Date.now() + BACKEND_KILL_GRACE_MS;
      while (this.signalProcessGroup(groupPid, 0)) {
        if (Date.now() > deadline) {
          this.signalProcessGroup(groupPid, "SIGKILL");
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    }
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
    await this.killChild(this.frontend, this.frontendGroupPid);
    this.frontend = null;
    this.frontendGroupPid = null;
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

export async function runDev(): Promise<number> {
  let args: DevArgs;
  try {
    args = parseDevArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误：${(err as Error).message}\n用法：npm run dev -- [<路径> | --config | --desktop]`);
    return 1;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const profile = await bootstrapProfile(devProfileFor(root));
    fs.mkdirSync(profile.logsDir, { recursive: true, mode: 0o700 });
    return await new DevSession(root, profile, args).run();
  } catch (error) {
    process.stderr.write(`[ruukoto:dev] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
