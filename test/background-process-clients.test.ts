import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { BackgroundEndGuard } from "@ruukoto/control/background-end.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import type { BackgroundProcessView } from "@ruukoto/core/background-processes.ts";
import { BackgroundProcesses } from "@ruukoto/tui/tui/background-processes.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { DesktopBackgroundProcesses } from "../apps/desktop/src/renderer/background-processes.ts";
import { DesktopSubmissions } from "../apps/desktop/src/main/submissions.ts";
import { ipcResult } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge } from "../apps/desktop/src/shared/bridge.ts";
import { FakeTransport, fakeSnapshot } from "./helpers/fake-control.ts";

const at = "2026-10-21T00:00:00.000Z";
function processView(extra: Partial<BackgroundProcessView> = {}): BackgroundProcessView {
  return { id: "background", sessionId: "session", taskId: "source", command: "serve --host 127.0.0.1", source: { kind: "coding-owner", accessMode: "full_access" }, state: "running", exit: null, stopVerified: false, reason: null, stdoutBytes: 6, stderrBytes: 3, partial: false, createdAt: at, updatedAt: at, version: 1, ...extra };
}
async function settle(): Promise<void> { for (let index = 0; index < 4; index++) await new Promise<void>(resolve => setImmediate(resolve)); }
function harness(options: { loseEnd?: boolean; refreshDuringAction?: boolean } = {}) {
  const pending = new PendingRequestStore(fs.mkdtempSync(path.join(os.tmpdir(), "background-client-")));
  let process = processView(), endCalls = 0, sessionId = "session", instanceId = "inst-1";
  const endKeys: string[] = [];
  const transport = new FakeTransport({ handlers: {
    background_processes: params => ({ processes: params.session_id === "session" ? [process] : [], totalCount: 1, nextOffset: null }),
    background_process_output: params => ({ text: params.offset ? "尾" : "首", base64: Buffer.from(params.offset ? "尾" : "首").toString("base64"), offset: params.offset ?? 0, nextOffset: (params.offset ?? 0) + 3, totalBytes: 6, partial: false }),
    background_process_stop: async params => { assert.equal(params.process_id, process.id); process = { ...process, state: "stop_requested", version: process.version + 1 }; if (options.refreshDuringAction) await panel.refresh(); return process; },
    session_background_end: async params => {
      endKeys.push(params.request_id); endCalls++;
      assert.equal(pending.list().records[0]?.requestId, params.request_id, "关闭键必须先落盘再发送");
      if (options.loseEnd && endCalls === 1) throw new ControlClientError("request_timeout", "应答丢失", "unknown");
      process = { ...process, state: "stopped", stopVerified: true, version: process.version + 1 };
      if (options.refreshDuringAction) await panel.refresh();
      return { processes: [process], stopVerified: true };
    },
  } });
  const request = transport.request.bind(transport);
  let closed = 0;
  const makePanel = () => new BackgroundProcesses({ request, pending, sessionId: () => sessionId, instanceId: () => instanceId, online: () => true, render: () => {}, close: () => { closed++; } });
  const panel = makePanel();
  const connection = { instanceId, request };
  const submissions = new DesktopSubmissions(pending, () => connection, () => {}, request);
  const bridge: Pick<DesktopBridge, "request"> = { request: async (_target, op, params) => op === "session_background_end" ? ipcResult(() => submissions.endBackground(params)) : ipcResult(() => request(op as "background_processes", params as { session_id: string })) };
  const view = new ViewState();
  view.applySnapshot({ snapshot: fakeSnapshot({ backgroundProcesses: [process] }), replay: [], seq: 0 }, false);
  const desktop = new DesktopBackgroundProcesses(bridge, view, () => true, () => {});
  return { pending, transport, panel, desktop, view, request, bridge, submissions, makePanel, endKeys, get process() { return process; }, get endCalls() { return endCalls; }, get closed() { return closed; }, selectSession(id: string) { sessionId = id; }, selectInstance(id: string) { instanceId = id; }, cleanup() { fs.rmSync(pending.dir, { recursive: true, force: true }); } };
}
const draw = (panel: BackgroundProcesses) => stripVTControlCharacters(panel.render(100).join("\n"));
async function press(panel: BackgroundProcesses, key: string): Promise<void> { panel.handleInput(key); await settle(); }

