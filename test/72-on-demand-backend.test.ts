/**
 * ruukoto-dev TUI 启动按需拉起本机后台（agent-direction issue 02，ADR 0017）。
 *
 * 测试接缝（预先约定）：
 * - src/control/ensure-backend.ts：ensureBackend 的可观察行为——探测、拉起、并发收敛、
 *   失败分类（启动失败附日志尾部）；拉起对象是真实 bin 后台进程（真实文件/socket/SQLite，
 *   模型打桩），与 issue 01 的真实/模拟边界一致；
 * - TUI 入口门控（按需拉起只属于 ruukoto-dev；ruukoto 沿用显式 server/systemd）。
 *
 * 沿用既有规则不得破坏：实例锁是单实例仲裁；重连只恢复观察；关闭客户端不停止后台
 * 或取消任务；重开看到同一任务，不重复提交。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ensureBackend, tuiSpawnsBackendOnDemand } from "../src/control/ensure-backend.ts";
import { ControlClient } from "../src/control/client.ts";
import { authenticateClient, cleanupDirs, makeTestDirs, routeResponder, waitFor, writeModelsJson, createProjectSession, taskStatus } from "./helpers/testkit.ts";
import { killProcessTree } from "./helpers/backend.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const RUUKOTO_DEV_BIN = nodePath.join(repoRoot, "bin", "ruukoto-dev.mjs");

// ---- 单元：门控 ----

test("门控：只有 ruukoto-dev 的 TUI 按需拉起后台（ruukoto 沿用显式启动）", () => {
  assert.equal(tuiSpawnsBackendOnDemand("ruukoto-dev"), true);
  assert.equal(tuiSpawnsBackendOnDemand("ruukoto"), false);
});

// ---- 进程级（真实 bin 后台、文件、socket、SQLite；模型打桩） ----

function devSpawnArgv(dirs: { dataDir: string; agentDir: string }): string[] {
  return [RUUKOTO_DEV_BIN, "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--tools", "mock"];
}

function cleanEnv(controlDir: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_DEV_CONTROL_DIR: controlDir };
}

function devOpts(dirs: { root: string; dataDir: string; agentDir: string }): Parameters<typeof ensureBackend>[0] {
  const controlDir = nodePath.join(dirs.root, "control");
  return { dataDir: dirs.dataDir, agentDir: dirs.agentDir, controlDir, spawnArgv: devSpawnArgv(dirs), env: cleanEnv(controlDir) };
}

async function connectAuthed(controlDir: string): Promise<ControlClient> {
  const client = await ControlClient.connect(nodePath.join(controlDir, "control.sock"), 3000);
  await authenticateClient(client, controlDir);
  return client;
}

async function stopAndWait(controlDir: string): Promise<void> {
  const client = await connectAuthed(controlDir);
  try {
    await client.request("stop");
  } finally {
    client.close();
  }
  // 优雅停止是控制面 op 触发、进程自行收尾：等 socket 消失
  await waitFor("后台停止（socket 消失）", () => !fs.existsSync(nodePath.join(controlDir, "control.sock")), 20_000);
}

/** 测试收尾兜底：停得下来就优雅停；停不下来按实例锁登记的 pid 整组杀掉（防孤儿后台）。 */
async function stopBestEffort(controlDir: string, dataDir: string): Promise<void> {
  try {
    await stopAndWait(controlDir);
    return;
  } catch {
    // 已停或不可达：走锁登记 pid
  }
  try {
    const owner = JSON.parse(fs.readFileSync(nodePath.join(dataDir, "runtime.lock", "owner.json"), "utf8"));
    try {
      process.kill(-owner.pid, "SIGKILL");
    } catch {
      process.kill(owner.pid, "SIGKILL");
    }
  } catch {
    // 锁不存在或 pid 已死
  }
}

