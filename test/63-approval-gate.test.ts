/**
 * 架构工单 04：审批闸门（直接构造 Store 与假 reviewer，不起 Runtime）。
 *
 * - 提交：登记审批、任务转入等待确认；全部等待结束才回到 running；
 * - 未批准：拥有者拒绝、自动审查拒绝、模式切换、停止，返回与落库的是同一句，未消费；
 * - 获批后：同一事务内复核、单次消费、事件、提交本地效果；复核/消费失败、
 *   recheck/commit 抛错都使批准失效（stale），已消费的批准不动；
 * - 提前中止只动本审批。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { AccessMode, ApprovalScope } from "../src/core/types.ts";
import { ApprovalGate, type ApprovalRequest } from "../src/agent/approval-gate.ts";
import type { ApprovalReviewer } from "../src/agent/review.ts";

const FILE_READ: ApprovalScope = { kind: "file_operation", path: "/outside/a.txt", access: "read", originalSha256: null, contentSha256: null, contentBytes: null };
const TOOL = "request_file_access";

function kit(opts: { accessMode?: AccessMode; reviewer?: ApprovalReviewer } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-gate-"));
  const db = new Db(root);
  const store = new Store(db);
  const project = store.createProject("p");
  const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi-1", confirmTools: [] });
  const { task } = store.insertQueuedTask({
    sessionId: session.id,
    requestId: "r1",
    input: "读取外部文件",
    modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" },
    submissionDigest: "r1",
    accessMode: opts.accessMode,
  });
  store.transitionTask(task.id, ["queued"], "running", {});
  const gate = new ApprovalGate({ store, reviewer: () => opts.reviewer });
  let n = 0;
  /** 记录一次执行意图并提交审批（不 await：审批已同步登记）。 */
  const ask = <T = void>(extra: Partial<ApprovalRequest<T>> = {}) => {
    const hostOpId = `op_${++n}`;
    const params = { path: "/outside/a.txt", n };
    store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: session.id, toolName: TOOL, params });
    const result = gate.request<T>({ task: store.getTask(task.id)!, hostOpId, toolName: TOOL, params, scope: FILE_READ, ...extra });
    const confirmation = store.listConfirmationsByTask(task.id).find((c) => c.toolOpId === hostOpId)!;
    return { hostOpId, result, id: confirmation.id };
  };
  const status = () => store.getTask(task.id)!.status;
  const approval = (id: string) => store.getConfirmation(id)!;
  const summary = (hostOpId: string) => store.getToolOp(hostOpId)!.resultSummary;
  const events = (type: string) => store.getTaskEventsAfter(task.id, 0, 1000).filter((e) => e.body.type === type);
  const cleanup = () => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { store, task, gate, ask, status, approval, summary, events, cleanup };
}

test("批准：只消费一次，交回审批记录的参数快照并写 task.approval_consumed；任务回到 running", async () => {
  const k = kit();
  try {
    const { result, id } = k.ask();
    assert.equal(k.approval(id).status, "pending");
    assert.equal(k.status(), "awaiting_confirmation");
    assert.equal(k.gate.resolve(id, "approved"), true);
    const r = await result;
    assert.ok(r.approved);
    assert.equal(r.approvalId, id);
    assert.deepEqual(r.params, k.approval(id).params, "参数取自审批记录");
    assert.notEqual(k.approval(id).consumedAt, null);
    assert.equal(k.events("task.approval_consumed").length, 1);
    assert.equal(k.events("task.confirmation_resolved").length, 1);
    assert.equal(k.status(), "running");
    assert.equal(k.gate.resolve(id, "approved"), false, "已结束的等待不再接受应答");
  } finally {
    k.cleanup();
  }
});

