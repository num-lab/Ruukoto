import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";
/** 分支使用真实 JSONL、SQLite、控制面与模拟模型，验证快照边界和最终发送内容。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { parseSessionFile, parseSessionFileStrict, snapshotSessionHistory } from "@ruukoto/core/history.ts";
import { getBranchRequest } from "@ruukoto/core/branch.ts";
import { checkpointFingerprint, COMPACTION_PROMPT_VERSION } from "@ruukoto/agent/compaction.ts";
import { TASK_START_MARKER, TASK_END_MARKER, randomId, type Session } from "@ruukoto/core/types.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { applyLegacyImport, previewLegacyImport, revertLegacyImport } from "../apps/ruukoto-code/src/legacy-import.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { ControlClient, ControlClientError } from "@ruukoto/control/client.ts";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { TuiApp } from "@ruukoto/tui/tui/app.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";
import { startTestRuntime, waitFor, afterTool, inputText, realTools, type TestRuntime } from "./helpers/testkit.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function history(t: TestRuntime, session: Session) {
  const store = t.runtime.store;
  const file = path.join(t.dirs.dataDir, "sessions", `source_${session.piSessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: session.piSessionId, timestamp: new Date().toISOString(), cwd: session.cwdReal })}\n`);
  store.setSessionFile(session.id, file);
  let parentId: string | null = null;
  const entry = (value: Record<string, unknown>) => {
    const id = randomUUID().slice(0, 8);
    fs.appendFileSync(file, `${JSON.stringify({ ...value, id, parentId, timestamp: new Date().toISOString() })}\n`);
    parentId = id;
    return id;
  };
  const task = (status: "completed" | "interrupted" | "running" | "awaiting_confirmation" = "completed", sourceEventId?: string) => {
    const task = store.withTx(() => {
      const task = store.insertQueuedTask({ sessionId: session.id, requestId: randomId("req"), input: "来源对话", modelSelection: t.runtime.defaultSelection, submissionDigest: randomId("digest"), sourceEventId }).task;
      if (status === "completed" || status === "interrupted") store.endTask(task.id, ["queued"], status);
      else store.transitionTask(task.id, ["queued"], status);
      return store.getTask(task.id)!;
    });
    entry({ type: "custom", customType: TASK_START_MARKER, data: { taskId: task.id } });
    return task;
  };
  const user = (text: string, refs?: unknown[]) => entry({ type: "message", message: { role: "user", content: text, timestamp: Date.now(), ...(refs ? { ruukotoMediaRefs: refs } : {}) } });
  const assistant = (content: unknown[]) => entry({ type: "message", message: { role: "assistant", content, timestamp: Date.now(), api: "openai-completions", provider: "mock", model: "mock-model", usage, stopReason: content.some((p: any) => p.type === "toolCall") ? "toolUse" : "stop" } });
  const result = (name: string, id: string, isError = false) => entry({ type: "message", message: { role: "toolResult", toolName: name, toolCallId: id, isError, content: [{ type: "text", text: "结果" }], timestamp: Date.now() } });
  return { file, entry, task, user, assistant, result };
}

async function fixture(prefix: string) {
  const t = await startTestRuntime(prefix, async () => ({ kind: "text", text: "分支回复" }), { config: { product: product.runtime } });
  const session = (await t.runtime.openWorkspace({ cwd: t.work[0]! })).session;
  return { t, session, h: history(t, session) };
}

test("严格安全点：完整用户尾、活动批次回退、旧孤儿及重复调用 ID、坏行与部分尾行", async () => {
  const { t, session, h } = await fixture("branch-prefix");
  try {
    h.task("interrupted"); h.user("旧中断"); h.assistant([{ type: "toolCall", id: "repeat", name: "read", arguments: {} }]);
    h.task(); h.user("正常对话"); h.assistant([{ type: "toolCall", id: "repeat", name: "read", arguments: {} }]); h.result("read", "repeat");
    h.task("running"); const lastUser = h.user("完整落盘用户尾");
    const before = fs.readFileSync(h.file);
    assert.equal(snapshotSessionHistory(h.file, id => t.runtime.store.getTask(id)?.status ?? null).entryId, lastUser);
    h.assistant([{ type: "toolCall", id: "pending", name: "read", arguments: {} }, { type: "toolCall", id: "other", name: "read", arguments: {} }]);
    h.result("read", "pending");
    fs.appendFileSync(h.file, '{"type":"message"');
    const snapshot = snapshotSessionHistory(h.file, id => t.runtime.store.getTask(id)?.status ?? null);
    assert.equal(snapshot.entryId, lastUser);
    assert.equal(snapshot.messageCount, 6);
    assert.equal(snapshot.excluded.length, 2);
    const source = fs.readFileSync(h.file);
    const branch = await t.runtime.branchSession({ sessionId: session.id, requestId: "safe-prefix" });
    assert.deepEqual(parseSessionFile(branch.sessionFile!).slice(1), parseSessionFileStrict(before.toString()).entries.slice(1));
    assert.deepEqual(fs.readFileSync(h.file), source, "复制不会给源文件补换行");
    const branchTask = await t.runtime.submit({ sessionId: branch.id, requestId: "clean-pairing", input: "新分支输入", modelSelection: t.runtime.defaultSelection });
    await waitFor("旧孤儿在模型视图清理", () => t.runtime.store.getTask(branchTask.id)!.status === "completed");
    const calls = t.server.calls[0]!.messages.filter(m => m.role === "assistant" && Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls as unknown[]);
    assert.equal(calls.length, 1, "旧中断调用不能由下一任务复用 ID 的结果补齐");
    fs.appendFileSync(h.file, '\n');
    await assert.rejects(() => t.runtime.branchSession({ sessionId: session.id, requestId: "bad-line" }), (error: any) => error.code === "history_corrupt");
    assert.deepEqual(fs.readFileSync(h.file).subarray(0, source.length), source);
  } finally { await t.shutdown(); }
});

test("空历史、未映射旧会话、main/归档和目录替换零创建；映射旧会话保持资料身份与各默认模式", async () => {
  const { t, session, h } = await fixture("branch-reject");
  try {
    const rt = t.runtime;
    await assert.rejects(() => rt.branchSession({ sessionId: session.id, requestId: "empty" }), (e: any) => e.code === "entry_not_found");
    h.task(); h.user("可复制历史");
    const legacy = await rt.createSession({ projectName: "旧资料项目", cwd: t.work[0]! });
    const old = history(t, legacy); old.task(); old.user("旧会话历史");
    await assert.rejects(() => rt.branchSession({ sessionId: legacy.id, requestId: "unmapped" }), /尚未映射/);
    rt.store.db.prepare("UPDATE sessions SET workspace_project_id = ? WHERE id = ?").run(session.projectId, legacy.id);
    for (const mode of ["confirm", "auto-review", "full_access", "plan"] as const) {
      const current = rt.store.getSession(legacy.id)!;
      rt.store.withTx(() => rt.store.setSessionDefaultMode(legacy.id, mode, current.defaultAccessModeVersion));
      const child = await rt.branchSession({ sessionId: legacy.id, name: "同名", requestId: `mapped-${mode}` });
      assert.equal(child.projectId, legacy.projectId);
      assert.equal(child.workspaceProjectId, session.projectId);
      assert.equal(child.defaultAccessMode, mode);
      assert.equal(child.defaultAccessModeVersion, 0);
    }
    const count = rt.store.listSessions().length;
    const main = rt.store.getAgentRole("main")!;
    await assert.rejects(() => rt.branchSession({ sessionId: main.sessionId, requestId: "main" }), /普通开发/);
    rt.store.db.prepare("UPDATE sessions SET kind = 'qq_group' WHERE id = ?").run(session.id);
    await assert.rejects(() => rt.branchSession({ sessionId: session.id, requestId: "retired" }), /普通开发/);
    rt.store.db.prepare("UPDATE sessions SET kind = 'dev' WHERE id = ?").run(session.id);
    fs.renameSync(t.work[0]!, `${t.work[0]}-original`); fs.mkdirSync(t.work[0]!);
    await assert.rejects(() => rt.branchSession({ sessionId: session.id, requestId: "replaced" }), (e: any) => e.code === "cwd_changed");
    assert.equal(rt.store.listSessions().length, count);
    assert.equal(rt.store.db.prepare("SELECT COUNT(*) AS n FROM branch_requests WHERE status != 'published'").get()!.n, 0);
  } finally { await t.shutdown(); }
});

test("真实等待审批与排队期间分支只取用户安全尾，新任务等待同目录占用，原审批不转移", async () => {
  const t = await startTestRuntime("branch-active", async req => afterTool(req) ? ({ kind: "text", text: "完成" }) : ({ kind: "tool_calls", calls: [{ id: "gate", name: "mock_gate", arguments: { note: "确认" } }] }), { config: { product: product.runtime } });
  try {
    const rt = t.runtime;
    const source = (await rt.openWorkspace({ cwd: t.work[0]! })).session;
    rt.store.db.prepare("UPDATE sessions SET confirm_tools = ? WHERE id = ?").run('["mock_gate"]', source.id);
    const first = await rt.submit({ sessionId: source.id, requestId: "active", input: "已落盘用户", modelSelection: rt.defaultSelection });
    await waitFor("来源等待审批", () => rt.store.getTask(first.id)!.status === "awaiting_confirmation");
    const queued = await rt.submit({ sessionId: source.id, requestId: "queued", input: "排队输入不能复制", modelSelection: rt.defaultSelection });
    const branch = await rt.branchSession({ sessionId: source.id, requestId: "active-branch" });
    const text = fs.readFileSync(branch.sessionFile!, "utf8");
    assert.ok(text.includes("已落盘用户") && !text.includes("排队输入不能复制") && !text.includes('"toolCall"'));
    assert.equal(branch.branchSource!.excluded.length, 1);
    assert.equal(rt.store.listTasksBySession(branch.id).length, 0);
    const own = await rt.submit({ sessionId: branch.id, requestId: "own", input: "分支自己的输入", modelSelection: rt.defaultSelection });
    assert.equal(rt.store.getTask(own.id)!.status, "queued");
    assert.equal(rt.store.getTask(queued.id)!.status, "queued");
    assert.equal(rt.store.listConfirmationsByTask(own.id).length, 0);
    const approval = rt.store.listConfirmationsByTask(first.id)[0]!;
    assert.equal(approval.status, "pending");
    await rt.cancelTask(queued.id);
    rt.respondConfirmation(approval.id, "approved", approval.permissionVersion);
    await waitFor("源审批后继续原任务", () => rt.store.getTask(first.id)!.status === "completed");
    await waitFor("分支以自己的审批继续", () => rt.store.getTask(own.id)!.status === "awaiting_confirmation");
    assert.notEqual(rt.store.listConfirmationsByTask(own.id)[0]!.id, approval.id);
    await rt.cancelTask(own.id);
  } finally { await t.shutdown(); }
});

test("幂等独立历史、名称及设置；首个新任务只统计自己的请求，压缩与清单各自延续", async () => {
  const { t, session, h } = await fixture("branch-create");
  try {
    const original = h.task(); h.user("来源对话");
    const todos = [{ content: "检查分支清单", status: "in_progress" }];
    h.assistant([{ type: "toolCall", id: "todo", name: "todo_write", arguments: { todos } }]); h.result("todo_write", "todo");
    h.assistant([{ type: "text", text: "父会话回答" }]); h.entry({ type: "custom", customType: TASK_END_MARKER, data: { taskId: original.id } });
    const source = fs.readFileSync(h.file);
    t.runtime.store.withTx(() => t.runtime.store.setSessionDefaultMode(session.id, "plan", 0));
    t.runtime.store.db.prepare("UPDATE sessions SET confirm_tools = ? WHERE id = ?").run('["bash"]', session.id);
    const messages = parseSessionFile(h.file).filter(e => e.type === "message").map(e => e.message);
    const cp = { id: randomId("ckpt"), sessionId: session.id, summarizedCount: 1, clearedCount: 1, fingerprint: checkpointFingerprint(messages, 1), summary: "来源对话摘要", summaryUntil: null,
      clearedRefs: {}, clearedResults: 0, summaryModel: null, summaryStatus: "none" as const, summaryError: null, promptVersion: COMPACTION_PROMPT_VERSION,
      usage: { input: 10000, output: 20 }, estimateBefore: 100, estimateAfter: 50, taskId: original.id, callIndex: 1, createdAt: new Date().toISOString() };
    t.runtime.store.withTx(() => t.runtime.store.insertCheckpoint(cp));
    const [a, replay] = await Promise.all([t.runtime.branchSession({ sessionId: session.id, name: "中文 名称", requestId: "branch-one" }), t.runtime.branchSession({ sessionId: session.id, name: "中文 名称", requestId: "branch-one" })]);
    assert.equal(a.id, replay.id);
    assert.equal(a.name, "中文 名称"); assert.equal(a.defaultAccessMode, "plan"); assert.equal(a.defaultAccessModeVersion, 0);
    assert.deepEqual(a.confirmTools, ["bash"]); assert.notEqual(a.piSessionId, session.piSessionId);
    assert.equal(parseSessionFile(a.sessionFile!)[0]!.id, a.piSessionId);
    assert.deepEqual(parseSessionFile(a.sessionFile!).slice(1), parseSessionFile(h.file).slice(1));
    assert.deepEqual(t.runtime.getSessionTodos(a.id).todos, todos);
    assert.equal(t.runtime.store.listTasksBySession(a.id).length, 0); assert.equal(t.server.calls.length, 0);
    assert.deepEqual(t.runtime.getSessionUsage(a.id), { input: 0, output: 0 });
    assert.notEqual(t.runtime.store.getActiveCheckpoint(a.id)!.id, cp.id);
    t.runtime.store.withTx(() => t.runtime.store.invalidateCheckpoint(cp.id));
    assert.ok(t.runtime.store.getActiveCheckpoint(a.id));
    await assert.rejects(() => t.runtime.branchSession({ sessionId: session.id, name: "异参", requestId: "branch-one" }), (e: any) => e.code === "request_conflict");
    const auto = await Promise.all(["auto-a", "auto-b"].map(requestId => t.runtime.branchSession({ sessionId: session.id, requestId })));
    assert.notEqual(auto[0]!.name, auto[1]!.name);
    const committed = t.runtime.store.onCommitted;
    t.runtime.store.onCommitted = events => {
      committed?.(events);
      if (events.some(event => event.body.type === "session.created" && event.body.session?.branchSource)) throw new Error("提交后广播窗口故障");
    };
    try {
      const published = await t.runtime.branchSession({ sessionId: session.id, requestId: "committed-reply" });
      assert.equal(t.runtime.findBranchSession("committed-reply").session!.id, published.id, "提交成功不误报未创建");
    } finally { t.runtime.store.onCommitted = committed; }
    const task = await t.runtime.submit({ sessionId: a.id, requestId: "new-task", input: "新分支输入", modelSelection: t.runtime.defaultSelection });
    await waitFor("分支第一次任务结束", () => t.runtime.store.getTask(task.id)!.status === "completed");
    assert.equal(t.runtime.getSession(a.id).name, a.name);
    assert.equal(t.runtime.store.listSelectionRecordsBySession(a.id).length, 1);
    assert.match(inputText(t.server.calls[0]!), /检查分支清单/);
    assert.deepEqual(fs.readFileSync(h.file), source);
    assert.ok(fs.readFileSync(a.sessionFile!).length > source.length);
    assert.equal(t.runtime.listSessionSummaries({ projectId: session.projectId }).find(s => s.sessionId === a.id)!.name, a.name);
  } finally { await t.shutdown(); }
});

test("分支独立复制手动压缩来源，原操作回执与取消资格不转移", async () => {
  const { t, session, h } = await fixture("branch-manual-compaction");
  try {
    h.task(); h.user("已确认要求"); h.assistant([{ type: "text", text: "最后完整回复" }]);
    const messages = parseSessionFile(h.file).filter(entry => entry.type === "message").map(entry => entry.message);
    const point = { id: randomId("ckpt"), sessionId: session.id, summarizedCount: 1, clearedCount: 1, fingerprint: checkpointFingerprint(messages, 1), summary: "已确认要求", summaryUntil: null,
      clearedRefs: {}, clearedResults: 0, summaryModel: "mock/mock-model", summaryStatus: "ok" as const, summaryError: null, promptVersion: COMPACTION_PROMPT_VERSION,
      usage: null, estimateBefore: 100, estimateAfter: 50, taskId: null, callIndex: null, manualRequestId: "source-manual-compaction", createdAt: new Date().toISOString() };
    t.runtime.store.withTx(() => {
      t.runtime.store.insertCheckpoint(point);
      t.runtime.store.db.prepare("INSERT INTO compaction_requests (request_id, session_id, params_digest, payload, status) VALUES ('source-manual-compaction', ?, 'digest', '{}', 'succeeded')").run(session.id);
    });
    const child = await t.runtime.branchSession({ sessionId: session.id, requestId: "branch-manual-source" });
    const inherited = t.runtime.store.getActiveCheckpoint(child.id)!;
    assert.notEqual(inherited.id, point.id);
    assert.deepEqual([inherited.taskId, inherited.callIndex, inherited.manualRequestId], [null, null, point.manualRequestId]);
    assert.equal(t.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM compaction_requests WHERE session_id = ?").get(child.id)!.n, 0);
    t.runtime.store.withTx(() => t.runtime.store.invalidateCheckpoint(point.id));
    assert.equal(t.runtime.store.getActiveCheckpoint(child.id)!.id, inherited.id);
  } finally { await t.shutdown(); }
});

test("连续分支恢复原图片的实际模型 payload，伪造、缺失和损坏图片均拒绝且零请求", async () => {
  const { t, session, h } = await fixture("branch-images");
  try {
    const rt = t.runtime;
    const resolve = rt.models.current.modelCatalog.resolve.bind(rt.models.current.modelCatalog);
    rt.models.current.modelCatalog.resolve = async selection => ({ ...await resolve(selection), input: ["text", "image"] });
    const event = rt.store.withTx(() => rt.store.registerInboundEvent({ source: "telegram", externalId: randomId("in"), actor: "telegram:owner", targetRole: "main", body: "图片" }).event);
    const task = h.task("completed", event.id);
    const image = rt.artifacts.importImage({ id: randomId("art"), taskId: task.id, sessionId: session.id, name: "inbound-image:0",
      mimeType: "image/png", byteCount: PNG.length, contentHash: createHash("sha256").update(PNG).digest("hex") }, PNG);
    rt.store.withTx(() => {
      rt.store.markInboundQueued(event.id, task.id);
      rt.store.db.prepare("UPDATE inbound_events SET artifact_refs = ? WHERE id = ?").run(JSON.stringify([image.id]), event.id);
    });
    const ref = { artifactId: image.id, taskId: task.id, sessionId: session.id, mimeType: image.mimeType, byteCount: image.byteCount, contentHash: image.contentHash };
    h.user("原图", [ref]); h.assistant([{ type: "text", text: "这是原图" }]);
    const b = await rt.branchSession({ sessionId: session.id, requestId: "image-b" });
    const c = await rt.branchSession({ sessionId: b.id, requestId: "image-c" });
    assert.equal(c.branchSource!.artifacts[0]!.sessionId, session.id);
    const modelTask = await rt.submit({ sessionId: c.id, requestId: "vision", input: "继续看原图", modelSelection: rt.defaultSelection });
    await waitFor("图片分支结束", () => rt.store.getTask(modelTask.id)!.status === "completed");
    assert.ok(t.server.calls[0]!.messages.some(message => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url" && part.image_url.url === `data:image/png;base64,${PNG.toString("base64")}`)));
    const own = await rt.createSession({ projectId: session.projectId, cwd: t.work[0]! });
    const forged = history(t, own); forged.task(); forged.user("伪造来源", [ref]);
    await assert.rejects(() => rt.branchSession({ sessionId: own.id, requestId: "forged-image" }), (e: any) => e.code === "image_reference_invalid");
    const before = t.server.calls.length;
    fs.writeFileSync(path.join(t.dirs.dataDir, "artifacts", `${image.id}.bin`), Buffer.from("损坏图片"));
    const bad = await rt.submit({ sessionId: b.id, requestId: "corrupt-image", input: "查看图片", modelSelection: rt.defaultSelection });
    await waitFor("损坏图片任务中断", () => rt.store.getTask(bad.id)!.status === "interrupted");
    assert.match(rt.store.getTask(bad.id)!.interruptReason!, /image_reference_invalid/);
    assert.equal(t.server.calls.length, before);
    fs.rmSync(path.join(t.dirs.dataDir, "artifacts", `${image.id}.bin`));
    const missing = await rt.submit({ sessionId: c.id, requestId: "missing-image", input: "再看图片", modelSelection: rt.defaultSelection });
    await waitFor("缺失图片任务中断", () => rt.store.getTask(missing.id)!.status === "interrupted");
    assert.equal(t.server.calls.length, before);
  } finally { await t.shutdown(); }
});

test("partial 产物固定字节与状态，正文任意 ID 不进入宿主来源，连续分支保留上限", async () => {
  const { t, session, h } = await fixture("branch-artifact");
  try {
    const rt = t.runtime;
    const task = h.task(); h.user("运行工具");
    const artifact = rt.artifacts.begin({ taskId: task.id, sessionId: session.id, name: "bash stdout" });
    rt.artifacts.append(artifact.id, Buffer.from("原片段"));
    const unrelated = rt.artifacts.begin({ taskId: task.id, sessionId: session.id, name: "无引用产物" });
    rt.artifacts.append(unrelated.id, Buffer.from("不授权"));
    h.assistant([{ type: "toolCall", id: "bash-id", name: "bash", arguments: { command: "true" } }]);
    rt.store.withTx(() => {
      const opId = randomId("op");
      rt.store.recordToolIntent({ id: opId, sessionId: session.id, taskId: task.id, toolName: "bash", sdkCallId: "bash-id", params: { command: "true" } });
      new ToolOpLedger(rt.store).recordResult(task, opId, "结果", false, { artifactIds: [artifact.id] });
    });
    h.result("bash", "bash-id"); h.assistant([{ type: "text", text: `用户正文提到 ${unrelated.id} 不产生读取资格` }]);
    const b = await rt.branchSession({ sessionId: session.id, requestId: "artifact-b" });
    assert.deepEqual(b.branchSource!.artifacts.map(a => a.id), [artifact.id]);
    rt.artifacts.append(artifact.id, Buffer.from("分支之后")); rt.artifacts.complete(artifact.id);
    const c = await rt.branchSession({ sessionId: b.id, requestId: "artifact-c" });
    for (const branch of [b, c]) {
      const result = rt.queryArtifact({ taskId: task.id, artifactId: artifact.id, sessionId: branch.id, length: 4096 });
      assert.equal(Buffer.from(result.data, "base64").toString(), "原片段");
      assert.equal(result.artifact.status, "partial");
      assert.throws(() => rt.queryArtifact({ taskId: task.id, artifactId: unrelated.id, sessionId: branch.id }), (e: any) => e.code === "access_denied");
    }
  } finally { await t.shutdown(); }
});

test("发布失败保留原回执，重启核实原快照；成功文件缺失明确拒绝", async () => {
  const { t, session, h } = await fixture("branch-recovery");
  let restarted: Runtime | null = null;
  try {
    h.task(); h.user("原快照");
    const prepare = t.runtime.store.createSession.bind(t.runtime.store);
    t.runtime.store.createSession = input => {
      if (input.branchSession) throw new Error("注入元数据提交失败");
      return prepare(input);
    };
    await assert.rejects(() => t.runtime.branchSession({ sessionId: session.id, requestId: "recover-branch" }), (e: any) => e.code === "branch_prepare_failed");
    const request = getBranchRequest(t.runtime.store, "recover-branch")!;
    assert.equal(t.runtime.store.getSession(request.session.id), null);
    await assert.rejects(() => t.runtime.createSession({ projectId: session.projectId, cwd: session.cwd, createRequestId: "recover-branch" }), (e: any) => e.code === "request_conflict");
    await assert.rejects(() => t.runtime.openWorkspace({ cwd: session.cwd, createRequestId: "recover-branch" }), (e: any) => e.code === "request_conflict");
    assert.ok(fs.existsSync(request.session.sessionFile!));
    h.user("来源后来追加");
    t.runtime.store.createSession = prepare;
    await t.runtime.stop("test_restart");
    restarted = await Runtime.start(t.runtime.config);
    const found = restarted.findBranchSession("recover-branch");
    assert.equal(found.status, "published");
    assert.equal(found.session!.branchSource!.entryId, request.session.branchSource!.entryId);
    assert.ok(!fs.readFileSync(found.session!.sessionFile!, "utf8").includes("来源后来追加"));
    assert.equal(t.server.calls.length, 0);
    const historyBefore = fs.readFileSync(h.file);
    fs.rmSync(found.session!.sessionFile!);
    await assert.rejects(() => restarted!.branchSession({ sessionId: session.id, requestId: "recover-branch" }), (e: any) => e.code === "history_corrupt");
    await assert.rejects(() => restarted!.branchSession({ sessionId: found.session!.id, requestId: "missing-source-branch" }), (e: any) => e.code === "history_corrupt");
    assert.deepEqual(fs.readFileSync(h.file), historyBefore);
  } finally { await restarted?.stop("test_end"); await t.shutdown(); }
});

test("跨项目来源每次读取核实授权；撤销不借连续分支恢复", async () => {
  const { t, session, h } = await fixture("branch-revoke");
  try {
    const rt = t.runtime;
    const foreign = await rt.createSession({ projectName: "其他资料", cwd: t.work[1]! });
    const fh = history(t, foreign); const ft = fh.task(); fh.user("其他历史");
    const artifact = rt.artifacts.begin({ taskId: ft.id, sessionId: foreign.id, name: "资料" }); rt.artifacts.append(artifact.id, Buffer.from("限定读取")); rt.artifacts.complete(artifact.id);
    const grant = rt.store.withTx(() => rt.access.createGrant({ fromProjectId: foreign.projectId, toProjectId: session.projectId, category: "artifact" }));
    const task = h.task(); h.user("按现有授权读资料"); h.assistant([{ type: "toolCall", id: "read", name: "read_artifact", arguments: { artifact_id: artifact.id } }]);
    rt.store.withTx(() => {
      const id = randomId("op"); rt.store.recordToolIntent({ id, taskId: task.id, sessionId: session.id, toolName: "read_artifact", sdkCallId: "read", params: { artifact_id: artifact.id } });
      new ToolOpLedger(rt.store).recordResult(task, id, "已读", false);
    });
    h.result("read_artifact", "read");
    const b = await rt.branchSession({ sessionId: session.id, requestId: "grant-b" });
    const c = await rt.branchSession({ sessionId: b.id, requestId: "grant-c" });
    assert.equal(c.branchSource!.artifacts[0]!.id, artifact.id);
    assert.equal(Buffer.from(rt.queryArtifact({ sessionId: c.id, taskId: ft.id, artifactId: artifact.id }).data, "base64").toString(), "限定读取");
    rt.store.withTx(() => rt.access.revokeGrant(grant.id));
    for (const branch of [b, c]) assert.throws(() => rt.queryArtifact({ sessionId: branch.id, taskId: ft.id, artifactId: artifact.id }), (e: any) => e.code === "access_denied");
  } finally { await t.shutdown(); }
});

test("Coding 导入保留分支、可回退且缺来源拒绝", async () => {
  const { t, session, h } = await fixture("branch-import");
  try {
    h.task(); h.user("旧实例原文");
    const branch = await t.runtime.branchSession({ sessionId: session.id, name: "保留名称", requestId: "imported-branch" });
    await t.runtime.stop("offline_import");
    const db = new Db(t.dirs.dataDir);
    // Coding 仍从旧个人实例读取开发资料，源格式与原文保持。
    new Store(db).setMetaValue("product.type", "ruukoto"); db.close();
    const root = path.join(t.dirs.root, "target-code");
    const deps = { targetDataDir: path.join(root, "data"), targetAgentDir: path.join(root, "agent") };
    const preview = previewLegacyImport(deps, { from: t.dirs.dataDir });
    const input = { plan: { from: t.dirs.dataDir }, source_instance_id: preview.source.instance_id, revision: preview.revision!, request_id: "import-code" };
    const receipt = applyLegacyImport(deps, input);
    const target = new Db(deps.targetDataDir);
    const imported = new Store(target).getSession(branch.id);
    assert.ok(imported);
    assert.equal(imported.name, branch.name);
    assert.deepEqual(imported.branchSource, branch.branchSource);
    assert.deepEqual(fs.readFileSync(imported.sessionFile!), fs.readFileSync(branch.sessionFile!));
    assert.equal(target.prepare("SELECT COUNT(*) AS n FROM branch_requests").get()!.n, 0);
    target.close();
    const reverted = revertLegacyImport(deps, receipt.import_id);
    assert.equal(reverted.ok, true);
    const source = new Db(t.dirs.dataDir);
    const broken = { ...branch.branchSource!, taskIds: ["不存在的来源任务"] };
    source.prepare("UPDATE sessions SET branch_source = ? WHERE id = ?").run(JSON.stringify(broken), branch.id);
    source.close();
    const brokenDeps = { targetDataDir: path.join(t.dirs.root, "broken-data"), targetAgentDir: path.join(t.dirs.root, "broken-agent") };
    assert.throws(() => previewLegacyImport(brokenDeps, { from: t.dirs.dataDir }), (e: any) => e.code === "source_scope_unavailable");

  } finally { await t.shutdown(); }
});

test("文件写入失败及来源前缀改变：按原回执拒绝恢复，无可选半成品与源删除", async () => {
  const { t, session, h } = await fixture("branch-file-failure");
  const directory = path.dirname(h.file);
  let restarted: Runtime | null = null;
  try {
    h.task(); h.user("原快照");
    fs.chmodSync(directory, 0o500);
    await assert.rejects(() => t.runtime.branchSession({ sessionId: session.id, requestId: "failed-file" }), (e: any) => e.code === "branch_prepare_failed");
    fs.chmodSync(directory, 0o700);
    const request = getBranchRequest(t.runtime.store, "failed-file")!;
    assert.equal(request.status, "prepared");
    assert.equal(t.runtime.store.getSession(request.session.id), null);
    fs.writeFileSync(h.file, fs.readFileSync(h.file, "utf8").replace("原快照", "被修改"));
    const source = fs.readFileSync(h.file);
    await t.runtime.stop("test_restart");
    restarted = await Runtime.start(t.runtime.config);
    assert.equal(restarted.findBranchSession("failed-file").status, "failed");
    assert.equal(restarted.store.getSession(request.session.id), null);
    assert.deepEqual(fs.readFileSync(h.file), source);
    assert.ok(!fs.existsSync(request.session.sessionFile!));
    assert.equal(t.server.calls.length, 0);
  } finally { fs.chmodSync(directory, 0o700); await restarted?.stop("test_end"); await t.shutdown(); }
});

test("真实 SIGKILL 窗口：文件已安装而会话未发布，重启仅按原请求发布一次", async () => {
  const { t, session, h } = await fixture("branch-kill");
  let restarted: Runtime | null = null;
  try {
    h.task(); h.user("进程崩溃前的历史");
    const source = fs.readFileSync(h.file);
    await t.runtime.stop("before_child");
    const script = `
      import { Runtime } from './packages/runtime/src/runtime.ts';
      import { product } from './apps/ruukoto-code/src/product.ts';
      const runtime = await Runtime.start({ product: product.runtime, dataDir: process.argv[1], agentDir: process.argv[2], modelProvider: 'mock', modelId: 'mock-model' });
      const create = runtime.store.createSession.bind(runtime.store);
      runtime.store.createSession = input => { if (input.branchSession) process.kill(process.pid, 'SIGKILL'); return create(input); };
      await runtime.branchSession({ sessionId: process.argv[3], requestId: 'killed-request' });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, t.dirs.dataDir, t.dirs.agentDir, session.id], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("分支崩溃子进程超时")); }, 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (_code, signal) => { clearTimeout(timer); resolve(signal); });
    });
    assert.equal(signal, "SIGKILL", stderr);
    restarted = await Runtime.start(t.runtime.config);
    const found = restarted.findBranchSession("killed-request");
    assert.equal(found.status, "published");
    assert.equal((await restarted.branchSession({ sessionId: session.id, requestId: "killed-request" })).id, found.session!.id);
    assert.equal(restarted.store.listSessions().filter(s => s.branchSource).length, 1);
    assert.deepEqual(fs.readFileSync(h.file), source);
    assert.equal(t.server.calls.length, 0);
  } finally { await restarted?.stop("test_end"); await t.shutdown(); }
});

test("来源 SubAgent 结果固定到原任务；连续分支只读，后续复用结果和所有管理操作被拒绝", async () => {
  let workId = "";
  const t = await startTestRuntime("branch-results", async req => {
    const text = inputText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: text.includes("后续执行") ? "后续新增结果" : "原快照结果" };
    if (afterTool(req)) return { kind: "text", text: "读完结果" };
    return { kind: "tool_calls", calls: [{ id: "result", name: "subagent_result", arguments: { work_id: workId } }] };
  }, { config: { product: product.runtime, ...realTools() } });
  try {
    const rt = t.runtime;
    const source = (await rt.openWorkspace({ cwd: t.work[0]! })).session;
    const h = history(t, source); const parent = h.task(); h.user("原工作"); h.assistant([{ type: "text", text: "准备委派" }]);
    const first = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "original", request: "原执行", readPaths: ["."], materials: null, paramsDigest: "first" });
    workId = first.work.id;
    await waitFor("原子任务完成且空闲", () => rt.store.getTask(first.task.id)!.status === "completed" && rt.store.getSubAgent(first.agent.id)!.state === "idle");
    await assert.rejects(() => rt.branchSession({ sessionId: first.agent.sessionId, requestId: "subagent-source" }), /普通开发/);
    h.user("已取得原结果");
    const artifact = rt.artifacts.begin({ taskId: first.task.id, sessionId: first.agent.sessionId, name: "result.txt" }); rt.artifacts.append(artifact.id, Buffer.from("原结果产物")); rt.artifacts.complete(artifact.id);
    const b = await rt.branchSession({ sessionId: source.id, requestId: "result-b" });
    const c = await rt.branchSession({ sessionId: b.id, requestId: "result-c" });
    assert.deepEqual(c.branchSource!.results, [{ workId, taskIds: [first.task.id] }]);
    assert.ok(c.branchSource!.artifacts.some(a => a.id === artifact.id));
    const later = await delegateFromActiveTask(rt, { parentTaskId: parent.id, workId, key: "later", request: "后续执行", readPaths: ["."], materials: null, paramsDigest: "later" });
    await waitFor("后续源任务完成", () => rt.store.getTask(later.task.id)!.status === "completed" && rt.store.getSubAgent(first.agent.id)!.state === "idle");
    const before = t.server.calls.length;
    const own = await rt.submit({ sessionId: c.id, requestId: "read-results", input: "读取已有结果", modelSelection: rt.defaultSelection });
    await waitFor("分支结果查询完成", () => rt.store.getTask(own.id)!.status === "completed");
    const payload = inputText(t.server.calls[before + 1]!);
    assert.ok(payload.includes("原快照结果") && !payload.includes("后续新增结果") && !payload.includes(later.task.id));
    const params = { parentTaskId: own.id, key: "forbidden", request: "不能管理原工作", readPaths: ["."], materials: null, paramsDigest: "forbidden" };
    await assert.rejects(() => delegateFromActiveTask(rt, { ...params, workId }));
    await assert.rejects(() => delegateFromActiveTask(rt, { ...params, subAgentId: first.agent.id }));
    assert.throws(() => rt.subagents!.close({ subAgentId: first.agent.id, parentSessionId: c.id, by: `agent:${own.id}` }));
    await assert.rejects(() => rt.subagents!.cancelWork({ workId, parentSessionId: c.id, by: `agent:${own.id}` }));
    await assert.rejects(() => messageFromActiveTask(rt, { senderTaskId: own.id, workId, key: "forbidden", text: "消息", paramsDigest: "message" }));
    await assert.rejects(() => rt.subagents!.integrate({ workId, parentTaskId: own.id, parentSessionId: c.id }));
    const ownWork = await delegateFromActiveTask(rt, params);
    assert.equal(ownWork.work.parentSessionId, c.id);
    await waitFor("分支自己的新委派完成", () => rt.store.getTask(ownWork.task.id)!.status === "completed");
  } finally { await t.shutdown(); }
});

async function appHarness(t: TestRuntime, sessionId: string, suffix: string, loseReply = false) {
  const state = new ViewState();
  const terminal = new FakeTerminal();
  let app: TuiApp;
  let lost = false;
  const connection = new ControlConnection({ socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())!, reconnectInitialMs: 20, reconnectMaxMs: 50,
    clientFactory: async (socketPath, timeout) => {
      const client = await ControlClient.connect(socketPath, timeout);
      const request = client.request.bind(client);
      client.request = async <T>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
        const result = await request<T>(op, params, timeoutMs);
        if (op === "branch_session" && loseReply && !lost) { lost = true; throw new ControlClientError("timeout", "模拟创建应答丢失", "unknown"); }
        return result;
      };
      return client;
    } }, { onState: (s, d) => app?.onConnectionState(s, d), onSnapshot: (r, c) => app?.onSnapshot(r, c), onEvent: (e, k) => app?.onEvent(e, k) });
  const pendingStore = new PendingRequestStore(path.join(t.dirs.root, `pending-${suffix}`));
  app = new TuiApp({ connection, state, pendingStore, guard: new SubmissionGuard(pendingStore, connection), terminal, initialSessionId: sessionId, onExit: () => {} });
  await app.start();
  await waitFor("TUI 已选择来源", () => state.currentSessionId === sessionId && connection.state === "online");
  return { app, state, terminal, connection, pendingStore };
}

test("两个真实控制客户端与 TUI：中文名称、完整设置、应答丢失原键核实、父命令历史与失败草稿", async () => {
  const { t, session, h } = await fixture("branch-tui");
  const apps: TuiApp[] = [];
  try {
    h.task(); h.user("已有历史");
    await t.runtime.setSessionDefaultMode({ sessionId: session.id, mode: "auto-review", expectedVersion: 0 });
    const a = await appHarness(t, session.id, "a", true); apps.push(a.app);
    const b = await appHarness(t, session.id, "b"); apps.push(b.app);
    a.terminal.send("/branch 中文 名称\r");
    await waitFor("发起客户端自动切换", () => a.state.currentSessionId !== session.id);
    const branch = t.runtime.getSession(a.state.currentSessionId!);
    await waitFor("另一客户端收到完整创建事件", () => b.state.sessions.some(s => s.id === branch.id));
    assert.equal(branch.name, "中文 名称");
    assert.deepEqual(a.state.sessions.find(s => s.id === branch.id), branch);
    assert.deepEqual(b.state.sessions.find(s => s.id === branch.id), branch);
    assert.equal(b.state.currentSessionId, session.id);
    assert.equal(branch.defaultAccessModeVersion, 0, "自动切换没有发错误 CAS 更新");
    assert.equal((a.app as any).editor.getExpandedText(), "");
    assert.equal(t.runtime.store.listSessions().filter(s => s.branchSource).length, 1);
    assert.equal(new PendingRequestStore(path.join(a.pendingStore.dir, "branches")).list().records.length, 0);
    const parentView = a.state.sessionViews.get(session.id)!;
    assert.ok(parentView.flow.items.some(row => row.kind === "command" && row.line === "/branch 中文 名称"));
    assert.ok(!fs.readFileSync(branch.sessionFile!, "utf8").includes("/branch"));
    (a.app as any).editor.setText("保留草稿");
    const reasons: string[] = [];
    await (a.app as any).cmdBranch("x".repeat(513), (text: string) => reasons.push(text));
    assert.equal(a.state.currentSessionId, branch.id);
    assert.equal((a.app as any).editor.getExpandedText(), "保留草稿");
    assert.ok(reasons.some(text => text.includes("名称")));
    a.app.quit();
    const reconnected = await appHarness(t, branch.id, "a"); apps.push(reconnected.app);
    assert.deepEqual(reconnected.state.sessions.find(s => s.id === branch.id), branch);
    assert.equal(t.server.calls.length, 0);
  } finally { apps.forEach(app => app.quit()); await t.shutdown(); }
});
