import { createHash } from "node:crypto";
/**
 * 桌面浏览器通路（mygo-agent-browser 步骤 3）：登记身份的窄命令通道、
 * 事件上行、分块装配与完整性校验、断线解绑、任务来源归属。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { CONTROL_PROTOCOL_VERSION, encodeFrame } from "@ruukoto/control/protocol.ts";
import { createProjectSession, connectAuthedClient, routeResponder, startTestRuntime } from "./helpers/testkit.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

/** 已登记的桌面连接（登记返回 connection_id）。 */
async function registeredClient(runtime: Parameters<typeof connectAuthedClient>[0]) {
  const client = await connectAuthedClient(runtime);
  const reg = (await client.request("desktop_browser_register", { shell: "mygo" })) as { connection_id: string };
  return { client, connectionId: reg.connection_id };
}

test("登记连接才能收发浏览器消息；窄命令应答原路返回；重复登记幂等", async () => {
  const t = await startTestRuntime("browser-reg", routeResponder([]));
  try {
    // 未登记连接发事件/分块被拒
    const stranger = await connectAuthedClient(t.runtime);
    await assert.rejects(stranger.request("desktop_browser_event", { event: { session: "s", kind: "nav", generation: 1 } }), (e: unknown) => e instanceof ControlClientError && (e as ControlClientError).code === "not_registered");
    await assert.rejects(stranger.request("desktop_browser_chunk", { command_id: "call-1", index: 0, total: 1, total_bytes: 0, sha256: "0".repeat(64), data: "" }), (e: unknown) => (e as ControlClientError).code === "not_registered");

    const { client, connectionId } = await registeredClient(t.runtime);
    const again = (await client.request("desktop_browser_register", { shell: "mygo" })) as { connection_id: string };
    assert.equal(again.connection_id, connectionId);

    // 窄命令：服务端经登记连接下发，客户端应答原路返回
    let seen: { op: string; params: Record<string, unknown>; callId: string } | null = null;
    client.onCall(async (op, params, callId) => { seen = { op, params, callId }; return { ok: true, value: { session: params["session"], generation: 7 } }; });
    const result = (await t.runtime.desktopBrowserCall!(connectionId, { op: "status", session: "s1" })) as { ok: boolean; value: { generation: number } };
    assert.equal(seen!.op, "browser_command");
    assert.equal((seen!.params as Record<string, unknown>)["op"], "status");
    assert.deepEqual(result, { ok: true, value: { session: "s1", generation: 7 } });

    // 事件上行到达运行时钩子，归属登记身份而非参数自称
    const events: { connectionId: string; event: { kind: string } }[] = [];
    t.runtime.onDesktopBrowserEvent = (connectionId, event) => events.push({ connectionId, event });
    await client.request("desktop_browser_event", { event: { session: "s1", kind: "gate", generation: 8, owned: false, source: "owner" } });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.connectionId, connectionId);
    assert.equal(events[0]!.event.kind, "gate");

    // 未登记的连接身份不被 callBrowser 接受
    await assert.rejects(t.runtime.desktopBrowserCall!("desktop-ghost", {}), (e: unknown) => (e as { code?: string }).code === "browser_unavailable");
    stranger.close();
    client.close();
  } finally {
    await t.shutdown();
  }
});

test("在途命令随连接断开按 disconnected 拒绝；应答帧错连不串话", async () => {
  const t = await startTestRuntime("browser-drop", routeResponder([]));
  try {
    const { client, connectionId } = await registeredClient(t.runtime);
    const other = await registeredClient(t.runtime);
    const stranger = await registeredClient(t.runtime);
    try {
      // 命令挂起（客户端不应答），关闭登记连接后在途请求按断线拒绝
      client.onCall(() => new Promise(() => {}));
      const pending = t.runtime.desktopBrowserCall!(connectionId, { op: "status", session: "s1" });
      client.close();
      await assert.rejects(pending, (e: unknown) => (e as { outcome?: string }).outcome === "disconnected");
      await assert.rejects(t.runtime.desktopBrowserCall!(connectionId, {}), (e: unknown) => (e as { code?: string }).code === "browser_unavailable");

      // 伪造应答帧：不存在的 id 与发在别的连接上的应答都被丢弃
      const strangerSocket = (stranger.client as unknown as { socket: { write(data: string): void } }).socket;
      strangerSocket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id: "call-999", ok: true, result: {} }));
      other.client.onCall(async () => ({ ok: true, value: { real: true } }));
      const real = t.runtime.desktopBrowserCall!(other.connectionId, { op: "status", session: "s2" });
      strangerSocket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id: "call-2", ok: true, result: { ok: true, value: { forged: true } } }));
      assert.deepEqual(await real, { ok: true, value: { real: true } });
      other.client.close();
      stranger.client.close();
    } catch (err) {
      other.client.close();
      stranger.client.close();
      throw err;
    }
  } finally {
    await t.shutdown();
  }
});

