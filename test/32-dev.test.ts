/**
 * dev 启动器（issue 21 §1/§5）测试：
 *
 * - 单元：档案路径（稳定/按仓库区分/仓库外/随 HOME 覆盖）、子进程环境清洗、
 *   监听分类矩阵、参数解析（--tui+--config 在建目录前报错）、模型配置导入；
 * - 集成（真实仓库 + HOME=临时目录，档案落在临时目录内）：
 *   普通 dev 启动就绪（清洗后环境可认证握手、QQ 停用标记生效）与 SIGINT 清理
 *   （无残留锁/孤儿进程）；已在运行拒绝且不碰外来后台；无有效模型直接失败；
 *   --import-models 只复制 models.json/auth.json（0600）；
 * - TUI 重载状态（FakeTerminal 直驱 app.ts）：草稿/会话/继续意图持久化与恢复、
 *   instanceId 篡改失效回落、继续目标任务已结束时丢弃意图（草稿保留，提交仍是新任务）；
 * - PTY（python3 + pty，无 python3 跳过）：npm run dev -- --tui 端到端，/quit 后
 *   dev 退出、终端恢复、后台日志不与终端交错、子进程无残留。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeTerminal } from "./helpers/fake-terminal.ts";
import {
  buildChildEnv,
  classifyWatchPath,
  planWatchRestart,
  devProfileFor,
  importModelConfigs,
  parseDevArgs,
  probeControlPlane,
} from "../src/dev.ts";
import { ControlClient } from "../src/control/client.ts";
import { readOwnerToken } from "../src/control/owner-token.ts";
import { ControlConnection } from "../src/control/connection.ts";
import { PendingRequestStore } from "../src/control/pending-requests.ts";
import { SubmissionGuard } from "../src/control/submission.ts";
import { ViewState } from "../src/tui/state.ts";
import { TuiApp } from "../src/tui/app.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { killBackend, spawnBackend } from "./helpers/backend.ts";
import {
  createProjectSession,
  lastUserText,
  startTestRuntime,
  waitFor,
  writeModelsJson,
  type TestRuntime,
} from "./helpers/testkit.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpHome(prefix = "ruukoto-test-dev-"): string {
  // macOS Unix socket 路径上限约 104 字符：os.tmpdir()（/var/folders/…）下的
  // 档案 control.sock 会超限（listen EINVAL），测试 HOME 一律用 /tmp 短路径
  return fs.mkdtempSync(path.join("/tmp", prefix));
}

/** 在档案 agent 目录写入指向 MockModelServer 的有效模型配置。 */
async function writeMockModelConfig(agentDir: string, baseUrl: string): Promise<void> {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  await writeModelsJson({ root: "", dataDir: "", agentDir }, baseUrl);
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }, null, 2), {
    mode: 0o600,
  });
}

interface DevRun {
  child: childProcess.ChildProcess;
  stdout: () => string;
  stderr: () => string;
  waitExit: () => Promise<number | null>;
}

function runDev(home: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): DevRun {
  const child = spawn(process.execPath, ["--import", "tsx", "src/dev.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr!.on("data", (c: Buffer) => (err += c.toString("utf8")));
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    waitExit: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once("exit", (code) => resolve(code));
      }),
  };
}

async function killDev(run: DevRun): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) {
    run.child.kill("SIGKILL");
    await new Promise<void>((r) => {
      run.child.once("exit", () => r());
      setTimeout(r, 5000);
    });
  }
}

// ---------- 单元 ----------

test("档案路径：稳定、按仓库区分、在仓库外、随 HOME 参数变化", () => {
  const home = tmpHome();
  const a = devProfileFor(repoRoot, home);
  const b = devProfileFor(repoRoot, home);
  assert.deepEqual(a, b, "同一仓库同一 HOME 结果稳定");
  const real = fs.realpathSync(repoRoot);
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 8);
  assert.equal(a.root, path.join(home, ".ruukoto-dev", `ruukoto-${hash}`));
  assert.ok(!a.root.startsWith(real + path.sep), "档案在仓库外（保护根不含它）");
  for (const sub of [a.dataDir, a.agentDir, a.controlDir, a.pendingDir, a.logsDir]) {
    assert.ok(sub.startsWith(a.root + path.sep));
  }
  assert.equal(path.dirname(a.dataDir), a.root, "dirname(dataDir)/qq-work 落在档案内");
  const other = devProfileFor(path.join(home, "another-repo"), home);
  assert.notEqual(other.root, a.root, "不同仓库不同档案目录");
  const home2 = tmpHome();
  assert.notEqual(devProfileFor(repoRoot, home2).root, a.root, "HOME 覆盖生效");
});