test("TUI 后台按程序持有的引用选取，stdout/stderr 字节分页保留原始内容", async () => {
  const h = harness();
  try {
    await h.panel.refresh(); await press(h.panel, "\r"); await press(h.panel, "\r");
    assert.match(draw(h.panel), /stdout · 字节 0–3\/6/); assert.match(draw(h.panel), /首/);
    await press(h.panel, "\r");
    assert.match(draw(h.panel), /字节 3–6\/6/); assert.match(draw(h.panel), /尾/);
    await press(h.panel, "\r");
    assert.match(draw(h.panel), /字节 0–3\/6/);
    await press(h.panel, "\x1b[B"); await press(h.panel, "\r");
    assert.match(draw(h.panel), new RegExp(Buffer.from("首").toString("base64")));
    await press(h.panel, "\x1b"); await press(h.panel, "\x1b[B"); await press(h.panel, "\r");
    const logs = h.transport.requests.filter(request => request.op === "background_process_output");
    assert.deepEqual(logs.map(request => request.params), [
      { session_id: "session", process_id: "background", stream: "stdout", offset: 0 },
      { session_id: "session", process_id: "background", stream: "stdout", offset: 3 },
      { session_id: "session", process_id: "background", stream: "stdout", offset: 0 },
      { session_id: "session", process_id: "background", stream: "stderr", offset: 0 },
    ]);
  } finally { h.cleanup(); }
});

test("TUI 停止接纳不冒充停止完成，关闭面板没有停止副作用", async () => {
  const h = harness();
  try {
    await h.panel.refresh(); await press(h.panel, "\r"); await press(h.panel, "\x1b[B"); await press(h.panel, "\x1b[B"); await press(h.panel, "\r");
    assert.match(draw(h.panel), /停止核实中/); assert.doesNotMatch(draw(h.panel), /已核实停止/);
    await press(h.panel, "\x1b"); await press(h.panel, "\x1b");
    assert.equal(h.closed, 1); assert.equal(h.transport.requests.filter(request => request.op === "background_process_stop").length, 1); assert.equal(h.endCalls, 0);
  } finally { h.cleanup(); }
});

test("关闭应答丢失跨客户端恢复原键，刷新及重连查询不重发关闭", async () => {
  const h = harness({ loseEnd: true });
  try {
    const first = await new BackgroundEndGuard(h.pending, { instanceId: "inst-1", request: h.request }).end("session");
    assert.equal(first.kind, "pending"); const key = h.pending.list().records[0].requestId;
    const restored = h.makePanel(); await restored.refresh(); await press(restored, "r");
    assert.match(draw(restored), /重核原结束请求/); assert.equal(h.endCalls, 1);
    await press(restored, "\x1b[B"); await press(restored, "\x1b[B"); await press(restored, "\r"); await press(restored, "\r");
    assert.deepEqual(h.endKeys, [key, key]); assert.equal(h.pending.list().records.length, 0); assert.match(draw(restored), /本次结束请求涉及的后台已核实停止/);
  } finally { h.cleanup(); }
});

test("关闭持久记录失败零发送；其他实例的原关闭不在新实例重放", async () => {
  const h = harness({ loseEnd: true });
  try {
    h.pending.save = () => { throw new Error("disk unavailable"); };
    await assert.rejects(new BackgroundEndGuard(h.pending, { instanceId: "inst-1", request: h.request }).end("session"), { code: "pending_write_failed", outcome: "not_sent" });
    assert.equal(h.endCalls, 0);
    const record = { requestId: "old", op: "session_background_end" as const, params: { session_id: "session", request_id: "old" }, instanceId: "old-instance", createdAt: at };
    PendingRequestStore.prototype.save.call(h.pending, record);
    await h.submissions.reconcile(); assert.equal(h.endCalls, 0); assert.equal(h.pending.list().records.length, 1);
  } finally { h.cleanup(); }
});

test("Desktop 日志按原字节位置分页，停止只接纳，关闭窗口/断开不结束后台", async () => {
  const h = harness();
  try {
    h.desktop.open("session"); await settle(); h.desktop.select(h.process); await settle();
    assert.equal(h.desktop.output?.base64, Buffer.from("首").toString("base64"));
    h.desktop.nextOutput(); await settle(); assert.equal(h.desktop.output?.offset, 3);
    h.desktop.previousOutput(); await settle(); assert.equal(h.desktop.output?.offset, 0);
    await h.desktop.read(0, "stderr"); assert.equal(h.desktop.stream, "stderr");
    await h.desktop.stop(h.process); assert.match(h.desktop.message ?? "", /已接纳/); assert.equal(h.desktop.selected?.state, "stop_requested");
    h.desktop.close(); h.desktop.update({ type: "state", state: "closed" });
    assert.equal(h.endCalls, 0); assert.equal(h.transport.requests.filter(request => request.op === "background_process_stop").length, 1);
  } finally { h.cleanup(); }
});