test("截图分块：乱序补齐、重复与篡改拒绝、迟到分块按 unknown_command", async () => {
  const t = await startTestRuntime("browser-chunk", routeResponder([]));
  try {
    const { client, connectionId } = await registeredClient(t.runtime);
    const bytes = Buffer.alloc(300 * 1024, 7); // 两块：256KiB + 44KiB
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    client.onCall(async (_op, _params, callId) => {
      // 先乱序发第二块再第一块，服务端按 index 装配
      const chunk = async (index: number) => client.request("desktop_browser_chunk", {
        command_id: callId, index, total: 2, total_bytes: bytes.length, sha256,
        data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString("base64"),
      });
      await chunk(1);
      await chunk(0);
      return { ok: true, value: { generation: 3, transfer: { kind: "screenshot", sha256, total_bytes: bytes.length, total: 2 } } };
    });
    const result = (await t.runtime.desktopBrowserCall!(connectionId, { op: "screenshot", session: "s1", generation: 3 })) as { ok: boolean; value: { transfer: { kind: string; data: Buffer } } };
    assert.equal(result.value.transfer.kind, "screenshot");
    assert.deepEqual(result.value.transfer.data, bytes);

    // 重复分块拒绝
    client.onCall(async (_op, _p, callId) => {
      await client.request("desktop_browser_chunk", { command_id: callId, index: 0, total: 1, total_bytes: 4, sha256: createHash("sha256").update("abcd").digest("hex"), data: "YWJjZA==" });
      await assert.rejects(client.request("desktop_browser_chunk", { command_id: callId, index: 0, total: 1, total_bytes: 4, sha256: createHash("sha256").update("abcd").digest("hex"), data: "YWJjZA==" }), (e: unknown) => (e as ControlClientError).code === "transfer_invalid");
      return { ok: true, value: { transfer: { kind: "screenshot", sha256: createHash("sha256").update("abcd").digest("hex"), total_bytes: 4, total: 1 } } };
    });
    const dup = (await t.runtime.desktopBrowserCall!(connectionId, { op: "screenshot", session: "s1" })) as { value: { transfer: { data: Buffer } } };
    assert.deepEqual(dup.value.transfer.data, Buffer.from("abcd"));

    // 内容被篡改：声明与字节不符 → 装配校验失败，效果未知
    client.onCall(async (_op, _p, callId) => {
      await client.request("desktop_browser_chunk", { command_id: callId, index: 0, total: 1, total_bytes: 4, sha256: createHash("sha256").update("abcd").digest("hex"), data: "eHh4eA==" });
      return { ok: true, value: { transfer: { kind: "screenshot", sha256: createHash("sha256").update("abcd").digest("hex"), total_bytes: 4, total: 1 } } };
    });
    await assert.rejects(t.runtime.desktopBrowserCall!(connectionId, { op: "screenshot", session: "s1" }), (e: unknown) => (e as { code?: string }).code === "transfer_corrupt");

    // 无传输声明的命令完成后再来分块 → unknown_command
    client.onCall(async () => ({ ok: true, value: { generation: 1 } }));
    await t.runtime.desktopBrowserCall!(connectionId, { op: "status", session: "s1" });
    await assert.rejects(client.request("desktop_browser_chunk", { command_id: "call-stale", index: 0, total: 1, total_bytes: 0, sha256: "0".repeat(64), data: "" }), (e: unknown) => (e as ControlClientError).code === "unknown_command");
    client.close();
  } finally {
    await t.shutdown();
  }
});

test("任务来源归属：登记连接提交写入绑定，未登记连接与重放命中不写", async () => {
  const t = await startTestRuntime("browser-origin", routeResponder([]));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const { client, connectionId } = await registeredClient(t.runtime);
    const submit = (requestId: string) => client.request<Record<string, unknown>>("submit", { model_selection: MODEL, session_id: sessionId, request_id: requestId, input: "hello" });
    const task = (await submit("req-browser-1")) as { id: string };
    assert.deepEqual(t.runtime.store.getTaskBrowserBinding(task.id), { connectionId });

    // 普通连接提交不绑定
    const plain = (await t.client.request<Record<string, unknown>>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "req-plain", input: "hi" })) as { id: string };
    assert.equal(t.runtime.store.getTaskBrowserBinding(plain.id), null);

    // 幂等重放命中旧任务不偷换绑定
    const dup = (await submit("req-browser-1")) as { id: string };
    assert.equal(dup.id, task.id);
    assert.deepEqual(t.runtime.store.getTaskBrowserBinding(task.id), { connectionId });
    client.close();
  } finally {
    await t.shutdown();
  }
});