test("未批准：拥有者拒绝、模式切换、停止——返回与落库逐字相同，均未消费", async () => {
  const k = kit();
  try {
    const rejected = k.ask();
    k.gate.resolve(rejected.id, "rejected");
    assert.deepEqual(await rejected.result, { approved: false, text: `拥有者拒绝执行 ${TOOL}` });
    assert.equal(k.summary(rejected.hostOpId), `拥有者拒绝执行 ${TOOL}`);

    const superseded = k.ask();
    k.gate.supersedeAll();
    const s = await superseded.result;
    assert.deepEqual(s, { approved: false, text: `审批已失效（模式切换或任务停止），${TOOL} 未执行；如仍需要请重新申请` });
    assert.equal(k.summary(superseded.hostOpId), (s as { text: string }).text);

    const canceled = k.ask();
    k.gate.cancelAll();
    const c = await canceled.result;
    assert.deepEqual(c, { approved: false, text: `任务停止，确认等待解除（${TOOL} 未执行）` });
    assert.equal(k.summary(canceled.hostOpId), (c as { text: string }).text);

    for (const x of k.store.listConfirmationsByTask(k.task.id)) assert.equal(x.consumedAt, null);
    assert.equal(k.events("task.approval_consumed").length, 0);
    assert.equal(k.status(), "running");
  } finally {
    k.cleanup();
  }
});

test("自动审查拒绝：来源与理由落库，文案不显示成拥有者拒绝", async () => {
  const reviewer: ApprovalReviewer = { review: async () => ({ decision: "reject", reason: "与任务无关" }) as any };
  const k = kit({ accessMode: "auto-review", reviewer });
  try {
    const { result, hostOpId, id } = k.ask();
    const text = `自动审查拒绝执行 ${TOOL}：与任务无关`;
    assert.deepEqual(await result, { approved: false, text });
    assert.equal(k.summary(hostOpId), text);
    assert.equal(k.approval(id).decisionSource, "auto_review");
  } finally {
    k.cleanup();
  }
});

test("自动审查只覆盖可审查范围：通用 tool 门直接转拥有者，不调用审查模型", async () => {
  let calls = 0;
  const reviewer: ApprovalReviewer = { review: async () => { calls++; return { decision: "approve", reason: "" } as any; } };
  const k = kit({ accessMode: "auto-review", reviewer });
  try {
    const { result, id } = k.ask({ scope: { kind: "tool", workspaceOnly: true } });
    await new Promise((r) => setImmediate(r));
    assert.equal(k.approval(id).reviewStatus, "asked_owner");
    assert.equal(calls, 0);
    k.gate.resolve(id, "approved");
    assert.ok((await result).approved);
    assert.equal(k.approval(id).decisionSource, "owner");
  } finally {
    k.cleanup();
  }
});

test("复核：返回原因即不消费、批准失效，交回该原因；复核在消费事务内执行", async () => {
  const k = kit();
  try {
    let inTx = false;
    const { result, id } = k.ask({
      recheck: () => {
        // 事务内不能再开核心库事务（Db.tx 不嵌套）
        try {
          k.store.withTx(() => {});
        } catch {
          inTx = true;
        }
        return "配置已变化，未执行";
      },
    });
    k.gate.resolve(id, "approved");
    assert.deepEqual(await result, { approved: false, text: "配置已变化，未执行" });
    assert.equal(inTx, true, "复核在消费事务内");
    assert.equal(k.approval(id).status, "stale");
    assert.equal(k.approval(id).consumedAt, null);
    assert.equal(k.events("task.approval_consumed").length, 0);
  } finally {
    k.cleanup();
  }
});

test("复核抛错：不消费、批准失效，错误原样抛出", async () => {
  const k = kit();
  try {
    const { result, id } = k.ask({ recheck: () => { throw new Error("应用库不可用"); } });
    k.gate.resolve(id, "approved");
    await assert.rejects(result, /应用库不可用/);
    assert.equal(k.approval(id).status, "stale");
    assert.equal(k.approval(id).consumedAt, null);
  } finally {
    k.cleanup();
  }
});

