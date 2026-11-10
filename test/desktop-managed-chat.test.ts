import { profileChildEnv } from "@ruukoto/core/profile.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ModelSelection } from "@ruukoto/core/types.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { pickAttachments } from "../apps/desktop/src/main/attachments.ts";
import { DesktopChatDrafts } from "../apps/desktop/src/main/chat-drafts.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { CodeWrites } from "../apps/desktop/src/renderer/code-writes.ts";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { adoptEnvironment } from "../apps/desktop/src/main/environment.ts";
import { ipcResult } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopChatCreation, DesktopChatDraft, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";


const selection: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

test("Managed first-send journal recovers a lost creation response and cold upload retry without submitting", async () => {
  const t = await startTestRuntime("d-managed-journal", () => ({ kind: "text", text: "ok" }), {});
  try {
    const token = `draft_${randomUUID()}`, local = path.join(t.work[0], "input.txt");
    fs.writeFileSync(local, "input");
    const staged = new Map([[token, { token, path: local, name: "input.txt", size: 5 }]]);
    const store = new PendingRequestStore(path.join(t.dirs.root, "chat-intents"));
    let lose = true, creationCalls = 0;
    const source = {
      instanceId: () => t.runtime.store.db.getInstanceId(), status: { type: "state" as const, state: "online" as const },
      request: async <K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> => {
        const result = await t.client.request<OpResult<K>>(op, params);
        if (op === "create_managed_session") { ++creationCalls; if (lose) { lose = false; throw new ControlClientError("lost", "Lost creation response", "unknown"); } }
        return result;
      },
    };
    const journal = () => new DesktopChatDrafts(store, () => source, id => t.runtime.store.getProject(id) ?? undefined, staged);
    const request = { request_id: randomUUID(), workspace_id: "", text: "first message", mode: "full_access", model_selection: selection, tokens: [token] };
    await assert.rejects(journal().start(request), { code: "lost" });
    const first = t.runtime.store.listSessions().filter(session => session.createRequestId === request.request_id);
    assert.equal(first.length, 1);
    fs.unlinkSync(local);
    staged.clear();
    const recovered = await journal().list();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].requestId, request.request_id);
    assert.ok(staged.has(token));
    assert.equal(fs.readFileSync(staged.get(token)!.path, "utf8"), "input");
    assert.ok(!JSON.stringify(recovered).includes(local), "Native paths stay out of renderer updates");
    assert.equal(t.runtime.store.listTasksBySession(first[0].id).length, 0);
    const created = await journal().start(request);
    assert.equal(created.session.id, first[0].id);
    assert.equal(created.project.managed, true);
    assert.equal(creationCalls, 2);
    assert.equal(t.runtime.store.listProjects().filter(project => project.managed).length, 1);
    const uploaded = [{ id: `att_${randomUUID()}`, name: "input.txt", size: 5 }];
    journal().uploaded(source.instanceId(), created.session.id, [token], uploaded);
    assert.deepEqual(await journal().list().then(drafts => drafts[0].uploadedAttachments), uploaded);
    assert.deepEqual(journal().upload(source.instanceId(), created.session.id, [token]), uploaded);
    assert.equal(journal().upload(source.instanceId(), "other", [token]), null);
    await assert.rejects(journal().start({ ...request, text: "changed" }), { code: "request_conflict" });
    const submitted = await t.client.request("submit", { session_id: created.session.id, request_id: created.draft.submissionRequestId, input: request.text, model_selection: selection });
    assert.ok(submitted);
    await journal().finish(request.request_id);
    assert.deepEqual(await journal().list(), []);
  } finally { t.client.close(); await t.shutdown(); }
});

