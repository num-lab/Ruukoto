import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ControlClient, ControlClientError } from "@ruukoto/control/client.ts";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import type { ManagedChatDraft } from "@ruukoto/tui/tui/managed-chat.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { TuiApp } from "@ruukoto/tui/tui/app.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { ManagedChat } from "@ruukoto/tui/tui/managed-chat.ts";
import { loadReloadState } from "@ruukoto/tui/tui/reload-state.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";
import { startTestRuntime, waitFor, type TestRuntime } from "./helpers/testkit.ts";

const selection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" as const };
const flush = () => new Promise(resolve => setTimeout(resolve, 80));
const workspaces = (t: TestRuntime) => t.runtime.store.listProjects().filter(project => project.rootDir);
const chats = (t: TestRuntime) => t.runtime.store.listSessions();
const editor = (app: TuiApp) => Reflect.get(app, "editor") as { getExpandedText(): string; setText(text: string): void };
const managedChat = (app: TuiApp) => Reflect.get(app, "managedChat") as ManagedChat;
const tui = (app: TuiApp) => Reflect.get(app, "tui") as { getFocusedComponent(): unknown };

async function startApp(t: TestRuntime, pendingDir = path.join(t.dirs.root, "managed-tui-pending"), intercept?: (client: ControlClient) => void, sessionId?: string, reloadStateFile?: string) {
  const state = new ViewState(), terminal = new FakeTerminal();
  let app: TuiApp, exited = false;
  const connection = new ControlConnection({ profile: t.dirs.profile, token: readOwnerToken(t.runtime.controlDir())!,
    reconnectInitialMs: 20, reconnectMaxMs: 50,
    clientFactory: async (socket, timeout) => { const client = await ControlClient.connect(socket, timeout); intercept?.(client); return client; },
  }, { onState: (s, d) => app?.onConnectionState(s, d), onSnapshot: (r, c) => app?.onSnapshot(r, c), onEvent: (e, k) => app?.onEvent(e, k) });
  const pending = new PendingRequestStore(pendingDir);
  app = new TuiApp({ connection, guard: new SubmissionGuard(pending, connection), pendingStore: pending, state, terminal, initialSessionId: sessionId, reloadStateFile, onExit: () => { exited = true; } });
  await app.start();
  await waitFor("managed TUI online", () => connection.state === "online");
  return { app, state, terminal, connection, pending, exited: () => exited };
}

async function selectManaged(h: Awaited<ReturnType<typeof startApp>>) {
  await waitFor("No workspace startup option", () => h.terminal.output().includes("No workspace"));
  h.terminal.send("\r");
  await flush();
  assert.equal(h.state.currentSessionId, null);
}

