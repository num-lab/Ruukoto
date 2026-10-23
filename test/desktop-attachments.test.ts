import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { pickAttachments } from "../apps/desktop/src/main/attachments.ts";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { adoptEnvironment } from "../apps/desktop/src/main/environment.ts";
import type { DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { ATTACHMENT_CHUNK_BYTES, type AttachmentMetadata, type AttachmentUpload } from "@ruukoto/core/attachments.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import { parseSessionFile, readHistoryPage } from "@ruukoto/core/history.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { AttachmentReferenceError, attachmentReferenceView, taskAttachmentReferences } from "@ruukoto/agent/owner-attachments.ts";
import { ContextSendBlocked } from "@ruukoto/agent/context-assembly.ts";
import { EventFlow, type FlowEntry } from "@ruukoto/view/event-flow.ts";
import { createProjectSession, realTools, startAssemblyKit, startTestRuntime, waitFor } from "./helpers/testkit.ts";

const selection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" as const };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=", "base64");
function upload(sessionId: string, bytes: Buffer, name = "资料.txt", id = `att_${randomUUID()}`): AttachmentUpload {
  return { session_id: sessionId, attachment_id: id, name, offset: 0, total_bytes: bytes.length, content_hash: createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") };
}

test("系统选取仅上传选中文件快照，丢答重放原块；空文件、取消与换实例", async () => {
  const t = await startTestRuntime("desktop-file-picker", () => ({ kind: "text", text: "完成" }));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const file = path.join(t.work[0], "选中文件.txt");
    const content = Buffer.from("真实中文文件\n".repeat(40000));
    fs.writeFileSync(file, content);
    fs.writeFileSync(path.join(t.work[0], "未选文件.txt"), "不应读取");
    const calls: AttachmentUpload[] = [];
    let lose = true;
    const source = { instanceId: () => "same", pick: async () => [file], upload: async (params: AttachmentUpload) => {
      calls.push(params);
      const result = await t.client.request<{ nextOffset: number; complete: boolean }>("put_attachment", params);
      if (lose) { lose = false; throw new ControlClientError("timeout", "丢答", "unknown"); }
      return result;
    } };
    const [attachment] = await pickAttachments(sessionId, source);
    assert.deepEqual(attachment, { id: calls[0].attachment_id, name: "选中文件.txt", size: content.length });
    assert.ok(calls.length > 2); assert.deepEqual(calls[0], calls[1]);
    assert.ok(calls.every(call => call.data.length <= ATTACHMENT_CHUNK_BYTES / 3 * 4));
    assert.ok(!JSON.stringify(calls).includes(t.work[0]) && !JSON.stringify(calls).includes("未选文件"));
    const staged = t.runtime.attachments.prepare(sessionId, [attachment]);
    assert.deepEqual(staged[0].bytes, content);
    const empty = path.join(t.work[0], "empty"); fs.writeFileSync(empty, "");
    const [zero] = await pickAttachments(sessionId, { ...source, pick: async () => [empty] });
    assert.equal(zero.size, 0); assert.equal(t.runtime.attachments.prepare(sessionId, [zero])[0].bytes.length, 0);
    assert.deepEqual(await pickAttachments(sessionId, { ...source, pick: async () => [] }), []);
    let instance = "original";
    await assert.rejects(pickAttachments(sessionId, { ...source, instanceId: () => instance, pick: async () => { instance = "other"; return [file]; } }), error => error instanceof Error && "code" in error && error.code === "attachment_instance_changed");
    const large = path.join(t.work[0], "large"); fs.writeFileSync(large, ""); fs.truncateSync(large, 8 * 1024 * 1024 + 1);
    await assert.rejects(pickAttachments(sessionId, { ...source, pick: async () => [large] }), error => error instanceof Error && "code" in error && error.code === "attachment_limit");
    const link = path.join(t.work[0], "link"); fs.symlinkSync(file, link);
    await assert.rejects(pickAttachments(sessionId, { ...source, pick: async () => [link] }), error => error instanceof Error && "code" in error && error.code === "attachment_read_failed");
  } finally { await t.shutdown(); }
});

