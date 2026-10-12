import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";
/** 公共 manager 接口 + 真实 Db/Store；模型与执行入口用桩控制事务和等待窗口。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { randomId, type ModelSelection, type SubAgentMessage, type Task, type WorkDelegation } from "@ruukoto/core/types.ts";
import { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { SubAgentDelegationError, SubAgentManager, type SubAgentManagerDeps } from "@ruukoto/runtime/subagents.ts";
import { WorkCopyManager } from "@ruukoto/runtime/work-copy.ts";

const DEFAULT: ModelSelection = { provider: "mock", modelId: "default", thinkingLevel: "off" };
const MAIN: ModelSelection = { ...DEFAULT, modelId: "main-override" };
const configBusy = () => new SubAgentDelegationError("model_config_busy", "配置正在应用");

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function kit(parentKind: "main" | "dev" = "main") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-lifecycle-")));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const db = new Db(dataDir);
  const store = new Store(db);
  const project = store.createProject("lifecycle");
  let inTx = false;
  const withTx = store.withTx.bind(store);
  store.withTx = <T>(fn: () => T): T => withTx(() => {
    inTx = true;
    try { return fn(); } finally { inTx = false; }
  });
  const session = (name: string) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    const stat = fs.statSync(cwd);
    return store.createSession({ projectId: project.id, cwd, cwdReal: cwd, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: randomId("pi"), confirmTools: [], modelSelection: DEFAULT });
  };
  const parentSession = session("parent");
  if (parentKind === "main") store.insertAgentRole({ id: "main", projectId: project.id, sessionId: parentSession.id, workDir: parentSession.cwd, modelSelection: MAIN, tools: [], createdAt: parentSession.createdAt });
  const task = (sessionId: string, overrides: Partial<Parameters<Store["insertQueuedTask"]>[0]> = {}) => store.withTx(() => store.insertQueuedTask({
    sessionId, requestId: randomId("req"), input: "执行", modelSelection: DEFAULT, submissionDigest: randomId("digest"), ...overrides,
  }).task);
  const complete = (t: Task, result = true) => {
    store.transitionTask(t.id, ["queued", "running"], "completed", { endedAt: new Date().toISOString() });
    if (result) store.setTaskResult(t.id, "完成", "{}");
    return store.getTask(t.id)!;
  };
  const parent = complete(task(parentSession.id, { accessMode: "full_access" }));
  const sub = session("child");
  const agent = { id: randomId("sagent"), parentSessionId: parentSession.id, sessionId: sub.id, workDir: sub.cwd, activeWorkId: null, currentTaskId: null, state: "idle" as const, closedAt: null, closedBy: null, createdAt: sub.createdAt };
  store.insertSubAgent(agent);
  const newWork = (writeTarget: WorkDelegation["writeTarget"] = null) => {
    const work: WorkDelegation = { id: randomId("work"), parentSessionId: parentSession.id, originTaskId: parent.id, subAgentId: agent.id, requestKey: randomId("key"), paramsDigest: "work", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget, createdAt: new Date().toISOString() };
    store.insertWorkDelegation(work);
    return work;
  };
  const work = newWork();
  store.setSubAgentState(agent.id, "idle", { activeWorkId: work.id, currentTaskId: null });
  const readScope = { paths: [{ path: parentSession.cwd, dev: parentSession.cwdDev, ino: parentSession.cwdIno, purpose: "既有只读范围" }], sourceRefs: [] };
  const child = complete(task(sub.id, { parentTaskId: parent.id, workId: work.id, subAgentId: agent.id, readScope }));
  const kicks: string[] = [];
  const resumed: string[] = [];
  const resolved: ModelSelection[] = [];
  const parentDelivery = new ParentDelivery({
    store,
    submit: async (input) => store.withTx(() => store.insertQueuedTask({ ...input, submissionDigest: input.requestId }).task),
    defaultModelSelection: () => DEFAULT,
    readReply: () => null,
    isReviewEvent: () => false,
    resultNotice: () => null,
    sendWorkReport: () => {},
  });
  const deps: SubAgentManagerDeps = {
    store, dataDir, workRoot: path.join(root, "sub-agents"),
    workCopies: new WorkCopyManager({ worktreeRoot: path.join(root, "worktrees"), protectedRoots: () => [dataDir] }),
    sources: { resolve: () => ({ text: "材料", refs: [] }), verify: () => null },
    resolveSelection: async (selection) => {
      assert.equal(inTx, false, "模型预检不能持有数据库事务");
      resolved.push(selection);
      return () => assert.equal(inTx, true, "模型门闩必须在登记事务内重检");
    },
    launcherFor: (mode) => {
      assert.equal(inTx, false, "执行入口预检不能持有数据库事务");
      assert.ok(["confirm", "full_access", "auto-review"].includes(mode));
      return { kind: "local", launch: async () => { throw new Error("本测试不启动执行单元"); } };
    },
    defaultModelSelection: () => DEFAULT,
    kickSession: (id) => { assert.equal(inTx, false, "提交之后才能 kick"); kicks.push(id); },
    resumeQueue: async (id) => { resumed.push(id); store.setSessionQueueState(id, "active", null); },
    parentDelivery,
    cancelTask: async () => { throw new Error("本测试不停止执行单元"); },
    protectedRoots: () => [dataDir],
  };
  const manager = new SubAgentManager(deps);
  const input = (to: "sub" | "parent", key = "msg") => ({
    senderTaskId: to === "sub" ? parent.id : child.id,
    workId: work.id, key, text: "协作正文", paramsDigest: `digest-${key}`,
    toSubAgentId: to === "sub" ? agent.id : null,
  });
  const seedMessage = (to: "sub" | "parent", key = randomId("msg")) => {
    const request = input(to, key);
    const msg: SubAgentMessage = {
      id: randomId("smsg"), workId: work.id, parentSessionId: parentSession.id,
      fromSubAgentId: to === "sub" ? null : agent.id, fromTaskId: request.senderTaskId,
      accessMode: store.getTask(request.senderTaskId)!.accessMode, sourcePermissionVersion: store.getTask(request.senderTaskId)!.permissionVersion,
      toSubAgentId: request.toSubAgentId, requestKey: key, paramsDigest: request.paramsDigest, body: request.text,
      createdAt: new Date().toISOString(), deliveredTaskId: null, deliveredAt: null, undeliveredReason: null,
    };
    store.withTx(() => store.insertSubAgentMessage(msg));
    return msg;
  };
  const counts = () => ["tasks", "subagent_messages", "events", "work_delegations", "sub_agents", "sessions"].map((table) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  const deliveries = () => [...store.listTasksBySession(sub.id), ...store.listTasksBySession(parentSession.id)].filter((t) => t.requestId.startsWith("smsg:"));
  const occupy = (t: Task) => assert.equal(store.withTx(() => store.tryAcquireOccupancy({ cwdReal: sub.cwdReal, cwdDev: sub.cwdDev, cwdIno: sub.cwdIno, sessionId: sub.id, taskId: t.id })), true);
  const cleanup = () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { store, manager, deps, parentDelivery, parentSession, parent, sub, agent, work, child, task, complete, newWork, input, seedMessage, counts, deliveries, occupy, kicks, resumed, resolved, inTx: () => inTx, cleanup };
}

for (const to of ["sub", "parent"] as const) {
  for (const failure of ["model", "execution", "transaction_check"] as const) {
    test(`新消息 ${to}：${failure} 拒绝时消息、任务、事件与身份零新增`, async () => {
      const k = kit();
      try {
        let checks = 0;
        if (failure === "model") k.deps.resolveSelection = async () => { throw configBusy(); };
        if (failure === "execution") k.deps.launcherFor = () => { throw new SubAgentDelegationError("execution_unavailable", "受限入口不可用"); };
        if (failure === "transaction_check") k.deps.resolveSelection = async () => {
          assert.equal(k.inTx(), false);
          return () => { assert.equal(k.inTx(), true); checks++; throw configBusy(); };
        };
        const before = k.counts();
        const agentBefore = k.store.getSubAgent(k.agent.id);
        await assert.rejects(() => messageFromActiveTask({ store: k.store, subagents: k.manager }, k.input(to)), { code: failure === "execution" ? "execution_unavailable" : "model_config_busy" });
        assert.deepEqual(k.counts(), before, "拒绝不能留下消息行、排队任务或 sent 事件");
        assert.deepEqual(k.store.getSubAgent(k.agent.id), agentBefore);
        assert.deepEqual(k.kicks, []);
        if (failure === "transaction_check") assert.equal(checks, 1);
      } finally { k.cleanup(); }
    });
  }

  test(`新消息 ${to}：已核实模型与发起任务授权落到实际承载任务`, async () => {
    const k = kit();
    try {
      const sent = await messageFromActiveTask({ store: k.store, subagents: k.manager }, k.input(to));
      const carrier = k.store.getTask(sent.message.deliveredTaskId!)!;
      const expected = to === "parent" ? MAIN : DEFAULT;
      assert.deepEqual(k.resolved, [expected]);
      assert.deepEqual(carrier.modelSelection, expected);
      assert.equal(carrier.accessMode, to === "sub" ? "full_access" : "confirm");
      assert.equal(carrier.sourcePermissionVersion, sent.message.sourcePermissionVersion);
      assert.deepEqual(carrier.grantedPaths, []);
      assert.equal(carrier.parentTaskId, sent.message.fromTaskId);
      assert.deepEqual(k.kicks, [carrier.sessionId]);
      if (to === "sub") {
        assert.equal(carrier.workId, k.work.id);
        assert.equal(carrier.subAgentId, k.agent.id);
        assert.deepEqual(carrier.readScope, k.child.readScope, "正文不能扩展既有读范围");
      } else {
        assert.equal(carrier.agentId, "main");
        assert.equal(carrier.deadline, null);
      }
    } finally { k.cleanup(); }
  });

  test(`幂等 ${to}：配置忙和执行入口失效仍返回原行，不再预检`, async () => {
    const k = kit();
    try {
      const first = await messageFromActiveTask({ store: k.store, subagents: k.manager }, k.input(to));
      k.store.cancelWorkDelegation(k.work.id, new Date().toISOString(), "owner", null);
      k.store.closeSubAgent(k.agent.id, new Date().toISOString(), "owner");
      let preflights = 0;
      k.deps.resolveSelection = async () => { preflights++; throw configBusy(); };
      k.deps.launcherFor = () => { preflights++; throw new Error("执行入口失效"); };
      const before = k.counts();
      const replay = await messageFromActiveTask({ store: k.store, subagents: k.manager }, k.input(to));
      assert.equal(replay.created, false);
      assert.equal(replay.delivery, null);
      assert.deepEqual(replay.message, first.message);
      await assert.rejects(() => messageFromActiveTask({ store: k.store, subagents: k.manager }, { ...k.input(to), paramsDigest: "different" }), { code: "request_conflict" });
      assert.equal(preflights, 0);
      assert.deepEqual(k.counts(), before);
      assert.equal(k.deliveries().length, 1);
    } finally { k.cleanup(); }
  });

  test(`待投递 ${to}：配置预检和事务内门闩失败保留原行，恢复后只补投一次`, async () => {
    const k = kit();
    try {
      const msg = k.seedMessage(to);
      const normalResolve = k.deps.resolveSelection;
      for (const failure of ["preflight", "check"] as const) {
        k.deps.resolveSelection = async () => {
          if (failure === "preflight") throw configBusy();
          return () => { assert.equal(k.inTx(), true); throw configBusy(); };
        };
        const before = k.counts();
        await k.manager.flushPendingMessages(k.parentSession.id);
        assert.deepEqual(k.store.getSubAgentMessage(msg.id), msg, "失败不能终结、丢弃或换消息键");
        assert.deepEqual(k.counts(), before);
        assert.deepEqual(k.kicks, []);
      }
      k.deps.resolveSelection = normalResolve;
      await k.manager.flushPendingMessages(k.parentSession.id);
      const delivered = k.store.getSubAgentMessage(msg.id)!;
      assert.ok(delivered.deliveredAt);
      assert.equal(delivered.undeliveredReason, null);
      assert.equal(k.store.getTask(delivered.deliveredTaskId!)!.requestId, `smsg:${msg.id}`);
      await k.manager.flushPendingMessages(k.parentSession.id);
      assert.deepEqual(k.store.getSubAgentMessage(msg.id), delivered);
      assert.equal(k.deliveries().length, 1);
      assert.equal(k.kicks.length, 1);
    } finally { k.cleanup(); }
  });
}

for (const change of ["closed", "canceled", "moved_work"] as const) {
  test(`消息等待模型预检时发生 ${change}：提交前重核，零新增`, async () => {
    const k = kit();
    try {
      const entered = gate<void>();
      const released = gate<() => void>();
      k.deps.resolveSelection = () => { assert.equal(k.inTx(), false); entered.resolve(); return released.promise; };
      const pending = messageFromActiveTask({ store: k.store, subagents: k.manager }, k.input("sub"));
      await entered.promise;
      if (change === "closed") k.manager.close({ subAgentId: k.agent.id, by: "owner" });
      if (change === "canceled") await k.manager.cancelWork({ workId: k.work.id, by: "owner" });
      if (change === "moved_work") k.store.setSubAgentState(k.agent.id, "idle", { activeWorkId: k.newWork().id, currentTaskId: null });
      const beforeCommit = k.counts();
      const agentBefore = k.store.getSubAgent(k.agent.id);
      released.resolve(() => {});
      await assert.rejects(pending, { code: change === "closed" ? "closed" : "invalid_state" });
      assert.deepEqual(k.counts(), beforeCommit, "异步窗口失去资格不能生成新消息或执行");
      assert.deepEqual(k.store.getSubAgent(k.agent.id), agentBefore);
      assert.deepEqual(k.kicks, []);
    } finally { k.cleanup(); }
  });

  test(`冲刷等待模型预检时发生 ${change}：保留明确未投递结果，旧消息不入新执行`, async () => {
    const k = kit();
    try {
      const msg = k.seedMessage("sub");
      const entered = gate<void>();
      const released = gate<() => void>();
      k.deps.resolveSelection = () => { entered.resolve(); return released.promise; };
      const flushing = k.manager.flushPendingMessages();
      await entered.promise;
      if (change === "closed") k.manager.close({ subAgentId: k.agent.id, by: "owner" });
      if (change === "canceled") await k.manager.cancelWork({ workId: k.work.id, by: "owner" });
      if (change === "moved_work") k.store.setSubAgentState(k.agent.id, "idle", { activeWorkId: k.newWork().id, currentTaskId: null });
      released.resolve(() => {});
      await flushing;
      await k.manager.flushPendingMessages();
      const dropped = k.store.getSubAgentMessage(msg.id)!;
      assert.equal(dropped.undeliveredReason, change === "closed" ? `closed:${k.store.getSubAgent(k.agent.id)!.closedAt}` : change === "canceled" ? "work_canceled" : "moved_work");
      assert.equal(dropped.deliveredTaskId, null);
      assert.equal(dropped.deliveredAt, null);
      assert.equal(k.deliveries().length, 0);
      const drops = k.store.db.prepare("SELECT body FROM events WHERE json_extract(body, '$.type') = 'subagent_message.dropped'").all();
      assert.equal(drops.length, 1, "关闭/取消与在途冲刷重入不能重复登记未投递事件");
      assert.deepEqual(k.kicks, []);
    } finally { k.cleanup(); }
  });
}

for (const nextWork of [false, true]) {
  test(`旧结果补记：${nextWork ? "新工作" : "同工作的新任务"}的运行指针不被覆盖`, () => {
    const k = kit("dev");
    try {
      const old = k.complete(k.task(k.sub.id, { workId: k.work.id, subAgentId: k.agent.id, parentTaskId: k.parent.id }), false);
      const work = nextWork ? k.newWork() : k.work;
      const current = k.task(k.sub.id, { workId: work.id, subAgentId: k.agent.id, parentTaskId: k.parent.id });
      k.store.setSubAgentState(k.agent.id, "running", { activeWorkId: work.id, currentTaskId: current.id });
      const before = k.store.getSubAgent(k.agent.id);
      k.store.withTx(() => {
        assert.equal(k.store.setTaskResult(old.id, "迟到的历史结果", "{}"), true);
        k.manager.resultRecorded(k.store.getTask(old.id)!);
      });
      assert.deepEqual(k.store.getSubAgent(k.agent.id), before, "历史结果不能将后来任务虚置为空闲");
      assert.equal(k.store.getTask(current.id)!.status, "queued");
    } finally { k.cleanup(); }
  });
}

test("结果登记→unverified→核实占用释放→idle：pending 消息只在实际恢复后补投一次", async () => {
  const k = kit("dev");
  try {
    const current = k.task(k.sub.id, { workId: k.work.id, subAgentId: k.agent.id, parentTaskId: k.parent.id, readScope: k.child.readScope });
    k.store.setSubAgentState(k.agent.id, "running", { activeWorkId: k.work.id, currentTaskId: current.id });
    k.occupy(current);
    const sent = await messageFromActiveTask({ store: k.store, subagents: k.manager }, k.input("sub"));
    assert.equal(sent.delivery, "pending");
    k.store.withTx(() => { k.manager.resultRecorded(k.complete(current)); });
    assert.equal(k.store.getSubAgent(k.agent.id)!.state, "unverified");
    assert.equal(k.store.getSubAgent(k.agent.id)!.currentTaskId, null);
    assert.equal(k.store.withTx(() => k.manager.executionVerified(k.sub.id)), null, "占用未释放不虚称恢复");
    await k.manager.flushPendingMessages();
    assert.equal(k.deliveries().length, 0);
    const parentSessionId = k.store.withTx(() => {
      assert.equal(k.store.releaseOccupancy(current.id), true);
      return k.manager.executionVerified(k.sub.id);
    });
    assert.equal(parentSessionId, k.parentSession.id);
    assert.equal(k.store.getSubAgent(k.agent.id)!.state, "idle");
    await k.manager.flushPendingMessages(parentSessionId!);
    await k.manager.flushPendingMessages(parentSessionId!);
    const delivered = k.store.getSubAgentMessage(sent.message.id)!;
    assert.equal(k.deliveries().length, 1);
    assert.equal(k.store.getSubAgent(k.agent.id)!.currentTaskId, delivered.deliveredTaskId);
    assert.equal(k.store.getSubAgent(k.agent.id)!.state, "running");
    assert.deepEqual(k.kicks, [k.sub.id]);
    assert.equal(k.store.withTx(() => k.manager.executionVerified(k.sub.id)), null, "新任务活动时恢复不能倒写 idle");
  } finally { k.cleanup(); }
});

test("恢复拒绝结果缺失：invalid_state 回滚占用释放，不虚称空闲", () => {
  const k = kit("dev");
  try {
    const current = k.task(k.sub.id, { workId: k.work.id, subAgentId: k.agent.id });
    k.complete(current, false);
    k.store.setSubAgentState(k.agent.id, "unverified", { activeWorkId: k.work.id, currentTaskId: current.id });
    k.occupy(current);
    const before = k.store.getSubAgent(k.agent.id);
    assert.throws(() => k.store.withTx(() => {
      k.store.releaseOccupancy(current.id);
      k.manager.executionVerified(k.sub.id);
    }), { code: "invalid_state" });
    assert.deepEqual(k.store.getSubAgent(k.agent.id), before);
    assert.equal(k.store.listAllOccupancy().length, 1, "核实失败事务必须保留原占用");
    assert.equal(k.store.getTask(current.id)!.resultSummary, null);
  } finally { k.cleanup(); }
});

test("计划模式由父任务固定模式判定，继续链不决定资格：修改和沿用既有写目标均拒绝，只读可委派", async () => {
  const k = kit("dev");
  try {
    const plan = k.complete(k.task(k.parentSession.id, { input: "调研变更", planMode: true }));
    const resumed = k.complete(k.task(k.parentSession.id, { input: "继续", resumesTaskId: plan.id }));
    const continued = k.complete(k.task(k.parentSession.id, { input: "再继续", resumesTaskId: resumed.id, planMode: true }));
    const writeWork = k.newWork({ kind: "direct", path: k.sub.cwdReal, dev: k.sub.cwdDev, ino: k.sub.cwdIno });
    for (const parent of [plan, continued]) {
      for (const extra of [{ mode: "modify" as const, target: "." }, { workId: writeWork.id }]) {
        const before = k.counts();
        await assert.rejects(() => delegateFromActiveTask({ store: k.store, subagents: k.manager }, { parentTaskId: parent.id, key: randomId("plan"), request: "修改", paramsDigest: "plan", ...extra }), /计划模式/);
        assert.deepEqual(k.counts(), before, "计划模式拒绝发生在建立目录、工作和任务之前");
      }
    }
    assert.deepEqual(k.resolved, [], "拒绝不启动模型或执行准备");
    await assert.rejects(() => delegateFromActiveTask({ store: k.store, subagents: k.manager }, { parentTaskId: continued.id, key: "explicit-analyze", request: "继续只读", workId: k.work.id, mode: "analyze", paramsDigest: "explicit" }), { code: "invalid_params" });
    const delegated = await delegateFromActiveTask({ store: k.store, subagents: k.manager }, { parentTaskId: continued.id, key: "read-plan", request: "只读调研", readPaths: ["."], paramsDigest: "read-plan" });
    assert.equal(delegated.created, true);
    assert.equal(delegated.work.writeTarget, null);
    assert.equal(delegated.task.accessMode, "auto-review");
    assert.deepEqual(delegated.task.grantedPaths, []);
    assert.equal(delegated.task.readScope!.paths[0]!.path, k.parentSession.cwdReal);
  } finally { k.cleanup(); }
});

test("启动由 manager 补 main 消息唤醒一次；取消记未投递，dev 保留待注入", async () => {
  const main = kit();
  const canceled = kit();
  const dev = kit("dev");
  try {
    const msg = main.seedMessage("parent");
    const canceledMsg = canceled.seedMessage("parent");
    canceled.store.cancelWorkDelegation(canceled.work.id, new Date().toISOString(), "owner", null);
    const devMsg = dev.seedMessage("parent");
    await main.parentDelivery.sweep();
    assert.equal(main.deliveries().length, 0, "ParentDelivery 巡检不补消息执行");
    await main.manager.start();
    await main.manager.start();
    const delivered = main.store.getSubAgentMessage(msg.id)!;
    assert.ok(delivered.deliveredTaskId);
    assert.equal(main.deliveries().length, 1);
    assert.deepEqual(main.kicks, [main.parentSession.id]);
    assert.deepEqual(main.store.getTask(delivered.deliveredTaskId!)!.modelSelection, MAIN);
    await canceled.manager.start();
    assert.equal(canceled.store.getSubAgentMessage(canceledMsg.id)!.undeliveredReason, "work_canceled");
    assert.equal(canceled.deliveries().length, 0);
    await dev.manager.start();
    assert.deepEqual(dev.store.getSubAgentMessage(devMsg.id), devMsg);
    assert.deepEqual(dev.parentDelivery.takeInjection(dev.parentSession.id).messages.map((m) => m.id), [devMsg.id]);
  } finally { main.cleanup(); canceled.cleanup(); dev.cleanup(); }
});

test("启动仅恢复无占用的 backend_restart 子会话，保留 occupancy_unverified 与其他暂停", async () => {
  for (const state of ["safe", "occupied", "unverified", "manual"] as const) {
    const k = kit("dev");
    try {
      const reason = state === "unverified" ? "occupancy_unverified" : state === "manual" ? "owner" : "backend_restart";
      k.store.setSessionQueueState(k.sub.id, "paused", reason);
      if (state === "occupied") k.occupy(k.child);
      await k.manager.start();
      assert.deepEqual(k.resumed, state === "safe" ? [k.sub.id] : []);
      assert.equal(k.store.getSession(k.sub.id)!.queueState, state === "safe" ? "active" : "paused");
    } finally { k.cleanup(); }
  }
});

test("重启分类：仅无入站来源的 queued SubAgent 执行被中断，评审与普通父任务保持排队", () => {
  const k = kit("dev");
  try {
    const owner = k.task(k.sub.id, { workId: k.work.id, subAgentId: k.agent.id, parentTaskId: k.parent.id });
    const message = k.task(k.sub.id, { requestId: "smsg:queued-before-crash", workId: k.work.id, subAgentId: k.agent.id, parentTaskId: k.parent.id });
    const review = k.task(k.sub.id, { workId: k.work.id, subAgentId: k.agent.id, sourceEventId: "evt-review" });
    const parent = k.task(k.parentSession.id);
    const recovered = k.store.withTx(() => k.manager.recoverQueuedTasks());
    assert.deepEqual(recovered.sort(), [owner.id, message.id].sort());
    for (const t of [owner, message]) {
      const after = k.store.getTask(t.id)!;
      assert.equal(after.status, "interrupted");
      assert.equal(after.interruptReason, "backend_restart");
      assert.equal(after.startedAt, null);
      assert.equal(after.effectUnknown, false, "从未启动的任务没有未知副作用");
      assert.equal(after.resultSummary, null, "结果补记留给编排器，恢复不虚构成功");
      assert.equal(after.workId, k.work.id);
      assert.equal(after.subAgentId, k.agent.id);
    }
    assert.equal(k.store.getTask(review.id)!.status, "queued");
    assert.equal(k.store.getTask(parent.id)!.status, "queued");
    const before = k.counts();
    assert.deepEqual(k.store.withTx(() => k.manager.recoverQueuedTasks()), []);
    assert.deepEqual(k.counts(), before, "重复恢复不登记第二次中断");
    assert.deepEqual(k.kicks, []);
  } finally { k.cleanup(); }
});

for (const action of ["delegate", "message"] as const) {
  for (const change of ["ended", "version"] as const) {
    test(`${action} 异步准备后来源 ${change}：拒绝登记且没有半条任务、消息或事件`, async () => {
      const k = kit("dev");
      try {
        k.store.transitionTask(k.parent.id, ["completed"], "running");
        const waiting = gate<void>();
        const entered = gate<void>();
        k.deps.resolveSelection = async () => { entered.resolve(); await waiting.promise; return () => {}; };
        const before = k.counts();
        const operation = action === "delegate"
          ? k.manager.delegate({ parentTaskId: k.parent.id, key: "race", request: "调研", readPaths: ["."], paramsDigest: "race" })
          : k.manager.message(k.input("sub"));
        const rejected = assert.rejects(operation, { code: "task_ending" });
        await entered.promise;
        if (change === "ended") k.complete(k.parent);
        else k.store.updateGrantedPaths(k.parent.id, []);
        waiting.resolve();
        await rejected;
        assert.deepEqual(k.counts(), before);
        assert.deepEqual(k.kicks, []);
      } finally { k.cleanup(); }
    });
  }
}

test("继续旧工作与复用身份取本次发起任务授权，既有任务与批准保持原记录", async () => {
  const k = kit("dev");
  try {
    const first = await delegateFromActiveTask({ store: k.store, subagents: k.manager }, { parentTaskId: k.parent.id, key: "first", request: "分析", readPaths: ["."], paramsDigest: "first" });
    assert.equal(first.task.accessMode, "full_access");
    assert.equal(first.task.sourcePermissionVersion, k.parent.permissionVersion);
    k.manager.resultRecorded(k.complete(first.task));
    const next = k.task(k.parentSession.id, { accessMode: "confirm" });
    k.store.updateGrantedPaths(next.id, []);
    const continued = await k.manager.delegate({ parentTaskId: next.id, key: "continue", request: "继续分析", workId: first.work.id, readPaths: ["."], paramsDigest: "continue" });
    assert.equal(continued.task.accessMode, "confirm");
    assert.equal(continued.task.sourcePermissionVersion, 2);
    assert.equal(k.store.getTask(first.task.id)!.accessMode, "full_access");
    k.manager.resultRecorded(k.complete(continued.task));
    const reused = await delegateFromActiveTask({ store: k.store, subagents: k.manager }, { parentTaskId: k.parent.id, key: "reuse", request: "新分析", subAgentId: first.agent.id, readPaths: ["."], paramsDigest: "reuse" });
    assert.equal(reused.task.accessMode, "full_access");
    assert.equal(reused.task.parentTaskId, k.parent.id);
    assert.equal(k.store.listConfirmationsByTask(reused.task.id).length, 0);
    assert.deepEqual(reused.task.grantedPaths, []);
  } finally { k.cleanup(); }
});
