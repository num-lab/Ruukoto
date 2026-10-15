import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolResultView } from "@ruukoto/core/history.ts";
import type { SubAgent, WorkDelegation } from "@ruukoto/core/types.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { canReadDiff, diffDisplay, parsePatch, type DiffTool } from "../apps/desktop/src/renderer/diff.ts";
import { DesktopInspector } from "../apps/desktop/src/renderer/inspector.ts";
import type { DesktopBridge } from "../apps/desktop/src/shared/bridge.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";

const tool = (extra: Partial<DiffTool> = {}): DiffTool => ({ kind: "tool", key: "tool", at: "", seq: 1, name: "write", target: "file", status: "done", entryId: "entry", toolOpId: "op", toolCallId: "call", params: { content: "不得当作结果" }, paramsTruncated: false, summary: null, artifactIds: [], ...extra });
const result = (extra: Partial<ToolResultView> = {}): ToolResultView => ({ text: "结果", patch: null, writeContent: "已写入", truncated: false, toolName: "write", isError: false, ...extra });

test("差异判定保留失败与效果未知，拒绝用 Write 参数恢复的内容冒充成功", () => {
  for (const status of ["error", "effect_unknown"] as const) {
    assert.deepEqual(diffDisplay(tool({ status }), result({ text: "错误正文", isError: true })), { kind: status, text: "错误正文", truncated: false });
    for (const summary of [null, "已有摘要"]) {
      const entry = tool({ status, entryId: null, summary });
      assert.equal(canReadDiff(entry), false);
      assert.deepEqual(diffDisplay(entry), { kind: status, text: summary ?? (status === "error" ? "失败，详情不可用" : "效果未知"), truncated: false });
    }
  }
  assert.equal(diffDisplay(tool(), result({ isError: true })).kind, "error");
  assert.equal(diffDisplay(tool(), result({ isError: null })).kind, "unavailable");
});

test("差异读取等待历史关联，空文件有效，缺少成功字段不可用", () => {
  assert.equal(canReadDiff(tool({ status: "running" })), false);
  assert.equal(diffDisplay(tool({ status: "running" })).text, "运行中");
  const pending = tool({ entryId: null });
  assert.equal(canReadDiff(pending), false);
  assert.equal(diffDisplay(pending).text, "等待结果落盘");
  assert.equal(canReadDiff({ ...pending, entryId: "landed" }), true);
  assert.equal(diffDisplay(tool({ name: "edit" }), result()).kind, "unavailable");
  assert.equal(diffDisplay(tool(), result({ writeContent: null })).kind, "unavailable");
  assert.deepEqual(diffDisplay(tool(), result({ writeContent: "", writeTotalLines: 0 })), { kind: "write", text: "", truncated: false });
  assert.deepEqual(diffDisplay(tool({ name: "edit" }), result({ patch: "+正文", truncated: true })), { kind: "patch", text: "+正文", truncated: true });
});

test("unified patch 解析普通、多 hunk、截断及无末尾换行", () => {
  const patch = "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n 上下文\n-旧\n+新\n\\ No newline at end of file\n@@ -8 +8 @@\n-末\n+尾";
  assert.deepEqual(parsePatch(patch).map(line => line.kind), ["header", "header", "hunk", "context", "removed", "added", "notice", "hunk", "removed", "added"]);
  assert.equal(parsePatch(patch).at(-1)?.text, "+尾");
  assert.deepEqual(parsePatch("@@ -1 +1 @@\n-旧\n+截断").map(line => line.kind), ["hunk", "removed", "added"]);
  assert.deepEqual(parsePatch("@@ -1 +1 @@\n-旧\n+新\n"), parsePatch("@@ -1 +1 @@\n-旧\n+新"));
  assert.deepEqual(parsePatch(""), []);
});