test("环境清洗：生产令牌/执行账户变量被剥除，档案目录与 QQ 停用注入", () => {
  const profile = devProfileFor(repoRoot, tmpHome());
  const env = buildChildEnv(
    {
      PATH: "/usr/bin",
      RUUKOTO_OWNER_TOKEN: "prod-token",
      RUUKOTO_OWNER_TOKEN_FILE: "/etc/owner.token",
      RUUKOTO_EXECUTION_BACKEND: "systemd",
      RUUKOTO_EXEC_UID: "900",
      RUUKOTO_CONTAINER_IMAGE: "img",
      RUUKOTO_WORKER_IMAGE: "worker",
      RUUKOTO_DATA_DIR: "/prod/data",
      RUUKOTO_AGENT_DIR: "/prod/agent",
      RUUKOTO_CONTROL_DIR: "/prod/control",
      RUUKOTO_PENDING_DIR: "/prod/pending",
      RUUKOTO_DISABLE_QQ: "0",
      RUUKOTO_RELOAD_STATE_FILE: "/prod/reload.json",
    },
    profile,
  );
  for (const key of [
    "RUUKOTO_OWNER_TOKEN",
    "RUUKOTO_OWNER_TOKEN_FILE",
    "RUUKOTO_EXECUTION_BACKEND",
    "RUUKOTO_EXEC_UID",
    "RUUKOTO_CONTAINER_IMAGE",
    "RUUKOTO_WORKER_IMAGE",
    "RUUKOTO_RELOAD_STATE_FILE",
  ]) {
    assert.equal(env[key], undefined, `${key} 不得继承`);
  }
  assert.equal(env.PATH, "/usr/bin", "普通变量保留");
  assert.equal(env.RUUKOTO_DATA_DIR, profile.dataDir);
  assert.equal(env.RUUKOTO_AGENT_DIR, profile.agentDir);
  assert.equal(env.RUUKOTO_CONTROL_DIR, profile.controlDir);
  assert.equal(env.RUUKOTO_PENDING_DIR, profile.pendingDir);
  assert.equal(env.RUUKOTO_DISABLE_QQ, "1", "dev 固定停用真实 QQ 通道");
  assert.equal(env.RUUKOTO_DISABLE_TELEGRAM, "1", "dev 固定停用真实 Telegram 通道");
});

test("监听分类：tui / config-tui / backend / both / self", () => {
  assert.equal(classifyWatchPath("src/dev.ts"), "self");
  assert.equal(classifyWatchPath("src/tui/app.ts"), "tui");
  assert.equal(classifyWatchPath("src/tui/state.ts"), "tui");
  assert.equal(classifyWatchPath("src/config-tui/index.ts"), "config-tui");
  assert.equal(classifyWatchPath("src/config-tui/panels/models.ts"), "config-tui");
  assert.equal(classifyWatchPath("src/cli.ts"), "backend");
  assert.equal(classifyWatchPath("src/runtime/runtime.ts"), "backend");
  assert.equal(classifyWatchPath("src/agent/model-config.ts"), "backend");
  assert.equal(classifyWatchPath("src/qq/adapter.ts"), "backend");
  assert.equal(classifyWatchPath("src/control/server.ts"), "both");
  assert.equal(classifyWatchPath("src/core/types.ts"), "both");
  assert.equal(classifyWatchPath("src/cli-entry.ts"), "both");
  assert.equal(classifyWatchPath("src/index.ts"), "both");
  assert.equal(classifyWatchPath("src/tui/app.js"), null, "只盯 .ts");
  assert.equal(classifyWatchPath("test/32-dev.test.ts"), null, "监听范围外");
  assert.equal(classifyWatchPath("README.md"), null);
});

