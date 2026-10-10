/**
 * ruukoto-code TUI 启动按需拉起本机后台（agent-direction issue 02）。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
 *
 * 测试接缝（预先约定）：
 * - src/control/ensure-backend.ts：ensureBackend 的可观察行为——探测、拉起、并发收敛、
 *   失败分类（启动失败附日志尾部）；拉起对象是真实 bin 后台进程（真实文件/socket/SQLite，
 *   模型打桩），与 issue 01 的真实/模拟边界一致；探测令牌与客户端同一来源
 *   （RUUKOTO_OWNER_TOKEN / RUUKOTO_OWNER_TOKEN_FILE / 控制目录 owner.token，评审 R3）；
 *   默认派生参数覆盖真实 bin 与 npm start TS 两种入口形态（TS 换固定 bin 服务入口，评审 R4）；
 *   锁竞争按本进程专用退出码归属判定（共享 spawn.log 的历史与并发内容不参与，评审 R7）；
 *   专用退出码只属已确认的活后台竞争：无法核实持锁身份按普通启动失败展示人工处理指引
 *   且锁保留，遗留锁按安全规则接管（评审 R10）；
 *   探测被拒保留原始原因（协议版本不兼容显示版本与升级指引，评审 R8）；传输中断或无
 *   凭据时重判当前 socket，已消失即进入按需拉起（评审 R9）；
 * - TUI 入口门控（按需拉起只属于 ruukoto-code；ruukoto 沿用显式 server/systemd）。
 *
 * 沿用既有规则不得破坏：实例锁是单实例仲裁；重连只恢复观察；关闭客户端不停止后台
 * 或取消任务；重开看到同一任务，不重复提交。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ensureBackend, tuiSpawnsBackendOnDemand } from "../src/control/ensure-backend.ts";
import { ControlClient } from "../src/control/client.ts";
import { INSTANCE_LOCK_EXIT_CODE } from "../src/core/instance-lock.ts";
import { authenticateClient, cleanupDirs, makeTestDirs, routeResponder, waitFor, writeModelsJson, createProjectSession, taskStatus } from "./helpers/testkit.ts";
import { killProcessTree } from "./helpers/backend.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const RUUKOTO_CODE_BIN = nodePath.join(repoRoot, "bin", "ruukoto-code.mjs");

// ---- 单元：门控 ----

test("门控：只有 ruukoto-code 的 TUI 按需拉起后台（ruukoto 沿用显式启动）", () => {
  assert.equal(tuiSpawnsBackendOnDemand("ruukoto-code"), true);
  assert.equal(tuiSpawnsBackendOnDemand("ruukoto"), false);
});

// ---- 进程级（真实 bin 后台、文件、socket、SQLite；模型打桩） ----

function devSpawnArgv(dirs: { dataDir: string; agentDir: string }): string[] {
  return [RUUKOTO_CODE_BIN, "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--tools", "mock"];
}

function cleanEnv(controlDir: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_CODE_CONTROL_DIR: controlDir };
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
    assert.match(r.error, /ruukoto-code config/, "未配置模型时必须给出配置入口提示");
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
      // 立即以锁冲突专用退出码退出的假子进程：并发拉起里败下阵来的那一侧
      spawnArgv: ["-e", `console.error("实例锁冲突：另一个进程正在运行（pid 1），若确认无其他后台请删除该锁目录"); process.exit(${INSTANCE_LOCK_EXIT_CODE})`],
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

test("后台在运行、默认令牌文件不可读：经 RUUKOTO_OWNER_TOKEN / RUUKOTO_OWNER_TOKEN_FILE 复用后台（评审 R3）", async () => {
  const { dirs } = await makeTestDirs("od-tok", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  await writeModelsJson(dirs, await server.start());
  const controlDir = devOpts(dirs).controlDir;
  const savedEnv = { token: process.env.RUUKOTO_OWNER_TOKEN, tokenFile: process.env.RUUKOTO_OWNER_TOKEN_FILE };
  // 探测读取本进程环境：起点置空，避免运维环境变量干扰
  delete process.env.RUUKOTO_OWNER_TOKEN;
  delete process.env.RUUKOTO_OWNER_TOKEN_FILE;
  try {
    const first = await ensureBackend(devOpts(dirs));
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    assert.equal(first.spawned, true);

    // 拥有者与后台不同 UID：原令牌文件不可读（模拟为不存在），但持有有效副本
    const tokenFile = nodePath.join(controlDir, "owner.token");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const copyPath = nodePath.join(dirs.root, "owner-token-copy");
    fs.copyFileSync(tokenFile, copyPath);
    fs.rmSync(tokenFile);

    process.env.RUUKOTO_OWNER_TOKEN_FILE = copyPath;
    const viaFile = await ensureBackend(devOpts(dirs));
    assert.deepEqual(viaFile, { ok: true, spawned: false }, "令牌副本可认证：复用已运行后台，不误判认证失败");

    delete process.env.RUUKOTO_OWNER_TOKEN_FILE;
    process.env.RUUKOTO_OWNER_TOKEN = token;
    const viaEnv = await ensureBackend(devOpts(dirs));
    assert.deepEqual(viaEnv, { ok: true, spawned: false }, "环境令牌可认证：复用已运行后台");

    process.env.RUUKOTO_OWNER_TOKEN = "0".repeat(64);
    const wrong = await ensureBackend(devOpts(dirs));
    assert.equal(wrong.ok, false, "错误凭据必须明确拒绝");
    if (!wrong.ok) assert.match(wrong.error, /后台在运行/, "socket 可连时按认证问题指引，不得再拉起第二个后台");

    delete process.env.RUUKOTO_OWNER_TOKEN;
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 }); // 恢复默认文件供优雅停止
    await stopAndWait(controlDir);
  } finally {
    if (savedEnv.token === undefined) delete process.env.RUUKOTO_OWNER_TOKEN; else process.env.RUUKOTO_OWNER_TOKEN = savedEnv.token;
    if (savedEnv.tokenFile === undefined) delete process.env.RUUKOTO_OWNER_TOKEN_FILE; else process.env.RUUKOTO_OWNER_TOKEN_FILE = savedEnv.tokenFile;
    await stopBestEffort(controlDir, dirs.dataDir);
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("默认拉起入口两种形态都能按需拉起：真实 bin 与 npm start 的 TS 入口，首开拉起、再开复用（评审 R4）", async () => {
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  const savedArgv1 = process.argv[1];
  delete process.env.RUUKOTO_OWNER_TOKEN;
  delete process.env.RUUKOTO_OWNER_TOKEN_FILE;
  // 默认派生参数按 argv[1] 形态区分：JS 入口（真实 bin）原样复用；npm start 下 tsx 执行
  // src/cli.ts，argv[1] 指向 TypeScript 文件，必须换用能加载 TypeScript 的固定 bin 服务入口
  const entries: Array<[string, string]> = [
    ["od-bin", RUUKOTO_CODE_BIN],
    ["od-npm", nodePath.join(repoRoot, "src", "cli.ts")],
  ];
  try {
    for (const [prefix, entry] of entries) {
      const { dirs } = await makeTestDirs(prefix, 0);
      await writeModelsJson(dirs, baseUrl);
      const controlDir = devOpts(dirs).controlDir;
      process.argv[1] = entry;
      try {
        const opts = { dataDir: dirs.dataDir, agentDir: dirs.agentDir, controlDir, env: cleanEnv(controlDir) };
        const first = await ensureBackend(opts);
        assert.equal(first.ok, true, `${prefix}：${first.ok ? "" : first.error}`);
        assert.equal(first.spawned, true);

        const client = await connectAuthed(controlDir);
        const idBefore = ((await client.handshake()) as any).snapshot?.instanceId;
        client.close();
        assert.ok(idBefore, `${prefix}：默认入口拉起的后台可认证握手`);

        const second = await ensureBackend(opts);
        assert.deepEqual(second, { ok: true, spawned: false }, `${prefix}：再开复用同一后台`);
        const again = await connectAuthed(controlDir);
        assert.equal(((await again.handshake()) as any).snapshot?.instanceId, idBefore, `${prefix}：复用不重启（数据实例标识不变）`);
        again.close();

        await stopAndWait(controlDir);
      } finally {
        await stopBestEffort(controlDir, dirs.dataDir);
        await cleanupDirs(dirs);
      }
    }
  } finally {
    process.argv[1] = savedArgv1;
    await server.close();
  }
});

test("历史日志里的锁错误不误判本次启动失败：保留失败原因与配置提示（评审 R7）", async () => {
  const { dirs } = await makeTestDirs("od-hist", 0);
  const controlDir = devOpts(dirs).controlDir;
  try {
    // 上一次拉起的遗留：spawn.log 尾部含历史实例锁冲突文本
    fs.mkdirSync(controlDir, { recursive: true });
    fs.writeFileSync(nodePath.join(controlDir, "spawn.log"), "实例锁冲突：另一个进程正在运行（pid 1），若确认无其他后台请删除该锁目录\n");
    // 本次后台因缺少模型退出（不写 models.json）：必须报启动失败，不得按锁竞争等到超时
    const r = await ensureBackend({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      controlDir,
      spawnArgv: devSpawnArgv(dirs),
      env: cleanEnv(controlDir),
      deadlineMs: 10_000,
      exitGraceMs: 1500,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /后台启动失败/, "历史锁错误不得把本次失败误判为锁竞争等待");
    assert.doesNotMatch(r.error, /等待后台就绪超时/);
    assert.match(r.error, /no_model|未找到可用模型/, "保留本次启动的实际失败原因");
    assert.match(r.error, /ruukoto-code config/, "保留模型配置指引");
    assert.match(r.error, /spawn\.log/);
    assert.ok(!fs.existsSync(nodePath.join(controlDir, "control.sock")), "启动失败不得留下可连接后台");
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await cleanupDirs(dirs);
  }
});

test("协议版本不兼容的探测保留原始原因：显示版本与升级指引，不核对令牌、不拉起（评审 R8）", async () => {
  const { dirs } = await makeTestDirs("od-proto", 0);
  const controlDir = devOpts(dirs).controlDir;
  fs.mkdirSync(controlDir, { recursive: true });
  // 有效令牌副本就位：问题不在令牌
  fs.writeFileSync(nodePath.join(controlDir, "owner.token"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  const socketPath = nodePath.join(controlDir, "control.sock");
  // 模拟旧版本服务端：任意请求按真实 ControlServer 形状回 protocol_version
  const stub = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    conn.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx === -1) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as { id?: string };
        conn.write(
          JSON.stringify({
            v: 8,
            id: req.id ?? "",
            ok: false,
            error: { code: "protocol_version", message: "协议版本不兼容：服务端 v8，请求 v9；请升级客户端" },
          }) + "\n",
        );
      }
    });
  });
  await new Promise<void>((resolve) => stub.listen(socketPath, resolve));
  try {
    const r = await ensureBackend({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      controlDir,
      spawnArgv: devSpawnArgv(dirs), // 正确分类时不会走到拉起；误入会立即失败（无 models.json）
      env: cleanEnv(controlDir),
      deadlineMs: 3000,
      exitGraceMs: 500,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /协议版本不兼容/, "展示原始拒绝原因而非统一的令牌提示");
    assert.match(r.error, /v8/, "显示服务端版本");
    assert.match(r.error, /升级/, "给出升级指引");
    assert.doesNotMatch(r.error, /RUUKOTO_OWNER_TOKEN/, "不得提示核对有效令牌");
    assert.match(r.error, /不重复拉起/);
    assert.ok(!fs.existsSync(nodePath.join(controlDir, "spawn.log")), "不得拉起第二个后台");
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    await stopBestEffort(controlDir, dirs.dataDir);
    await cleanupDirs(dirs);
  }
});

test("多字节历史日志不干扰锁竞争判定：本次锁竞争按退出码归属，等满时限（评审 R7 复审）", async () => {
  const { dirs } = await makeTestDirs("od-multi", 0);
  const controlDir = devOpts(dirs).controlDir;
  try {
    // 大段中文历史（多字节）：锁竞争判定按本进程退出码归属，历史内容再多也不参与
    fs.mkdirSync(controlDir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(controlDir, "spawn.log"),
      "实例锁冲突：另一个进程正在运行（pid 1），若确认无其他后台请删除该锁目录\n".repeat(5),
    );
    // 本次启动败于实例锁竞争（无胜者）：必须按锁竞争等满时限，不得报启动失败
    const r = await ensureBackend({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      controlDir,
      spawnArgv: ["-e", `console.error("实例锁冲突：另一个进程正在运行（pid 1），若确认无其他后台请删除该锁目录"); process.exit(${INSTANCE_LOCK_EXIT_CODE})`],
      env: cleanEnv(controlDir),
      deadlineMs: 2500,
      exitGraceMs: 300,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /等待后台就绪超时/, "锁竞争必须等满时限复用胜者（无胜者则按时限标注），不得误判启动失败");
    assert.doesNotMatch(r.error, /后台启动失败/);
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await cleanupDirs(dirs);
  }
});

test("并发拉起窗口内他进程锁错误不归属本进程：各自失败各自分类（评审 R7 第三轮）", async () => {
  const { dirs } = await makeTestDirs("od-conc", 0);
  const controlDir = devOpts(dirs).controlDir;
  try {
    // A：普通启动失败（350ms 后 no_model 退出）；B：100ms 后以锁冲突专用退出码退出。
    // 共享 spawn.log 里 B 的锁文本落在 A 的日志段中——归属判定不得采用共享日志内容
    const runA = ensureBackend({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      controlDir,
      spawnArgv: ["-e", 'setTimeout(() => { console.error("no_model: 未找到可用模型（校验 models.json 与 ruukoto-code config）"); process.exit(1); }, 350)'],
      env: cleanEnv(controlDir),
      deadlineMs: 5000,
      exitGraceMs: 300,
    });
    const runB = ensureBackend({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      controlDir,
      spawnArgv: ["-e", `setTimeout(() => { console.error("实例锁冲突：另一个进程正在运行（pid 1），若确认无其他后台请删除该锁目录"); process.exit(${INSTANCE_LOCK_EXIT_CODE}); }, 100)`],
      env: cleanEnv(controlDir),
      deadlineMs: 2000,
      exitGraceMs: 300,
    });
    const [ra, rb] = await Promise.all([runA, runB]);
    assert.equal(ra.ok, false);
    if (!ra.ok) {
      assert.match(ra.error, /后台启动失败/, "A 是普通启动失败：B 的锁文本不得让 A 按锁竞争等待");
      assert.doesNotMatch(ra.error, /等待后台就绪超时/);
      assert.match(ra.error, /no_model|未找到可用模型/, "A 保留本次启动的实际失败原因");
      assert.match(ra.error, /ruukoto-code config/, "A 保留模型配置指引");
    }
    assert.equal(rb.ok, false);
    if (!rb.ok) assert.match(rb.error, /等待后台就绪超时/, "B 退出码为锁冲突：按锁竞争等胜者（无胜者按时限标注）");
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await cleanupDirs(dirs);
  }
});

test("探测期间后台退出不被误判为认证拒绝：socket 消失后进入按需拉起（评审 R9）", async () => {
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  try {
    for (const phase of ["auth", "handshake"] as const) {
      const { dirs } = await makeTestDirs(`od-drop-${phase === "auth" ? "a" : "h"}`, 0);
      await writeModelsJson(dirs, baseUrl);
      const controlDir = devOpts(dirs).controlDir;
      fs.mkdirSync(controlDir, { recursive: true });
      // 令牌有效：问题不在令牌；探测连上后后台即退出（删 socket、断开、不发拒绝应答）
      fs.writeFileSync(nodePath.join(controlDir, "owner.token"), `${"a".repeat(64)}\n`, { mode: 0o600 });
      const socketPath = nodePath.join(controlDir, "control.sock");
      let conns: net.Socket[] = [];
      const stub = net.createServer((conn) => {
        conns.push(conn);
        conn.setEncoding("utf8");
        let buf = "";
        conn.on("data", (chunk: string) => {
          buf += chunk;
          const idx = buf.indexOf("\n");
          if (idx === -1) return;
          const req = JSON.parse(buf.slice(0, idx)) as { id?: string; op?: string };
          buf = buf.slice(idx + 1);
          if (req.op === "auth" && phase === "handshake") {
            conn.write(JSON.stringify({ v: 9, id: req.id ?? "", ok: true, result: { authenticated: true } }) + "\n");
            return;
          }
          // 后台退出：收监听、删 socket 文件、断开全部连接（不回复任何拒绝应答）
          fs.rmSync(socketPath, { force: true });
          stub.close();
          for (const c of conns) c.destroy();
        });
      });
      await new Promise<void>((resolve) => stub.listen(socketPath, resolve));
      try {
        const r = await ensureBackend({
          dataDir: dirs.dataDir,
          agentDir: dirs.agentDir,
          controlDir,
          spawnArgv: devSpawnArgv(dirs),
          env: cleanEnv(controlDir),
          deadlineMs: 20_000,
        });
        assert.equal(r.ok, true, `${phase} 期间后台退出：socket 已不可达必须进入按需拉起（${r.ok ? "" : r.error}）`);
        assert.equal(r.spawned, true, `${phase} 期间后台退出：不得误报后台在运行并停在令牌核对`);

        const client = await connectAuthed(controlDir);
        assert.ok(((await client.handshake()) as any).snapshot?.instanceId, `${phase}：拉起后可认证握手`);
        client.close();
        await stopAndWait(controlDir);
      } finally {
        for (const c of conns) c.destroy();
        await new Promise<void>((resolve) => stub.close(() => resolve()));
        await stopBestEffort(controlDir, dirs.dataDir);
        await cleanupDirs(dirs);
      }
    }
  } finally {
    await server.close();
  }
});

test("无法核实持锁身份不按锁竞争等待：普通启动失败展示人工处理指引，锁保留（评审 R10）", async () => {
  const { dirs } = await makeTestDirs("od-unver", 0);
  const controlDir = devOpts(dirs).controlDir;
  try {
    // 预置锁：记录的 PID 指向存活进程；子进程 PATH="" 使 ps 无法运行，身份无法核实
    const lockDir = nodePath.join(dirs.dataDir, "runtime.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const ownerJson = JSON.stringify({ pid: process.pid, command: "ruukoto-backend node bin/ruukoto-code.mjs server", startedAt: new Date().toISOString() });
    fs.writeFileSync(nodePath.join(lockDir, "owner.json"), ownerJson);
    const r = await ensureBackend({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      controlDir,
      spawnArgv: devSpawnArgv(dirs),
      env: { ...cleanEnv(controlDir), PATH: "" },
      deadlineMs: 15_000,
      exitGraceMs: 500,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /后台启动失败/, "无法核实持锁身份不是锁竞争：不得按等待胜者处理");
    assert.doesNotMatch(r.error, /等待后台就绪超时/);
    assert.match(r.error, /无法核实进程身份/, "展示锁错误的原始原因");
    assert.match(r.error, /人工确认/, "保留人工处理指引");
    // 锁必须原样保留（未经确认绝不静默删除）
    assert.equal(fs.readFileSync(nodePath.join(lockDir, "owner.json"), "utf8"), ownerJson, "核实失败不得删除或接管锁");
    assert.ok(!fs.existsSync(nodePath.join(controlDir, "control.sock")), "失败不得留下可连接后台");
  } finally {
    // 测试断言「锁保留」后先自除种子锁：stopBestEffort 按 owner.json 杀进程组，
    // 种子 PID 是本测试进程，不删会自杀
    fs.rmSync(nodePath.join(dirs.dataDir, "runtime.lock"), { recursive: true, force: true });
    await stopBestEffort(controlDir, dirs.dataDir);
    await cleanupDirs(dirs);
  }
});

test("遗留锁（PID 已死）不影响按需拉起：按既有安全规则接管（评审 R10）", async () => {
  const { dirs } = await makeTestDirs("od-stale", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  await writeModelsJson(dirs, await server.start());
  const controlDir = devOpts(dirs).controlDir;
  try {
    // 确定的死 PID：刚退出的子进程
    const dead = childProcess.spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((r) => dead.once("exit", r));
    assert.notEqual(dead.pid, undefined);
    const lockDir = nodePath.join(dirs.dataDir, "runtime.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(lockDir, "owner.json"),
      JSON.stringify({ pid: dead.pid, command: "ruukoto-backend node bin/ruukoto-code.mjs server", startedAt: new Date().toISOString() }),
    );
    const r = await ensureBackend(devOpts(dirs));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.spawned, true, "遗留锁按安全规则接管，照常首次拉起");
    const owner = JSON.parse(fs.readFileSync(nodePath.join(lockDir, "owner.json"), "utf8"));
    assert.notEqual(owner.pid, dead.pid, "接管后登记新实例");

    const client = await connectAuthed(controlDir);
    assert.ok(((await client.handshake()) as any).snapshot?.instanceId, "接管后可认证握手");
    client.close();
    await stopAndWait(controlDir);
  } finally {
    await stopBestEffort(controlDir, dirs.dataDir);
    await server.close();
    await cleanupDirs(dirs);
  }
});
