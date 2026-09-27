/**
 * 架构工单 04：审批闸门（直接构造 Store 与假 reviewer，不起 Runtime）。
 *
 * - 提交：登记审批、任务转入等待确认；全部等待结束才回到 running；
 * - 决定：拥有者批准/拒绝、自动审查拒绝、模式切换、停止，未批准记录已知未执行；
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { AccessMode, ApprovalScope } from "../src/core/types.ts";
import { ApprovalGate } from "../src/agent/approval-gate.ts";
import type { ApprovalReviewer } from "../src/agent/review.ts";

const FILE_READ: ApprovalScope = { kind: "file_operation", path: "/outside/a.txt", access: "read", originalSha256: null, contentSha256: null, contentBytes: null };

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
  const ask = (scope: ApprovalScope = FILE_READ, signal?: AbortSignal) => {
    const hostOpId = `op_${++n}`;
    store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: session.id, toolName: "request_file_access", params: { path: "/outside/a.txt" } });
    const current = store.getTask(task.id)!;
    const outcome = gate.await({ task: current, hostOpId, toolName: "request_file_access", params: { path: "/outside/a.txt" }, scope, signal });
    const confirmation = store.listConfirmationsByTask(task.id).find((c) => c.toolOpId === hostOpId);
    return { hostOpId, outcome, confirmation };
  };
  const status = () => store.getTask(task.id)!.status;
  const events = (type: string) => store.getTaskEventsAfter(task.id, 0, 1000).filter((e) => e.body.type === type);
  const cleanup = () => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { store, task, gate, ask, status, events, cleanup };
}

test("拥有者批准：任务等待确认，批准后回到 running，应答事件记来源", async () => {
  const k = kit();
  try {
    const { outcome, confirmation } = k.ask();
    assert.ok(confirmation);
    assert.equal(confirmation.status, "pending");
    assert.equal(k.status(), "awaiting_confirmation");
    assert.equal(k.gate.resolve(confirmation.id, "approved"), true);
    assert.deepEqual(await outcome, { decision: "approved", source: "owner", reviewReason: null });
    assert.equal(k.status(), "running");
    assert.equal(k.events("task.confirmation_resolved").length, 1);
    assert.equal(k.gate.resolve(confirmation.id, "approved"), false, "已结束的等待不再接受应答");
  } finally {
    k.cleanup();
  }
});

test("未批准记录已知未执行：拥有者拒绝、模式切换、停止", async () => {
  const k = kit();
  try {
    const rejected = k.ask();
    k.gate.resolve(rejected.confirmation!.id, "rejected");
    assert.equal((await rejected.outcome).decision, "rejected");
    assert.equal(k.store.getToolOp(rejected.hostOpId)!.resultSummary, "拥有者拒绝执行 request_file_access");

    const superseded = k.ask();
    k.gate.supersedeAll();
    assert.equal((await superseded.outcome).decision, "superseded");
    assert.match(k.store.getToolOp(superseded.hostOpId)!.resultSummary!, /审批已失效（模式切换或任务停止），request_file_access 未执行/);

    const canceled = k.ask();
    k.gate.cancelAll();
    assert.equal((await canceled.outcome).decision, "superseded", "停止对调用方与失效同样是未执行");
    assert.equal(k.store.getToolOp(canceled.hostOpId)!.resultSummary, "任务停止，确认等待解除（request_file_access 未执行）");

    for (const c of k.store.listConfirmationsByTask(k.task.id)) assert.equal(c.consumedAt, null);
    assert.equal(k.status(), "running");
  } finally {
    k.cleanup();
  }
});

test("自动审查拒绝：来源与理由落库，文案不显示成拥有者拒绝", async () => {
  const reviewer: ApprovalReviewer = { review: async () => ({ decision: "reject", reason: "与任务无关" }) as any };
  const k = kit({ accessMode: "auto-review", reviewer });
  try {
    const { outcome, hostOpId } = k.ask();
    assert.deepEqual(await outcome, { decision: "rejected", source: "auto_review", reviewReason: "与任务无关" });
    assert.equal(k.store.getToolOp(hostOpId)!.resultSummary, "自动审查拒绝执行 request_file_access：与任务无关");
  } finally {
    k.cleanup();
  }
});

test("自动审查只覆盖可审查范围：通用 tool 门直接转拥有者，不调用审查模型", async () => {
  let calls = 0;
  const reviewer: ApprovalReviewer = { review: async () => { calls++; return { decision: "approve", reason: "" } as any; } };
  const k = kit({ accessMode: "auto-review", reviewer });
  try {
    const { outcome, confirmation } = k.ask({ kind: "tool", workspaceOnly: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(k.store.getConfirmation(confirmation!.id)!.reviewStatus, "asked_owner");
    assert.equal(calls, 0);
    k.gate.resolve(confirmation!.id, "approved");
    assert.equal((await outcome).source, "owner");
  } finally {
    k.cleanup();
  }
});

test("两个审批同时等待：两个都结束后任务才回到 running", async () => {
  const k = kit();
  try {
    const a = k.ask();
    const b = k.ask();
    k.gate.resolve(a.confirmation!.id, "approved");
    await a.outcome;
    assert.equal(k.status(), "awaiting_confirmation", "仍有审批在等待");
    k.gate.resolve(b.confirmation!.id, "rejected");
    await b.outcome;
    assert.equal(k.status(), "running");
  } finally {
    k.cleanup();
  }
});