test("fresh TUI opens a local No workspace draft with model/mode controls, then creates on first send", async () => {
  const t = await startTestRuntime("managed-tui-fresh", () => ({ kind: "text", text: "managed response" }), { workDirs: 0 });
  const apps: TuiApp[] = [];
  try {
    const writes: string[] = [];
    const h = await startApp(t, undefined, client => {
      const request = client.request.bind(client);
      client.request = async (op, params, timeout) => { if (["set_session_model", "set_session_mode", "create_managed_session", "submit"].includes(op)) writes.push(op); return request(op, params, timeout); };
    });
    apps.push(h.app);
    await selectManaged(h);
    assert.equal(workspaces(t).length, 0);
    assert.equal(chats(t).length, 0);
    assert.deepEqual(fs.readdirSync(t.dirs.profile.workspaceDir), []);
    h.terminal.send("\x1b[Z");
    await flush();
    assert.match(h.terminal.output(), /Full access/);
    h.terminal.send("/mode\r"); await flush();
    h.terminal.send("\x1b[B\x1b[B\r"); await flush();
    h.terminal.send("\x1b[Z"); await flush();
    h.terminal.send("/model\r");
    await waitFor("draft model picker", () => h.terminal.output().includes("思考强度"));
    h.terminal.send("\r"); await flush();
    assert.deepEqual(writes, [], "draft mode and model selection are local");
    h.terminal.send("first managed message\r");
    await waitFor("first managed task", () => h.state.currentSessionId !== null && t.runtime.store.listTasksBySession(h.state.currentSessionId).length === 1);
    const session = t.runtime.getSession(h.state.currentSessionId!);
    const project = t.runtime.store.getProject(session.projectId)!;
    assert.equal(project.managed, true);
    assert.equal(session.cwdReal, fs.realpathSync(path.join(t.dirs.profile.workspaceDir, project.id)));
    assert.deepEqual(session.modelSelection, selection);
    assert.equal(session.defaultAccessMode, "plan");
    assert.equal(t.runtime.store.listTasksBySession(session.id)[0].planMode, true);
    assert.deepEqual(writes, ["create_managed_session", "submit"]);
    await waitFor("first managed task complete", () => t.runtime.store.listTasksBySession(session.id)[0].status === "completed");
    h.terminal.send("/new\r"); await flush();
    assert.equal(h.state.currentSessionId, null);
    h.terminal.send("abandoned draft"); await flush();
    h.terminal.send("\x03"); await flush();
    h.terminal.send("/project\r"); await flush();
    h.terminal.send("\x1b[B\r");
    await waitFor("reopen managed conversation", () => h.state.currentSessionId === session.id);
    assert.equal(workspaces(t).length, 1);
    assert.equal(chats(t).length, 1);
    assert.deepEqual(fs.readdirSync(t.dirs.profile.workspaceDir), [project.id]);
    h.terminal.send("/new\r"); await flush();
    h.terminal.send("second managed message\r");
    await waitFor("independent managed conversation", () => h.state.currentSessionId !== null && h.state.currentSessionId !== session.id);
    const second = t.runtime.getSession(h.state.currentSessionId!);
    assert.notEqual(second.projectId, session.projectId);
    assert.notEqual(second.cwdReal, session.cwdReal);
    assert.equal(second.defaultAccessMode, "plan");
    assert.equal(workspaces(t).length, 2);
  } finally {
    for (const app of apps) app.quit();
    await t.shutdown();
  }
});

test("ordinary workspace /new still creates a session in the selected workspace and retains its draft", async () => {
  const t = await startTestRuntime("managed-tui-ordinary", () => ({ kind: "text", text: "ok" }));
  let app: TuiApp | undefined;
  try {
    const original = (await t.runtime.openWorkspace({ cwd: t.work[0] })).session;
    const h = await startApp(t, undefined, undefined, original.id); app = h.app;
    h.terminal.send("/new\r");
    await waitFor("ordinary new session", () => h.state.currentSessionId !== null && h.state.currentSessionId !== original.id);
    const next = t.runtime.getSession(h.state.currentSessionId!);
    assert.equal(next.projectId, original.projectId);
    assert.equal(next.cwdReal, original.cwdReal);
    assert.equal(workspaces(t).length, 1);
    assert.deepEqual(fs.readdirSync(t.dirs.profile.workspaceDir), []);
    h.terminal.send("retained ordinary draft"); await flush();
    h.app["switchSession"](original.id);
    h.app["switchSession"](next.id);
    assert.equal(editor(h.app).getExpandedText(), "retained ordinary draft");
    assert.equal(chats(t).length, 2);
    assert.equal(t.runtime.store.listTasksBySession(next.id).length, 0);
  } finally {
    app?.quit();
    await t.shutdown();
  }
});