test("Native first-chat restore preserves attachment snapshots and opens only its verified workspace", async () => {
  const t = await startTestRuntime("d-chat-cold", () => ({ kind: "text", text: "ok" }), {});
  const environment = { ...process.env };
  Object.assign(process.env, profileChildEnv(t.runtime.config.profile.selection, { RUUKOTO_DESKTOP_MANAGED: "1" }));
  const hosts: DesktopHost[] = [], updates: DesktopUpdate[] = [], userData = path.join(t.dirs.root, "desktop-data");
  const start = async () => {
    const host = new DesktopHost(path.resolve(import.meta.dirname, ".."), userData, { publish: (target, update) => { if (target === "code") updates.push(update); }, focused: () => true, notice() {}, badge() {} });
    hosts.push(host); host.subscribe("code");
    await waitFor("desktop online", () => updates.some(update => update.type === "chat_drafts"));
    return host;
  };
  try {
    const firstHost = await start();
    const file = path.join(t.work[0], "attachment.txt"); fs.writeFileSync(file, "preserved");
    const staged = await firstHost.pickDraftAttachments(async () => [file]);
    const input = { request_id: "cold-first", workspace_id: "", text: "first", mode: "full_access", model_selection: selection, tokens: staged.map(item => item.id) };
    const response = await firstHost.request("code", "desktop_chat_start", input);
    assert.ok(response.ok);
    const first = response.value as DesktopChatCreation;
    fs.unlinkSync(file);
    await firstHost.close(); updates.length = 0;
    const reopened = await start();
    const recovery = updates.find((update): update is Extract<DesktopUpdate, { type: "chat_drafts" }> => update.type === "chat_drafts")!;
    assert.equal(recovery.drafts.length, 1);
    assert.equal(recovery.drafts[0].sessionId, first.session.id);
    assert.equal(t.runtime.store.listTasksBySession(first.session.id).length, 0);
    const original = await reopened.request("code", "desktop_chat_start", input);
    assert.ok(original.ok);
    assert.equal((original.value as DesktopChatCreation).session.id, first.session.id);
    const uploaded = await reopened.uploadDraftAttachments(first.session.id, input.tokens);
    assert.deepEqual(t.runtime.attachments.prepare(first.session.id, uploaded)[0].bytes, Buffer.from("preserved"));
    assert.deepEqual(await reopened.uploadDraftAttachments(first.session.id, input.tokens), uploaded);
    const corrected = await reopened.request("code", "desktop_chat_prepare_submission", { creation_request_id: input.request_id, session_id: first.session.id, request_id: first.draft.submissionRequestId, input: "corrected first", access_mode: "confirm", model_selection: selection, attachments: uploaded });
    assert.deepEqual(corrected, { ok: true, value: { accepted: false } });
    const folder = await reopened.request("code", "desktop_workspace_path", { workspace_id: first.project.id, instance_id: t.runtime.store.db.getInstanceId() });
    assert.deepEqual(folder, { ok: true, value: { path: first.session.cwdReal } });
    fs.renameSync(first.session.cwdReal, `${first.session.cwdReal}-retained`); fs.mkdirSync(first.session.cwdReal);
    assert.equal((await reopened.request("code", "desktop_workspace_path", { workspace_id: first.project.id, instance_id: t.runtime.store.db.getInstanceId() })).ok, false);
    assert.equal((await reopened.request("code", "desktop_workspace_path", { workspace_id: first.project.id, instance_id: "foreign" })).ok, false);
    await reopened.close(); updates.length = 0;
    const finalHost = await start();
    assert.deepEqual(await finalHost.uploadDraftAttachments(first.session.id, input.tokens), uploaded);
    const finalDraft = updates.find((update): update is Extract<DesktopUpdate, { type: "chat_drafts" }> => update.type === "chat_drafts")!.drafts[0];
    assert.equal(finalDraft.text, "corrected first");
    assert.equal(finalDraft.mode, "confirm");
    assert.equal(t.runtime.store.listTasksBySession(first.session.id).length, 0);
  } finally { await Promise.all(hosts.map(host => host.close())); adoptEnvironment(environment); t.client.close(); await t.shutdown(); }
});