test("Desktop 关闭未知保留持久原键，重新打开只查询，显式重核不扩大关闭", async () => {
  const h = harness({ loseEnd: true });
  try {
    h.desktop.open("session"); h.desktop.endConfirm = true; await settle(); await h.desktop.end();
    const key = h.pending.list().records[0].requestId; assert.equal(h.desktop.pendingEnd?.requestId, key);
    h.desktop.close(); h.desktop.open("session"); await settle(); await h.submissions.reconcile();
    assert.equal(h.endCalls, 1); await h.desktop.end(); assert.deepEqual(h.endKeys, [key, key]); assert.equal(h.pending.list().records.length, 0);
  } finally { h.cleanup(); }
});

test("共享后台投影以快照恢复，旧版本事件不覆盖停止核实", () => {
  const view = new ViewState(), stopped = processView({ state: "stopped", stopVerified: true, version: 3 });
  view.applySnapshot({ snapshot: fakeSnapshot({ backgroundProcesses: [stopped] }), replay: [], seq: 5 }, false);
  view.applyEvent({ seq: 6, sessionId: "session", taskId: "source", createdAt: at, body: { type: "background_process.changed", process: processView({ version: 2 }) } }, "live");
  assert.equal(view.backgroundProcesses[0].stopVerified, true);
  view.applySnapshot({ snapshot: fakeSnapshot(), replay: [], seq: 7 }, true);
  assert.deepEqual(view.backgroundProcesses, []);
});

test("原关闭未知后重核未发送，仍保留旧键而不授权新关闭", async () => {
  const h = harness({ loseEnd: true });
  try {
    await new BackgroundEndGuard(h.pending, { instanceId: "inst-1", request: h.request }).end("session");
    const key = h.pending.list().records[0].requestId;
    const guard = new BackgroundEndGuard(h.pending, { instanceId: "inst-1", request: () => Promise.reject(new ControlClientError("closed", "重核未发出", "not_sent")) });
    const result = await guard.end("session", key);
    assert.equal(result.kind, "pending"); assert.equal(h.pending.list().records[0].requestId, key); assert.equal(h.endCalls, 1);
  } finally { h.cleanup(); }
});

test("损坏的关闭原记录可见并阻止换新键发送", async () => {
  const h = harness();
  try {
    fs.writeFileSync(path.join(h.pending.dir, "original.json"), "{");
    await assert.rejects(new BackgroundEndGuard(h.pending, { instanceId: "inst-1", request: h.request }).end("session"), { code: "pending_record_invalid", outcome: "not_sent" });
    assert.equal(h.endCalls, 0); assert.deepEqual(h.pending.list().corrupt, ["original.json"]);
  } finally { h.cleanup(); }
});

test("Desktop 迟到日志页不覆盖后来选择的会话或进程", async () => {
  const h = harness();
  try {
    let release: (() => void) | undefined;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const bridge: Pick<DesktopBridge, "request"> = { request: async (target, op, params) => {
      if (op === "background_process_output") await hold;
      return h.bridge.request(target, op, params);
    } };
    const desktop = new DesktopBackgroundProcesses(bridge, h.view, () => true, () => {});
    desktop.open("session"); await settle(); desktop.select(h.process);
    desktop.open("other-session"); release!(); await settle();
    assert.equal(desktop.sessionId, "other-session"); assert.equal(desktop.output, null);
  } finally { h.cleanup(); }
});