test("差异请求仅在可读后发出，使用子会话来源并拒绝旧快照结果", async () => {
  const view = new ViewState();
  const flow = view.openSession("child").flow;
  let entry = tool({ entryId: null });
  // 投影输入来自真实工具事件；entryId 后续经历史条目关联。
  flow.apply({ seq: 1, sessionId: "child", taskId: "task", createdAt: "2026-10-15T00:00:00Z", body: { type: "task.tool_intent", taskId: "task", toolOpId: "op", sdkCallId: "call", toolName: "write", params: { path: "file", content: "参数" } } });
  flow.apply({ seq: 2, sessionId: "child", taskId: "task", createdAt: "2026-10-15T00:00:01Z", body: { type: "task.tool_result", taskId: "task", toolOpId: "op", summary: "完成", isError: false, artifactIds: [] } });
  entry = flow.items.find((item): item is DiffTool => item.kind === "tool")!;
  const calls: Record<string, unknown>[] = [];
  let release!: (value: Awaited<ReturnType<DesktopBridge["request"]>>) => void;
  const inspector = new DesktopInspector({ request: async (_target, op, params) => { assert.equal(op, "read_tool_result"); calls.push(params); return new Promise(resolve => { release = resolve; }); } }, view, async () => {}, () => {});
  inspector.openDiff("child", entry);
  assert.equal(calls.length, 0);
  flow.apply({ seq: 3, sessionId: "child", taskId: "task", createdAt: "2026-10-15T00:00:01Z", body: { type: "task.output_entry", taskId: "task", sessionId: "child", entryId: "entry", sessionFile: "/history", role: "toolResult", messageId: null } });
  flow.addHistory({ entryId: "entry", taskId: "task", inputPurpose: "user", parentId: null, role: "toolResult", text: "完成", timestamp: "2026-10-15T00:00:01Z", offset: 0, totalBytes: 6, truncated: false, toolCalls: [], toolCallId: "call", toolName: "write", isError: false, hasNonTextContent: false });
  const pending = inspector.loadDiff();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { session_id: "child", entry_id: "entry", length: 65536 });
  inspector.update({ type: "snapshot", result: { snapshot: fakeSnapshot(), seq: 0, replay: [] }, instanceChanged: true });
  release({ ok: true, value: result({ writeContent: "旧代次" }) });
  await pending;
  assert.equal(inspector.result, null);
});

const agent: SubAgent = { id: "agent", parentSessionId: "parent", sessionId: "child", workDir: "/work", definition: null, activeWorkId: "work", currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: "" };
const work: WorkDelegation = { id: "work", parentSessionId: "parent", originTaskId: "origin", subAgentId: "agent", requestKey: "key", paramsDigest: "digest", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: "" };
test("工作读取保留全部协作者，新事件触发的新查询不被旧应答覆盖", async () => {
  const view = new ViewState();
  view.subAgents = [agent, { ...agent, id: "collaborator", sessionId: "collaborator-session" }];
  const releases: Array<(value: Awaited<ReturnType<DesktopBridge["request"]>>) => void> = [];
  const inspector = new DesktopInspector({ request: async () => new Promise(resolve => releases.push(resolve)) }, view, async () => {}, () => {});
  inspector.openParent("parent");
  const fresh = inspector.loadWorks();
  releases[1]({ ok: true, value: { works: [{ work, agent: { ...agent, state: "unverified" }, tasks: [] }] } });
  await fresh;
  releases[0]({ ok: true, value: { works: [{ work, agent, tasks: [] }] } });
  await Promise.resolve();
  assert.equal(inspector.agents().length, 2);
  assert.equal(inspector.agents()[0].state, "unverified");
  const detail = inspector.selectWork("work");
  inspector.update({ type: "snapshot", result: { snapshot: fakeSnapshot(), seq: 0, replay: [] }, instanceChanged: true });
  releases[2]({ ok: true, value: { work, agent, tasks: [], messages: [] } });
  await detail;
  assert.equal(inspector.detail, null);
  assert.equal(inspector.parentSessionId, null);
});

test("IPC 读取异常可见，重新读取能恢复工作委托", async () => {
  let reject = true;
  const inspector = new DesktopInspector({ request: async () => { if (reject) throw new Error("IPC closed"); return { ok: true, value: { works: [{ work, agent, tasks: [] }] } }; } }, new ViewState(), async () => {}, () => {});
  inspector.parentSessionId = "parent";
  await inspector.loadWorks();
  assert.match(inspector.workError!, /连接不可用/);
  assert.equal(inspector.loadingWorks, false);
  reject = false;
  await inspector.loadWorks();
  assert.equal(inspector.workError, null);
  assert.equal(inspector.works.length, 1);
});