test("Managed draft retry keeps first creation identity after upload failure and exposes the owning workspace", async () => {
  const t = await startTestRuntime("d-managed-state", () => ({ kind: "text", text: "ok" }), {});
  try {
    let created: DesktopChatCreation | null = null, failUpload = true, sendCalls = 0;
    const model = new CodeState({ request: async (_target, op, params) => {
      if (op === "desktop_chat_start") {
        const result = await t.client.request<OpResult<"create_managed_session">>("create_managed_session", { request_id: String(params.request_id), mode: "full_access", model_selection: selection });
        const draft: DesktopChatDraft = { requestId: String(params.request_id), instanceId: t.runtime.store.db.getInstanceId(), workspaceId: "", text: String(params.text), mode: "full_access", modelSelection: selection, attachments: [], submissionRequestId: "first-submit", sessionId: result.session.id, uploadedAttachments: null };
        created = { ...result, draft };
        return { ok: true, value: created };
      }
      if (op === "desktop_chat_prepare_submission") return { ok: true, value: { accepted: false } };
      if (op === "submit") { ++sendCalls; return { ok: true, value: { kind: "not_sent", requestId: params.request_id, message: "retry" } }; }
      return ipcResult(() => t.client.request(op, params));
    } }, () => {});
    model.update({ type: "snapshot", result: await t.client.handshake(), instanceChanged: false });
    model.update({ type: "state", state: "online" });
    const input = { requestId: "managed-first", workspaceId: "", text: "hello", mode: "full_access" as const, modelSelection: selection, attachments: [{ id: "draft_token", name: "input.txt", size: 5 }] };
    const upload = async () => { if (failUpload) { failUpload = false; throw new Error("Upload failed"); } return []; };
    assert.equal(await model.startChat(input, upload), null);
    assert.equal(t.runtime.store.listSessions().filter(session => session.createRequestId === input.requestId).length, 1);
    assert.equal(sendCalls, 0);
    const sessionId = await model.startChat(input, upload);
    assert.ok(sessionId);
    assert.equal(t.runtime.store.listSessions().filter(session => session.createRequestId === input.requestId).length, 1);
    const managed = model.view.sessions.find(session => session.id === sessionId)!;
    assert.equal(model.workspaceName(managed.projectId), "No workspace");
    assert.equal(model.inspector.workspace()?.id, managed.projectId);
    assert.equal(model.managedSessions().length, 1);
    await waitFor("first-send attempt", () => sendCalls === 1);
    await model.writes.send(sessionId);
    assert.equal(sendCalls, 2);
    assert.ok(created);
  } finally { t.client.close(); await t.shutdown(); }
});