test("附件分块校验、实例与会话隔离、原始元数据绑定和普通文件真实读取", async () => {
  let artifactId = "";
  const t = await startTestRuntime("owner-file", (req, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "read-file", name: "read_artifact", arguments: { artifact_id: artifactId } }] } : { kind: "text", text: "已读取" }, { config: { ...realTools(), product: codeProduct.runtime } });
  try {
    const own = { sessionId: (await t.runtime.openWorkspace({ cwd: t.work[0], createRequestId: "own" })).session.id };
    const other = { sessionId: (await t.runtime.openWorkspace({ cwd: t.work[1], createRequestId: "other" })).session.id };
    const bytes = Buffer.from("这是真实附件正文\n");
    const params = upload(own.sessionId, bytes);
    artifactId = params.attachment_id;
    const meta: AttachmentMetadata = { id: artifactId, name: params.name, size: bytes.length };
    await t.client.request("put_attachment", params);
    await assert.rejects(t.client.request("put_attachment", { ...params, session_id: other.sessionId }), /当前会话/);
    await assert.rejects(t.client.request("put_attachment", { ...params, name: "../../secret" }), /名称/);
    await assert.rejects(t.client.request("put_attachment", { ...params, attachment_id: `att_${randomUUID()}`, offset: 1, data: bytes.subarray(0, 1).toString("base64") }), /不连续/);
    await assert.rejects(t.client.request("put_attachment", { ...params, attachment_id: `att_${randomUUID()}`, content_hash: "0".repeat(64) }), /校验失败/);
    await assert.rejects(t.client.request("submit", { session_id: own.sessionId, request_id: "wrong-meta", model_selection: selection, input: "", attachments: [{ ...meta, name: "伪造" }] }), /不一致/);
    const send = { session_id: own.sessionId, request_id: "file-only", model_selection: selection, input: "", attachments: [meta] };
    const task = await t.client.request<TaskView>("submit", send);
    await waitFor("附件任务完成", () => t.runtime.store.getTask(task.id)?.status === "completed");
    assert.equal(task.input, "");
    assert.deepEqual((await t.client.request<TaskView>("submit", send)).id, task.id);
    assert.equal(t.runtime.store.taskAttachments(task.id)[0].id, artifactId);
    assert.deepEqual(t.runtime.artifacts.read(artifactId), bytes);
    assert.throws(() => t.runtime.artifacts.append(artifactId, Buffer.from("改写")), /不可修改/);
    await assert.rejects(t.client.request("submit", { ...send, request_id: "reuse" }), /已用于其他提交/);
    assert.match(JSON.stringify(t.server.calls[0].messages), /read_artifact/);
    assert.match(JSON.stringify(t.server.calls[1].messages), /这是真实附件正文/);
    const file = t.runtime.store.getSession(own.sessionId)!.sessionFile!;
    const page = readHistoryPage(file);
    const user = page.entries.find(entry => entry.role === "user")!;
    assert.equal(user.text, ""); assert.deepEqual(user.attachments, [meta]);
    const flow = new EventFlow();
    flow.task(task);
    for (const event of t.runtime.store.getTaskEventsAfter(task.id, 0, 100)) flow.apply(event);
    flow.addHistory(user);
    flow.task({ ...task, input: "迟到的正文" });
    const messages = flow.items.filter((entry): entry is Extract<FlowEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "user");
    assert.equal(messages.length, 1); assert.deepEqual(messages[0].attachments, [meta]);
    assert.equal(messages[0].text, "", "已落盘的纯附件正文不被迟到元数据改写");
    const branch = await t.runtime.branchSession({ sessionId: own.sessionId, requestId: "files-branch" });
    assert.ok(branch.branchSource?.artifacts.some(artifact => artifact.id === artifactId));
    fs.writeFileSync(path.join(t.dirs.dataDir, "artifacts", `${artifactId}.bin`), "损坏");
    assert.throws(() => t.runtime.artifacts.read(artifactId), /校验失败/);
  } finally { await t.shutdown(); }
});