test("TUI持续输出刷新不丢日志响应，切换会话清除旧清单", async () => {
  const h = harness();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let sessionId = "session", online = true;
  const request: typeof h.request = async (op, params) => { if (op === "background_process_output") await hold; return h.request(op, params); };
  const panel = new BackgroundProcesses({ request, pending: h.pending, sessionId: () => sessionId, instanceId: () => "inst-1", online: () => online, render: () => {}, close: () => {} });
  try {
    await panel.refresh(); panel.handleInput("\r"); panel.handleInput("\r");
    await panel.refresh(); release(); await settle();
    assert.match(draw(panel), /首/); assert.doesNotMatch(draw(panel), /正在读取日志/);
    sessionId = "other"; online = false; await panel.refresh();
    assert.doesNotMatch(draw(panel), /serve --host/);
    h.desktop.open("session"); await settle(); assert.equal(h.desktop.processes.length, 1);
    h.desktop.open("other"); assert.equal(h.desktop.processes.length, 0); assert.equal(h.desktop.totalCount, 0); assert.equal(h.desktop.nextOffset, null);
  } finally { release(); h.cleanup(); }
});

test("原关闭记录目录不可读取时不生成新请求键", async t => {
  const h = harness({ loseEnd: true });
  try {
    await new BackgroundEndGuard(h.pending, { instanceId: "inst-1", request: h.request }).end("session");
    const key = h.pending.list().records[0].requestId;
    t.mock.method(fs, "readdirSync", () => { throw Object.assign(new Error("模拟目录不可读"), { code: "EACCES" }); });
    syncBuiltinESMExports();
    await assert.rejects(new BackgroundEndGuard(h.pending, { instanceId: "inst-1", request: h.request }).end("session"), { code: "pending_record_unavailable", outcome: "not_sent" });
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(h.endCalls, 1); assert.equal(h.pending.list().records[0].requestId, key);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); h.cleanup(); }
});


test("TUI结束后台保留当前状态页，上一页沿原游标返回", async () => {
  const h = harness(), offsets: number[] = [];
  const transport = new FakeTransport({ handlers: {
    background_processes: params => {
      const offset = params.offset ?? 0; offsets.push(offset);
      return { processes: [processView({ command: `状态页 ${offset}` })], totalCount: 6, nextOffset: offset === 0 ? 2 : offset === 2 ? 5 : null };
    },
    session_background_end: () => ({ processes: [], stopVerified: true }),
  } });
  const panel = new BackgroundProcesses({ request: transport.request.bind(transport), pending: h.pending, sessionId: () => "session", instanceId: () => "inst-1", online: () => true, render: () => {}, close: () => {} });
  const down = "\x1b[B";
  try {
    await panel.refresh(); await press(panel, down); await press(panel, "\r");
    await press(panel, down); await press(panel, down); await press(panel, "\r");
    await press(panel, down); await press(panel, down); await press(panel, down); await press(panel, "\r"); await press(panel, "\r");
    assert.deepEqual(offsets, [0, 2, 5, 5]);
    assert.match(draw(panel), /状态页 5/);
    await press(panel, down); await press(panel, "\r");
    await press(panel, down); await press(panel, "\r");
    assert.deepEqual(offsets, [0, 2, 5, 5, 2, 0]);
  } finally { h.cleanup(); }
});


test("TUI重连成功清除查询故障提示，保留后续停止结果", async () => {
  const h = harness();
  let online = false;
  const panel = new BackgroundProcesses({ request: h.request, pending: h.pending, sessionId: () => "session", instanceId: () => "inst-1", online: () => online, render: () => {}, close: () => {} });
  try {
    await panel.refresh();
    assert.match(draw(panel), /等待连接恢复/);
    online = true; await panel.refresh();
    assert.doesNotMatch(draw(panel), /等待连接恢复/);
    await press(panel, "\r"); await press(panel, "\x1b[B"); await press(panel, "\x1b[B"); await press(panel, "\r");
    assert.match(draw(panel), /停止请求已接纳/);
    await panel.refresh();
    assert.match(draw(panel), /停止请求已接纳/);
  } finally { h.cleanup(); }
});


test("TUI实时状态刷新不丢失在途停止和结束请求的结果", async () => {
  const h = harness({ refreshDuringAction: true });
  try {
    await h.panel.refresh(); await press(h.panel, "\r"); await press(h.panel, "\x1b[B"); await press(h.panel, "\x1b[B"); await press(h.panel, "\r");
    assert.match(draw(h.panel), /停止请求已接纳/);
    assert.doesNotMatch(draw(h.panel), /正在登记停止/);
    await press(h.panel, "\x1b"); await press(h.panel, "\x1b[B"); await press(h.panel, "\x1b[B"); await press(h.panel, "\r"); await press(h.panel, "\r");
    assert.match(draw(h.panel), /本次结束请求涉及的后台已核实停止/);
  } finally { h.cleanup(); }
});