for (const phase of ["creation", "upload"] as const) test(`First-send ${phase} completion after navigation retains the original draft for explicit restore`, async () => {
  const t = await startTestRuntime(`d-chat-nav-${phase}`, () => ({ kind: "text", text: "ok" }), {});
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    const token = `draft_${randomUUID()}`, file = path.join(t.work[0], "input.txt"), attachmentId = `att_${randomUUID()}`;
    fs.writeFileSync(file, "input");
    const staged = new Map([[token, { token, path: file, name: "input.txt", size: 5 }]]);
    const store = new PendingRequestStore(path.join(t.dirs.root, "chat-intents"));
    const source = { instanceId: () => t.runtime.store.db.getInstanceId(), status: { type: "state" as const, state: "online" as const }, request: <K extends TuiOp>(op: K, params: OpParams<K>) => t.client.request<OpResult<K>>(op, params) };
    let journal = new DesktopChatDrafts(store, () => source, id => t.runtime.store.getProject(id) ?? undefined, staged);
    const guard = new SubmissionGuard(new PendingRequestStore(path.join(t.dirs.root, "submissions")), { instanceId: source.instanceId(), request: source.request });
    const creations: DesktopChatCreation[] = [], creationKeys: string[] = [], sent: Record<string, unknown>[] = [];
    let ownsDraft = true, waiting = false, uploads = 0, preparations = 0;
    const model = new CodeState({ request: async (_target, op, params) => {
      if (op === "desktop_chat_start") return ipcResult(async () => {
        creationKeys.push(String(params.request_id));
        const created = await journal.start(params);
        creations.push(created);
        if (phase === "creation" && creations.length === 1) { waiting = true; await blocked; }
        return created;
      });
      if (op === "desktop_chat_prepare_submission") { ++preparations; return ipcResult(() => journal.prepareSubmission(params)); }
      if (op === "desktop_chat_finish") return ipcResult(() => journal.finish(params.request_id));
      if (op === "submit") { sent.push(params); return ipcResult(() => guard.submit("submit", params, { requestId: String(params.request_id) })); }
      return ipcResult(() => t.client.request(op, params));
    } }, () => {});
    model.update({ type: "snapshot", result: await t.client.handshake(), instanceChanged: false });
    model.update({ type: "state", state: "online" });
    const input = { requestId: `first-${phase}`, workspaceId: "", text: "original first message", mode: "confirm" as const, modelSelection: selection, attachments: [{ id: token, name: "input.txt", size: 5 }] };
    const upload = async (sessionId: string, tokens: string[]) => {
      ++uploads;
      const attachments = await pickAttachments(sessionId, { instanceId: source.instanceId, pick: async () => tokens.map(id => staged.get(id)!.path), attachmentId: () => attachmentId, upload: params => t.client.request("put_attachment", params) });
      journal.uploaded(source.instanceId(), sessionId, tokens, attachments);
      if (phase === "upload" && uploads === 1) { waiting = true; await blocked; }
      return attachments;
    };
    const pending = model.startChat(input, upload, () => ownsDraft);
    await waitFor("first-send phase held", () => waiting);
    ownsDraft = false;
    release();
    assert.equal(await pending, null);
    const original = creations[0];
    assert.equal(uploads, phase === "upload" ? 1 : 0);
    assert.equal(preparations, 0);
    assert.equal(sent.length, 0);
    assert.equal(model.view.currentSessionId, null);
    assert.deepEqual(model.tabs, []);
    assert.deepEqual(model.writes.draft(original.session.id), { text: "" });
    assert.equal(model.recoveredChats[0].sessionId, original.session.id);
    assert.equal(model.recoveredChats[0].submissionRequestId, original.draft.submissionRequestId);
    assert.equal(t.runtime.store.listTasksBySession(original.session.id).length, 0);
    fs.unlinkSync(file);
    staged.clear();
    journal = new DesktopChatDrafts(store, () => source, id => t.runtime.store.getProject(id) ?? undefined, staged);
    const restored = await journal.list();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].requestId, input.requestId);
    assert.equal(restored[0].sessionId, original.session.id);
    assert.equal(restored[0].submissionRequestId, original.draft.submissionRequestId);
    assert.equal(fs.readFileSync(staged.get(token)!.path, "utf8"), "input");
    if (model.resumePreparedChat(restored[0])) {
      assert.equal(sent.length, 0, "Restoration waits for an explicit send");
      await model.writes.send(original.session.id);
    } else {
      assert.equal(await model.startChat({ ...input, requestId: restored[0].requestId, attachments: restored[0].attachments }, upload), original.session.id);
    }
    await waitFor("restored first message accepted", () => sent.length === 1 && !model.writes.checking(original.session.id));
    assert.deepEqual(creationKeys, phase === "creation" ? [input.requestId, input.requestId] : [input.requestId]);
    assert.equal(uploads, 1);
    assert.equal(preparations, 1);
    assert.equal(sent[0].request_id, original.draft.submissionRequestId);
    assert.equal(sent[0].session_id, original.session.id);
    assert.equal(sent[0].input, input.text);
    assert.deepEqual(sent[0].attachments, [{ id: attachmentId, name: "input.txt", size: 5 }]);
    assert.equal(t.runtime.store.listSessions().filter(session => session.createRequestId === input.requestId).length, 1);
    assert.equal(t.runtime.store.listTasksBySession(original.session.id).length, 1);
  } finally { release(); t.client.close(); await t.shutdown(); }
});

test("First-message submission retries use the retained original request key", async () => {
  const t = await startTestRuntime("d-first-key", () => ({ kind: "text", text: "ok" }), {});
  try {
    const result = await t.client.request<OpResult<"open_workspace">>("open_workspace", { cwd: t.work[0] });
    const view = new CodeState({ request: async () => ({ ok: true, value: null }) }, () => {}).view;
    view.applySnapshot(await t.client.handshake(), false);
    const requests: Record<string, unknown>[] = [];
    const writes = new CodeWrites({ request: async (_target, op, params) => {
      if (op === "submit") { requests.push(params); return { ok: true, value: requests.length < 3 ? { kind: "not_sent", requestId: params.request_id, message: "not sent" } : { kind: "pending_verification", requestId: params.request_id, outcome: "unknown", reason: "lost" } }; }
      if (op === "desktop_chat_prepare_submission") return { ok: true, value: { accepted: false } };
      return { ok: true, value: null };
    } }, view, () => true, () => {}, "code");
    writes.installFirstChat(result.session.id, "hello", [], "retained-key", "creation-key", "full_access", selection);
    await writes.send(result.session.id);
    const current = view.sessions.find(session => session.id === result.session.id)!;
    current.modelSelection = { ...selection, thinkingLevel: "high" };
    current.defaultAccessMode = "confirm";
    await writes.send(result.session.id);
    assert.deepEqual(requests.map(params => ({ requestId: params.request_id, mode: params.access_mode, model: params.model_selection })), [{ requestId: "retained-key", mode: "full_access", model: selection }, { requestId: "retained-key", mode: "confirm", model: current.modelSelection }]);
    await writes.send(result.session.id);
    writes.update({ type: "submission", record: { requestId: "retained-key", op: "submit", params: requests[2], instanceId: view.instanceId!, createdAt: new Date().toISOString() }, result: { kind: "linked", requestId: "retained-key", taskId: "accepted" } });
    assert.equal(writes.draft(result.session.id).text, "");
  } finally { t.client.close(); await t.shutdown(); }
});

