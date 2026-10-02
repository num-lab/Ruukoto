/**
 * 开发机受限/完全访问接入（agent-direction issue 04，ADR 0003/0004/0017）。
 *
 * 测试接缝（预先约定）：
 * - ruukoto/ruukoto-dev 的 `server` 进程入口：执行后端按产品解析默认值
 *   （ruukoto-dev = container，ruukoto = local），`--execution` 与
 *   RUUKOTO_EXECUTION_BACKEND 显式覆盖；local 生效时打印无隔离警告；
 * - 握手快照 `snapshot.execution`（TUI 展示的来源）后台声明的实际后端；
 * - `submit`：容器后端下完全访问缺少执行账户入口时，以 execution_unavailable
 *   在执行前拒绝且不回退；confirm 提交照常完成。
 *
 * 边界本身的文件/子进程/网络约束与停止回收属工单 03 与
 * .scratch/agent-direction/smoke-04-desktop-execution.mts 的真实环境验证，
 * 本文件只做离线进程级断言（模型打桩，进程/文件/socket/SQLite 真实）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../src/control/client.ts";
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

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

interface SpawnedBackend {
  child: childProcess.ChildProcess;
  controlDir: string;
  stderr(): string;
  exit(): Promise<number | null>;
}

async function spawnBackend(opts: {
  product: "ruukoto" | "ruukoto-dev";
  dataDir: string;
  agentDir: string;
  root: string;
  extraArgv?: string[];
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<SpawnedBackend> {
  const controlDir = nodePath.join(opts.root, "control");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...opts.extraEnv };
  env[opts.product === "ruukoto" ? "RUUKOTO_CONTROL_DIR" : "RUUKOTO_DEV_CONTROL_DIR"] = controlDir;
  const binFile = opts.product === "ruukoto" ? "ruukoto.mjs" : "ruukoto-dev.mjs";
  const child = childProcess.spawn(
    process.execPath,
    [nodePath.join(repoRoot, "bin", binFile), "server", "--data-dir", opts.dataDir, "--agent-dir", opts.agentDir, "--tools", "mock", ...(opts.extraArgv ?? [])],
    { cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const socketPath = nodePath.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${opts.product} 后台提前退出：${stderr.slice(0, 2000)}`);
    }
    try {
      const client = await ControlClient.connect(socketPath, 1500);
      await authenticateClient(client, controlDir);
      await client.handshake();
      client.close();
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        killProcessTree(child);
        throw new Error(`${opts.product} 后台连接超时：${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return {
    child,
    controlDir,
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

async function connectAuthed(controlDir: string): Promise<ControlClient> {
  const client = await ControlClient.connect(nodePath.join(controlDir, "control.sock"), 3000);
  await authenticateClient(client, controlDir);
  await client.handshake();
  return client;
}

async function stopBackend(backend: SpawnedBackend): Promise<void> {
  const client = await connectAuthed(backend.controlDir);
  try {
    await client.request("stop");
  } finally {
    client.close();
  }
  assert.equal(await backend.exit(), 0);
}

type TestDirs = { dataDir: string; agentDir: string; root: string };

test("ruukoto-dev 默认执行后端 = 容器（已验证边界）；完全访问缺执行账户入口时在执行前拒绝、不回退", async () => {
  const { dirs, work } = await makeTestDirs("x73dev", 1);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  let backend: SpawnedBackend | null = null;
  try {
    backend = await spawnBackend({ product: "ruukoto-dev", ...(dirs as TestDirs) });
    const client = await connectAuthed(backend.controlDir);
    try {
      const { snapshot } = await client.handshake();
      assert.equal(snapshot.execution.backend, "container", "ruukoto-dev 未显式指定时须以容器后端启动");
      assert.match(snapshot.execution.note, /容器/, "执行后端说明不得暗示无隔离");
      assert.doesNotMatch(backend.stderr(), /尚在验证/, "验证已完成，不得再打印受限模式待验证提示");

      // 完全访问：干净环境没有执行账户入口 → 提交即拒绝（执行前），不回退到普通账户
      const { sessionId } = await createProjectSession(client, work[0]!);
      await assert.rejects(
        client.request("submit", {
          session_id: sessionId,
          request_id: "full-access-1",
          input: "读取系统状态",
          access_mode: "full_access",
          model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        }),
        (err: any) => err.code === "execution_unavailable" && /不回退/.test(String(err.message)),
      );
      assert.equal(
        (await client.request<any>("list_tasks", { session_id: sessionId })).tasks.length,
        0,
        "被拒绝的提交不得创建任务",
      );

      // confirm 提交照常（请求确认模式使用容器边界）
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

test("ruukoto-dev 显式 local（flag 或环境变量）：local 生效并打印无隔离警告", async () => {
  for (const override of [
    { name: "flag", extraArgv: ["--execution", "local"] },
    { name: "env", extraEnv: { RUUKOTO_EXECUTION_BACKEND: "local" } },
  ]) {
    const { dirs } = await makeTestDirs(`x73loc${override.name === "flag" ? "f" : "e"}`, 0);
    const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
    const baseUrl = await server.start();
    await writeModelsJson(dirs, baseUrl);
    let backend: SpawnedBackend | null = null;
    try {
      backend = await spawnBackend({ product: "ruukoto-dev", ...(dirs as TestDirs), ...override });
      const client = await connectAuthed(backend.controlDir);
      try {
        const { snapshot } = await client.handshake();
        assert.equal(snapshot.execution.backend, "local", `${override.name} 覆盖后按指定后端运行`);
      } finally {
        client.close();
      }
      assert.match(backend.stderr(), /无隔离，仅用于开发\/验证/, "local 生效必须显式标注无隔离");
      await stopBackend(backend);
      backend = null;
    } finally {
      if (backend) killProcessTree(backend.child);
      await server.close();
      await cleanupDirs(dirs);
    }
  }
});

test("ruukoto（个人 Agent）默认执行后端不变 = local，同样打印无隔离警告", async () => {
  const { dirs } = await makeTestDirs("x73prod", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  let backend: SpawnedBackend | null = null;
  try {
    backend = await spawnBackend({ product: "ruukoto", ...(dirs as TestDirs) });
    const client = await connectAuthed(backend.controlDir);
    try {
      const { snapshot } = await client.handshake();
      assert.equal(snapshot.execution.backend, "local");
    } finally {
      client.close();
    }
    assert.match(backend.stderr(), /无隔离，仅用于开发\/验证/);
    await stopBackend(backend);
    backend = null;
  } finally {
    if (backend) killProcessTree(backend.child);
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("非法 --execution 取值仍在入口拒绝", async () => {
  const { dirs } = await makeTestDirs("x73bogus", 0);
  try {
    const r = childProcess.spawnSync(
      process.execPath,
      [
        nodePath.join(repoRoot, "node_modules", ".bin", "tsx"),
        "src/cli.ts",
        "server",
        "--data-dir",
        dirs.dataDir,
        "--agent-dir",
        dirs.agentDir,
        "--execution",
        "bogus",
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_PRODUCT: "ruukoto-dev" } },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--execution 取值无效/);
  } finally {
    await cleanupDirs(dirs);
  }
});
