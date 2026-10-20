/**
 * dev 启动器（issue 21 §1/§5）测试：
 *
 * - 单元：档案路径（稳定/按仓库区分/仓库外/随 HOME 覆盖）、子进程环境清洗、
 *   双产品隔离、监听分类矩阵、参数解析（移除 --tui）、模型配置导入；
 * - 集成（真实仓库 + HOME=临时目录，档案落在临时目录内）：
 *   普通 dev 启动就绪（清洗后环境可认证握手、QQ 停用标记生效）与 SIGINT 清理
 *   （无残留锁/孤儿进程）；已在运行拒绝且不碰外来后台；无有效模型直接失败；
 *   --import-models 只复制 models.json/auth.json（0600）；
 * - TUI 重载状态（FakeTerminal 直驱 app.ts）：草稿/会话/继续意图持久化与恢复、
 *   instanceId 篡改失效回落、继续目标任务已结束时丢弃意图（草稿保留，提交仍是新任务）；
 * - PTY（python3 + pty，无 python3 跳过）：npm run code 默认 TUI 与在线/首次离线
 *   配置中心；退出后启动器收尾、终端恢复、后台日志不与终端交错、子进程无残留。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
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
  importModelConfigs,
  parseDevArgs,
  probeControlPlane,
} from "@ruukoto/tui/dev.ts";
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
  createProjectSession,
  lastUserText,
  startTestRuntime,
  waitFor,
  writeModelsJson,
  type TestRuntime,
} from "./helpers/testkit.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpHome(prefix = "rk-dev-"): string {
  // macOS Unix socket 路径上限约 104 字符：os.tmpdir()（/var/folders/…）下的
  // 档案 control.sock 会超限（listen EINVAL）；克隆目录名也占长度，HOME 前缀保持短。
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

function runDev(home: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, product: "ruukoto-code" = "ruukoto-code"): DevRun {
  const entry = `apps/${product}/src/dev.ts`;
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

function assertCodeBackendStopped(profile: ReturnType<typeof devProfileFor>): void {
  for (const lock of [path.join(profile.dataDir, "runtime.lock"), path.join(profile.agentDir, "config.lock")]) {
    assert.ok(!fs.existsSync(lock), `退出后释放 ${lock}`);
  }
  assert.ok(!fs.existsSync(path.join(profile.controlDir, "control.sock")), "退出后清理控制面 socket");
  const backendLog = fs.readFileSync(path.join(profile.logsDir, "backend.log"), "utf8");
  assert.ok(backendLog.includes("后台已启动"), "后台日志含启动记录");
  const pid = Number(/\(pid (\d+)\)/.exec(backendLog)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, `backend.log 应含后台 pid：${backendLog.slice(-300)}`);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "后台进程随开发入口退出，无残留");
  const db = new DatabaseSync(path.join(profile.dataDir, "ruukoto.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'product.type'").get()!.value, "ruukoto-code");
    const started = db.prepare("SELECT body FROM events").all().map((row) => JSON.parse(String(row.body))).find((event) => event.type === "backend.started");
    assert.equal(started?.product, "ruukoto-code");
    assert.equal(started?.executionBackend, "native", "code 沿用产品默认执行后端");
  } finally {
    db.close();
  }
}

// ---------- 单元 ----------

test("档案路径：稳定、按仓库区分、在仓库外、随 HOME 参数变化", () => {
  const home = tmpHome();
  const fixtureRepo = path.join(home, "fixture-repo");
  fs.mkdirSync(fixtureRepo);
  const a = devProfileFor(fixtureRepo, home);
  const b = devProfileFor(fixtureRepo, home);
  assert.deepEqual(a, b, "同一仓库同一 HOME 结果稳定");
  const real = fs.realpathSync(fixtureRepo);
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 8);
  assert.equal(a.product, "ruukoto");
  assert.equal(a.root, path.join(home, ".ruukoto-dev", `fixture-repo-${hash}`));
  assert.ok(!a.root.startsWith(real + path.sep), "档案在仓库外（保护根不含它）");
  for (const sub of [a.dataDir, a.agentDir, a.controlDir, a.pendingDir, a.logsDir]) {
    assert.ok(sub.startsWith(a.root + path.sep));
  }
  assert.equal(path.dirname(a.dataDir), a.root, "dirname(dataDir)/qq-work 落在档案内");
  const other = devProfileFor(path.join(home, "another-repo"), home);
  assert.notEqual(other.root, a.root, "不同仓库不同档案目录");
  const home2 = tmpHome();
  assert.notEqual(devProfileFor(fixtureRepo, home2).root, a.root, "HOME 覆盖生效");
});

test("code 档案：同仓库稳定复用，与 dev 及日常产品档案分别隔离", () => {
  const home = tmpHome();
  try {
    const a = devProfileFor(repoRoot, home, "ruukoto-code");
    const dev = devProfileFor(repoRoot, home);
    assert.deepEqual(a, devProfileFor(repoRoot, home, "ruukoto-code"));
    assert.equal(a.product, "ruukoto-code");
    assert.equal(a.root, path.join(home, ".ruukoto-code-dev", path.basename(dev.root)));
    for (const dir of ["dataDir", "agentDir", "controlDir", "pendingDir", "logsDir", "reloadStateFile"] as const) {
      assert.notEqual(a[dir], dev[dir], `${dir} 不跨产品复用`);
      assert.ok(a[dir].startsWith(a.root + path.sep), `${dir} 留在 code 开发档案内`);
    }
    assert.ok(!a.root.startsWith(path.join(home, ".ruukoto-code") + path.sep));
    assert.ok(!a.root.startsWith(fs.realpathSync(repoRoot) + path.sep));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("环境清洗：生产令牌/执行账户变量被剥除，档案目录与 QQ 停用注入", () => {
  const profile = devProfileFor(repoRoot, tmpHome());
  const env = buildChildEnv(
    {
      PATH: "/usr/bin",
      RUUKOTO_OWNER_TOKEN: "prod-token",
      RUUKOTO_OWNER_TOKEN_FILE: "/etc/owner.token",
      RUUKOTO_EXECUTION_BACKEND: "systemd",
      RUUKOTO_SERVICE_SUDO: "900",
      RUUKOTO_DATA_DIR: "/prod/data",
      RUUKOTO_AGENT_DIR: "/prod/agent",
      RUUKOTO_CONTROL_DIR: "/prod/control",
      RUUKOTO_PENDING_DIR: "/prod/pending",
      RUUKOTO_DISABLE_QQ: "0",
      RUUKOTO_RELOAD_STATE_FILE: "/prod/reload.json",
      RUUKOTO_DESKTOP_MANAGED: "1",
      RUUKOTO_DESKTOP_DEV_NONCE: "inherited-nonce",
    },
    profile,
  );
  for (const key of [
    "RUUKOTO_OWNER_TOKEN",
    "RUUKOTO_OWNER_TOKEN_FILE",
    "RUUKOTO_EXECUTION_BACKEND",
    "RUUKOTO_SERVICE_SUDO",
    "RUUKOTO_RELOAD_STATE_FILE",
    "RUUKOTO_DESKTOP_MANAGED",
    "RUUKOTO_DESKTOP_DEV_NONCE",
  ]) {
    assert.equal(env[key], undefined, `${key} 不得继承`);
  }
  assert.equal(env.PATH, "/usr/bin", "普通变量保留");
  assert.equal(env.RUUKOTO_PRODUCT, "ruukoto", "产品由入口显式钉定");
  assert.equal(env.RUUKOTO_DATA_DIR, profile.dataDir);
  assert.equal(env.RUUKOTO_AGENT_DIR, profile.agentDir);
  assert.equal(env.RUUKOTO_CONTROL_DIR, profile.controlDir);
  assert.equal(env.RUUKOTO_PENDING_DIR, profile.pendingDir);
  assert.equal(env.RUUKOTO_DISABLE_QQ, "1", "dev 固定停用真实 QQ 通道");
  assert.equal(env.RUUKOTO_DISABLE_TELEGRAM, "1", "dev 固定停用真实 Telegram 通道");
});

test("监听分类：tui / config-tui / backend / both / self", () => {
  assert.equal(classifyWatchPath("packages/tui/src/dev.ts"), "self");
  assert.equal(classifyWatchPath("apps/ruukoto/src/dev.ts"), "self");
  assert.equal(classifyWatchPath("apps/ruukoto-code/src/dev.ts"), "self");
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
  assert.equal(classifyWatchPath("apps/ruukoto-code/src/product.ts"), "backend");
  assert.equal(classifyWatchPath("packages/runtime/src/runtime.ts"), "backend");
  assert.equal(classifyWatchPath("packages/agent/src/model-config.ts"), "backend");
  assert.equal(classifyWatchPath("packages/channels/src/qq/adapter.ts"), "backend");
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

test("参数解析：dev 仅后台、code 默认 TUI；--config 取代 TUI，严格拒绝旧 --tui", () => {
  assert.deepEqual(parseDevArgs([]), { tui: false, config: false, desktop: false, importModels: undefined, workspacePath: undefined });
  assert.deepEqual(parseDevArgs([], "ruukoto-code"), { tui: true, config: false, desktop: false, importModels: undefined, workspacePath: undefined });
  assert.deepEqual(parseDevArgs(["--config"]), { tui: false, config: true, desktop: false, importModels: undefined, workspacePath: undefined });
  assert.deepEqual(parseDevArgs(["--config"], "ruukoto-code"), { tui: false, config: true, desktop: false, importModels: undefined, workspacePath: undefined });
  for (const product of ["ruukoto", "ruukoto-code"] as const) {
    assert.equal(parseDevArgs(["--import-models", "/tmp/x"], product).importModels, "/tmp/x");
    assert.throws(() => parseDevArgs(["--tui"], product));
    assert.throws(() => parseDevArgs(["--nope"], product));
  }
  assert.throws(() => parseDevArgs(["pos"]));
});

test("code 路径参数：单目录可与模型导入同用，拒绝多个目录及配置模式", () => {
  for (const dir of ["../my project", "/tmp/work", "config", "server"]) {
    assert.equal(parseDevArgs([dir], "ruukoto-code").workspacePath, dir);
  }
  assert.deepEqual(parseDevArgs(["../my project", "--import-models", "/tmp/models"], "ruukoto-code"), {
    tui: true, config: false, desktop: false, importModels: "/tmp/models", workspacePath: "../my project",
  });
  assert.throws(() => parseDevArgs(["/tmp/a", "/tmp/b"], "ruukoto-code"), /只接受一个路径/);
  assert.throws(() => parseDevArgs(["--config", "/tmp/a"], "ruukoto-code"), /不能与工作区路径同用/);
  assert.equal(parseDevArgs(["--", "--config"], "ruukoto-code").workspacePath, "--config");
});

test("桌面参数：仅 code 可用，取代 TUI，拒绝配置中心与工作区路径", () => {
  assert.deepEqual(parseDevArgs(["--desktop", "--import-models", "/tmp/models"], "ruukoto-code"), {
    tui: false, config: false, desktop: true, importModels: "/tmp/models", workspacePath: undefined,
  });
  assert.throws(() => parseDevArgs(["--desktop"]), /只适用于 ruukoto-code/);
  assert.throws(() => parseDevArgs(["--desktop", "--config"], "ruukoto-code"), /不能与 --config 同用/);
  assert.throws(() => parseDevArgs(["--desktop", "/tmp/work"], "ruukoto-code"), /不能与工作区路径同用/);
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

test("桌面开发入口：清洗档案环境、每次生成 nonce；退出前端或启动器都清理整组进程", { timeout: 180_000 }, async () => {
  const home = tmpHome();
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
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
  product: process.env.RUUKOTO_PRODUCT, dataDir: process.env.RUUKOTO_CODE_DATA_DIR,
  controlDir: process.env.RUUKOTO_CODE_CONTROL_DIR, ownerToken: process.env.RUUKOTO_OWNER_TOKEN,
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
        RUUKOTO_CODE_DATA_DIR: "/daily/data",
        RUUKOTO_CODE_CONTROL_DIR: "/daily/control",
        RUUKOTO_OWNER_TOKEN: "daily-token",
        RUUKOTO_DESKTOP_DEV_NONCE: "inherited-nonce",
      }, "ruukoto-code");
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
        assert.equal(vite.product, "ruukoto-code");
        assert.equal(vite.dataDir, profile.dataDir);
        assert.equal(vite.controlDir, profile.controlDir);
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

for (const product of ["ruukoto-code"] as const) {
  for (const flag of ["--tui", "--nope"]) {
    test(`${product} 开发入口：${flag} 在建目录前失败（无副作用）`, { timeout: 60_000 }, async () => {
      const home = tmpHome();
      const run = runDev(home, [flag], {}, product);
      try {
        assert.equal(await run.waitExit(), 1);
        assert.ok(run.stderr().includes("参数错误"), run.stderr());
        assert.ok(!fs.existsSync(path.join(home, ".ruukoto-dev")), "dev 档案未被创建");
        assert.ok(!fs.existsSync(path.join(home, ".ruukoto-code-dev")), "code 档案未被创建");
      } finally {
        await killDev(run);
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test(`${product} 开发入口：无模型提示本入口的配置命令且不启动后台`, { timeout: 60_000 }, async () => {
    const home = tmpHome();
    const profile = devProfileFor(repoRoot, home, product);
    const run = runDev(home, [], {}, product);
    try {
      assert.equal(await run.waitExit(), 1);
      assert.ok(run.stderr().includes("未配置有效模型"), run.stderr());
      assert.ok(run.stderr().includes("npm run code -- --config"), run.stderr());
      assert.ok(!fs.existsSync(path.join(profile.controlDir, "control.sock")), "后台未启动");
      assert.ok(!fs.existsSync(path.join(profile.logsDir, "backend.log")), "未产生后台日志");
    } finally {
      await killDev(run);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("code --import-models：复制后进入门禁；无效配置退出且 credentials.json 未导入", { timeout: 60_000 }, async () => {
  const home = tmpHome();
  const dir = tmpHome("ruukoto-test-import-src-");
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {} }));
  fs.writeFileSync(path.join(dir, "auth.json"), "{}");
  fs.writeFileSync(path.join(dir, "credentials.json"), "{}");
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
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

test("code：开发实例已在运行 → 报错退出且不碰外来后台", { timeout: 180_000 }, async () => {
  const home = tmpHome();
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
  fs.mkdirSync(profile.dataDir, { recursive: true });
  fs.mkdirSync(profile.agentDir, { recursive: true });
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  let backend: Awaited<ReturnType<typeof spawnBackend>> | undefined;
  let run: DevRun | undefined;
  try {
    const baseUrl = await server.start();
    await writeMockModelConfig(profile.agentDir, baseUrl);
    backend = await spawnBackend(profile.dataDir, profile.agentDir);
    run = runDev(home);
    const code = await run.waitExit();
    assert.equal(code, 1);
    assert.ok(run.stderr().includes("已在运行"), run.stderr());
    assert.ok(
      await probeControlPlane(path.join(profile.controlDir, "control.sock"), readOwnerToken(profile.controlDir), 800),
      "外来后台仍在运行，dev 不得停止它",
    );
  } finally {
    if (run) await killDev(run);
    if (backend) await killBackend(backend);
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("code：有效模型但非 TTY 时非零退出并清理后台", { timeout: 120_000 }, async () => {
  const home = tmpHome();
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeMockModelConfig(profile.agentDir, baseUrl);
  const run = runDev(home, [], {}, "ruukoto-code");
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
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
  fs.mkdirSync(profile.controlDir, { recursive: true });
  fs.writeFileSync(path.join(profile.controlDir, "owner.token"), "a".repeat(64), { mode: 0o600 });
  const sockets = new Set<net.Socket>();
  let accepted = false;
  const stalled = net.createServer((socket) => {
    sockets.add(socket);
    accepted = true;
  });
  await new Promise<void>((resolve) => stalled.listen(path.join(profile.controlDir, "control.sock"), resolve));
  const run = runDev(home, ["--config"], {}, "ruukoto-code");
  try {
    assert.equal(await run.waitExit(), 1, run.stderr());
    assert.equal(accepted, true);
    assert.match(run.stderr(), /已在运行/);
    assert.ok(!run.stderr().includes("先打开离线配置中心"), run.stderr());
    assert.ok(!run.stderr().includes("配置中心需要交互式终端"), "终止后不派生配置进程");
    assert.ok(!fs.existsSync(path.join(profile.agentDir, "config.lock")), "未启动离线配置或留下配置锁");
    assert.ok(!fs.existsSync(path.join(profile.logsDir, "backend.log")), "未启动后台");
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
    cmd: ["npm", "run", "code", ...(opts.args?.length ? ["--", ...opts.args] : [])],
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

test("PTY：npm run code 默认 TUI，/quit 后退出、终端恢复、日志不交错、无残留进程", { timeout: 90_000 }, async (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const home = tmpHome();
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeMockModelConfig(profile.agentDir, baseUrl);
  try {
    const result = await runCodeInPty({
      env: { HOME: home },
      inputs: [["连接：在线", "/quit\r"]],
      expect: ["连接：在线", "已退出 TUI"],
    });
    assert.equal(result.expectSeen, result.expectTotal, `未看到退出提示：${result.tail}`);
    assert.equal(result.exitCode, 0, `code 应随前端退出（退出码 0）；tail：${result.tail}`);
    assert.ok(result.all.includes("\x1b[?1049l"), "退出时离开 alt screen（终端恢复）");
    assert.ok(!result.all.includes("后台已启动"), "后台日志不混入终端输出");
    assertCodeBackendStopped(profile);
    assert.ok(!fs.existsSync(devProfileFor(repoRoot, home).root), "code 不读写 dev 的既有档案");
    assert.ok(!fs.existsSync(path.join(home, ".ruukoto-code")), "code 不读写日常 Coding Agent 档案");
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
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
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

test("PTY：npm run code -- --config 打开在线配置中心，退出时停开发后台", { timeout: 90_000 }, async (t) => {
  if (!hasPython3()) {
    t.skip("python3 不可用");
    return;
  }
  const home = tmpHome();
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
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
  const profile = devProfileFor(repoRoot, home, "ruukoto-code");
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
    assert.ok(!fs.existsSync(path.join(profile.controlDir, "control.sock")), "后台未启动");
    assert.ok(!fs.existsSync(path.join(profile.logsDir, "backend.log")), "未产生后台日志");
    assert.ok(!fs.existsSync(devProfileFor(repoRoot, home).root), "首次配置只写 code 开发档案");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
