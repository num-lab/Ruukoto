import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { ControlClientError, type ControlClient } from "@ruukoto/control/client.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { SESSION_DEFAULT_MODES, type SessionDefaultMode, type Session, type Project } from "@ruukoto/core/types.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { handleRequest } from "../apps/desktop/src/main/ipc.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, connectAuthedClient, makeTestDirs, writeModelsJson } from "./helpers/testkit.ts";

const selected = { provider: "second", modelId: "reasoner", thinkingLevel: "high" as const };
async function fixture(t: TestContext, mode: SessionDefaultMode = "plan") {
  const { dirs, work } = await makeTestDirs("desktop-create-settings", 2);
  const server = new MockModelServer(() => ({ kind: "text", text: "ok" }));
  let runtime: Runtime | undefined, client: ControlClient | undefined;
  t.after(async () => { client?.close(); await runtime?.stop("test_end"); await server.close(); await cleanupDirs(dirs); });
  await writeModelsJson(dirs, await server.start());
  const file = path.join(dirs.agentDir, "models.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.providers.second = { ...config.providers.mock, models: [{ ...config.providers.mock.models[0], id: "reasoner", reasoning: true, maxTokens: 4096 }] };
  fs.writeFileSync(file, JSON.stringify(config));
  runtime = await Runtime.start({ product: product.runtime, dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"), modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", toolFactory: context => createMockTools(context) });
  await ControlServer.start(runtime);
  client = await connectAuthedClient(runtime);
  const source = (await runtime.openWorkspace({ cwd: work[0] })).session;
  await runtime.setSessionModel({ sessionId: source.id, expectedVersion: source.modelSelectionVersion, modelSelection: selected });
  await runtime.setSessionDefaultMode({ sessionId: source.id, expectedVersion: source.defaultAccessModeVersion, mode });
  const transport = client;
  const creations: { op: string; params: Record<string, unknown> }[] = [];
  const hook: { afterCreate?: () => Promise<void>; beforeRequest?: (name: string) => Promise<void>; afterRequest?: (name: string) => Promise<void> } = {};
  const model = new CodeState({ request: (target, op, params) => handleRequest(target, op, params, async () => {}, async (name, input) => {
    const creating = name === "create_session" || name === "open_workspace";
    if (creating) creations.push({ op: name, params: structuredClone(input) });
    await hook.beforeRequest?.(name);
    const result = await transport.request(name, input);
    await hook.afterRequest?.(name);
    if (creating) await hook.afterCreate?.();
    return result;
  }) }, () => {});
  model.update({ type: "snapshot", result: await client.handshake(), instanceChanged: false });
  model.update({ type: "state", state: "online" }); model.openSession(source.id);
  return { runtime, client, model, source, work, creations, hook };
}

function rendererFixture(mode: SessionDefaultMode) {
  const work = ["/work/first", "/work/second"];
  const source: Session = { id: "source", projectId: "project", workspaceProjectId: null, kind: "dev", name: null, branchSource: null, cwd: work[0], cwdReal: work[0], cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: { ...selected }, modelSelectionVersion: 1, defaultAccessMode: mode, defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: "now" };
  const project: Project = { id: source.projectId, name: "工作区", createRequestId: null, rootDir: { cwd: work[0], cwdReal: work[0], dev: 1, ino: 1 }, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "now" };
  const creations: { op: string; params: Record<string, unknown> }[] = [];
  const model = new CodeState({ request: async (_target, op, params) => {
    if (op === "create_session" || op === "open_workspace") {
      creations.push({ op, params: structuredClone(params) });
      const session = { ...source, id: "created" };
      return { ok: true, value: op === "open_workspace" ? { session, project, reused: false } : session };
    }
    return { ok: false, error: { code: "fixture_unavailable", message: "本用例只提供创建应答", outcome: "rejected" } };
  } }, () => {});
  model.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ projects: [project], sessions: [source] }), replay: [], seq: 0 }, instanceChanged: false });
  model.update({ type: "state", state: "online" }); model.openSession(source.id);
  return { model, source, work, creations };
}

