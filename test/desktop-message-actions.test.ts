import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { OpParams } from "@ruukoto/control/ops.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { Session, TaskStatus } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import { ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

const at = "2026-10-28T00:00:00.000Z";
let server: ViteDevServer;
let Conversation: ComponentType<{ model: CodeState; sessionId: string; child?: boolean }>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  ({ Conversation } = await server.ssrLoadModule("/conversation.tsx"));
});
after(async () => { await server.close(); });

function task(status: TaskStatus): TaskView {
  return { id: "task", sessionId: "s1", requestId: "request", input: "问题", inputPurpose: "user", modelSelection: null, submissionDigest: null, status, accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: ["answer"], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at, startedAt: at, endedAt: status === "completed" || status === "failed" || status === "canceled" || status === "interrupted" ? at : null };
}
function model(status: TaskStatus, role: "assistant" | "user" = "assistant"): CodeState {
  const state = new CodeState({ request: async () => ({ ok: false, error: { code: "unused", outcome: "rejected", message: "不应发起请求" } }) }, () => {});
  state.view.instanceId = "inst-1";
  state.view.sessions.push(source);
  state.status = { type: "state", state: "online" };
  state.view.openSession("s1").flow.addHistory({ entryId: "answer", taskId: "task", inputPurpose: "user", parentId: null, role, text: "本轮回答", timestamp: at, offset: 0, totalBytes: Buffer.byteLength("本轮回答"), truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: false });
  state.view.tasks.set("task", task(status));
  return state;
}
const source: Session = { id: "s1", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: "来源", branchSource: null, cwd: "/w", cwdReal: "/w", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: at };

test("agent 消息只在对应任务完成时显示复制与分支操作", () => {
  const completed = renderToStaticMarkup(createElement(Conversation, { model: model("completed"), sessionId: "s1" }));
  assert.match(completed, /aria-label="复制消息"/);
  assert.match(completed, /aria-label="从当前任务建立分支"/);
  for (const status of ["running", "failed", "canceled", "interrupted"] as const) {
    const html = renderToStaticMarkup(createElement(Conversation, { model: model(status), sessionId: "s1" }));
    assert.doesNotMatch(html, /aria-label="复制消息"|aria-label="从当前任务建立分支"/, status);
  }
});

test("任务内多条 assistant 消息各自显示操作，定时会话不显示分支", () => {
  const state = model("completed");
  state.view.openSession("s1").flow.addHistory({ entryId: "earlier", taskId: "task", inputPurpose: "user", parentId: null, role: "assistant", text: "中间步骤", timestamp: "2026-10-27T00:00:00.000Z", offset: 0, totalBytes: Buffer.byteLength("中间步骤"), truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: false });
  const html = renderToStaticMarkup(createElement(Conversation, { model: state, sessionId: "s1" }));
  assert.equal((html.match(/aria-label="复制消息"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="从当前任务建立分支"/g) ?? []).length, 2);
  state.view.sessions[0]!.codeScheduleRunId = "run";
  const scheduled = renderToStaticMarkup(createElement(Conversation, { model: state, sessionId: "s1" }));
  assert.match(scheduled, /aria-label="复制消息"/);
  assert.doesNotMatch(scheduled, /aria-label="从当前任务建立分支"/);
});

test("用户消息显示复制，子会话不提供建立分支", () => {
  for (const status of ["completed", "running"] as const) {
    const user = renderToStaticMarkup(createElement(Conversation, { model: model(status, "user"), sessionId: "s1" }));
    assert.match(user, /aria-label="复制消息"/);
    assert.doesNotMatch(user, /aria-label="从当前任务建立分支"/);
  }
  const child = renderToStaticMarkup(createElement(Conversation, { model: model("completed"), sessionId: "s1", child: true }));
  assert.match(child, /aria-label="复制消息"/);
  assert.doesNotMatch(child, /aria-label="从当前任务建立分支"/);
});

test("建立分支携带任务身份，成功后切换到新会话", async () => {
  const branch: Session = { ...source, id: "branch", createRequestId: "request-branch", name: "来源 · 分支 1" };
  const handlers: FakeHandlers = {
    branch_session: params => {
      assert.deepEqual(params, { session_id: "s1", task_id: "task", request_id: params.request_id });
      return branch;
    },
  };
  const transport = new FakeTransport({ handlers });
  const state = new CodeState({ request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {});
  state.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [source] }), replay: [], seq: 0 }, instanceChanged: false });
  state.update({ type: "state", state: "online" });
  state.view.tasks.set("task", task("completed"));
  assert.equal(await state.branch("s1", "task"), true);
  assert.equal(state.view.currentSessionId, "branch");
  assert.ok(state.view.sessions.some(session => session.id === "branch"));
  assert.equal(state.pendingBranch, null);
});

test("分支明确拒绝时按原请求核实，确认未发布才清除待办", async () => {
  let found = 0;
  const transport = new FakeTransport({ handlers: {
    branch_session: () => { throw new ControlClientError("invalid_params", "任务尚未完成", "rejected"); },
    find_branch_session: () => { found++; return { status: "not_found" as const, session: null, error: null }; },
  } });
  const state = new CodeState({ request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {});
  state.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [source] }), replay: [], seq: 0 }, instanceChanged: false });
  state.update({ type: "state", state: "online" });
  state.view.tasks.set("task", task("completed"));
  assert.equal(await state.branch("s1", "task"), false);
  assert.equal(found, 1);
  assert.equal(state.pendingBranch, null);
  assert.match(state.message!, /建立分支失败/);
});