test("消费失败：获批后权限版本变化 → 消费失败文案、批准失效", async () => {
  const k = kit();
  try {
    // 复核期间递增权限版本：条件更新要求任务当前版本等于审批时的版本
    const { result, id } = k.ask({ recheck: () => (k.store.applyModeSwitch(k.task.id, "full_access"), null) });
    k.gate.resolve(id, "approved");
    assert.deepEqual(await result, { approved: false, text: `批准已失效（任务结束、权限版本变化或已被消费），${TOOL} 未执行` });
    assert.equal(k.approval(id).status, "stale");
    assert.equal(k.approval(id).consumedAt, null);
  } finally {
    k.cleanup();
  }
});

test("失效标记不动已消费的批准", async () => {
  const k = kit();
  try {
    const { result, id } = k.ask();
    k.gate.resolve(id, "approved");
    assert.ok((await result).approved);
    k.store.withTx(() => k.store.invalidateConfirmation(id));
    assert.equal(k.approval(id).status, "approved");
    assert.notEqual(k.approval(id).consumedAt, null);
  } finally {
    k.cleanup();
  }
});

test("commit 与消费同一事务：返回值交回；抛错则消费一起回滚、批准失效", async () => {
  const k = kit();
  try {
    const ok = k.ask<string>({ commit: (approvalId) => `登记 ${approvalId}` });
    k.gate.resolve(ok.id, "approved");
    const r = await ok.result;
    assert.ok(r.approved);
    assert.equal(r.value, `登记 ${ok.id}`);

    const bad = k.ask<string>({
      commit: () => {
        assert.notEqual(k.approval(bad.id).consumedAt, null, "commit 在消费之后执行");
        throw new Error("活跃计划已达上限");
      },
    });
    k.gate.resolve(bad.id, "approved");
    await assert.rejects(bad.result, /活跃计划已达上限/);
    assert.equal(k.approval(bad.id).consumedAt, null, "消费随 commit 回滚");
    assert.equal(k.approval(bad.id).status, "stale");
    assert.equal(k.events("task.approval_consumed").length, 1, "只有成功的那次");
  } finally {
    k.cleanup();
  }
});

test("两个审批同时等待：两个都结束后任务才回到 running", async () => {
  const k = kit();
  try {
    const a = k.ask();
    const b = k.ask();
    k.gate.resolve(a.id, "approved");
    await a.result;
    assert.equal(k.status(), "awaiting_confirmation", "仍有审批在等待");
    k.gate.resolve(b.id, "rejected");
    await b.result;
    assert.equal(k.status(), "running");
  } finally {
    k.cleanup();
  }
});

test("提前中止：只有本审批失效，另一个等待中的审批与任务状态不受影响", async () => {
  const k = kit();
  try {
    const other = k.ask();
    const aborted = new AbortController();
    aborted.abort();
    const early = k.ask({ signal: aborted.signal });
    const text = `审批已失效（模式切换或任务停止），${TOOL} 未执行；如仍需要请重新申请`;
    assert.deepEqual(await early.result, { approved: false, text });
    assert.equal(k.summary(early.hostOpId), text);
    assert.equal(k.approval(early.id).status, "stale");
    assert.equal(k.approval(other.id).status, "pending", "其他审批仍在等待");
    assert.equal(k.status(), "awaiting_confirmation");
    k.gate.resolve(other.id, "approved");
    assert.ok((await other.result).approved);
    assert.equal(k.status(), "running");
  } finally {
    k.cleanup();
  }
});

test("等待中信号中止：按失效返回，等待结束后移除监听", async () => {
  const k = kit();
  try {
    const ctl = new AbortController();
    const { result, id } = k.ask({ signal: ctl.signal });
    ctl.abort();
    assert.equal((await result).approved, false);
    assert.equal(k.gate.resolve(id, "approved"), false, "等待表不再持有该审批");
  } finally {
    k.cleanup();
  }
});