test("重启计划：后台变更只重启后台；配置中心不重连，随后台一并重载", () => {
  assert.deepEqual(planWatchRestart(["backend"], "tui"), { backend: true, frontend: false }, "任务界面自动重连");
  assert.deepEqual(planWatchRestart(["backend"], "config"), { backend: true, frontend: true });
  assert.deepEqual(planWatchRestart(["backend"], null), { backend: true, frontend: false });
  assert.deepEqual(planWatchRestart(["tui"], "config"), { backend: false, frontend: false });
  assert.deepEqual(planWatchRestart(["config-tui"], "config"), { backend: false, frontend: true });
  assert.deepEqual(planWatchRestart(["both"], "tui"), { backend: true, frontend: true });
});

test("参数解析：--tui+--config 冲突抛错；严格模式拒绝未知参数", () => {
  assert.deepEqual(parseDevArgs([]), { tui: false, config: false, importModels: undefined });
  assert.deepEqual(parseDevArgs(["--tui"]), { tui: true, config: false, importModels: undefined });
  assert.deepEqual(parseDevArgs(["--config"]), { tui: false, config: true, importModels: undefined });
  assert.equal(parseDevArgs(["--import-models", "/tmp/x"]).importModels, "/tmp/x");
  assert.throws(() => parseDevArgs(["--tui", "--config"]), /不能同时使用/);
  assert.throws(() => parseDevArgs(["--nope"]));
  assert.throws(() => parseDevArgs(["pos"]));
});

test("importModelConfigs：只复制 models.json/auth.json（0600），忽略 credentials.json", () => {
  const dir = tmpHome("ruukoto-test-import-");
  const src = path.join(dir, "src");
  const dst = path.join(dir, "agent");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "models.json"), "{}");
  fs.writeFileSync(path.join(src, "auth.json"), "{}");
  fs.writeFileSync(path.join(src, "credentials.json"), "{}");
  const copied = importModelConfigs(src, dst);
  assert.deepEqual(copied.sort(), ["auth.json", "models.json"]);
  for (const name of ["models.json", "auth.json"]) {
    assert.equal(fs.statSync(path.join(dst, name)).mode & 0o777, 0o600, `${name} 0600`);
  }
  assert.ok(!fs.existsSync(path.join(dst, "credentials.json")), "credentials.json 绝不导入");
  assert.deepEqual(importModelConfigs(path.join(dir, "empty"), dst), [], "目录无文件不报错");
});

// ---------- 集成（真实仓库 + HOME=临时目录） ----------

