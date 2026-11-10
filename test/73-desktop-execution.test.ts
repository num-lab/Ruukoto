/**
 * 产品执行后端选择、握手与完全访问入口。
 * Note: 见 .agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md
 * Note: 见 .agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md
 * Note: 见 .agents/notes/archived/architecture/2026-10-02-two-agent-products.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
 *
 * 测试接缝（预先约定）：
 * - ruukoto 的 `server` 进程入口：默认使用 native，旧 local/container 覆盖拒绝并提供迁移指引；
 * - 握手快照 `snapshot.execution`（TUI 展示的来源）后台声明的实际后端；
 * - `submit`：完全访问直接使用启动账户；confirm 仍保留受限后端。
 *
 * 边界本身的文件/子进程/网络约束与停止回收属工单 03 与
 * verification/smoke/smoke-04-desktop-execution.mts 的真实环境验证，
 * 本文件只做离线进程级断言（模型打桩，进程/文件/socket/SQLite 真实）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "@ruukoto/control/client.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import {
  authenticateClient,
  cleanupDirs,
  createProjectSession,
  makeTestDirs,
  taskStatus,
  waitFor,
  writeModelsJson,
} from "./helpers/testkit.ts";
import { killProcessTree } from "./helpers/backend.ts";
import { profileChildEnv, type ProfilePaths } from "@ruukoto/core/profile.ts";

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

interface SpawnedBackend {
  child: childProcess.ChildProcess;
  profile: ProfilePaths;
  stderr(): string;
  exit(): Promise<number | null>;
}

async function spawnBackend(opts: {
  profile: ProfilePaths;
  extraArgv?: string[];
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<SpawnedBackend> {
  const profile = opts.profile;
  const env = profileChildEnv(profile.selection, { PATH: process.env.PATH, HOME: process.env.HOME, ...opts.extraEnv });
  const child = childProcess.spawn(
    process.execPath,
    [nodePath.join(repoRoot, "apps/ruukoto/bin/ruukoto.mjs"), "server", "--tools", "mock", ...(opts.extraArgv ?? [])],
    { cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const socketPath = profile.socketPath;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`ruukoto backend exited: ${stderr.slice(0, 2000)}`);
    }
    try {
      const client = await ControlClient.connect(socketPath, 1500);
      await authenticateClient(client, profile);
      await client.handshake();
      client.close();
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        killProcessTree(child);
        throw new Error(`ruukoto backend connection timed out: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return {
    child,
    profile,
    stderr: () => stderr,
    exit: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        const timer = setTimeout(() => resolve(-1), 20_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
  };
}

async function connectAuthed(profile: ProfilePaths): Promise<ControlClient> {
  const client = await ControlClient.connect(profile.socketPath, 3000);
  await authenticateClient(client, profile);
  await client.handshake();
  return client;
}

async function stopBackend(backend: SpawnedBackend): Promise<void> {
  const client = await connectAuthed(backend.profile);
  try {
    await client.request("stop");
  } finally {
    client.close();
  }
  assert.equal(await backend.exit(), 0);
}

type TestDirs = { profile: ProfilePaths };

const product = "ruukoto";
test(`${product} 默认执行后端 = native；完全访问无需额外执行入口`, async () => {
  const { dirs, work } = await makeTestDirs("x73dev", 1);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  let backend: SpawnedBackend | null = null;
  try {
    backend = await spawnBackend({ ...(dirs as TestDirs) });
    const client = await connectAuthed(backend.profile);
    try {
      const { snapshot } = await client.handshake();
      assert.equal(snapshot.execution.backend, "native", `${product} 未显式指定时须以原生后端启动`);
      assert.match(snapshot.execution.note, /原生/, "执行后端说明不得暗示无隔离");
      assert.doesNotMatch(backend.stderr(), /尚在验证/, "验证已完成，不得再打印受限模式待验证提示");

      const { sessionId } = await createProjectSession(client, work[0]!);
      const full = await client.request<any>("submit", {
        session_id: sessionId, request_id: "full-access-1", input: "读取系统状态",
        access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      });
      await waitFor("完全访问任务完成", async () => (await taskStatus(client, full.id)).task.status === "completed", 60_000);
      assert.equal(full.accessMode, "full_access");

      // confirm 提交照常；本例的工具为 mock，OS 边界另经真实 smoke 验证。
      const task = await client.request<any>("submit", {
        session_id: sessionId,
        request_id: "confirm-1",
        input: "检查工作区",
        access_mode: "confirm",
        model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      });
      await waitFor("confirm 任务完成", async () => (await taskStatus(client, task.id)).task.status === "completed", 60_000);
    } finally {
      client.close();
    }
    await stopBackend(backend);
    backend = null;
  } finally {
    if (backend) killProcessTree(backend.child);
    await server.close();
    await cleanupDirs(dirs);
  }
});

test(`${product} 显式 native（flag 或环境变量）：握手展示原生执行后端`, async () => {
  for (const override of [
    { name: "flag", extraArgv: ["--execution", "native"] },
    { name: "env", extraEnv: { RUUKOTO_EXECUTION_BACKEND: "native" } },
  ]) {
    const { dirs } = await makeTestDirs(`x73nat${override.name === "flag" ? "f" : "e"}`, 0);
    const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
    await writeModelsJson(dirs, await server.start());
    let backend: SpawnedBackend | null = null;
    try {
      backend = await spawnBackend({ ...(dirs as TestDirs), ...override });
      const client = await connectAuthed(backend.profile);
      try {
        const { snapshot } = await client.handshake();
        assert.equal(snapshot.execution.backend, "native");
        assert.match(snapshot.execution.note, /原生/);
      } finally {
        client.close();
      }
      await stopBackend(backend);
      backend = null;
    } finally {
      if (backend) killProcessTree(backend.child);
      await server.close();
      await cleanupDirs(dirs);
    }
  }
});

test(`${product} 的旧 local/container flag 与环境覆盖拒绝，并给出迁移指引`, async () => {
  const { dirs } = await makeTestDirs("x73legacy", 0);
  try {
    for (const execution of ["local", "container"]) {
      for (const argv of [["server", "--execution", execution], ["server"], [], [dirs.dataDir], ["tui"]]) {
        const result = childProcess.spawnSync(process.execPath,
          [nodePath.join(repoRoot, "apps", product, "bin", product + ".mjs"), ...argv],
          { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: {
            PATH: process.env.PATH, HOME: process.env.HOME,
            ...profileChildEnv(dirs.profile.selection, {}), RUUKOTO_EXECUTION_BACKEND: argv.includes("--execution") ? undefined : execution,
          } });
        assert.equal(result.status, 1, `${execution}: ${argv.join(" ")}`);
        assert.match(result.stderr, /--execution 取值无效/);
        assert.match(result.stderr, /--execution native/);
        assert.match(result.stderr, /移除 --execution \/ RUUKOTO_EXECUTION_BACKEND/);
      }
    }
  } finally {
    await cleanupDirs(dirs);
  }
});

test(`${product} 非法执行后端在 server、TUI、工作区与旧 tui 入口提前拒绝`, async () => {
  const { dirs } = await makeTestDirs("x73bogus", 0);
  try {
    for (const argv of [["server", "--execution", "bogus"], [], [dirs.dataDir], ["tui"]]) {
      const result = childProcess.spawnSync(process.execPath,
        [nodePath.join(repoRoot, "apps", product, "bin", product + ".mjs"), ...argv],
        { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: {
          PATH: process.env.PATH, HOME: process.env.HOME,
          ...profileChildEnv(dirs.profile.selection, {}),
          RUUKOTO_EXECUTION_BACKEND: argv.includes("--execution") ? undefined : "bogus",
        } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--execution 取值无效/);
    }
  } finally {
    await cleanupDirs(dirs);
  }
});