test("附件图片使用既有视觉输入且历史无base64，空文件与继续来源均保留", async () => {
  const t = await startTestRuntime("owner-image", () => ({ kind: "text", text: "图片已读" }), { config: { product: codeProduct.runtime } });
  try {
    const sessionId = (await t.runtime.openWorkspace({ cwd: t.work[0], createRequestId: "image-workspace" })).session.id;
    const originalResolve = t.runtime.models.current.modelCatalog.resolve.bind(t.runtime.models.current.modelCatalog);
    t.runtime.models.current.modelCatalog.resolve = async selection => ({ ...await originalResolve(selection), input: ["text", "image"] });
    const image = upload(sessionId, PNG, "photo.png");
    const empty = upload(sessionId, Buffer.alloc(0), "empty.txt");
    await t.client.request("put_attachment", image); await t.client.request("put_attachment", empty);
    const attachments = [image, empty].map(item => ({ id: item.attachment_id, name: item.name, size: item.total_bytes }));
    const task = await t.client.request<TaskView>("submit", { session_id: sessionId, request_id: "image", input: "", model_selection: selection, attachments });
    await waitFor("图片任务完成", () => t.runtime.store.getTask(task.id)?.status === "completed");
    assert.match(JSON.stringify(t.server.calls[0].messages), /data:image\/png;base64/);
    assert.ok(fs.existsSync(path.join(t.dirs.dataDir, "artifacts", `${empty.attachment_id}.bin`)));
    const file = t.runtime.store.getSession(sessionId)!.sessionFile!;
    const messages = parseSessionFile(file).filter(entry => entry.type === "message");
    assert.ok(!fs.readFileSync(file, "utf8").includes(PNG.toString("base64")));
    assert.equal((messages.find(entry => (entry.message as { role: string }).role === "user")!.message as { ruukotoAttachmentRefs: unknown[] }).ruukotoAttachmentRefs.length, 2);
    const branch = await t.runtime.branchSession({ sessionId, requestId: "image-branch" });
    assert.equal(branch.branchSource?.artifacts.filter(artifact => attachments.some(item => item.id === artifact.id)).length, 2);
    t.runtime.store.withTx(() => t.runtime.store.db.prepare("UPDATE tasks SET status='interrupted' WHERE id=?").run(task.id));
    const resumed = await t.client.request<TaskView>("continue", { session_id: sessionId, task_id: task.id, request_id: "image-continue", input: "继续", model_selection: selection });
    await waitFor("继续图片完成", () => t.runtime.store.getTask(resumed.id)?.status === "completed");
    assert.match(JSON.stringify(t.server.calls.at(-1)!.messages.at(-1)), /data:image\/png;base64/);
  } finally { await t.shutdown(); }
});

test("原附件引用随pending落盘并跨重建核实，明确拒绝可用同快照重发", async () => {
  const t = await startTestRuntime("attachment-pending", () => ({ kind: "text", text: "已接收" }));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const params = upload(sessionId, Buffer.from("待核实原文"));
    await t.client.request("put_attachment", params);
    const attachment = { id: params.attachment_id, name: params.name, size: params.total_bytes };
    const submit = { session_id: sessionId, input: "", model_selection: selection, attachments: [attachment] };
    await assert.rejects(t.client.request("submit", { ...submit, request_id: "denied", model_selection: { ...selection, modelId: "not-configured" } }));
    assert.equal(t.runtime.attachments.prepare(sessionId, [attachment])[0].metadata.id, attachment.id);
    const { PendingRequestStore } = await import("@ruukoto/control/pending-requests.ts");
    const { SubmissionGuard } = await import("@ruukoto/control/submission.ts");
    const pendingDir = path.join(t.dirs.root, "pending");
    const pending = new PendingRequestStore(pendingDir);
    const connection = { instanceId: t.runtime.instanceId(), request: async <K extends import("@ruukoto/control/ops.ts").TuiOp>(op: K, request: import("@ruukoto/control/ops.ts").OpParams<K>): Promise<import("@ruukoto/control/ops.ts").OpResult<K>> => t.client.request(op, request) };
    const guard = new SubmissionGuard(pending, { ...connection, request: async (op, request) => { const task = await connection.request(op, request); if (op === "submit") throw new ControlClientError("timeout", "接收应答丢失", "unknown"); return task; } });
    const outcome = await guard.submit("submit", submit);
    assert.equal(outcome.kind, "pending_verification");
    const record = new PendingRequestStore(pendingDir).list().records[0];
    assert.equal(record.params.input, ""); assert.deepEqual(record.params.attachments, [attachment]);
    assert.ok(!JSON.stringify(record).includes(params.data) && !JSON.stringify(record).includes(t.work[0]));
    const recovered = new SubmissionGuard(new PendingRequestStore(pendingDir), connection);
    assert.equal((await recovered.reconcile(record)).kind, "linked");
    assert.equal(pending.list().records.length, 0);
    assert.equal(t.runtime.listTasks({ sessionId }).tasks.length, 1);
  } finally { await t.shutdown(); }
});

