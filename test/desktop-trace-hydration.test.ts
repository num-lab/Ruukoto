import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { PersistentEvent, Session } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import type { OpParams } from "@ruukoto/control/ops.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { conversationActivity, conversationSections } from "../apps/desktop/src/renderer/activity.ts";
import { ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import { FakeTransport, fakeSnapshot } from "./helpers/fake-control.ts";

const at = (s: number) => new Date(Date.UTC(2026, 9, 19, 0, 0, s)).toISOString();
const task = (): TaskView => ({ id: "task", sessionId: "a", requestId: "r", input: "问题", inputPurpose: "user", modelSelection: null, submissionDigest: null, status: "completed", queueOrder: 1, accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: ["final"], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at(0), startedAt: at(1), endedAt: at(9) });
const entry = (entryId: string, role: string, text: string, timestamp: string, extra: Partial<HistoryEntryView> = {}): HistoryEntryView => ({ entryId, taskId: "task", inputPurpose: "user", parentId: null, role, text, timestamp, offset: 0, totalBytes: Buffer.byteLength(text), truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false, ...extra });
const event = (seq: number, body: PersistentEvent["body"]): PersistentEvent => ({ seq, body, sessionId: "a", taskId: "task", createdAt: at(seq) });
const session: Session = { id: "a", projectId: "w", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/w", cwdReal: "/w", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, queueRevision: 0, archivedAt: null, createdAt: at(0) };
const events = [
  event(2, { type: "task.thinking", sessionId: "a", taskId: "task", thinkingId: "th", messageId: "m1", startedAt: at(1), endedAt: at(2), text: "思考" }),
  event(3, { type: "task.tool_intent", taskId: "task", toolOpId: "op", sdkCallId: "c", toolName: "bash", params: { command: "ls" } }),
  event(4, { type: "task.tool_result", taskId: "task", toolOpId: "op", summary: "ok", isError: false, artifactIds: [] }),
  event(5, { type: "task.output_fragment", taskId: "task", sessionId: "a", messageId: "m2", text: "最终回复", totalBytes: 12, truncated: false, partial: true, startedAt: at(5), offset: 0 }),
  event(6, { type: "task.output_entry", taskId: "task", sessionId: "a", entryId: "final", messageId: "m2", role: "assistant", sessionFile: "/f.jsonl" }),
];

/** 记录历史页可见后每次交给界面的 trace 收起态；中间投影若被画出来会留下展开记录。 */
async function hydrate(historyPage: HistoryEntryView[], handlers: Partial<ConstructorParameters<typeof FakeTransport>[0]["handlers"]> = {}) {
  const transport = new FakeTransport({ handlers: {
    list_session_summaries: () => [],
    read_history: () => ({ fileAvailable: true, hasPartialTail: false, nextBefore: null, entries: historyPage }),
    list_tasks: () => ({ tasks: [task()], hasMore: false }),
    get_task: () => ({ task: task(), toolOps: [], confirmations: [], artifacts: [], outputPreview: null, seq: 6 }),
    read_task_events: params => ({ events: events.filter(item => item.seq > (params.after_seq ?? 0)), nextAfter: null }),
    ...handlers,
  } });
  const observed: boolean[] = [];
  const model = new CodeState({ request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {
    if (!model.view.sessionViews.get("a")?.historyLoaded) return;
    const items = model.view.openSession("a").flow.items;
    for (const section of conversationSections(model.view, items, conversationActivity(model.view, "a", true, items).timeline, undefined, id => model.historyReady("a", id))) if (section.trace) observed.push(section.completed);
  });
  model.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [session], tasks: [] }), replay: [], seq: 100 }, instanceChanged: false });
  model.update({ type: "state", state: "online" });
  await model.loadHistory("a");
  return { observed, model, transport };
}

test("冷启动恢复只交一次最终投影，窗口外正文补读不闪现展开态", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // 历史页只到中间回复，最终条目由事件补读；补读期间保持挂起，确认恢复窗口内没有中间渲染。
  const pending = hydrate([entry("ask", "user", "问题", at(0.5)), entry("mid", "assistant", "中间", at(2.5))], {
    read_history_entry: async () => { await gate; return entry("final", "assistant", "最终回复", at(6)); },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  release();
  const { observed } = await pending;
  assert.ok(observed.length > 0, "历史页可见后 trace 至少渲染过一次");
  assert.ok(observed.every(Boolean), "恢复期间的中间投影不展示，trace 从首次可见起保持收起");
});