test("managed first-send creation loss and rejected submission restore the original keys without sending on restart", async () => {
  const t = await startTestRuntime("managed-tui-retry", () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  try {
    const keys: string[] = [];
    let loseCreation = true, rejectSubmit = true;
    const connection = { instanceId: t.runtime.instanceId(), request: async <K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> => {
      if (op === "create_managed_session" || op === "submit") keys.push(String("request_id" in params ? params.request_id : ""));
      if (op === "submit" && rejectSubmit) { rejectSubmit = false; throw new ControlClientError("temporary_rejection", "fixture submission refused", "rejected"); }
      const result = await t.client.request<OpResult<K>>(op, params);
      if (op === "create_managed_session" && loseCreation) { loseCreation = false; throw new ControlClientError("request_timeout", "fixture creation response lost", "unknown"); }
      return result;
    } };
    const pendingDir = path.join(t.dirs.root, "first-message");
    const chat = new ManagedChat(new PendingRequestStore(pendingDir), connection);
    chat.open({ mode: "confirm", modelSelection: selection });
    await assert.rejects(chat.send("original input"), { code: "request_timeout" });
    const creationKey = chat.pending!.requestId, submitKey = chat.pending!.submitRequestId;
    assert.equal(workspaces(t).length, 1);
    assert.equal(chats(t).length, 1);
    const restored = new ManagedChat(new PendingRequestStore(pendingDir), connection);
    assert.deepEqual(restored.restore(), []);
    const observed = await restored.reconcile();
    assert.ok(observed?.session);
    assert.equal(observed.task, null);
    assert.equal(t.runtime.store.listTasksBySession(observed.session.id).length, 0, "restart only observes creation");
    restored.open({ mode: "full_access", modelSelection: selection });
    assert.equal(restored.draft!.text, "original input");
    assert.equal((await restored.send("original input"))!.outcome!.kind, "rejected");
    assert.equal(restored.pending!.requestId, creationKey);
    assert.equal(restored.pending!.submitRequestId, submitKey);
    const accepted = await restored.send("original input");
    assert.equal(accepted!.outcome!.kind, "accepted");
    assert.equal(workspaces(t).length, 1);
    assert.equal(chats(t).length, 1);
    assert.equal(t.runtime.store.listTasksBySession(observed.session.id).length, 1);
    assert.equal(keys.filter(key => key === creationKey).length, 3);
    assert.equal(keys.filter(key => key === submitKey).length, 2);
    assert.deepEqual(new PendingRequestStore(pendingDir).list().records, []);
  } finally { await t.shutdown(); }
});

for (const outcome of ["rejected", "not_sent"] as const) test(`managed ${outcome} first submission accepts durable corrected text and settings under its original keys`, async () => {
  const t = await startTestRuntime(`managed-tui-correct-${outcome}`, () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  try {
    const requests: Array<{ op: string; params: unknown }> = [];
    let refuse = true;
    const connection = { instanceId: t.runtime.instanceId(), request: async <K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> => {
      if (op === "submit" || op === "create_managed_session") requests.push({ op, params });
      if (op === "submit" && refuse) { refuse = false; throw new ControlClientError("execution_unavailable", "Fixture first submission was not accepted", outcome); }
      return t.client.request<OpResult<K>>(op, params);
    } };
    const dir = path.join(t.dirs.root, "correct-first"), chat = new ManagedChat(new PendingRequestStore(dir), connection);
    chat.open({ mode: "full_access", modelSelection: selection });
    assert.equal((await chat.send("original input"))!.outcome!.kind, outcome);
    const { requestId, submitRequestId, sessionId } = chat.pending!;
    assert.equal(chat.editable(), true);
    const config = await t.client.request<OpResult<"get_model_config">>("get_model_config", {});
    const providers = JSON.parse(fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8")).providers;
    providers.mock.models.push({ ...providers.mock.models[0], id: "corrected-model" });
    await t.client.request("save_model_catalog", { providers, expected_revision: config.revision });
    const corrected = { ...selection, modelId: "corrected-model" };
    Object.assign(chat.draft!, { text: "corrected input", mode: "confirm", modelSelection: corrected });
    chat.saveDraft();
    const restored = new ManagedChat(new PendingRequestStore(dir), connection);
    assert.deepEqual(restored.restore(), []);
    restored.open({ mode: "plan", modelSelection: selection });
    assert.deepEqual(restored.draft, { text: "corrected input", mode: "confirm", modelSelection: corrected });
    assert.equal(t.runtime.store.listTasksBySession(sessionId!).length, 0);
    const result = await restored.send("corrected input");
    assert.equal(result!.outcome!.kind, "accepted");
    assert.equal(result!.creation.session.id, sessionId);
    assert.equal(result!.creation.session.defaultAccessMode, "confirm");
    assert.deepEqual(result!.creation.session.modelSelection, corrected);
    assert.deepEqual(requests.filter(request => request.op === "create_managed_session").map(request => request.params), Array(2).fill({ request_id: requestId, mode: "full_access", model_selection: selection }));
    assert.deepEqual(requests.filter(request => request.op === "submit").map(request => request.params), [{ session_id: sessionId, request_id: submitRequestId, input: "original input", access_mode: "full_access", model_selection: selection }, { session_id: sessionId, request_id: submitRequestId, input: "corrected input", access_mode: "confirm", model_selection: corrected }]);
    assert.equal(workspaces(t).length, 1);
    assert.equal(chats(t).length, 1);
    assert.equal(t.runtime.store.listTasksBySession(sessionId!).length, 1);
  } finally { await t.shutdown(); }
});

test("managed recovery fails closed on unreadable creation journals and corrupt or orphan original submissions", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-tui-corrupt-")), now = new Date().toISOString();
  const first = { requestId: "original-create", op: "create_managed_session" as const, instanceId: "original-instance", createdAt: now, params: { request_id: "original-create", submit_request_id: "original-submit", session_id: "canonical-session", input: "original input", mode: "full_access", model_selection: selection } };
  const submit = { requestId: "original-submit", op: "submit" as const, instanceId: first.instanceId, createdAt: now, params: { request_id: "original-submit", session_id: "canonical-session", input: "original input", access_mode: "full_access", model_selection: selection } };
  const writes: unknown[] = [];
  const connection = { instanceId: first.instanceId, request: async <K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> => { writes.push({ op, params }); throw new Error("Corrupt recovery must not issue a request"); } };
  try {
    const store = new PendingRequestStore(dir); store.save(first);
    const list = store.list.bind(store);
    store.list = () => { throw Object.assign(new Error("Fixture EIO"), { code: "EIO" }); };
    const unreadable = new ManagedChat(store, connection);
    assert.throws(() => unreadable.restore(), { code: "EIO" });
    assert.throws(() => unreadable.open({ mode: "confirm", modelSelection: selection }), { code: "managed_chat_record_corrupt" });
    store.list = list;
    assert.deepEqual(unreadable.restore(), []);
    const submissions = new PendingRequestStore(path.join(dir, "submissions"));
    for (const params of [{ ...submit.params, request_id: "foreign-key" }, { ...submit.params, granted_paths: ["/foreign"] }]) {
      submissions.save({ ...submit, params });
      const snapshot = fs.readFileSync(path.join(submissions.dir, `${submit.requestId}.json`), "utf8");
      const chat = new ManagedChat(store, connection);
      assert.throws(() => chat.restore(), { code: "managed_chat_record_corrupt" });
      assert.throws(() => chat.open({ mode: "confirm", modelSelection: selection }), { code: "managed_chat_record_corrupt" });
      await assert.rejects(chat.send("original input"), { code: "managed_chat_record_corrupt" });
      assert.equal(fs.readFileSync(path.join(submissions.dir, `${submit.requestId}.json`), "utf8"), snapshot);
    }
    submissions.save(submit); store.remove(first.requestId);
    const orphan = new ManagedChat(store, connection);
    assert.throws(() => orphan.restore(), { code: "managed_chat_record_corrupt" });
    const fresh = new ManagedChat(store, connection); fresh.open({ mode: "confirm", modelSelection: selection });
    await assert.rejects(fresh.send("new input"), { code: "managed_chat_record_corrupt" });
    assert.deepEqual(store.list(true).records, []);
    assert.deepEqual(writes, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("managed unknown submission keeps its original payload and refuses a foreign saved session before replay", async () => {
  const t = await startTestRuntime("managed-tui-unknown", () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  try {
    const sent: Array<OpParams<"submit">> = [];
    let unknown = true;
    const connection = { instanceId: t.runtime.instanceId(), request: async <K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> => {
      if (op === "submit") {
        sent.push(params as OpParams<"submit">);
        if (unknown) { unknown = false; throw new ControlClientError("request_timeout", "Fixture submit was sent; acceptance is unknown", "unknown"); }
      }
      return t.client.request<OpResult<K>>(op, params);
    } };
    const store = new PendingRequestStore(path.join(t.dirs.root, "unknown-first")), chat = new ManagedChat(store, connection);
    chat.open({ mode: "full_access", modelSelection: selection });
    assert.equal((await chat.send("original input"))!.outcome!.kind, "pending_verification");
    assert.equal(chat.editable(), false);
    Object.assign(chat.draft!, { text: "correction", mode: "confirm", modelSelection: { ...selection, modelId: "changed" } });
    chat.saveDraft();
    await assert.rejects(chat.send("correction"), { code: "managed_chat_input_pending" });
    assert.equal(chat.pending!.input, "original input");
    const first = store.list(true).records[0], submissions = new PendingRequestStore(path.join(store.dir, "submissions")), original = submissions.list(true).records[0];
    store.save({ ...first, params: { ...first.params, session_id: "foreign-session" } });
    submissions.save({ ...original, params: { ...original.params, session_id: "foreign-session" } });
    const corrupted = new ManagedChat(store, connection);
    assert.deepEqual(corrupted.restore(), []);
    corrupted.open({ mode: "confirm", modelSelection: selection });
    await assert.rejects(corrupted.reconcile(), { code: "managed_chat_record_corrupt" });
    await assert.rejects(corrupted.send("original input"), { code: "managed_chat_record_corrupt" });
    assert.equal(sent.length, 1);
    assert.equal(store.list(true).records[0].params.session_id, "foreign-session");
    store.save(first); submissions.save(original);
    chat.draft!.text = "original input\n\nlater local edit";
    await chat.send(chat.draft!.text);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
    const result = await chat.reconcile();
    assert.ok(result?.task);
    assert.equal(result.task.input, "original input");
    assert.equal(chat.draft!.text, "original input\n\nlater local edit");
    assert.equal(t.runtime.store.listTasksBySession(result.session.id).length, 1);
  } finally { await t.shutdown(); }
});

test("lost creation response keeps the TUI draft, and reopening resumes the original first message", async () => {
  const t = await startTestRuntime("managed-tui-loss", () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  const apps: TuiApp[] = [];
  try {
    let lose = true;
    const keys: string[] = [];
    const h = await startApp(t, undefined, client => {
      const request = client.request.bind(client);
      client.request = async <T = unknown>(op: string, params?: Record<string, unknown>, timeout?: number): Promise<T> => {
        if (op === "create_managed_session") keys.push(String(params?.request_id));
        const result = await request<T>(op, params, timeout);
        if (op === "create_managed_session" && lose) { lose = false; throw new ControlClientError("request_timeout", "creation response lost", "unknown"); }
        return result;
      };
    });
    apps.push(h.app);
    await selectManaged(h);
    h.terminal.send("retained first input\r");
    await waitFor("failed creation draft restored", () => h.terminal.output().includes("retained first input") && workspaces(t).length === 1);
    await flush();
    assert.equal(h.state.currentSessionId, null);
    const session = chats(t)[0];
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, 0);
    h.terminal.send("\x15"); h.terminal.send("/project\r"); await flush();
    h.terminal.send("\x1b[B\r"); await flush();
    assert.equal(h.state.currentSessionId, null);
    h.terminal.send("\r");
    await waitFor("original first input accepted", () => h.state.currentSessionId === session.id && t.runtime.store.listTasksBySession(session.id).length === 1);
    assert.equal(workspaces(t).length, 1);
    assert.equal(chats(t).length, 1);
    assert.equal(new Set(keys).size, 1);
  } finally {
    for (const app of apps) app.quit();
    await t.shutdown();
  }
});

test("leaving a managed draft during creation preserves its binding and sends no hidden input", async () => {
  const t = await startTestRuntime("managed-tui-away", () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  try {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let created = false;
    const connection = { instanceId: t.runtime.instanceId(), request: async <K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> => {
      const result = await t.client.request<OpResult<K>>(op, params);
      if (op === "create_managed_session") { created = true; await held; }
      return result;
    } };
    const chat = new ManagedChat(new PendingRequestStore(path.join(t.dirs.root, "away-pending")), connection);
    chat.open({ mode: "confirm", modelSelection: selection });
    const sending = chat.send("hidden input");
    await waitFor("creation held", () => created);
    chat.close(); release();
    const result = await sending;
    assert.equal(result!.outcome, null);
    assert.equal(t.runtime.store.listTasksBySession(result!.creation.session.id).length, 0);
    assert.equal(chat.pending!.sessionId, result!.creation.session.id);
    chat.open({ mode: "confirm", modelSelection: selection });
    const retry = await chat.send("hidden input");
    assert.equal(retry!.outcome!.kind, "accepted");
    assert.equal(workspaces(t).length, 1);
  } finally { await t.shutdown(); }
});

for (const outcome of ["accepted", "rejected", "unknown"] as const) test(`managed TUI ${outcome} first-send completion preserves text typed while its request is pending`, async () => {
  const t = await startTestRuntime(`managed-tui-flight-${outcome}`, () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  let app: TuiApp | undefined, release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const h = await startApp(t, undefined, client => {
      const request = client.request.bind(client);
      client.request = async <T = unknown>(op: string, params?: Record<string, unknown>, timeout?: number): Promise<T> => {
        if (op === (outcome === "accepted" ? "create_managed_session" : "submit")) {
          const result = outcome === "accepted" ? await request<T>(op, params, timeout) : null;
          held = true; await gate;
          if (outcome !== "accepted") throw new ControlClientError("fixture_failure", "Fixture submission was not accepted", outcome);
          return result as T;
        }
        return request<T>(op, params, timeout);
      };
    }); app = h.app;
    await selectManaged(h);
    h.terminal.send("original input\r");
    await waitFor("managed first-send held", () => held);
    h.terminal.send("later local edit");
    assert.equal(editor(h.app).getExpandedText(), "later local edit");
    release();
    await waitFor("first-send settled", () => !managedChat(h.app).busy);
    if (outcome === "accepted") {
      await waitFor("managed session selected", () => h.state.currentSessionId !== null);
      assert.equal(editor(h.app).getExpandedText(), "later local edit");
      assert.equal(h.state.openSession(h.state.currentSessionId!).draft, "later local edit");
      assert.equal(t.runtime.store.listTasksBySession(h.state.currentSessionId!)[0].input, "original input");
    } else {
      assert.equal(editor(h.app).getExpandedText(), "original input\n\nlater local edit");
      assert.equal(h.state.currentSessionId, null);
      const chat = managedChat(h.app);
      assert.ok(chat.pending);
      assert.equal(chat.editable(), outcome === "rejected");
      if (outcome === "rejected") {
        editor(h.app).setText(""); h.terminal.send("/mode\r");
        await waitFor("rejected first mode control opens", () => tui(h.app).getFocusedComponent() !== editor(h.app));
        h.terminal.send("\r");
        await waitFor("mode selected", () => tui(h.app).getFocusedComponent() === editor(h.app));
        h.terminal.send("/model\r");
        await waitFor("rejected first model control opens", () => h.terminal.output().includes("思考强度"));
        h.terminal.send("\r");
        await waitFor("model selected", () => tui(h.app).getFocusedComponent() === editor(h.app));
        h.terminal.send("corrected input");
        await waitFor("corrected first draft saved", () => chat.store.list(true).records[0].params.input === "corrected input");
        const cold = new ManagedChat(chat.store, h.connection);
        assert.deepEqual(cold.restore(), []); cold.open({ mode: "plan", modelSelection: null });
        assert.equal(cold.draft!.text, "corrected input");
        assert.equal(cold.draft!.mode, "confirm");
      }
    }
  } finally {
    release(); app?.quit();
    await t.shutdown();
  }
});

test("linking an accepted original first message preserves a correction that was never submitted", async () => {
  const t = await startTestRuntime("managed-tui-old-acceptance", () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  let app: TuiApp | undefined, release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const h = await startApp(t, undefined, client => {
      const request = client.request.bind(client);
      client.request = async <T = unknown>(op: string, params?: Record<string, unknown>, timeout?: number): Promise<T> => {
        const result = await request<T>(op, params, timeout);
        if (op === "create_managed_session") { held = true; await gate; }
        return result;
      };
    }); app = h.app;
    await selectManaged(h);
    h.terminal.send("original input\r"); await waitFor("creation held", () => held);
    const chat = managedChat(h.app); chat.close(); release();
    await waitFor("creation journal retained", () => !chat.busy && chat.pending?.sessionId !== null);
    const original = chat.pending!;
    chat.open({ mode: "confirm", modelSelection: selection });
    editor(h.app).setText("corrected unsent text"); chat.saveDraft();
    await t.client.request("submit", { session_id: original.sessionId!, request_id: original.submitRequestId, input: "original input", access_mode: "confirm", model_selection: selection });
    h.terminal.send("\r");
    await waitFor("accepted original selected", () => h.state.currentSessionId === original.sessionId);
    assert.equal(editor(h.app).getExpandedText(), "corrected unsent text");
    assert.equal(h.state.openSession(original.sessionId!).draft, "corrected unsent text");
    assert.equal(t.runtime.store.listTasksBySession(original.sessionId!).length, 1);
    assert.equal(t.runtime.store.listTasksBySession(original.sessionId!)[0].input, "original input");
  } finally {
    release(); app?.quit();
    await t.shutdown();
  }
});

test("fresh managed TUI drafts read the current runtime default while opened local choices remain pinned", async () => {
  const t = await startTestRuntime("managed-tui-default", () => ({ kind: "text", text: "ok" }), { workDirs: 0, config: { modelProvider: undefined, modelId: undefined } });
  let app: TuiApp | undefined;
  try {
    const h = await startApp(t); app = h.app;
    assert.equal(h.state.defaultModel.id, selection.modelId);
    const config = await t.client.request<OpResult<"get_model_config">>("get_model_config", {});
    const providers = JSON.parse(fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8")).providers;
    providers.mock.models.push({ ...providers.mock.models[0], id: "current-default" });
    const catalog = await t.client.request<OpResult<"save_model_catalog">>("save_model_catalog", { providers, expected_revision: config.revision });
    await t.client.request("set_default_model", { provider: "mock", model_id: "current-default", thinking_level: "off", expected_revision: catalog.revision });
    await selectManaged(h);
    assert.equal(managedChat(h.app).draft!.modelSelection!.modelId, "current-default");
    const local: ManagedChatDraft = managedChat(h.app).draft!;
    local.modelSelection = selection;
    h.terminal.send("kept local text");
    editor(h.app).setText(""); h.terminal.send("/new\r"); await flush();
    assert.equal(managedChat(h.app).draft, local);
    assert.deepEqual(local.modelSelection, selection);
    assert.equal(workspaces(t).length, 0);
    assert.equal(chats(t).length, 0);
  } finally {
    app?.quit();
    await t.shutdown();
  }
});

test("managed creation preflight failure allows corrected settings only after proving no creation receipt", async () => {
  const t = await startTestRuntime("managed-tui-model", () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  try {
    const connection = { instanceId: t.runtime.instanceId(), request: <K extends TuiOp>(op: K, params: OpParams<K>) => t.client.request<OpResult<K>>(op, params) };
    const chat = new ManagedChat(new PendingRequestStore(path.join(t.dirs.root, "model-pending")), connection);
    chat.open({ mode: "confirm", modelSelection: { ...selection, modelId: "absent" } });
    await assert.rejects(chat.send("first model message"));
    assert.equal(chat.pending, null);
    assert.equal(workspaces(t).length, 0);
    chat.draft!.modelSelection = selection;
    assert.equal((await chat.send("first model message"))!.outcome!.kind, "accepted");
    assert.equal(workspaces(t).length, 1);
  } finally { await t.shutdown(); }
});

test("development reload restores an unsubmitted managed draft and its local settings without allocating a workspace", async () => {
  const t = await startTestRuntime("managed-tui-reload", () => ({ kind: "text", text: "ok" }), { workDirs: 0 });
  const apps: TuiApp[] = [];
  try {
    const reloadFile = path.join(t.dirs.root, "reload.json");
    const h = await startApp(t, undefined, undefined, undefined, reloadFile); apps.push(h.app);
    await selectManaged(h);
    h.terminal.send("draft through reload");
    h.terminal.send("\x1b[Z"); await flush();
    h.app.quit();
    await waitFor("first TUI exited", h.exited);
    const saved = loadReloadState(reloadFile);
    assert.ok(saved?.kind === "task-tui");
    assert.equal(saved.managedDraft!.text, "draft through reload");
    assert.equal(saved.managedDraft!.mode, "full_access");
    const restored = await startApp(t, undefined, undefined, undefined, reloadFile); apps.push(restored.app);
    await waitFor("managed draft restored", () => restored.terminal.output().includes("draft through reload"));
    assert.equal(restored.state.currentSessionId, null);
    assert.equal(workspaces(t).length, 0);
    assert.equal(chats(t).length, 0);
    assert.equal(t.server.calls.length, 0);
    assert.deepEqual(fs.readdirSync(t.dirs.profile.workspaceDir), []);
  } finally {
    for (const app of apps) app.quit();
    await t.shutdown();
  }
});