test("历史工具条目恢复操作身份后，差异选择仍指向原调用", async () => {
  const view = new ViewState();
  const flow = view.openSession("child").flow;
  const at = "2026-10-15T00:00:00Z";
  flow.addHistory({ entryId: "entry", taskId: "task", inputPurpose: "user", parentId: null, role: "toolResult", text: "完成", timestamp: at, offset: 0, totalBytes: 6, truncated: false, toolCalls: [], toolCallId: "call", toolName: "write", isError: false, hasNonTextContent: false });
  const entry = flow.items.find((item): item is DiffTool => item.kind === "tool")!;
  const inspector = new DesktopInspector({ request: async () => ({ ok: true, value: result() }) }, view, async () => {}, () => {});
  inspector.openDiff("child", entry);
  await inspector.loadDiff();
  flow.apply({ seq: 2, sessionId: "child", taskId: "task", createdAt: at, body: { type: "task.output_entry", taskId: "task", sessionId: "child", entryId: "entry", sessionFile: "/history", role: "toolResult", messageId: null } });
  flow.apply({ seq: 1, sessionId: "child", taskId: "task", createdAt: at, body: { type: "task.tool_intent", taskId: "task", toolOpId: "op", sdkCallId: "call", toolName: "write", params: { path: "file" } } });
  assert.notEqual(inspector.selectedTool()?.key, entry.key);
  assert.equal(inspector.selectedTool()?.toolOpId, "op");
  assert.equal(inspector.selectedTool()?.entryId, "entry");
});

test("工作查询失败时，缓存仍保留已收到的新委托、取消与 SubAgent 关闭", async () => {
  const view = new ViewState();
  view.subAgents = [agent]; view.workDelegations = [work];
  const inspector = new DesktopInspector({ request: async () => ({ ok: false, error: { code: "timeout", outcome: "unknown", message: "超时" } }) }, view, async () => {}, () => {});
  inspector.parentSessionId = "parent";
  inspector.works = [{ work: { ...work }, agent: { ...agent }, tasks: [] }];
  const close = { seq: 1, taskId: null, sessionId: "parent", createdAt: "2026-10-15T00:00:01Z", body: { type: "subagent.closed" as const, subAgentId: "agent", parentSessionId: "parent", closedBy: "owner" as const, taskId: null } };
  const cancel = { seq: 2, taskId: null, sessionId: "parent", createdAt: "2026-10-15T00:00:02Z", body: { type: "work_delegation.canceled" as const, workId: "work", parentSessionId: "parent", subAgentId: "agent", canceledBy: "owner" as const, reason: "不再需要", canceledTaskIds: [], stoppingTaskIds: [] } };
  const create = { seq: 3, taskId: null, sessionId: "parent", createdAt: "2026-10-15T00:00:03Z", body: { type: "work_delegation.created" as const, workId: "new-work", parentSessionId: "parent", subAgentId: "new-agent", agentSessionId: "new-child", taskId: "new-task" } };
  for (const event of [close, cancel, create]) { view.applyEvent(event, "live"); inspector.update({ type: "event", event, kind: "live" }); }
  await inspector.loadWorks();
  assert.match(inspector.workError!, /超时/);
  assert.equal(inspector.agents().find(item => item.id === "agent")?.closedAt, close.createdAt);
  assert.equal(inspector.workDelegations().find(item => item.id === "work")?.canceledAt, cancel.createdAt);
  assert.equal(inspector.workDelegations().find(item => item.id === "work")?.cancelReason, "不再需要");
  assert.ok(inspector.workDelegations().some(item => item.id === "new-work"));
  assert.ok(inspector.agents().some(item => item.id === "new-agent"));
  assert.equal(inspector.agents().find(item => item.id === "new-agent")?.definition, null);
});
