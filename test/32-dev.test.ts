/** Development profile, child ownership and real PTY lifecycle regressions. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { FakeTerminal } from "./helpers/fake-terminal.ts";
import {
  buildChildEnv,
  classifyWatchPath,
  planWatchRestart,
  devProfileFor,
  parseDevArgs,
} from "@ruukoto/tui/dev.ts";
import { bootstrapProfile, selectionTuple, selectProfile, type ProfilePaths } from "@ruukoto/core/profile.ts";
import { probeControlPlane } from "@ruukoto/control/ensure-backend.ts";
import { ControlClient } from "@ruukoto/control/client.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { TuiApp } from "@ruukoto/tui/tui/app.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { killBackend, spawnBackend } from "./helpers/backend.ts";
import {
  cleanupDirs,
  createProjectSession,
  lastUserText,
  startTestRuntime,
  waitFor,
  writeModelsJson,
  type TestRuntime,
} from "./helpers/testkit.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpHome(prefix = "rk-dev-"): string {
  return fs.mkdtempSync(path.join("/tmp", prefix));
}

/** 在档案 agent 目录写入指向 MockModelServer 的有效模型配置。 */
async function writeMockModelConfig(agentDir: string, baseUrl: string): Promise<void> {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  await writeModelsJson({ agentDir }, baseUrl);
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
  const entry = "apps/ruukoto/src/dev.ts";
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
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

function assertCodeBackendStopped(profile: ProfilePaths): void {
  for (const lock of [path.join(profile.dataDir, "runtime.lock"), path.join(profile.agentDir, "config.lock")]) {
    assert.ok(!fs.existsSync(lock), `退出后释放 ${lock}`);
  }
  assert.ok(!fs.existsSync(profile.socketPath), "退出后清理控制面 socket");
  const backendLog = fs.readFileSync(profile.backendLogPath, "utf8");
  assert.ok(backendLog.includes("后台已启动"), "后台日志含启动记录");
  const pid = Number(/\(pid (\d+)\)/.exec(backendLog)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, `backend.log 应含后台 pid：${backendLog.slice(-300)}`);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "后台进程随开发入口退出，无残留");
  const db = new DatabaseSync(path.join(profile.dataDir, "ruukoto.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'product.type'").get()!.value, "ruukoto");
    const started = db.prepare("SELECT body FROM events").all().map((row) => JSON.parse(String(row.body))).find((event) => event.type === "backend.started");
    assert.equal(started?.product, "ruukoto");
    assert.equal(started?.executionBackend, "native", "code 沿用产品默认执行后端");
  } finally {
    db.close();
  }
}

// ---------- 单元 ----------

test("checkout raw selection is stable, isolated and round trips through child environment", async t => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const selection = devProfileFor(repoRoot, home);
  assert.deepEqual(selection, devProfileFor(repoRoot, home));
  assert.ok(selection.dataDir.includes(".ruukoto-dev"));
  const profile = await bootstrapProfile(selection);
  const env = buildChildEnv({ PATH: "/usr/bin", RUUKOTO_OWNER_TOKEN: "daily", RUUKOTO_OWNER_TOKEN_FILE: "/daily/token", RUUKOTO_EXECUTION_BACKEND: "local", RUUKOTO_DATA_DIR: "/daily/data", RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_DESKTOP_DEV_NONCE: "daily" }, profile);
  assert.deepEqual(selectionTuple(selectProfile({}, env, home)), selectionTuple(selection));
  assert.equal(env.PATH, "/usr/bin");
  for (const key of ["RUUKOTO_OWNER_TOKEN", "RUUKOTO_OWNER_TOKEN_FILE", "RUUKOTO_EXECUTION_BACKEND", "RUUKOTO_DESKTOP_MANAGED", "RUUKOTO_DESKTOP_DEV_NONCE"]) assert.equal(env[key], undefined);
  assert.notEqual(profile.dataDir, selection.dataDir);
});

