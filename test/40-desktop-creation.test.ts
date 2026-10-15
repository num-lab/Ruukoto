import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { handleRequest, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import type { DesktopResult } from "../apps/desktop/src/shared/bridge.ts";
import { connectAuthedClient, startTestRuntime, type TestRuntime, waitFor } from "./helpers/testkit.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function install(model: CodeState, runtime: TestRuntime) {
  if (runtime.client.isClosed) runtime.client = await connectAuthedClient(runtime.runtime);
  const result = await runtime.client.handshake();
  model.update({ type: "snapshot", result, instanceChanged: model.view.instanceId !== null && model.view.instanceId !== result.snapshot.instanceId });
  model.update({ type: "state", state: "online" });
}
for (const op of ["open_workspace", "create_session"] as const) {
  for (const outcome of ["unknown", "disconnected", "rejected", "not_sent"] as const) {
    test(`桌面 ${op}：${outcome} 保留原键核实，重复点击不新建`, async () => {
      const t = await startTestRuntime(`d-${op[0]}-${outcome[0]}`, async () => ({ kind: "text", text: "ok" }), { config: { product: product.runtime } });
      try {
        const workspace = await t.client.request<OpResult<"open_workspace">>("open_workspace", { cwd: t.work[0], request_id: "fixture" });
        const params = { cwd: outcome === "rejected" ? t.dirs.dataDir : t.work[0], ...(op === "create_session" ? { project_id: workspace.session.projectId } : {}) };
        const calls: string[] = [];
        const accepted = deferred<void>();
        const release = deferred<void>();
        let first = true;
        const model = new CodeState({ request: (target, name, input) => handleRequest(target, name, input, async () => {}, async (name, input) => {
          if (name !== op) return t.client.request(name, input);
          calls.push(String((input as OpParams<"open_workspace">).request_id));
          if (!first) return t.client.request(name, input);
          first = false;
          if (outcome === "rejected") return t.client.request(name, input);
          if (outcome !== "not_sent") await t.client.request(name, input);
          accepted.resolve();
          await release.promise;
          if (outcome === "disconnected" || outcome === "not_sent") t.client.close();
          throw new ControlClientError("injected", "模拟应答丢失", outcome);
        }) }, () => {});
        await install(model, t);
        const operation = model.create(op, params);
        if (outcome !== "rejected") {
          await accepted.promise;
          const record = model.pendingCreation;
          await model.create(op, params);
          assert.equal(model.pendingCreation, record);
          assert.equal(calls.length, 1, "在途重复点击不另发请求");
          if (outcome === "disconnected" || outcome === "not_sent") model.update({ type: "state", state: "reconnecting" });
          release.resolve();
        }
        await operation;
        if (outcome === "rejected") {
          assert.equal(model.pendingCreation, null);
          assert.equal(model.view.currentSessionId, null);
          assert.match(model.message!, /创建失败/);
          assert.equal(t.runtime.store.listSessions().filter(session => calls.includes(session.createRequestId ?? "")).length, 0);
          return;
        }
        if (outcome !== "unknown") {
          const record = model.pendingCreation;
          assert.ok(record);
          assert.equal(calls.length, 1, "断线或未发送等待新快照");
          await model.create(op, params);
          assert.equal(calls.length, 1);
          await install(model, t);
        }
        await waitFor("按原键打开会话", () => model.view.currentSessionId !== null && model.pendingCreation === null);
        const created = t.runtime.store.listSessions().filter(session => session.createRequestId === calls[0]);
        assert.equal(created.length, 1);
        assert.equal(model.view.currentSessionId, created[0].id);
        assert.equal(new Set(calls).size, 1);
        const originalKey = calls[0];
        await model.create(op, params);
        assert.notEqual(calls.at(-1), originalKey, "成功后的独立操作用新键");
        assert.equal(t.runtime.store.listSessions().filter(session => session.projectId === workspace.session.projectId).length, 3, "初始夹具加两次独立创建");
      } finally { t.client.close(); await t.shutdown(); }
    });
  }
}