test("分支会话加载历史时恢复来源任务的思考与工具 trace", async () => {
  const branchSession: Session = { ...source, id: "branch-history", name: "来源 · 分支", branchSource: { sessionId: "s1", number: 1, entryId: "old", messageCount: 1, excluded: [], taskIds: ["ancestor"], artifacts: [], results: [] } };
  const ancestor = { ...task("completed"), id: "ancestor", sessionId: "s1" };
  const events = [
    { seq: 1, sessionId: "s1", taskId: "ancestor", createdAt: at, body: { type: "task.thinking" as const, taskId: "ancestor", sessionId: "s1", thinkingId: "thought", messageId: "old", startedAt: at, endedAt: at, text: "之前对话的思考" } },
    { seq: 2, sessionId: "s1", taskId: "ancestor", createdAt: at, body: { type: "task.tool_intent" as const, taskId: "ancestor", toolOpId: "operation", sdkCallId: "call", toolName: "read", params: { path: "old.ts" } } },
    { seq: 3, sessionId: "s1", taskId: "ancestor", createdAt: at, body: { type: "task.tool_result" as const, taskId: "ancestor", toolOpId: "operation", summary: "之前读取完成", isError: false, artifactIds: [] } },
  ];
  const historyEntry: HistoryEntryView = { entryId: "old", taskId: "ancestor", inputPurpose: "user", parentId: null, role: "assistant", text: "之前回答", timestamp: at, offset: 0, totalBytes: Buffer.byteLength("之前回答"), truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false };
  const transport = new FakeTransport({ handlers: {
    list_tasks: () => ({ tasks: [], hasMore: false }),
    read_history: () => ({ fileAvailable: true, hasPartialTail: false, entries: [historyEntry], nextBefore: null }),
    get_task: params => ({ task: { ...ancestor, id: params.task_id }, toolOps: [], outputPreview: null, seq: 3, confirmations: [], artifacts: [] }),
    read_task_events: params => ({ events: events.filter(event => event.seq > (params.after_seq ?? 0)), nextAfter: null }),
  } });
  const state = new CodeState({ request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {});
  state.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [branchSession] }), replay: [], seq: 0 }, instanceChanged: false });
  state.update({ type: "state", state: "online" });
  await state.loadHistory("branch-history");
  const items = state.view.openSession("branch-history").flow.items;
  assert.ok(items.some(item => item.kind === "thinking" && item.text === "之前对话的思考"));
  assert.ok(items.some(item => item.kind === "tool" && item.name === "read" && item.summary === "之前读取完成"));
});

test("分支应答丢失按原请求键重试一次，断线后按快照核实", async () => {
  const branch: Session = { ...source, id: "branch-retry", createRequestId: "request-retry", name: "来源 · 分支 2" };
  const ids: string[] = [];
  let attempts = 0;
  const retryTransport = new FakeTransport({ handlers: {
    branch_session: params => {
      attempts++; ids.push(params.request_id);
      if (attempts === 1) throw new ControlClientError("request_timeout", "模拟应答丢失", "unknown");
      return { ...branch, createRequestId: params.request_id };
    },
  } });
  const retry = new CodeState({ request: (_target, op, params) => ipcResult(() => retryTransport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {});
  retry.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [source] }), replay: [], seq: 0 }, instanceChanged: false });
  retry.update({ type: "state", state: "online" });
  retry.view.tasks.set("task", task("completed"));
  assert.equal(await retry.branch("s1", "task"), true);
  assert.equal(attempts, 2);
  assert.deepEqual([...new Set(ids)], [ids[0]]);

  const snapshotBranch: Session = { ...source, id: "branch-snapshot", createRequestId: "request-snapshot", name: "来源 · 分支 3" };
  let drops = 0;
  const dropTransport = new FakeTransport({ handlers: {
    branch_session: params => { if (++drops === 1) throw new ControlClientError("connection_closed", "模拟断线", "disconnected"); return { ...snapshotBranch, createRequestId: params.request_id }; },
  } });
  const dropped = new CodeState({ request: (_target, op, params) => ipcResult(() => dropTransport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {});
  dropped.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [source] }), replay: [], seq: 0 }, instanceChanged: false });
  dropped.update({ type: "state", state: "online" });
  dropped.view.tasks.set("task", task("completed"));
  assert.equal(await dropped.branch("s1", "task"), false);
  assert.ok(dropped.pendingBranch);
  const requestId = dropped.pendingBranch!.requestId;
  dropped.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [source, { ...snapshotBranch, createRequestId: requestId }] }), replay: [], seq: 100 }, instanceChanged: false });
  await waitFor("分支快照核实", () => dropped.pendingBranch === null);
  assert.equal(dropped.view.currentSessionId, "branch-snapshot");
});

test("分支准备未完成保留原键，可再次点击重试并在明确失败后清除", async () => {
  let finds = 0;
  const transport = new FakeTransport({ handlers: {
    branch_session: () => { throw new ControlClientError("branch_prepare_failed", "分支尚未发布", "rejected"); },
    find_branch_session: () => ++finds === 1 ? { status: "prepared" as const, session: null, error: null } : { status: "failed" as const, session: null, error: "准备失败" },
  } });
  const state = new CodeState({ request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {});
  state.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [source] }), replay: [], seq: 0 }, instanceChanged: false });
  state.update({ type: "state", state: "online" });
  state.view.tasks.set("task", task("completed"));
  assert.equal(await state.branch("s1", "task"), false);
  assert.ok(state.pendingBranch);
  assert.match(state.message!, /再次点击/);
  assert.equal(await state.branch("s1", "task"), false);
  assert.equal(state.pendingBranch, null);
  assert.match(state.message!, /建立分支失败/);
});