test("Precreation snapshot and ordinary model rejection leave an editable draft under the original key", async () => {
  const t = await startTestRuntime("d-chat-rejected", () => ({ kind: "text", text: "ok" }), {});
  try {
    const ordinary = await t.client.request<OpResult<"open_workspace">>("open_workspace", { cwd: t.work[0] });
    const store = new PendingRequestStore(path.join(t.dirs.root, "first-drafts"));
    const token = `draft_${randomUUID()}`, local = path.join(t.work[0], "selection.txt"); fs.writeFileSync(local, "input");
    const staged = new Map([[token, { token, path: local, name: "selection.txt", size: 5 }]]);
    const source = { instanceId: () => t.runtime.store.db.getInstanceId(), status: { type: "state" as const, state: "online" as const }, request: <K extends TuiOp>(op: K, params: OpParams<K>) => t.client.request<OpResult<K>>(op, params) };
    const journal = new DesktopChatDrafts(store, () => source, id => t.runtime.store.getProject(id) ?? undefined, staged);
    const original = { request_id: "editable-first", workspace_id: ordinary.session.projectId, text: "hello", mode: "full_access", model_selection: selection, tokens: [token] };
    fs.unlinkSync(local);
    await assert.rejects(journal.start(original), { code: "chat_not_created" });
    assert.equal(store.list().records.length, 0);
    assert.equal(staged.get(token)!.path, local);
    fs.writeFileSync(local, "input");
    await assert.rejects(journal.start({ ...original, model_selection: { ...selection, modelId: "missing" } }), { code: "chat_not_created" });
    assert.equal(store.list().records.length, 0);
    const accepted = await journal.start(original);
    assert.equal(accepted.session.createRequestId, original.request_id);
    assert.equal(accepted.session.projectId, ordinary.session.projectId);
    assert.equal(t.runtime.store.listSessions().filter(session => session.createRequestId === original.request_id).length, 1);
    assert.equal(t.runtime.store.listTasksBySession(accepted.session.id).length, 0);
  } finally { t.client.close(); await t.shutdown(); }
});

test("Cold first-message restoration preserves later edits and submits visible settings", async () => {
  const t = await startTestRuntime("d-chat-restored", () => ({ kind: "text", text: "ok" }), {});
  try {
    const created = await t.client.request<OpResult<"create_managed_session">>("create_managed_session", { request_id: "restored-create", mode: "full_access", model_selection: selection });
    await t.client.request("set_session_mode", { session_id: created.session.id, expected_version: created.session.defaultAccessModeVersion, mode: "confirm" });
    const sent: Record<string, unknown>[] = [];
    const state = new CodeState({ request: async (_target, op, params) => {
      if (op === "desktop_chat_prepare_submission") return { ok: true, value: { accepted: false } };
      if (op === "submit") { sent.push(params); return { ok: true, value: { kind: "not_sent", requestId: params.request_id, message: "retry" } }; }
      return ipcResult(() => t.client.request(op, params));
    } }, () => {});
    state.update({ type: "snapshot", result: await t.client.handshake(), instanceChanged: false });
    state.update({ type: "state", state: "online" });
    const draft: DesktopChatDraft = { requestId: "restored-create", instanceId: t.runtime.store.db.getInstanceId(), workspaceId: "", text: "restored text", mode: "full_access", modelSelection: selection, attachments: [], submissionRequestId: "restored-submit", sessionId: created.session.id, uploadedAttachments: [] };
    state.update({ type: "chat_drafts", drafts: [draft] });
    state.writes.edit(created.session.id, "later edit");
    state.update({ type: "chat_drafts", drafts: [draft] });
    assert.equal(state.writes.draft(created.session.id).text, "later edit");
    await state.writes.send(created.session.id);
    assert.equal(sent[0].request_id, "restored-submit");
    assert.equal(sent[0].input, "later edit");
    assert.equal(sent[0].access_mode, "confirm");
  } finally { t.client.close(); await t.shutdown(); }
});