for (const lateSuccess of [false, true]) test(`桌面跨实例：A ${lateSuccess ? "迟到成功" : "应答丢失"} 不安装到 B 或重发`, async () => {
  const a = await startTestRuntime("desktop-a", async () => ({ kind: "text", text: "ok" }), { config: { product: product.runtime } });
  const b = await startTestRuntime("desktop-b", async () => ({ kind: "text", text: "ok" }), { config: { product: product.runtime } });
  try {
    let current = a;
    let bWrites = 0;
    const accepted = deferred<void>();
    const response = deferred<DesktopResult<unknown>>();
    const model = new CodeState({ request: async (target, op, params) => {
      const runtime = current;
      if (op === "open_workspace") {
        if (runtime === b) bWrites++;
        const result = await handleRequest(target, op, params, async () => {}, (op, input) => runtime.client.request(op, input));
        accepted.resolve();
        if (lateSuccess) { await response.promise; return result; }
        return { ok: false, error: { code: "lost", outcome: "disconnected", message: "应答丢失" } };
      }
      return handleRequest(target, op, params, async () => {}, (op, input) => runtime.client.request(op, input));
    } }, () => {});
    await install(model, a);
    const operation = model.create("open_workspace", { cwd: a.work[0] });
    await accepted.promise;
    const record = model.pendingCreation;
    current = b;
    await install(model, b);
    response.resolve({ ok: true, value: null });
    await operation;
    await model.create("open_workspace", { cwd: b.work[0] });
    assert.equal(bWrites, 0);
    assert.equal(model.pendingCreation, record);
    assert.equal(model.view.currentSessionId, null);
    assert.equal(model.tabs.length, 0);
    assert.match(model.message!, /原操作结果仍未知/);
    current = a;
    await install(model, a);
    await waitFor("回原实例核实", () => model.pendingCreation === null);
    assert.ok(model.view.currentSessionId);
  } finally { await Promise.all([a.shutdown(), b.shutdown()]); }
});

test("桌面二次未知保留原操作，迟到创建事件能确认原会话", async () => {
  const t = await startTestRuntime("desktop-event", async () => ({ kind: "text", text: "ok" }), { config: { product: product.runtime } });
  try {
    const calls: Array<OpParams<DesktopOp>> = [];
    const model = new CodeState({ request: async (_target, op, params) => {
      if (op === "open_workspace") {
        calls.push(params as OpParams<DesktopOp>);
        return { ok: false, error: { code: "lost", outcome: "unknown", message: "应答丢失" } };
      }
      return { ok: true, value: [] };
    } }, () => {});
    await install(model, t);
    await model.create("open_workspace", { cwd: t.work[0] });
    assert.equal(calls.length, 2);
    assert.match(model.message!, /结果未知/);
    const request = model.pendingCreation!;
    await model.create("open_workspace", { cwd: t.work[0] });
    assert.equal(calls.length, 2, "未知后再次点击只核实，不无限重发");
    const result = await t.client.request<OpResult<"open_workspace">>("open_workspace", request.params);
    const snapshot: ConnectResult = await t.client.handshake();
    const event = snapshot.replay.find(event => event.body.type === "session.created");
    // 握手默认不补发，构造同一真实创建的事件载荷验证渲染入口。
    model.update({ type: "event", kind: "live", event: event ?? { seq: snapshot.seq, sessionId: result.session.id, taskId: null, createdAt: result.session.createdAt, body: { type: "session.created", sessionId: result.session.id, projectId: result.session.projectId, kind: "dev", cwd: result.session.cwd, modelSelection: result.session.modelSelection, modelSelectionVersion: result.session.modelSelectionVersion, createRequestId: request.params.request_id, session: result.session } } });
    await waitFor("迟到事件确认", () => model.pendingCreation === null);
    assert.equal(model.view.currentSessionId, result.session.id);
  } finally { await t.shutdown(); }
});