test("监听分类：tui / config-tui / backend / both / self", () => {
  assert.equal(classifyWatchPath("packages/tui/src/dev.ts"), "self");
  assert.equal(classifyWatchPath("apps/ruukoto/src/dev.ts"), "self");
  assert.equal(classifyWatchPath("apps/desktop/src/main/index.ts"), null);
  assert.equal(classifyWatchPath("apps/desktop/src/preload/index.ts"), null);
  assert.equal(classifyWatchPath("apps/desktop/src/renderer/App.tsx"), null);
  assert.equal(classifyWatchPath("apps/desktop/src/dev.ts"), null);
  assert.equal(classifyWatchPath("packages/tui/src/tui/app.ts"), "tui");
  assert.equal(classifyWatchPath("packages/tui/src/tui/state.ts"), "tui");
  assert.equal(classifyWatchPath("packages/view/src/event-flow.ts"), "tui");
  assert.equal(classifyWatchPath("packages/tui/src/config-tui/index.ts"), "config-tui");
  assert.equal(classifyWatchPath("packages/tui/src/config-tui/panels/models.ts"), "config-tui");
  assert.equal(classifyWatchPath("apps/ruukoto/src/main.ts"), "backend");
  assert.equal(classifyWatchPath("packages/tui/src/cli.ts"), "backend");
  assert.equal(classifyWatchPath("packages/runtime/src/runtime.ts"), "backend");
  assert.equal(classifyWatchPath("packages/agent/src/model-config.ts"), "backend");
  assert.equal(classifyWatchPath("packages/channels/src/scheduler/time.ts"), "backend");
  assert.equal(classifyWatchPath("packages/control/src/server.ts"), "both");
  assert.equal(classifyWatchPath("packages/core/src/types.ts"), "both");
  assert.equal(classifyWatchPath("packages/tui/src/cli-entry.ts"), "both");
  assert.equal(classifyWatchPath("packages/tui/src/index.ts"), "both");
  assert.equal(classifyWatchPath("packages/tui/src/tui/app.js"), null, "只盯 .ts");
  assert.equal(classifyWatchPath("test/32-dev.test.ts"), null, "监听范围外");
  assert.equal(classifyWatchPath("README.md"), null);
});

test("重启计划：后台变更只重启后台；配置中心不重连，随后台一并重载", () => {
  assert.deepEqual(planWatchRestart(["backend"], "tui"), { backend: true, frontend: false }, "任务界面自动重连");
  assert.deepEqual(planWatchRestart(["backend"], "config"), { backend: true, frontend: true });
  assert.deepEqual(planWatchRestart(["backend"], null), { backend: true, frontend: false });
  assert.deepEqual(planWatchRestart(["tui"], "config"), { backend: false, frontend: false });
  assert.deepEqual(planWatchRestart(["tui"], "tui"), { backend: false, frontend: true });
  assert.deepEqual(planWatchRestart(["config-tui"], "config"), { backend: false, frontend: true });
  assert.deepEqual(planWatchRestart(["both"], "tui"), { backend: true, frontend: true });
  for (const actions of [["backend"], ["both"]] as const) {
    assert.deepEqual(planWatchRestart([...actions], "desktop"), { backend: true, frontend: false });
  }
  assert.deepEqual(planWatchRestart(["tui"], "desktop"), { backend: false, frontend: false });
  assert.deepEqual(planWatchRestart(["config-tui"], "desktop"), { backend: false, frontend: false });
});

test("dev selects TUI, configuration or desktop without product switches", () => {
  assert.deepEqual(parseDevArgs([]), { tui: true, config: false, desktop: false, workspacePath: undefined });
  assert.equal(parseDevArgs(["--config"]).config, true);
  assert.equal(parseDevArgs(["--desktop"]).desktop, true);
  assert.equal(parseDevArgs(["../my project"]).workspacePath, "../my project");
  assert.equal(parseDevArgs(["--", "--config"]).workspacePath, "--config");
  for (const args of [["--desktop", "--config"], ["--config", "/work"], ["--desktop", "/work"], ["a", "b"], ["--tui"], ["--import-models", "/old"]]) assert.throws(() => parseDevArgs(args));
});