test("绑定事务失败保留不可变文件，原引用可重试且不发布半成品任务", async () => {
  const t = await startTestRuntime("attachment-transaction", () => ({ kind: "text", text: "完成" }));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    await assert.rejects(t.client.request("put_attachment", { session_id: {} }), /选择会话/);
    const params = upload(sessionId, Buffer.from("原始快照"));
    t.runtime.putAttachment(params);
    const input = { sessionId, requestId: "transaction", input: "", modelSelection: selection, attachments: [{ id: params.attachment_id, name: params.name, size: params.total_bytes }] };
    const append = t.runtime.store.appendEvent.bind(t.runtime.store);
    let fail = true;
    t.runtime.store.appendEvent = (body, options) => { if (body.type === "task.attachments" && fail) throw new Error("注入事件写入失败"); return append(body, options); };
    await assert.rejects(t.runtime.submit(input), /注入事件/);
    assert.equal(t.runtime.listTasks({ sessionId }).tasks.length, 0);
    assert.equal(t.runtime.store.getArtifact(params.attachment_id), null);
    assert.ok(fs.existsSync(path.join(t.dirs.dataDir, "artifacts", `${params.attachment_id}.bin`)));
    fail = false;
    const manifest = path.join(t.dirs.dataDir, "attachment-staging", `${params.attachment_id}.json`);
    const saved = fs.readFileSync(manifest, "utf8");
    fs.writeFileSync(manifest, saved.replace(params.attachment_id, "../../outside"));
    await assert.rejects(t.runtime.submit(input), /附件快照不可读/);
    fs.writeFileSync(manifest, saved);
    const task = await t.runtime.submit(input);
    assert.equal(t.runtime.store.taskAttachments(task.id)[0].id, params.attachment_id);
    assert.equal(t.runtime.listTasks({ sessionId }).tasks.length, 1);
  } finally { await t.shutdown(); }
});


test("附件引用错误用具名code跨上下文发送边界，消息不承载错误码协议", async () => {
  const rejected = (error: unknown) => error instanceof AttachmentReferenceError && error.code === "attachment_reference_invalid" && !error.message.includes(error.code);
  assert.throws(() => attachmentReferenceView([{ role: "assistant", content: "", ruukotoAttachmentRefs: [] }], () => true), rejected);
  assert.throws(() => attachmentReferenceView([{ role: "user", ruukotoAttachmentRefs: [] }], () => true), rejected);
  const kit = await startAssemblyKit("attachment-error-code");
  try {
    const { session } = kit.project();
    const task = kit.task(session, "输入");
    assert.throws(() => taskAttachmentReferences({ ...task, resumesTaskId: "missing" }, kit.store), rejected);
    const assembly = kit.begin(task, session);
    await assert.rejects(kit.send(assembly, [{ role: "user", content: "输入", ruukotoAttachmentRefs: [{}] }]), error => error instanceof ContextSendBlocked && error.code === "attachment_reference_invalid" && !error.message.includes(error.code));
    assert.equal(kit.server.calls.length, 0);
  } finally { await kit.close(); }
});

test("新对话草稿暂存附件只在建好会话后上传，token 用后失效", async () => {
  const t = await startTestRuntime("desktop-draft-file", () => ({ kind: "text", text: "完成" }), { config: { product: codeProduct.runtime } });
  const previous = { ...process.env };
  const control = fs.mkdtempSync(path.join(path.dirname(t.dirs.root), "rdc-"));
  fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(control, "owner.token"));
  fs.symlinkSync(t.runtime.socketPath(), path.join(control, "control.sock"));
  Object.assign(process.env, { RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_CODE_CONTROL_DIR: control, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir });
  const updates: DesktopUpdate[] = [];
  const host = new DesktopHost(path.resolve(import.meta.dirname, ".."), path.join(t.dirs.root, "draft-user-data"), { publish: (target, update) => { if (target === "code") updates.push(update); }, focused: () => true, notice() {}, badge() {} });
  try {
    host.subscribe("code");
    await waitFor("草稿页安装真实快照", () => updates.some(update => update.type === "snapshot"));
    const file = path.join(t.work[0], "草稿附件.txt");
    fs.writeFileSync(file, "草稿正文");
    const staged = await host.pickDraftAttachments(async () => [file]);
    assert.deepEqual(staged.map(item => item.name), ["草稿附件.txt"]);
    assert.equal(staged[0].size, Buffer.byteLength("草稿正文"));
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    assert.throws(() => host.uploadDraftAttachments(sessionId, ["draft_missing"]), { code: "attachment_expired" });
    const uploaded = await host.uploadDraftAttachments(sessionId, staged.map(item => item.id));
    assert.deepEqual(uploaded.map(item => item.name), ["草稿附件.txt"]);
    assert.deepEqual(t.runtime.attachments.prepare(sessionId, uploaded)[0].bytes, Buffer.from("草稿正文"));
    assert.throws(() => host.uploadDraftAttachments(sessionId, staged.map(item => item.id)), { code: "attachment_expired" }, "token 用后即失效");
  } finally { await host.close(); adoptEnvironment(previous); fs.rmSync(control, { recursive: true, force: true }); await t.shutdown(); }
});