test("dev：--tui+--config 在建目录前失败（无副作用）", { timeout: 60_000 }, async () => {
  const home = tmpHome();
  const run = runDev(home, ["--tui", "--config"]);
  try {
    const code = await run.waitExit();
    assert.equal(code, 1);
    assert.ok(run.stderr().includes("不能同时使用"), run.stderr());
    assert.ok(!fs.existsSync(path.join(home, ".ruukoto-dev")), "档案目录未被创建");
  } finally {
    await killDev(run);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("dev：无有效模型 → 报错并提示 --config，不启动任何东西", { timeout: 60_000 }, async () => {
  const home = tmpHome();
  const profile = devProfileFor(repoRoot, home);
  const run = runDev(home);
  try {
    const code = await run.waitExit();
    assert.equal(code, 1);
    assert.ok(run.stderr().includes("未配置有效模型"), run.stderr());
    assert.ok(run.stderr().includes("--config"), run.stderr());
    assert.ok(!fs.existsSync(path.join(profile.controlDir, "control.sock")), "后台未启动");
    assert.ok(!fs.existsSync(path.join(profile.logsDir, "backend.log")), "未产生后台日志");
  } finally {
    await killDev(run);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("dev --import-models：复制后进入门禁；无效配置退出且 credentials.json 未导入", { timeout: 60_000 }, async () => {
  const home = tmpHome();
  const dir = tmpHome("ruukoto-test-import-src-");
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {} }));
  fs.writeFileSync(path.join(dir, "auth.json"), "{}");
  fs.writeFileSync(path.join(dir, "credentials.json"), "{}");
  const profile = devProfileFor(repoRoot, home);
  const run = runDev(home, ["--import-models", dir]);
  try {
    const code = await run.waitExit();
    assert.equal(code, 1, run.stderr());
    assert.ok(run.stderr().includes("已导入模型配置"), run.stderr());
    assert.ok(run.stderr().includes("未配置有效模型"), run.stderr());
    assert.ok(fs.existsSync(path.join(profile.agentDir, "models.json")));
    assert.ok(fs.existsSync(path.join(profile.agentDir, "auth.json")));
    assert.equal(fs.statSync(path.join(profile.agentDir, "models.json")).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(profile.agentDir, "credentials.json")));
  } finally {
    await killDev(run);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "dev：后台就绪（QQ 停用、环境可认证），SIGINT 后无锁无孤儿进程",
  { timeout: 180_000 },
  async () => {
    const home = tmpHome();
    const profile = devProfileFor(repoRoot, home);
    const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
    const baseUrl = await server.start();
    await writeMockModelConfig(profile.agentDir, baseUrl);
    const tokenInjection = { RUUKOTO_OWNER_TOKEN: "x".repeat(40) }; // 被清洗，不得进入子进程
    const run = runDev(home, [], tokenInjection);
    try {
      await waitFor(
        "dev 后台就绪",
        async () => probeControlPlane(path.join(profile.controlDir, "control.sock"), readOwnerToken(profile.controlDir), 800),
        120_000,
      );
      // 令牌来自档案文件（清洗后的环境），QQ 入口按 dev 标记停用
      const client = await ControlClient.connect(path.join(profile.controlDir, "control.sock"), 3000);
      try {
        await client.authenticate(readOwnerToken(profile.controlDir)!);
        const qq = await client.request<Record<string, unknown>>("qq_status", {});
        assert.equal(qq.disabledByConfig, true, "QQ 按启动配置停用");
        assert.ok(String(qq.stateDetail).includes("停用"), String(qq.stateDetail));
      } finally {
        client.close();
      }

      run.child.kill("SIGINT");
      const code = await run.waitExit();
      assert.equal(code, 0, `收到 SIGINT 后 dev 正常清理退出；dev 输出：\n${run.stderr().slice(-1500)}`);
      assert.ok(run.stderr().includes("日志"), "退出时提示日志位置");
      await waitFor("实例锁释放", () => !fs.existsSync(path.join(profile.dataDir, "runtime.lock")), 15_000);
      assert.ok(!fs.existsSync(path.join(profile.controlDir, "control.sock")), "socket 已清理");
      // 后台 pid 从 backend.log 解析：进程必须已不存在（无孤儿）
      const backendLog = fs.readFileSync(path.join(profile.logsDir, "backend.log"), "utf8");
      const pid = Number(/\(pid (\d+)\)/.exec(backendLog)?.[1]);
      assert.ok(Number.isInteger(pid) && pid > 0, `backend.log 应含后台 pid：${backendLog.slice(-300)}`);
      assert.throws(() => process.kill(pid, 0), /ESRCH/, "后台进程已退出，无孤儿");
      assert.ok(
        !(await probeControlPlane(path.join(profile.controlDir, "control.sock"), readOwnerToken(profile.controlDir), 500)),
        "控制面不再可连",
      );
    } finally {
      await killDev(run);
      await server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

test("dev：开发实例已在运行 → 报错退出且不碰外来后台", { timeout: 180_000 }, async () => {
  const home = tmpHome();
  const profile = devProfileFor(repoRoot, home);
  fs.mkdirSync(profile.dataDir, { recursive: true });
  fs.mkdirSync(profile.agentDir, { recursive: true });
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeMockModelConfig(profile.agentDir, baseUrl);
  const backend = await spawnBackend(profile.dataDir, profile.agentDir);
  const run = runDev(home);
  try {
    const code = await run.waitExit();
    assert.equal(code, 1);
    assert.ok(run.stderr().includes("已在运行"), run.stderr());
    assert.ok(
      await probeControlPlane(path.join(profile.controlDir, "control.sock"), readOwnerToken(profile.controlDir), 800),
      "外来后台仍在运行，dev 不得停止它",
    );
  } finally {
    await killDev(run);
    await killBackend(backend);
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------- TUI 重载状态（FakeTerminal 直驱 app.ts） ----------

let reloadHarnessCounter = 0;

interface ReloadHarness {
  app: TuiApp;
  state: ViewState;
  terminal: FakeTerminal;
  exitCode(): number | null;
}

async function startReloadApp(
  t: TestRuntime,
  opts: { sessionId?: string; reloadFile?: string } = {},
): Promise<ReloadHarness> {
  const state = new ViewState();
  let appRef: TuiApp | null = null;
  const connection = new ControlConnection(
    { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
    {
      onState: (s, d) => appRef?.onConnectionState(s, d),
      onSnapshot: (r, ctx) => appRef?.onSnapshot(r, ctx),
      onEvent: (e, kind) => appRef?.onEvent(e, kind),
    },
  );
  const pendingStore = new PendingRequestStore(path.join(t.dirs.root, `reload-pending-${reloadHarnessCounter++}`));
  const guard = new SubmissionGuard(pendingStore, connection);
  const terminal = new FakeTerminal();
  let exitCode: number | null = null;
  const app = new TuiApp({
    connection,
    guard,
    pendingStore,
    state,
    terminal,
    initialSessionId: opts.sessionId,
    reloadStateFile: opts.reloadFile,
    onExit: (code) => {
      exitCode = code;
    },
  });
  appRef = app;
  await app.start();
  await waitFor("TUI 上线", () => connection.state === "online");
  return { app, state, terminal, exitCode: () => exitCode };
}

async function renderFlush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

function readReloadFile(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("重载状态：草稿/会话/继续意图持久化，重开后恢复并生成带 resumes 的继续任务", { timeout: 120_000 }, async () => {
  const t = await startTestRuntime("dev-reload", async (req) => {
    const text = lastUserText(req);
    if (text.includes("长跑")) {
      await new Promise((r) => setTimeout(r, 5000));
      return { kind: "text", text: "长跑结束" };
    }
    return { kind: "text", text: `继续完成：${text}` };
  });
  const apps: ReloadHarness[] = [];
  const reloadFile = path.join(t.dirs.root, "reload-state.json");
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h1 = await startReloadApp(t, { sessionId, reloadFile });
    apps.push(h1);
    // 可中断任务 + /continue 意图 + 未发送草稿
    h1.terminal.send("长跑任务");
    h1.terminal.send("\r");
    await waitFor("任务运行", () => [...h1.state.tasks.values()][0]?.status === "running");
    h1.terminal.send("/interrupt\r");
    await waitFor("任务中断", () => [...h1.state.tasks.values()][0]?.status === "interrupted");
    const interruptedId = [...h1.state.tasks.values()][0]!.id;
    h1.terminal.send("/continue\r");
    await renderFlush();
    h1.terminal.send("重载前的草稿");
    await new Promise((r) => setTimeout(r, 450)); // 超过防抖窗口
    h1.app.quit(0);
    await waitFor("h1 退出", () => h1.exitCode() === 0);

    const saved = readReloadFile(reloadFile);
    assert.equal(saved.kind, "task-tui");
    assert.equal(saved.instanceId, h1.state.instanceId);
    assert.equal(saved.sessionId, sessionId);
    assert.equal(saved.draft, "重载前的草稿");
    assert.equal(saved.continueForTaskId, interruptedId);

    // 重开（等价 dev 前端重启）：会话/草稿/继续意图恢复
    const h2 = await startReloadApp(t, { reloadFile });
    apps.push(h2);
    await waitFor("继续模式已恢复", () => h2.terminal.output().includes("已恢复继续模式"));
    assert.equal(h2.state.currentSessionId, sessionId);
    assert.equal((h2.app as any).editor.getText(), "重载前的草稿");

    h2.terminal.send("\r"); // 提交恢复的草稿：走继续路径
    await waitFor("继续任务创建", () => [...h2.state.tasks.values()].length === 2);
    const continued = [...h2.state.tasks.values()][1]!;
    assert.equal(continued.resumesTaskId, interruptedId, "恢复后继续提交生成带 resumes 的任务");
    h2.app.quit(0);
    await waitFor("h2 退出", () => h2.exitCode() === 0);
  } finally {
    for (const h of apps) h.app.quit(0);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("重载状态：instanceId 不符 → 失效提示并按正常入口启动", { timeout: 120_000 }, async () => {
  const t = await startTestRuntime("dev-reload-stale", async () => ({ kind: "text", text: "x" }));
  const apps: ReloadHarness[] = [];
  const reloadFile = path.join(t.dirs.root, "reload-state.json");
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    fs.writeFileSync(
      reloadFile,
      JSON.stringify({
        kind: "task-tui",
        instanceId: "inst_其他实例",
        sessionId,
        draft: "不应恢复的草稿",
        continueForTaskId: null,
        updatedAt: new Date().toISOString(),
      }),
    );
    const h = await startReloadApp(t, { reloadFile });
    apps.push(h);
    // 未选择会话时提示走 globalNotes（app.notify 的既有无会话通道，不上屏渲染）
    await waitFor("失效提示", () => h.state.globalNotes.some((n) => n.text.includes("重载恢复记录已失效")));
    await renderFlush();
    assert.equal(h.state.currentSessionId, null, "按正常入口：进入会话选择而不是恢复会话");
    assert.notEqual((h.app as any).editor.getText(), "不应恢复的草稿");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    for (const h of apps) h.app.quit(0);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("重载状态：继续目标任务已结束 → 意图丢弃并提示，草稿保留，提交仍是新任务", { timeout: 120_000 }, async () => {
  const t = await startTestRuntime("dev-reload-done", async (req) => ({ kind: "text", text: `done:${lastUserText(req)}` }));
  const apps: ReloadHarness[] = [];
  const reloadFile = path.join(t.dirs.root, "reload-state.json");
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h1 = await startReloadApp(t, { sessionId, reloadFile });
    apps.push(h1);
    h1.terminal.send("快速任务");
    h1.terminal.send("\r");
    await waitFor("任务完成", () => [...h1.state.tasks.values()][0]?.status === "completed");
    const completedId = [...h1.state.tasks.values()][0]!.id;
    h1.app.quit(0);
    await waitFor("h1 退出", () => h1.exitCode() === 0);

    // 模拟过期记录：意图指向已完成的任务（正常途径不会留下这种组合）
    fs.writeFileSync(
      reloadFile,
      JSON.stringify({
        kind: "task-tui",
        instanceId: h1.state.instanceId,
        sessionId,
        draft: "保留的草稿",
        continueForTaskId: completedId,
        updatedAt: new Date().toISOString(),
      }),
    );
    const h2 = await startReloadApp(t, { reloadFile });
    apps.push(h2);
    await waitFor("丢弃意图提示", () => h2.terminal.output().includes("继续目标任务已不存在或已结束"));
    assert.equal(h2.state.currentSessionId, sessionId);
    assert.equal((h2.app as any).editor.getText(), "保留的草稿", "草稿保留");

    h2.terminal.send("\r");
    await waitFor("新任务创建", () => [...h2.state.tasks.values()].length === 2);
    const created = [...h2.state.tasks.values()][1]!;
    assert.equal(created.resumesTaskId, null, "意图已丢弃：按普通新任务提交");
    assert.notEqual(created.id, completedId);
    h2.app.quit(0);
    await waitFor("h2 退出", () => h2.exitCode() === 0);
  } finally {
    for (const h of apps) h.app.quit(0);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

// ---------- PTY 端到端 ----------

function hasPython3(): boolean {
  try {
    execFileSync("python3", ["-c", "import pty"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** npm run dev 的 PTY 驱动（进程组隔离，超时可整组回收）。 */
const PTY_DRIVER = `
import os, pty, select, struct, fcntl, termios, signal, subprocess, sys, time, json

argv = json.loads(sys.argv[1])
cmd = argv["cmd"]
env = dict(os.environ, **argv["env"])
inputs = argv["inputs"]
expect = argv["expect"]
timeout = argv.get("timeout", 150)

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True, preexec_fn=os.setsid)
os.close(slave)

collected = b""
deadline = time.time() + timeout
expect_idx = 0
input_idx = 0
start = time.time()

def elapsed():
    return time.time() - start

while time.time() < deadline:
    while input_idx < len(inputs) and elapsed() >= inputs[input_idx][0]:
        os.write(master, inputs[input_idx][1].encode("utf-8"))
        input_idx += 1
    r, _, _ = select.select([master], [], [], 0.1)
    if master in r:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        collected += chunk
        text = collected.decode("utf-8", errors="replace")
        while expect_idx < len(expect) and expect[expect_idx] in text:
            expect_idx += 1
    if proc.poll() is not None:
        break

for _ in range(50):
    if proc.poll() is not None:
        break
    r, _, _ = select.select([master], [], [], 0.2)
    if master in r:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        collected += chunk

if proc.poll() is None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        proc.kill()
try:
    while True:
        chunk = os.read(master, 65536)
        if not chunk:
            break
        collected += chunk
except OSError:
    pass
os.close(master)
exit_code = proc.wait()

text = collected.decode("utf-8", errors="replace")
print(json.dumps({
    "exitCode": exit_code,
    "expectSeen": expect_idx,
    "expectTotal": len(expect),
    "tail": text[-3000:],
    "all": text,
}))
`;

interface PtyResult {
  exitCode: number;
  expectSeen: number;
  expectTotal: number;
  tail: string;
  all: string;
}

async function runDevTuiInPty(opts: {
  env: Record<string, string>;
  inputs: Array<[number, string]>;
  expect: string[];
  timeout?: number;
}): Promise<PtyResult> {
  const payload = JSON.stringify({
    cmd: ["npm", "run", "dev", "--", "--tui"],
    env: opts.env,
    inputs: opts.inputs,
    expect: opts.expect,
    timeout: opts.timeout ?? 150,
  });
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", PTY_DRIVER, payload], { cwd: repoRoot });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").at(-1)!) as PtyResult);
      } catch (e) {
        reject(new Error(`PTY 驱动输出解析失败：${(e as Error).message}\nstderr: ${err}\nstdout: ${out.slice(-2000)}`));
      }
    });
    child.on("error", reject);
  });
}

test("PTY：npm run dev -- --tui，/quit 后 dev 退出、终端恢复、日志不交错、无残留进程", { timeout: 300_000 }, async (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const home = tmpHome();
  const profile = devProfileFor(repoRoot, home);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeMockModelConfig(profile.agentDir, baseUrl);
  try {
    const result = await runDevTuiInPty({
      env: { HOME: home },
      inputs: [
        [40, "\x1b"], // 关闭会话选择（若已打开）
        [42, "你好，dev"],
        [43, "\r"],
        [45, "\x1b"], // 兜底：关掉可能被再次打开的选择面板，焦点回输入框
        [47, "/quit\r"],
      ],
      expect: ["已退出 TUI"],
      timeout: 150,
    });
    assert.equal(result.expectSeen, result.expectTotal, `未看到退出提示：${result.tail}`);
    assert.equal(result.exitCode, 0, `dev 应随前端退出（退出码 0）；tail：${result.tail}`);
    assert.ok(result.all.includes("\x1b[?1049l"), "退出时离开 alt screen（终端恢复）");
    await waitFor("实例锁释放", () => !fs.existsSync(path.join(profile.dataDir, "runtime.lock")), 20_000);
    const backendLogPath = path.join(profile.logsDir, "backend.log");
    assert.ok(fs.existsSync(backendLogPath), "后台日志已写入档案 logs");
    const backendLog = fs.readFileSync(backendLogPath, "utf8");
    assert.ok(backendLog.includes("后台已启动"), "后台日志含启动记录");
    assert.ok(!result.all.includes("后台已启动"), "后台日志不混入终端输出");
    const pid = Number(/\(pid (\d+)\)/.exec(backendLog)?.[1]);
    assert.ok(Number.isInteger(pid) && pid > 0, `backend.log 应含后台 pid：${backendLog.slice(-300)}`);
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "后台进程已随 dev 退出，无残留");
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
