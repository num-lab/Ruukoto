/** IM 审批模块的公开入口；真实 Store / ApprovalGate，无 Runtime、模型与平台连接。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ApprovalGate } from "../src/agent/approval-gate.ts";
import { ToolOpLedger } from "../src/agent/tool-op-ledger.ts";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { ApprovalScope, NotifyTarget, Task } from "../src/core/types.ts";
import { ImApprovals, type ImApprovalsDeps } from "../src/runtime/im-approvals.ts";
import { SchedulerStore } from "../src/scheduler/store.ts";

const SCOPE: Extract<ApprovalScope, { kind: "service_operation" }> = {
  kind: "service_operation", machineId: "machine", unit: "demo.service", action: "restart",
  policyRevision: "a".repeat(64), unitRevision: "b".repeat(64),
  taskId: "task", toolOpId: "op",
};
const SELECTION = { provider: "mock", modelId: "mock", thinkingLevel: "off" as const };

function kit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-im-approval-lifecycle-"));
  const db = new Db(root);
  const store = new Store(db);
  const sched = new SchedulerStore(store);
  const project = store.createProject("p");
  const main = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi-main", confirmTools: [] });
  store.insertAgentRole({ id: "main", projectId: project.id, sessionId: main.id, workDir: root, modelSelection: null, tools: [], createdAt: main.createdAt });
  let n = 0;
  let serviceAvailable = true;
  let kicks = 0;
  const entry = (source: string) => {
    const state = { target: { channel: source, account: "acct", chatId: "chat", configVersion: 1 } as NotifyTarget | null, actor: `${source}:owner`, gate: "run" as "run" | "wait" | { drop: string } };
    const adapter: NonNullable<ReturnType<ImApprovalsDeps["entry"]>> = {
      target: () => state.target, expectedActor: () => state.actor, replyCapChars: () => 4000, gatePrivate: () => state.gate,
    };
    return { state, adapter };
  };
  const tg = entry("telegram");
  const qq = entry("qq_private");
  const released: string[][] = [];
  let gate!: ApprovalGate;
  const approvals = new ImApprovals({
    store, sched,
    entry: (source) => source === "telegram" ? tg.adapter : source === "qq_private" ? qq.adapter : null,
    serviceAvailable: () => serviceAvailable,
    servicePolicyRevision: () => serviceAvailable ? SCOPE.policyRevision : null,
    applyDecision: (c, decision, txExtra) => gate.resolve(c.id, decision, { txExtra }),
    supersedeApprovals: (_sessionId, ids) => {
      assert.ok([...ids].every((id) => store.getConfirmation(id)?.status === "stale"), "提交后才解除等待");
      released.push([...ids]);
      gate.supersedeConfirmations(ids);
    },
    kickSender: () => kicks++,
  });
  gate = new ApprovalGate({
    store, ledger: new ToolOpLedger(store), reviewer: () => undefined,
    notifyConfirmation: (c, t) => approvals.notifyCreated(c, t),
    consumeRecheck: (c, t) => approvals.consumeRecheck(c, t),
    standingCandidate: (t, s) => approvals.standingCandidate(t, s),
  });
  const task = (source: string | null = "telegram", parentTaskId: string | null = null, eventKind: "task" | "im_approval" = "task") => {
    const own = source === "qq_private" ? qq : tg;
    const event = source ? store.registerInboundEvent({ source, externalId: `x${++n}`, actor: own.state.actor, replyTarget: own.state.target, targetRole: "main", body: "work", eventKind }).event : null;
    const { task } = store.insertQueuedTask({ sessionId: main.id, requestId: `r${++n}`, submissionDigest: `d${n}`, input: "work", modelSelection: SELECTION, parentTaskId, sourceEventId: event?.id ?? null });
    store.transitionTask(task.id, ["queued"], "running", {});
    return store.getTask(task.id)!;
  };
  const ask = (task: Task, scope: ApprovalScope = SCOPE) => {
    const hostOpId = `op${++n}`;
    const params = { unit: SCOPE.unit, machine_id: SCOPE.machineId, state_before: { activeState: "inactive", subState: "dead" }, data: "长".repeat(350) };
    store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: task.sessionId, toolName: "service_manage", params });
    const result = gate.request({ task, hostOpId, toolName: "service_manage", params, scope });
    return { result, confirmation: store.listConfirmationsByTask(task.id).at(-1)! };
  };
  const grant = (source: string = "telegram") => {
    const own = source === "qq_private" ? qq : tg;
    return store.withTx(() => store.createStandingPermission({
      sessionId: main.id, projectId: project.id, ...SCOPE, channel: source,
      account: "acct", chatId: "chat", actor: own.state.actor, pinnedTarget: own.state.target!,
      approvalId: `conf${++n}`, createdByEventId: `event${n}`,
    }));
  };
  const command = (text: string, source = "telegram", externalId = `cmd${++n}`) => {
    const own = source === "qq_private" ? qq : tg;
    return approvals.handleCommand({ source, externalId, actor: own.state.actor, replyTarget: own.state.target, commandText: text });
  };
  return { db, store, sched, approvals, gate, tg: tg.state, qq: qq.state, released, task, ask, grant, command,
    service: (available: boolean) => { serviceAvailable = available; }, kicks: () => kicks,
    close: () => { gate.cancelAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("通知→命令→消费共用来源：子任务沿父链通知原入口，批准、回执和消费恰好一次", async () => {
  const k = kit();
  try {
    const root = k.task("qq_private");
    const child = k.task(null, root.id);
    const { result, confirmation: c } = k.ask(child);
    const notice = k.sched.findOpBySource("confirmation", `im-approval:${c.id}`)!;
    assert.deepEqual(notice.target, k.qq.target);
    assert.match(notice.text, /root 提权.*原本不活动会被启动/);
    assert.match(notice.text, /请求时状态 inactive\/dead/);
    assert.match(notice.text, /不自动重发/);
    assert.ok(notice.text.includes(`/approve-standing ${c.id} 1`));
    assert.ok(notice.text.includes("…"), "参数摘要有界");
    assert.equal((await k.command(`/approve ${c.id} 1`, "telegram"))?.outcome, "not_found", "跨平台不能批准");
    assert.equal((await k.command(`/approve ${c.id} 1`, "qq_private", "approve-once"))?.outcome, "approved");
    assert.equal((await result).approved, true);
    assert.ok(k.store.getConfirmation(c.id)!.consumedAt);
    assert.equal((await k.command(`/approve ${c.id} 1`, "qq_private", "approve-once"))?.outcome, "redelivered_receipt_kept");
    assert.equal(k.store.getTaskEventsAfter(child.id, 0, 100).filter((e) => e.body.type === "task.approval_consumed").length, 1);
    assert.equal(k.store.listActiveStandingPermissions().length, 0, "普通批准不创建长期授权");
  } finally { k.close(); }
});

for (const change of ["generation", "disabled"] as const) {
  test(`已接受批准后 ${change}：消费事务重新核实原目标，零消费`, async () => {
    const k = kit();
    try {
      const { result, confirmation: c } = k.ask(k.task());
      assert.equal(k.gate.resolve(c.id, "approved"), true);
      k.tg.target = change === "disabled" ? null : { ...k.tg.target!, configVersion: 2 };
      assert.equal((await result).approved, false);
      assert.equal(k.store.getConfirmation(c.id)!.status, "stale");
      assert.equal(k.store.getConfirmation(c.id)!.consumedAt, null);
    } finally { k.close(); }
  });
}

for (const source of [null, "github", "control", "cycle", "depth", "broken"] as const) {
  test(`来源 ${source ?? "absent"}：不通知、不继承长期授权`, async () => {
    const k = kit();
    try {
      k.grant();
      let t = k.task(source === "control" ? "telegram" : source === "cycle" || source === "depth" || source === "broken" ? null : source, null, source === "control" ? "im_approval" : "task");
      if (source === "cycle") k.db.prepare("UPDATE tasks SET parent_task_id = id WHERE id = ?").run(t.id);
      if (source === "broken") k.db.prepare("UPDATE tasks SET parent_task_id = 'missing' WHERE id = ?").run(t.id);
      if (source === "depth") {
        t = k.task();
        for (let i = 0; i < 17; i++) t = k.task(null, t.id);
      }
      const { result, confirmation: c } = k.ask(t);
      assert.equal(k.sched.findOpBySource("confirmation", `im-approval:${c.id}`), null);
      assert.equal(k.approvals.standingCandidate(t, SCOPE), null);
      k.gate.resolve(c.id, "rejected");
      assert.equal((await result).approved, false);
    } finally { k.close(); }
  });
}

test("配置撤销同事务、来源隔离：只解除未消费的待决/已批准，已消费和另一平台保留", async () => {
  const k = kit();
  try {
    const pending = k.ask(k.task());
    const approved = k.ask(k.task());
    k.gate.resolve(approved.confirmation.id, "approved");
    const consumed = k.ask(k.task());
    k.gate.resolve(consumed.confirmation.id, "approved");
    await consumed.result;
    // approved 已在微任务中消费：另登记真实未消费记录模拟配置更改与消费之间的窗口。
    await approved.result;
    const waiting = k.ask(k.task());
    k.store.respondConfirmation(waiting.confirmation.id, "approved");
    const other = k.ask(k.task("qq_private"));
    const tgGrant = k.grant();
    const qqGrant = k.grant("qq_private");
    k.tg.gate = { drop: "entry_changed" };
    k.tg.target = { ...k.tg.target!, configVersion: 2 };
    k.approvals.invalidate("telegram");
    assert.equal((await pending.result).approved, false);
    assert.equal((await waiting.result).approved, false);
    assert.deepEqual(k.released.flat().sort(), [pending.confirmation.id, waiting.confirmation.id].sort());
    assert.equal(k.store.getConfirmation(consumed.confirmation.id)!.status, "approved");
    assert.ok(k.store.getConfirmation(consumed.confirmation.id)!.consumedAt);
    assert.equal(k.store.getConfirmation(other.confirmation.id)!.status, "pending");
    assert.equal(k.store.getStandingPermission(tgGrant.id)!.revokedReason, "entry_changed");
    assert.equal(k.store.getStandingPermission(qqGrant.id)!.revokedAt, null);
    k.gate.resolve(other.confirmation.id, "rejected");
    await other.result;
  } finally { k.close(); }
});

for (const mode of ["run", "wait"] as const) {
  test(`入口 ${mode}：审批和授权保留，等待不解除`, async () => {
    const k = kit();
    try {
      const { result, confirmation: c } = k.ask(k.task());
      const sp = k.grant();
      k.tg.gate = mode;
      k.approvals.invalidate("telegram");
      assert.equal(k.store.getConfirmation(c.id)!.status, "pending");
      assert.equal(k.store.getStandingPermission(sp.id)!.version, 1);
      assert.deepEqual(k.released, []);
      k.gate.resolve(c.id, "rejected");
      await result;
    } finally { k.close(); }
  });
}

for (const change of ["none", "service", "policy", "unit", "target", "actor"] as const) {
  test(`长期授权候选 ${change}：核实能力、入口和修订，失配明确撤销`, () => {
    const k = kit();
    try {
      const t = k.task();
      const sp = k.grant();
      const scope = { ...SCOPE };
      if (change === "service") k.service(false);
      if (change === "policy") scope.policyRevision = "c".repeat(64);
      if (change === "unit") scope.unitRevision = "c".repeat(64);
      if (change === "target") k.tg.target = { ...k.tg.target!, configVersion: 2 };
      if (change === "actor") k.tg.actor = "telegram:other";
      assert.deepEqual(k.approvals.standingCandidate(t, scope), change === "none" ? { id: sp.id, version: 1 } : null);
      const current = k.store.getStandingPermission(sp.id)!;
      assert.equal(current.revokedReason, change === "policy" || change === "unit" ? "revision_changed" : change === "target" || change === "actor" ? "entry_changed" : null);
      assert.equal(current.version, current.revokedReason ? 2 : 1);
    } finally { k.close(); }
  });
}

test("通知登记失败：审批、任务等待状态和通知全部回滚", async () => {
  const k = kit();
  try {
    const t = k.task();
    k.db.prepare("CREATE TEMP TRIGGER fail_notice BEFORE INSERT ON notification_ops BEGIN SELECT RAISE(ABORT, 'notice failed'); END").run();
    await assert.rejects(k.ask(t).result, /notice failed/);
    assert.equal(k.store.listConfirmationsByTask(t.id).length, 0);
    assert.equal(k.store.getTask(t.id)!.status, "running");
    assert.equal(k.sched.listOps({ limit: 50 }).items.length, 0);
  } finally { k.close(); }
});

test("撤销写入失败：审批与长期授权一起回滚，等待保持；恢复后才解除", async () => {
  const k = kit();
  try {
    const { result, confirmation: c } = k.ask(k.task());
    const sp = k.grant();
    k.tg.target = null;
    k.tg.gate = { drop: "disabled" };
    k.db.prepare("CREATE TEMP TRIGGER fail_revoke BEFORE UPDATE ON standing_permissions BEGIN SELECT RAISE(ABORT, 'revoke failed'); END").run();
    assert.throws(() => k.approvals.invalidate("telegram"), /revoke failed/);
    assert.equal(k.store.getConfirmation(c.id)!.status, "pending");
    assert.equal(k.store.getStandingPermission(sp.id)!.revokedAt, null);
    assert.deepEqual(k.released, []);
    k.db.prepare("DROP TRIGGER fail_revoke").run();
    k.approvals.invalidate("telegram");
    assert.equal((await result).approved, false);
    assert.equal(k.store.getStandingPermission(sp.id)!.revokedReason, "entry_changed");
  } finally { k.close(); }
});
