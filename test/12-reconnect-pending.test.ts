import { product as personalProduct } from "../apps/ruukoto/src/product.ts";
/**
 * 集成：连接恢复与输入提交去重（issue 04 §3）。
 *
 * 覆盖：握手期间实时事件的缓冲与顺序、重复事件丢弃、序号缺口触发重同步、
 * 断线退避重连与认证失败停止、数据实例变更通知；待确认记录的保存/核实/
 * 重试/冲突/实例不匹配；应答丢失后同一输入只对应一个任务。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ControlConnection, type ConnectionState } from "@ruukoto/control/connection.ts";
import { ControlClientError, type ControlTransport } from "@ruukoto/control/client.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard, type SubmitOutcome } from "@ruukoto/control/submission.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import {
  startTestRuntime,
  routeResponder,
  waitFor,
  createProjectSession,
  taskStatus,
  connectAuthedClient,
  lastUserText,
} from "./helpers/testkit.ts";
import { FakeTransport, fakeControl, fakeSnapshot } from "./helpers/fake-control.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";

// ---------- 假客户端（脚本化握手与事件推送，test/helpers/fake-control.ts） ----------

function event(seq: number): PersistentEvent {
  return {
    seq,
    taskId: null,
    sessionId: null,
    body: { type: "backend.stopping", reason: `e${seq}` },
    createdAt: new Date().toISOString(),
  };
}

interface ConnLog {
  states: Array<[ConnectionState, string | undefined]>;
  snapshots: Array<{ seq: number; resync: boolean; instanceChanged: boolean }>;
  events: Array<{ seq: number; kind: string }>;
}

function makeConn(
  config: Partial<ConstructorParameters<typeof ControlConnection>[0]>,
  log: ConnLog,
): { conn: ControlConnection } {
  const conn = new ControlConnection(
    { socketPath: "/tmp/fake.sock", token: "t".repeat(32), reconnectInitialMs: 20, reconnectMaxMs: 80, ...config },
    {
      onState: (s, d) => log.states.push([s, d]),
      onSnapshot: (r, ctx) => log.snapshots.push({ seq: r.seq, resync: ctx.resync, instanceChanged: ctx.instanceChanged }),
      onEvent: (e, kind) => log.events.push({ seq: e.seq, kind }),
    },
  );
  return { conn };
}

test("握手期间到达的实时事件被缓冲，快照安装后按序应用", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  const fake = new FakeTransport({
    handshake: async (_since, client) => {
      client.emit(event(6)); // 握手进行中到达的实时事件
      client.emit(event(7));
      return { seq: 5, replay: [], snapshot: fakeSnapshot() };
    },
  });
  const { conn } = makeConn({ clientFactory: async () => fake }, log);
  await conn.start();
  assert.deepEqual(
    log.snapshots.map((s) => s.seq),
    [5],
  );
  assert.deepEqual(
    log.events.map((e) => [e.seq, e.kind]),
    [
      [6, "live"],
      [7, "live"],
    ],
    "缓冲事件必须在快照之后按序应用",
  );
  assert.equal(conn.getSeq(), 7);
  assert.equal(conn.state, "online");
  conn.close();
});

test("重复事件丢弃；序号缺口触发重同步", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  let handshakeCount = 0;
  const fake = new FakeTransport({
    handshake: async () => {
      handshakeCount++;
      return { seq: handshakeCount === 1 ? 5 : 7, replay: [], snapshot: fakeSnapshot() };
    },
  });
  const { conn } = makeConn({ clientFactory: async () => fake }, log);
  await conn.start();
  fake.emit(event(6));
  fake.emit(event(6)); // 重复：丢弃
  assert.equal(conn.getSeq(), 6);
  fake.emit(event(9)); // 缺口：期望 7
  await waitFor("重同步完成", () => conn.getSeq() === 7 && handshakeCount === 2);
  assert.deepEqual(
    log.events.filter((e) => e.kind === "live").map((e) => e.seq),
    [6],
    "缺口事件不得直接应用",
  );
  assert.equal(log.snapshots.length, 2, "缺口后重新安装快照");
  assert.equal(log.snapshots[1]!.resync, true);
  conn.close();
});

test("断线退避重连：补发只用于补齐显示，实时事件无缝继续", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  const clients: FakeTransport[] = [];
  const factory = async (): Promise<ControlTransport> => {
    const client = new FakeTransport({
      handshake: async (since) => {
        if (since === undefined) return { seq: 5, replay: [], snapshot: fakeSnapshot() };
        // 重连：补发 (5, 8]，快照序号 8
        return { seq: 8, replay: [event(6), event(7), event(8)], snapshot: fakeSnapshot() };
      },
    });
    clients.push(client);
    return client;
  };
  const { conn } = makeConn({ clientFactory: factory }, log);
  await conn.start();
  assert.equal(conn.getSeq(), 5);
  clients[0]!.drop();
  await waitFor("重连上线", () => conn.state === "online" && conn.getSeq() === 8);
  assert.deepEqual(
    log.events.map((e) => [e.seq, e.kind]),
    [
      [6, "replay"],
      [7, "replay"],
      [8, "replay"],
    ],
    "补发事件必须标记为 replay（只补齐显示，不回滚状态）",
  );
  assert.equal(log.snapshots[1]!.resync, true);
  // 实时事件继续
  clients[1]!.emit(event(9));
  assert.equal(conn.getSeq(), 9);
  conn.close();
});

test("认证失败与协议不兼容：进入 failed，不自动重试", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  let connects = 0;
  const factory = async (): Promise<ControlTransport> => {
    connects++;
    return new FakeTransport({
      authenticate: async () => {
        throw new ControlClientError("unauthorized", "拥有者令牌无效", "rejected");
      },
      handshake: async () => ({ seq: 0, replay: [], snapshot: fakeSnapshot() }),
    });
  };
  const { conn } = makeConn({ clientFactory: factory, reconnectInitialMs: 10 }, log);
  await assert.rejects(() => conn.start());
  assert.equal(conn.state, "failed");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(connects, 1, "认证失败不得自动重试");
});

test("认证超时与认证中途断线：退避重连，不进入 failed", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  let attempt = 0;
  const ctl = fakeControl({
    authenticate: async (transport) => {
      attempt++;
      if (attempt === 1) throw new ControlClientError("request_timeout", "请求超时：auth", "unknown");
      if (attempt === 2) {
        transport.drop();
        throw new ControlClientError("connection_closed", "连接已关闭", "disconnected");
      }
    },
  });
  const { conn } = makeConn({ clientFactory: ctl.factory }, log);
  await assert.rejects(() => conn.start(), /请求超时/);
  await waitFor("重连上线", () => conn.state === "online");
  assert.equal(attempt, 3);
  assert.ok(!log.states.some(([s]) => s === "failed"), "应答丢失不是明确拒绝，不得停止重连");
  conn.close();
});

test("首次建连失败（后台未起）：退避后连上", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  const ctl = fakeControl();
  let refused = 0;
  const factory = async (): Promise<ControlTransport> => {
    if (refused++ < 2) throw new ControlClientError("connection_error", "Error: connect ENOENT", "not_sent");
    return ctl.factory();
  };
  const { conn } = makeConn({ clientFactory: factory }, log);
  await assert.rejects(() => conn.start(), /ENOENT/);
  assert.equal(conn.state, "reconnecting");
  await waitFor("连上", () => conn.state === "online");
  assert.equal(log.snapshots.length, 1);
  conn.close();
});

test("协议版本不兼容（握手阶段）：进入 failed，不自动重试", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  let connects = 0;
  const factory = async (): Promise<ControlTransport> => {
    connects++;
    return new FakeTransport({
      handshake: async () => {
        throw new ControlClientError("protocol_version", "协议版本不兼容：服务端 v3，请求 v2；请升级客户端", "rejected");
      },
    });
  };
  const { conn } = makeConn({ clientFactory: factory, reconnectInitialMs: 10 }, log);
  await assert.rejects(() => conn.start(), /协议版本不兼容/);
  assert.equal(conn.state, "failed");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(connects, 1, "协议不兼容不得自动重试");
});

test("数据实例变更：重连后 onSnapshot 明确通知", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  const clients: FakeTransport[] = [];
  const factory = async (): Promise<ControlTransport> => {
    const client = new FakeTransport({
      handshake: async (since) =>
        since === undefined
          ? { seq: 5, replay: [], snapshot: fakeSnapshot({ instanceId: clients.length === 1 ? "inst-1" : "inst-2" }) }
          : { seq: 5, replay: [], snapshot: fakeSnapshot({ instanceId: "inst-2" }) },
    });
    clients.push(client);
    return client;
  };
  const { conn } = makeConn({ clientFactory: factory }, log);
  await conn.start();
  clients[0]!.drop();
  await waitFor("重连上线", () => conn.state === "online" && log.snapshots.length === 2);
  assert.equal(log.snapshots[1]!.instanceChanged, true, "新数据实例必须明确通知");
  conn.close();
});

// ---------- 待确认请求记录 ----------

test("待确认记录：原子保存、读取、清除；损坏文件保留并列出", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-pending-"));
  const store = new PendingRequestStore(dir);
  const rec: PendingRequest = {
    requestId: "req_abc123",
    op: "submit",
    params: { session_id: "sess_1", request_id: "req_abc123", input: "原文" },
    instanceId: "inst-1",
    createdAt: new Date().toISOString(),
  };
  store.save(rec);
  const stat = fs.statSync(path.join(dir, "req_abc123.json"));
  assert.equal(stat.mode & 0o777, 0o600, "记录必须 0600");
  assert.deepEqual(store.list().records, [rec]);
  // 损坏文件：保留并列出，不静默丢弃
  fs.writeFileSync(path.join(dir, "broken.json"), "not json");
  const list = store.list();
  assert.equal(list.records.length, 1);
  assert.deepEqual(list.corrupt, ["broken.json"]);
  store.clear("req_abc123");
  assert.equal(store.list().records.length, 0);
  assert.equal(store.list().corrupt.length, 1);
});

// ---------- 提交守护（真实后台） ----------

async function startGuardRuntime() {
  const t = await startTestRuntime(
    "guard",
    routeResponder([{ match: /./, respond: (_req, text) => ({ kind: "text", text: `完成:${text.slice(0, 20)}` }) }]),
  );
  const pendingDir = path.join(t.dirs.root, "pending");
  const store = new PendingRequestStore(pendingDir);
  const conn = new ControlConnection(
    { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
    { onState: () => {}, onSnapshot: () => {}, onEvent: () => {} },
  );
  await conn.start();
  const guard = new SubmissionGuard(store, conn);
  return { t, store, conn, guard };
}

test("提交结果分类：未发送与明确拒绝清除记录；应答丢失（含坏帧断线）保留待核实", async () => {
  const log: ConnLog = { states: [], snapshots: [], events: [] };
  const store = new PendingRequestStore(fs.mkdtempSync(path.join(os.tmpdir(), "pending-outcome-")));
  let reply: "reject" | "timeout" | "connection_closed" | "bad_frame" = "reject";
  const ctl = fakeControl({
    handlers: {
      submit: (_params, transport) => {
        if (reply === "reject") return Promise.reject(new ControlClientError("invalid_params", "输入为空", "rejected"));
        if (reply === "timeout") return Promise.reject(new ControlClientError("request_timeout", "请求超时：submit", "unknown"));
        transport.drop(reply, "断线");
        return new Promise(() => {});
      },
    },
  });
  const { conn } = makeConn({ clientFactory: ctl.factory }, log);
  await conn.start();
  const guard = new SubmissionGuard(store, conn);
  const submit = () => guard.submit("submit", { session_id: "s", input: "x", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
  const pending = () => store.list().records.length;

  assert.equal((await submit()).kind, "rejected");
  assert.equal(pending(), 0, "明确拒绝清除记录");
  reply = "timeout";
  assert.deepEqual(pick(await submit()), ["pending_verification", "unknown"]);
  reply = "connection_closed";
  assert.deepEqual(pick(await submit()), ["pending_verification", "disconnected"]);
  await waitFor("重连上线", () => conn.state === "online" && ctl.transports.length === 2);
  reply = "bad_frame";
  assert.deepEqual(pick(await submit()), ["pending_verification", "disconnected"], "坏帧断线同样是应答丢失");
  assert.equal(pending(), 3, "应答丢失保留待核实");
  await waitFor("再次重连", () => conn.state === "online" && ctl.transports.length === 3);
  ctl.transports[2]!.drop();
  assert.equal((await submit()).kind, "not_sent", "断线后、重连前：连接层拒绝发送");
  assert.equal(pending(), 3, "未发送清除记录");
  conn.close();

  function pick(outcome: SubmitOutcome): [string, string | undefined] {
    return [outcome.kind, outcome.kind === "pending_verification" ? outcome.outcome : undefined];
  }
});

test("提交成功：记录清除；同一输入只产生一个任务", async () => {
  const { t, store, conn, guard } = await startGuardRuntime();
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const outcome = await guard.submit("submit", { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, input: "写一个文件" });
    assert.equal(outcome.kind, "accepted");
    assert.equal(store.list().records.length, 0, "确认接收后清除记录");
    await waitFor("任务完成", async () => (await taskStatus(t.client, (outcome as any).task.id)).task.status === "completed");
    conn.close();
  } finally {
    await t.shutdown();
  }
});

test("待确认记录写入失败：不得发送请求", async () => {
  const { t, conn, guard } = await startGuardRuntime();
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 让保存失败：记录目录只读
    fs.chmodSync((guard as any).store.dir, 0o500);
    await assert.rejects(() => guard.submit("submit", { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, input: "不应发送" }));
    fs.chmodSync((guard as any).store.dir, 0o700);
    const found = await conn.request("find_task", { session_id: sessionId, request_id: "never" });
    assert.equal(found.task, null);
    const tasks = (await conn.request("list_tasks", { session_id: sessionId })).tasks;
    assert.equal(tasks.length, 0, "保存失败时不得发送请求");
    conn.close();
  } finally {
    await t.shutdown();
  }
});

test("应答丢失：重连核实关联原任务，不重复启动", async () => {
  const { t, store, conn, guard } = await startGuardRuntime();
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 模拟"提交落盘但应答丢失"：任务已由后台接收，客户端只留下了待确认记录
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      request_id: "lost-ack-1",
      input: "丢失应答的输入",
    });
    store.save({
      requestId: "lost-ack-1",
      op: "submit",
      params: { session_id: sessionId, request_id: "lost-ack-1", input: "丢失应答的输入" },
      instanceId: conn.instanceId!,
      createdAt: new Date().toISOString(),
    });
    const outcomes = await guard.reconcileAll();
    assert.deepEqual(outcomes, [{ kind: "linked", requestId: "lost-ack-1", taskId: task.id }]);
    assert.equal(store.list().records.length, 0);
    const tasks = (await conn.request("list_tasks", { session_id: sessionId })).tasks;
    assert.equal(tasks.length, 1, "同一输入只对应一个任务");
    conn.close();
  } finally {
    await t.shutdown();
  }
});

test("明确未接收：以原键原参数重试；同键异参展示冲突", async () => {
  const { t, store, conn, guard } = await startGuardRuntime();
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 记录存在但后台从未接收 → 原键重发
    store.save({
      requestId: "never-sent-1",
      op: "submit",
      params: { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, request_id: "never-sent-1", input: "重发的输入" },
      instanceId: conn.instanceId!,
      createdAt: new Date().toISOString(),
    });
    const outcomes = await guard.reconcileAll();
    assert.equal(outcomes[0]!.kind, "resent");
    const taskId = (outcomes[0] as any).taskId;
    const detail = await taskStatus(t.client, taskId);
    assert.equal(detail.task.input, "重发的输入", "必须以原参数重发");
    assert.equal(detail.task.requestId, "never-sent-1", "必须以原键重发");

    // 同键异参：冲突展示，不换新键
    const conflict = await guard.submit("submit", { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, input: "不同的输入" }, { requestId: "never-sent-1" });
    assert.equal(conflict.kind, "conflict");
    conn.close();
  } finally {
    await t.shutdown();
  }
});

test("数据实例不匹配：保留待核实，不向空后台重发", async () => {
  const { t, store, conn, guard } = await startGuardRuntime();
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    store.save({
      requestId: "foreign-1",
      op: "submit",
      params: { session_id: sessionId, request_id: "foreign-1", input: "属于旧数据实例" },
      instanceId: "some-other-instance",
      createdAt: new Date().toISOString(),
    });
    const outcomes = await guard.reconcileAll();
    assert.deepEqual(outcomes, [{ kind: "foreign_instance", requestId: "foreign-1" }]);
    assert.equal(store.list().records.length, 1, "记录保留待拥有者处理");
    const found = await conn.request("find_task", { session_id: sessionId, request_id: "foreign-1" });
    assert.equal(found.task, null, "不得向新后台重发");
    conn.close();
  } finally {
    await t.shutdown();
  }
});

test("补发超过 5000 条：cursor_too_old 后重新同步快照，不丢状态", async () => {
  const t = await startTestRuntime("cursor-old", async () => ({ kind: "text", text: "ok" }));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 直接追加超过补发上限的事件（不经任务执行，快速构造）
    for (let i = 0; i < 5100; i++) {
      t.runtime.store.withTx(() => {
        t.runtime.store.appendEvent({ type: "backend.stopping", reason: `filler-${i}` }, { sessionId });
      });
    }
    // 客户端从旧游标连接：服务端拒绝补发
    const stale = await connectAuthedClient(t.runtime);
    await assert.rejects(() => stale.handshake(1), (err: any) => err.code === "cursor_too_old");
    stale.close();

    // ControlConnection 以旧游标重连：自动退化为全量快照同步
    const log: ConnLog = { states: [], snapshots: [], events: [] };
    const conn = new ControlConnection(
      { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
      {
        onState: (s, d) => log.states.push([s, d]),
        onSnapshot: (r, ctx) => log.snapshots.push({ seq: r.seq, resync: ctx.resync, instanceChanged: ctx.instanceChanged }),
        onEvent: (e, kind) => log.events.push({ seq: e.seq, kind }),
      },
    );
    await conn.start();
    const seqAfterFirst = conn.getSeq();
    conn.close();
    // 模拟"带着旧游标重连"：新建连接但 since 远落后于当前
    const conn2 = new ControlConnection(
      { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
      {
        onState: (s, d) => log.states.push([s, d]),
        onSnapshot: (r, ctx) => log.snapshots.push({ seq: r.seq, resync: ctx.resync, instanceChanged: ctx.instanceChanged }),
        onEvent: (e, kind) => log.events.push({ seq: e.seq, kind }),
      },
    );
    (conn2 as any).appliedSeq = 1; // 旧游标
    await conn2.start();
    assert.equal(conn2.state, "online");
    assert.ok(conn2.getSeq() >= seqAfterFirst, "重同步后游标覆盖到最新");
    conn2.close();
  } finally {
    await t.shutdown();
  }
});

test("后台重启：重连后看到中断任务与真实状态，不自动恢复队列", async () => {
  const t = await startTestRuntime("restart", async (req) => {
    const text = lastUserText(req);
    if (text.includes("长跑")) {
      await new Promise((r) => setTimeout(r, 30_000));
    }
    return { kind: "text", text: `完成:${text.slice(0, 20)}` };
  });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { session_id: sessionId, request_id: "rr-1", input: "长跑任务",
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
    await waitFor("任务运行", async () => (await taskStatus(t.client, task.id)).task.status === "running");

    // 停止后台（优雅停止即中断任务）；随后在同一数据目录重启（实例标识保留）
    const instanceBefore = t.runtime.store.db.getInstanceId();
    await t.runtime.stop("test_restart");
    const { Runtime } = await import("@ruukoto/runtime/runtime.ts");
    const { ControlServer } = await import("@ruukoto/control/server.ts");
    const runtime2 = await Runtime.start({
    product: personalProduct.runtime,
      dataDir: t.dirs.dataDir,
      agentDir: t.dirs.agentDir,
      socketPath: t.runtime.socketPath(),
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
      toolFactory: (ctx) => createMockTools(ctx),
    });
    await ControlServer.start(runtime2);
    assert.equal(runtime2.store.db.getInstanceId(), instanceBefore, "后台重启保留数据实例标识");

    // TUI 连接层重连：看到中断任务，不自动恢复队列
    const log: ConnLog = { states: [], snapshots: [], events: [] };
    const conn = new ControlConnection(
      { socketPath: runtime2.socketPath(), token: readOwnerToken(runtime2.controlDir())! },
      {
        onState: (s, d) => log.states.push([s, d]),
        onSnapshot: (r, ctx) => log.snapshots.push({ seq: r.seq, resync: ctx.resync, instanceChanged: ctx.instanceChanged }),
        onEvent: (e, kind) => log.events.push({ seq: e.seq, kind }),
      },
    );
    await conn.start();
    assert.equal(conn.state, "online");
    const detail = await conn.request<any>("get_task", { task_id: task.id });
    assert.equal(detail.task.status, "interrupted");
    assert.equal(detail.task.interruptReason, "backend_stop");
    const session = await conn.request<any>("list_tasks", { session_id: sessionId });
    assert.ok(session.tasks.length >= 1);
    // 重连只恢复观察：中断任务保持中断，不自动重跑
    const after = await conn.request<any>("get_task", { task_id: task.id });
    assert.equal(after.task.status, "interrupted", "重连后任务不被自动恢复");
    conn.close();
    await runtime2.stop("test_end");
  } finally {
    await t.shutdown();
  }
});