// ---------- 集成（真实仓库 + HOME=临时目录） ----------

test("桌面开发入口：清洗档案环境、每次生成 nonce；退出前端或启动器都清理整组进程", { timeout: 180_000 }, async () => {
  const home = tmpHome();
  const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  const binDir = path.join(home, "bin");
  const fixtureLog = path.join(home, "desktop.jsonl");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "electron-vite"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const log = (record) => fs.appendFileSync(process.env.DESKTOP_FIXTURE_LOG, JSON.stringify(record) + "\\n");
const electron = spawn(process.execPath, ["-e", \`
const fs = require("node:fs");
const log = (kind) => fs.appendFileSync(process.env.DESKTOP_FIXTURE_LOG, JSON.stringify({ kind, pid: process.pid }) + "\\\\n");
process.on("SIGTERM", () => { log("electron-stopped"); process.exit(0); });
log("electron");
setInterval(() => {}, 1000);
\`], { stdio: "ignore" });
let stopping = false;
electron.on("exit", () => { if (stopping) process.exit(0); });
process.on("SIGTERM", () => {
  stopping = true;
  if (electron.exitCode !== null || electron.signalCode !== null) process.exit(0);
});
process.on("SIGUSR2", () => { electron.unref(); process.exit(0); });
log({ kind: "vite", pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(),
  dataDir: process.env.RUUKOTO_DATA_DIR,
  controlDir: process.env.RUUKOTO_CONTROL_DIR, ownerToken: process.env.RUUKOTO_OWNER_TOKEN,
  managed: process.env.RUUKOTO_DESKTOP_MANAGED, nonce: process.env.RUUKOTO_DESKTOP_DEV_NONCE });
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  type FixtureRecord = { kind: string; pid: number; argv?: string[]; cwd?: string; product?: string; dataDir?: string; controlDir?: string; ownerToken?: string; managed?: string; nonce?: string };
  const records = (): FixtureRecord[] => fs.existsSync(fixtureLog)
    ? fs.readFileSync(fixtureLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as FixtureRecord)
    : [];
  const nonces: string[] = [];
  try {
    await writeMockModelConfig(profile.agentDir, baseUrl);
    for (const exit of ["launcher", "frontend"] as const) {
      fs.rmSync(fixtureLog, { force: true });
      const run = runDev(home, ["--desktop"], {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DESKTOP_FIXTURE_LOG: fixtureLog,
        RUUKOTO_DATA_DIR: "/daily/data",
        RUUKOTO_CONTROL_DIR: "/daily/control",
        RUUKOTO_OWNER_TOKEN: "daily-token",
        RUUKOTO_DESKTOP_DEV_NONCE: "inherited-nonce",
      });
      let vitePid: number | undefined;
      try {
        await waitFor("桌面替身与 Electron 子进程已启动", () => {
          if (run.child.exitCode !== null) throw new Error(run.stderr());
          return records().some(row => row.kind === "vite") && records().some(row => row.kind === "electron");
        }, 120_000);
        const vite = records().find(row => row.kind === "vite")!;
        vitePid = vite.pid;
        assert.deepEqual(vite.argv, ["dev", "--watch"]);
        assert.equal(vite.cwd, fs.realpathSync(path.join(repoRoot, "apps", "desktop")));
        assert.equal(vite.dataDir, profile.selection.dataDir);
        assert.equal(vite.controlDir, profile.selection.controlDir);
        assert.equal(vite.ownerToken, undefined);
        assert.equal(vite.managed, "1");
        assert.ok(vite.nonce && vite.nonce !== "inherited-nonce");
        assert.equal(Buffer.from(vite.nonce, "base64url").length, 24);
        assert.match(vite.nonce, /^[A-Za-z0-9_-]{32}$/);
        nonces.push(vite.nonce);
        if (exit === "launcher") run.child.kill("SIGINT");
        else process.kill(vite.pid, "SIGUSR2");
        assert.equal(await run.waitExit(), 0, run.stderr());
        assert.ok(records().some(row => row.kind === "electron-stopped"), "退出时通知 Electron 子进程，不能只停 electron-vite");
        assert.throws(() => process.kill(vite.pid, 0), /ESRCH/, "electron-vite 已退出");
        assertCodeBackendStopped(profile);
      } finally {
        if (vitePid !== undefined) {
          try {
            process.kill(-vitePid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") process.stderr.write(`[ruukoto:test] 桌面替身进程组清理失败：${String(error)}\n`);
          }
        }
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill("SIGTERM");
          await run.waitExit();
        }
        await killDev(run);
      }
    }
    assert.equal(new Set(nonces).size, 2, "每次启动前端使用新的 nonce");
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

{
  for (const flag of ["--tui", "--nope"]) {
    test(`development rejects ${flag} before storage`, { timeout: 60_000 }, async () => {
      const home = tmpHome();
      const run = runDev(home, [flag]);
      try {
        assert.equal(await run.waitExit(), 1);
        assert.ok(run.stderr().includes("参数错误"), run.stderr());
        assert.ok(!fs.existsSync(path.join(home, ".ruukoto-dev")), "dev 档案未被创建");
      } finally {
        await killDev(run);
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("development without a model leaves a recoverable profile but no backend", { timeout: 60_000 }, async () => {
    const home = tmpHome();
    const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
    const run = runDev(home);
    try {
      assert.equal(await run.waitExit(), 1);
      assert.ok(run.stderr().includes("未配置有效模型"), run.stderr());
      assert.ok(run.stderr().includes("npm run dev -- --config"), run.stderr());
      assert.ok(!fs.existsSync(profile.socketPath), "后台未启动");
      assert.ok(!fs.existsSync(profile.backendLogPath), "未产生后台日志");
    } finally {
      await killDev(run);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}


test("code：开发实例已在运行 → 报错退出且不碰外来后台", { timeout: 180_000 }, async () => {
  const home = tmpHome();
  const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
  fs.mkdirSync(profile.dataDir, { recursive: true });
  fs.mkdirSync(profile.agentDir, { recursive: true });
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  let backend: Awaited<ReturnType<typeof spawnBackend>> | undefined;
  let run: DevRun | undefined;
  try {
    const baseUrl = await server.start();
    await writeMockModelConfig(profile.agentDir, baseUrl);
    backend = await spawnBackend(profile);
    run = runDev(home);
    const code = await run.waitExit();
    assert.equal(code, 1);
    assert.ok(run.stderr().includes("已在运行"), run.stderr());
    assert.ok(
      await probeControlPlane(profile, readOwnerToken(profile.controlDir), 800),
      "外来后台仍在运行，dev 不得停止它",
    );
  } finally {
    if (run) await killDev(run);
    if (backend) await killBackend(backend);
    await server.close();
    await cleanupDirs({ root: home, profile });
  }
});

test("code：有效模型但非 TTY 时非零退出并清理后台", { timeout: 120_000 }, async () => {
  const home = tmpHome();
  const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeMockModelConfig(profile.agentDir, baseUrl);
  const run = runDev(home);
  try {
    assert.equal(await run.waitExit(), 1, run.stderr());
    assert.match(run.stderr(), /TUI 需要交互式终端/);
    assertCodeBackendStopped(profile);
  } finally {
    await killDev(run);
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("code --config：已有 socket 即拒绝接管，不等认证或把停止中的后台重复拉起", { timeout: 30_000 }, async () => {
  const home = tmpHome();
  const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
  const sockets = new Set<net.Socket>();
  let accepted = false;
  const stalled = net.createServer((socket) => {
    sockets.add(socket);
    accepted = true;
  });
  await new Promise<void>((resolve) => stalled.listen(profile.socketPath, resolve));
  const run = runDev(home, ["--config"]);
  try {
    assert.equal(await run.waitExit(), 1, run.stderr());
    assert.equal(accepted, true);
    assert.match(run.stderr(), /已在运行/);
    assert.ok(!run.stderr().includes("先打开离线配置中心"), run.stderr());
    assert.ok(!run.stderr().includes("配置中心需要交互式终端"), "终止后不派生配置进程");
    assert.ok(!fs.existsSync(path.join(profile.agentDir, "config.lock")), "未启动离线配置或留下配置锁");
    assert.ok(!fs.existsSync(profile.backendLogPath), "未启动后台");
  } finally {
    await killDev(run);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => stalled.close(() => resolve()));
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
  opts: { sessionId?: string; reloadFile?: string; workspace?: { path: string } } = {},
): Promise<ReloadHarness> {
  const state = new ViewState();
  let appRef: TuiApp | null = null;
  const connection = new ControlConnection(
    { profile: t.dirs.profile, token: readOwnerToken(t.runtime.controlDir())! },
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
    workspace: opts.workspace,
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

test("工作区入口重载：无参恢复原会话与草稿，不再次创建会话", { timeout: 60_000 }, async () => {
  const t = await startTestRuntime("dev-workspace-reload", async () => ({ kind: "text", text: "ok" }));
  const reloadFile = path.join(t.dirs.root, "reload-state.json");
  const apps: ReloadHarness[] = [];
  try {
    const first = await startReloadApp(t, { workspace: { path: t.work[0]! }, reloadFile });
    apps.push(first);
    await waitFor("工作区会话已创建", () => first.state.currentSessionId !== null);
    const sessionId = first.state.currentSessionId;
    const count = first.state.sessions.length;
    first.terminal.send("工作区草稿");
    first.app.quit(0);
    await waitFor("首次界面退出", () => first.exitCode() === 0);

    const restored = await startReloadApp(t, { reloadFile });
    apps.push(restored);
    await waitFor("会话与草稿已恢复", () => restored.state.currentSessionId === sessionId && (restored.app as any).editor.getText() === "工作区草稿");
    assert.equal(restored.state.sessions.length, count);
  } finally {
    for (const h of apps) h.app.quit(0);
    await t.shutdown();
  }
});

test("重载状态：暂停后恢复普通草稿，退出后的迟到应答不重启动画", { timeout: 120_000 }, async context => {
  let releaseModel!: () => void, releaseReply!: () => void;
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
  let replyReady = false;
  const submit = SubmissionGuard.prototype.submit;
  context.mock.method(SubmissionGuard.prototype, "submit", async function (this: SubmissionGuard, ...args: Parameters<SubmissionGuard["submit"]>) {
    const result = await submit.apply(this, args);
    if (args[0] === "submit" && args[1].input === "重载前的草稿") { replyReady = true; await replyGate; }
    return result;
  });
  const t = await startTestRuntime("dev-reload", async (req) => {
    const text = lastUserText(req);
    if (text.includes("长跑")) {
      await new Promise((r) => setTimeout(r, 5000));
      return { kind: "text", text: "长跑结束" };
    }
    await modelGate;
    return { kind: "text", text: `继续完成：${text}` };
  });
  const apps: ReloadHarness[] = [];
  const reloadFile = path.join(t.dirs.root, "reload-state.json");
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h1 = await startReloadApp(t, { sessionId, reloadFile });
    apps.push(h1);
    // A paused conversation preserves an ordinary unsent draft.
    h1.terminal.send("长跑任务");
    h1.terminal.send("\r");
    await waitFor("任务运行", () => [...h1.state.tasks.values()][0]?.status === "running");
    h1.terminal.send("/interrupt\r");
    await waitFor("任务中断", () => [...h1.state.tasks.values()][0]?.status === "interrupted");
    const interruptedId = [...h1.state.tasks.values()][0]!.id;
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
    assert.equal(saved.continueForTaskId, undefined);

    // Reload restores the conversation and draft without executable continuation intent.
    const h2 = await startReloadApp(t, { reloadFile });
    apps.push(h2);
    await waitFor("普通草稿已恢复", () => (h2.app as any).editor.getText() === "重载前的草稿");
    assert.equal(h2.state.currentSessionId, sessionId);
    assert.equal((h2.app as any).editor.getText(), "重载前的草稿");

    await t.client.request("resume_queue", { session_id: sessionId });
    h2.terminal.send("\r"); // Submit the restored draft as a new Task.
    await waitFor("继续任务运行且应答尚未交回", () => replyReady && [...h2.state.tasks.values()][1]?.status === "running");
    const continued = [...h2.state.tasks.values()][1]!;
    assert.equal(continued.resumesTaskId, null, "恢复草稿提交新任务");
    h2.app.quit(0);
    await waitFor("h2 退出", () => h2.exitCode() === 0);
    releaseReply();
    await waitFor("退出后提交处理完毕", () => !h2.app["submitting"]);
    assert.equal(h2.app["timingTimer"], null, "迟到应答不能重新持有运行中动画计时器");
    assert.equal(t.runtime.store.getTask(continued.id)!.status, "running", "退出客户端不停止后台任务");
    releaseModel();
    await waitFor("后台独立完成继续任务", () => t.runtime.store.getTask(continued.id)?.status === "completed");
  } finally {
    releaseReply(); releaseModel();
    for (const h of apps) {
      h.app.quit(0);
      // 回归失败时也回收重新出现的句柄，让断言失败能正常退出。
      if (h.app["timingTimer"]) clearInterval(h.app["timingTimer"]);
    }
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
    await waitFor("旧继续字段不影响草稿恢复", () => (h2.app as any).editor.getText() === "保留的草稿");
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

/** 开发入口的 PTY 驱动（看到界面标记再输入，进程组隔离，超时可整组回收）。 */
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
while time.time() < deadline:
    text = collected.decode("utf-8", errors="replace")
    while input_idx < len(inputs) and inputs[input_idx][0] in text:
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
while expect_idx < len(expect) and expect[expect_idx] in text:
    expect_idx += 1
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

async function runCodeInPty(opts: {
  env: Record<string, string>;
  args?: string[];
  inputs: Array<[string, string]>;
  expect: string[];
  timeout?: number;
}): Promise<PtyResult> {
  const payload = JSON.stringify({
    cmd: ["npm", "run", "dev", ...(opts.args?.length ? ["--", ...opts.args] : [])],
    env: opts.env,
    inputs: opts.inputs,
    expect: opts.expect,
    timeout: opts.timeout ?? 60,
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

test("PTY：npm run dev 默认 TUI，/quit 后退出、终端恢复、日志不交错、无残留进程", { timeout: 90_000 }, async (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const home = tmpHome();
  const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeMockModelConfig(profile.agentDir, baseUrl);
  try {
    const result = await runCodeInPty({
      env: { HOME: home },
      inputs: [["开始新对话", "\r"], ["发送消息开始对话。", "/quit\r"]],
      expect: ["No workspace", "发送消息开始对话。", "连接：在线", "已退出 TUI"],
    });
    assert.equal(result.expectSeen, result.expectTotal, `Missing startup or exit prompt: ${result.tail}`);
    assert.equal(result.exitCode, 0, `Code exits with its frontend; tail: ${result.tail}`);
    assert.ok(result.all.includes("\x1b[?1049l"), "Exit restores the terminal from the alternate screen");
    assert.ok(!result.all.includes("后台已启动"), "Backend logs stay out of terminal output");
    assertCodeBackendStopped(profile);
    assert.deepEqual(fs.existsSync(profile.workspaceDir) ? fs.readdirSync(profile.workspaceDir) : [], [], "Abandoning the draft creates no managed workspace");
    const db = new DatabaseSync(path.join(profile.dataDir, "ruukoto.db"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM projects WHERE root_real IS NOT NULL").get()!.count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()!.count, 0);
    } finally { db.close(); }
    assert.ok(!fs.existsSync(path.join(home, ".ruukoto")), "Development leaves daily storage untouched");
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PTY：code 相对路径含空格时创建工作区，重新启动复用工作区并新建会话", { timeout: 90_000 }, async (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const home = tmpHome();
  const workDir = path.join(home, "my project");
  fs.mkdirSync(workDir);
  const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeMockModelConfig(profile.agentDir, baseUrl);
  try {
    let workspaceId: string | undefined;
    for (let count = 1; count <= 2; count++) {
      const result = await runCodeInPty({
        env: { HOME: home },
        args: [path.relative(repoRoot, workDir)],
        inputs: [[" · 会话 ", "/quit\r"]],
        expect: [" · 会话 ", "已退出 TUI"],
      });
      assert.equal(result.expectSeen, result.expectTotal, result.tail);
      assert.equal(result.exitCode, 0, result.tail);
      assertCodeBackendStopped(profile);
      const db = new DatabaseSync(path.join(profile.dataDir, "ruukoto.db"), { readOnly: true });
      try {
        const workspaces = db.prepare("SELECT id, root_cwd, root_real FROM projects WHERE root_real IS NOT NULL").all();
        assert.equal(workspaces.length, 1, "相同目录仅创建一个工作区");
        const workspace = workspaces[0];
        assert.equal(workspace.root_cwd, workDir);
        assert.equal(workspace.root_real, fs.realpathSync(workDir));
        if (workspaceId) assert.equal(workspace.id, workspaceId, "重新启动复用工作区");
        workspaceId = String(workspace.id);
        const sessions = db.prepare("SELECT cwd, cwd_real FROM sessions WHERE project_id = ?").all(workspaceId);
        assert.equal(sessions.length, count, "每次独立启动创建一个新会话");
        for (const session of sessions) {
          assert.equal(session.cwd, workDir);
          assert.equal(session.cwd_real, fs.realpathSync(workDir));
        }
      } finally {
        db.close();
      }
    }
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PTY：npm run dev -- --config 打开在线配置中心，退出时停开发后台", { timeout: 90_000 }, async (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const home = tmpHome();
  const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeMockModelConfig(profile.agentDir, baseUrl);
  try {
    const result = await runCodeInPty({
      env: { HOME: home },
      args: ["--config"],
      inputs: [["配置分区", "\x1b"]],
      expect: ["配置中心（在线", "配置分区", "已退出配置中心"],
    });
    assert.equal(result.expectSeen, result.expectTotal, result.tail);
    assert.equal(result.exitCode, 0, result.tail);
    assert.ok(!result.all.includes("后台已启动"), "后台日志不混入配置界面");
    assert.ok(!result.all.includes("先打开离线配置中心"), "已有有效模型直接进入在线配置");
    assertCodeBackendStopped(profile);
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PTY：code 首次 --config 进入离线配置，放弃后不启动后台且释放配置锁", { timeout: 90_000 }, async (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const home = tmpHome();
  const profile = await bootstrapProfile(devProfileFor(repoRoot, home));
  try {
    const result = await runCodeInPty({
      env: { HOME: home },
      args: ["--config"],
      inputs: [["配置分区（离线模式", "\x1b"]],
      expect: ["先打开离线配置中心", "配置中心（离线", "已退出配置中心", "未启动后台"],
    });
    assert.equal(result.expectSeen, result.expectTotal, result.tail);
    assert.equal(result.exitCode, 1, "放弃首次模型配置后不能声称启动成功");
    assert.ok(!fs.existsSync(path.join(profile.agentDir, "config.lock")), "离线配置退出释放锁");
    assert.ok(!fs.existsSync(profile.socketPath), "后台未启动");
    assert.ok(!fs.existsSync(profile.backendLogPath), "未产生后台日志");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