for (const mode of SESSION_DEFAULT_MODES) for (const operation of ["new-session", "existing-workspace", "new-workspace", "last-tab-closed"] as const) {
  test(`Desktop 新会话保留 mode/model/effort：${mode}/${operation}`, async () => {
    const { model, source, work, creations } = rendererFixture(mode);
    if (operation === "last-tab-closed") model.closeSession(source.id);
    if (operation === "new-session" || operation === "last-tab-closed") await model.create("create_session", { project_id: source.projectId, cwd: work[0] });
    else await model.create("open_workspace", { cwd: work[operation === "new-workspace" ? 1 : 0] });
    assert.notEqual(model.view.currentSessionId, source.id, model.message ?? "应创建新的空会话");
    assert.equal(creations.length, 1);
    assert.equal(creations[0].params.mode, mode);
    assert.deepEqual(creations[0].params.model_selection, selected);
    assert.equal(creations[0].params.cwd, work[operation === "new-workspace" ? 1 : 0]);
    assert.equal(creations[0].op, operation === "new-session" || operation === "last-tab-closed" ? "create_session" : "open_workspace");
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
for (const state of ["saving", "unknown"] as const) {
  test(`Desktop 源设置 ${state} 时不创建会话`, async t => {
    const { model, source, work, creations, hook } = await fixture(t);
    const started = deferred(), release = deferred();
    let saving: Promise<void> | undefined;
    if (state === "saving") {
      hook.beforeRequest = async name => { if (name === "set_session_mode") { started.resolve(); await release.promise; } };
      saving = model.writes.setMode(model.view.sessions.find(session => session.id === source.id)!, "full_access");
      await started.promise;
    } else model.writes.unknown.set(source.id, { op: "settings", sessionId: source.id, instanceId: model.view.instanceId });
    assert.equal(await model.create("create_session", { project_id: source.projectId, cwd: work[0] }), false);
    assert.equal(creations.length, 0);
    assert.equal(model.view.currentSessionId, source.id);
    assert.match(model.message!, /设置/);
    release.resolve(); await saving;
  });
}

test("Desktop 未知降权不能被恢复队列覆盖，快照核实后继承后台实际模式", async t => {
  const { runtime, client, model, source, work, creations, hook } = await fixture(t, "full_access");
  let resumed = 0;
  hook.beforeRequest = async name => {
    if (name === "get_session") throw new ControlClientError("request_timeout", "测试核实失败", "unknown");
    if (name === "resume_queue") ++resumed;
  };
  hook.afterRequest = async name => { if (name === "set_session_mode") throw new ControlClientError("request_timeout", "测试设置已保存但应答丢失", "unknown"); };
  const current = model.view.sessions.find(session => session.id === source.id)!;
  await model.writes.setMode(current, "confirm");
  assert.equal(runtime.getSession(source.id).defaultAccessMode, "confirm");
  assert.equal(current.defaultAccessMode, "full_access");
  assert.equal(model.writes.settingsPending(source.id), true);
  await model.writes.resume(current);
  assert.equal(resumed, 0, "恢复队列不能替代未知设置的核实");
  assert.equal(model.writes.unknown.get(source.id)?.op, "settings");
  assert.equal(await model.create("create_session", { project_id: source.projectId, cwd: work[0] }), false);
  assert.equal(creations.length, 0);
  hook.afterRequest = undefined;
  hook.beforeRequest = async name => { if (name === "resume_queue") ++resumed; };
  model.update({ type: "snapshot", result: await client.handshake(), instanceChanged: false });
  assert.equal(model.writes.settingsPending(source.id), false);
  await model.writes.resume(model.view.sessions.find(session => session.id === source.id)!);
  assert.equal(resumed, 1);
  assert.equal(await model.create("create_session", { project_id: source.projectId, cwd: work[0] }), true);
  assert.equal(creations[0].params.mode, "confirm");
  assert.equal(runtime.getSession(model.view.currentSessionId!).defaultAccessMode, "confirm");
});

for (const state of ["saving", "unknown"] as const) {
  test(`Desktop 换实例后不被旧实例同 ID 的 ${state} 设置拦住`, async t => {
    const { model, client, source, work, hook } = await fixture(t);
    const started = deferred(), release = deferred();
    let saving: Promise<void> | undefined;
    if (state === "saving") {
      hook.beforeRequest = async name => { if (name === "set_session_mode") { started.resolve(); await release.promise; } };
      saving = model.writes.setMode(model.view.sessions.find(session => session.id === source.id)!, "full_access");
      await started.promise;
    } else model.writes.unknown.set(source.id, { op: "settings", sessionId: source.id, instanceId: model.view.instanceId });
    const next = await client.handshake(); next.snapshot.instanceId = "replacement-instance";
    model.update({ type: "snapshot", result: next, instanceChanged: true });
    model.openSession(source.id);
    assert.equal(await model.create("open_workspace", { cwd: work[1] }), true);
    release.resolve(); await saving;
  });
}

test("Desktop 创建重试固定首次克隆的设置，不随源对象修改漂移", async t => {
  const { runtime, model, source, work, creations, hook } = await fixture(t);
  let first = true;
  hook.afterCreate = async () => {
    if (!first) return;
    first = false;
    const current = model.view.sessions.find(session => session.id === source.id)!;
    current.modelSelection!.thinkingLevel = "low"; current.defaultAccessMode = "confirm";
    throw new ControlClientError("request_timeout", "测试丢答", "unknown");
  };
  await model.create("create_session", { project_id: source.projectId, cwd: work[0] });
  assert.equal(creations.length, 2);
  assert.deepEqual(creations[1].params, creations[0].params);
  assert.deepEqual(creations[0].params.model_selection, selected);
  assert.equal(creations[0].params.mode, "plan");
  const created = runtime.store.getSession(model.view.currentSessionId!)!;
  assert.deepEqual({ mode: created.defaultAccessMode, model: created.modelSelection }, { mode: "plan", model: selected });
});

test("Desktop 关闭 Code 标签后按同实例快照最新值继承，当前 Code 选择优先", async t => {
  const { runtime, client, model, source, work } = await fixture(t);
  model.closeSession(source.id);
  await runtime.setSessionDefaultMode({ sessionId: source.id, expectedVersion: runtime.getSession(source.id).defaultAccessModeVersion, mode: "auto-review" });
  model.update({ type: "snapshot", result: await client.handshake(), instanceChanged: false });
  await model.create("open_workspace", { cwd: work[1] });
  const second = runtime.getSession(model.view.currentSessionId!);
  assert.equal(second.defaultAccessMode, "auto-review");
  await model.writes.setMode(second, "full_access");
  model.openSession(source.id);
  await model.create("create_session", { cwd: work[1], project_id: second.projectId });
  assert.equal(runtime.getSession(model.view.currentSessionId!).defaultAccessMode, "auto-review");
});

test("Desktop 换数据实例清除 Code 来源，未选择来源时使用后台默认", async t => {
  const { runtime, client, model, work, creations } = await fixture(t);
  model.update({ type: "snapshot", result: await client.handshake(), instanceChanged: true });
  assert.equal(model.view.currentSessionId, null);
  await model.create("open_workspace", { cwd: work[1] });
  assert.equal(creations[0].params.mode, undefined);
  assert.equal(creations[0].params.model_selection, undefined);
  const created = runtime.getSession(model.view.currentSessionId!);
  assert.equal(created.defaultAccessMode, "confirm");
  assert.deepEqual(created.modelSelection, { provider: "mock", modelId: "mock-model", thinkingLevel: "off" });
});

for (const op of ["open_workspace", "create_session"] as const) {
  test(`初始设置 ${op}：首次成果优先，不被重放或失效模型覆盖`, async t => {
    const { runtime, client, source, work } = await fixture(t);
    for (const mode of SESSION_DEFAULT_MODES) {
      const cwd = path.join(work[1], mode); fs.mkdirSync(cwd);
      const params = { cwd, ...(op === "create_session" ? { project_id: source.projectId } : {}), request_id: `replay-${op}-${mode}`, mode, model_selection: selected };
      const first = await client.request<OpResult<typeof op>>(op, params);
      const created = "session" in first ? first.session : first;
      assert.deepEqual({ mode: created.defaultAccessMode, model: created.modelSelection }, { mode, model: selected });
      assert.equal(runtime.store.listTasksBySession(created.id).length, 0);
      await runtime.setSessionDefaultMode({ sessionId: created.id, expectedVersion: created.defaultAccessModeVersion, mode: "full_access" });
      await runtime.setSessionModel({ sessionId: created.id, expectedVersion: created.modelSelectionVersion, modelSelection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
      const seq = runtime.store.getMaxSeq();
      const second = await client.request<OpResult<typeof op>>(op, { ...params, model_selection: { ...selected, modelId: "removed" } });
      assert.deepEqual("session" in second ? second.session : second, runtime.getSession(created.id));
      assert.equal(runtime.getSession(created.id).defaultAccessMode, "full_access");
      assert.equal(runtime.store.getMaxSeq(), seq);
    }
  });

  test(`初始设置 ${op}：无效显式模型/模式不创建会话或工作区`, async t => {
    const { runtime, client, source, work } = await fixture(t);
    const params = { cwd: work[1], ...(op === "create_session" ? { project_id: source.projectId } : {}) };
    const count = runtime.store.listSessions().length, projects = runtime.store.listProjects(), seq = runtime.store.getMaxSeq();
    await assert.rejects(client.request(op, { ...params, mode: "plan", model_selection: { ...selected, modelId: "absent" } }), { code: "model_not_found" });
    await assert.rejects(client.request(op, { ...params, mode: "invalid", model_selection: selected }), { code: "invalid_params" });
    assert.equal(runtime.store.listSessions().length, count);
    assert.deepEqual(runtime.store.listProjects(), projects);
    assert.equal(runtime.store.getMaxSeq(), seq);
  });
}

test("Desktop 存档后隐藏、取消存档后恢复工作区会话列表", async t => {
  const { runtime, client, model, source } = await fixture(t);
  const kept = (await runtime.createSession({ projectId: source.projectId, cwd: source.cwdReal })).id;
  model.update({ type: "snapshot", result: await client.handshake(), instanceChanged: false });
  for (const archived of [true, false]) {
    await model.setArchived(source.id, archived);
    const listed = model.sessionsFor(source.projectId).map(session => session.id);
    const archivedIds = model.archivedSessions().map(session => session.id);
    assert.deepEqual(listed.includes(source.id), !archived, "工作区树按存档状态过滤");
    assert.deepEqual(archivedIds.includes(source.id), archived, "设置页只列已存档会话");
    assert.ok(listed.includes(kept), "其余会话不受影响");
    assert.equal(runtime.store.getSession(source.id)!.archivedAt === null, !archived);
    assert.equal(runtime.store.listTasksBySession(source.id).length, 0, "存档不建任务");
  }
});