test("按需拉起：后台不存在时拉起单个实例并可认证握手", async () => {
  const { dirs } = await makeTestDirs("ondemand-first", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  await writeModelsJson(dirs, await server.start());
  const controlDir = devOpts(dirs).controlDir;
  try {
    const r = await ensureBackend(devOpts(dirs));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.spawned, true);

    const client = await connectAuthed(controlDir);
    const hs = (await client.handshake()) as { snapshot?: { instanceId?: string } };
    assert.ok(hs.snapshot?.instanceId, "握手应给出数据实例标识");
    client.close();

    // 单实例仲裁仍是后台实例锁：<dataDir>/runtime.lock/owner.json 指向活进程
    const owner = JSON.parse(fs.readFileSync(nodePath.join(dirs.dataDir, "runtime.lock", "owner.json"), "utf8"));
    assert.ok(Number.isInteger(owner.pid));
    process.kill(owner.pid, 0); // pid 必须存活，否则抛错

    await stopAndWait(controlDir);
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("并发拉起收敛为单个实例：两个终端同时按需拉起，握手同一数据实例", async () => {
  const { dirs } = await makeTestDirs("ondemand-race", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  await writeModelsJson(dirs, await server.start());
  const controlDir = nodePath.join(dirs.root, "control");
  const opts = devOpts(dirs);
  try {
    const [a, b] = await Promise.all([ensureBackend(opts), ensureBackend(opts)]);
    assert.equal(a.ok, true, a.ok ? "" : a.error);
    assert.equal(b.ok, true, b.ok ? "" : b.error);

    // 两侧握手必须落到同一个数据实例（实例锁仲裁：只有一个后台存活）
    const probeA = await connectAuthed(controlDir);
    const idA = ((await probeA.handshake()) as any).snapshot?.instanceId;
    probeA.close();
    const probeB = await connectAuthed(controlDir);
    const idB = ((await probeB.handshake()) as any).snapshot?.instanceId;
    probeB.close();
    assert.ok(idA && idB, "握手应给出数据实例标识");
    assert.equal(idA, idB, "并发拉起不得形成两个数据实例");

    await stopAndWait(controlDir);
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("已在运行不重复拉起：第二次按需拉起直接复用，数据实例不变", async () => {
  const { dirs } = await makeTestDirs("ondemand-idem", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  await writeModelsJson(dirs, await server.start());
  const controlDir = nodePath.join(dirs.root, "control");
  const opts = devOpts(dirs);
  try {
    const first = await ensureBackend(opts);
    assert.equal(first.ok, true);
    const client = await connectAuthed(controlDir);
    const idBefore = ((await client.handshake()) as any).snapshot?.instanceId;
    client.close();

    const start = Date.now();
    const second = await ensureBackend(opts);
    assert.deepEqual(second, { ok: true, spawned: false });
    assert.ok(Date.now() - start < 5000, "探测通过应快速返回，不得再拉起进程");

    const again = await connectAuthed(controlDir);
    const idAfter = ((await again.handshake()) as any).snapshot?.instanceId;
    again.close();
    assert.equal(idAfter, idBefore, "复用不得重启后台（数据实例标识不变）");

    await stopAndWait(controlDir);
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("启动失败给出明确状态：服务进程提前退出，附日志尾部", async () => {
  const { dirs } = await makeTestDirs("ondemand-fail", 0);
  // 故意不写 models.json：Runtime.start 以 no_model 拒绝，子进程提前退出
  const controlDir = nodePath.join(dirs.root, "control");
  try {
    const r = await ensureBackend({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      controlDir,
      spawnArgv: devSpawnArgv(dirs),
      env: cleanEnv(controlDir),
      exitGraceMs: 1500,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /后台启动失败/);
    assert.match(r.error, /spawn\.log/);
    assert.match(r.error, /no_model|未找到可用模型/, "失败状态必须带服务进程的实际错误");
    assert.match(r.error, /ruukoto-dev config/, "未配置模型时必须给出配置入口提示");
    // 失败不得残留后台
    assert.ok(!fs.existsSync(nodePath.join(controlDir, "control.sock")), "启动失败不得留下可连接后台");
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await cleanupDirs(dirs);
  }
});

test("关闭客户端不停止后台或取消任务；重开看到同一任务，不重复提交", async () => {
  const { dirs, work } = await makeTestDirs("ondemand-close", 1);
  const server = new MockModelServer(routeResponder([]));
  await writeModelsJson(dirs, await server.start());
  const controlDir = devOpts(dirs).controlDir;
  try {
    const r = await ensureBackend(devOpts(dirs));
    assert.equal(r.ok, true);

    // 提交一个任务并完成（方式与 TUI 提交相同：控制面 submit + 幂等 request_id）
    const client1 = await connectAuthed(controlDir);
    let sessionId = "";
    let taskId = "";
    try {
      ({ sessionId } = await createProjectSession(client1, work[0]!));
      const task = (await client1.request<any>("submit", {
        model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sessionId,
        request_id: "req-close-1",
        input: "做一件事",
      })) as { id: string };
      taskId = task.id;
      await client1.handshake();
      await waitFor("任务完成", async () => (await taskStatus(client1, task.id)).task.status === "completed");
    } finally {
      // 关闭客户端 = 退出 TUI：不发 stop、不取消任务
      client1.close();
    }

    const missing = await ensureBackend(devOpts(dirs));
    assert.deepEqual(missing, { ok: true, spawned: false }, "客户端关闭不停止后台：再开 TUI 直接复用");

    const client2 = await connectAuthed(controlDir);
    try {
      const hs = (await client2.handshake()) as any;
      const tasks = (hs.snapshot?.tasks ?? []) as Array<{ id: string; status?: string }>;
      const mine = tasks.filter((t) => t.id === taskId);
      assert.equal(mine.length, 1, "重开必须看到同一任务");
      assert.equal(mine[0]!.status, "completed");
      const found = (await client2.request<any>("find_task", { session_id: sessionId, request_id: "req-close-1" })) as { task?: { id: string } | null };
      assert.equal(found?.task?.id, taskId, "幂等键仍指向原任务，不重复提交");
    } finally {
      client2.close();
    }

    await stopAndWait(controlDir);
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("并发拉起中败于实例锁的一侧不误判启动失败：等慢胜者就绪并复用（spawned=false）", async () => {
  const { dirs } = await makeTestDirs("od-slow", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  await writeModelsJson(dirs, await server.start());
  const controlDir = devOpts(dirs).controlDir;
  try {
    const winner = ensureBackend(devOpts(dirs)); // 真实 bin 后台：就绪需数秒（慢胜者）
    const loser = await ensureBackend({
      ...devOpts(dirs),
      // 立即以实例锁冲突退出的假子进程：并发拉起里败下阵来的那一侧
      spawnArgv: ["-e", 'console.error("实例锁冲突：另一个进程正在运行（pid 1），若确认无其他后台请删除该锁目录"); process.exit(1)'],
      exitGraceMs: 300,
    });
    assert.deepEqual(loser, { ok: true, spawned: false }, "败者必须等胜者就绪并复用，不得报错报为本进程拉起");
    const winnerResult = await winner;
    assert.equal(winnerResult.ok, true);

    await stopAndWait(controlDir);
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("后台在运行但令牌不符：明确认证指引，不重复拉起", async () => {
  const { dirs } = await makeTestDirs("od-badt", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  await writeModelsJson(dirs, await server.start());
  const controlDir = devOpts(dirs).controlDir;
  try {
    const first = await ensureBackend(devOpts(dirs));
    assert.equal(first.ok, true);

    // 破坏客户端手里的令牌文件（后台仍按启动时的令牌校验）
    const tokenFile = nodePath.join(controlDir, "owner.token");
    fs.writeFileSync(tokenFile, "0".repeat(64) + "\n", { mode: 0o600 });

    const start = Date.now();
    const r = await ensureBackend(devOpts(dirs));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /认证|令牌/, "必须给出令牌核对指引");
    assert.match(r.error, /后台在运行/, "后台其实在运行，不得归类为后台不在/启动失败");
    assert.ok(Date.now() - start < 5000, "socket 可连必须快速判定，不得白拉起一个进程");

    // 只应存在一个后台（锁登记的 pid 对应一个进程组）
    await stopBestEffort(controlDir, dirs.dataDir);
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await server.close();
    await cleanupDirs(dirs);
  }
});
