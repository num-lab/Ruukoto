import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { PersonalDesktopFrame } from "@ruukoto/view/personal-protocol.ts";
import type { DesktopBridge, DesktopResult, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { PersonalState } from "../apps/desktop/src/renderer/personal-state.ts";
import { PersonalConnectionState } from "../apps/desktop/src/renderer/personal-connection-state.ts";
import { SettingsState } from "../apps/desktop/src/renderer/settings-state.ts";

const ok = (value: unknown): DesktopResult<unknown> => ({ ok: true, value });
const identity = { v: 1, product: "ruukoto", remoteId: "remote", origin: "https://pa.example", profile: { id: "profile", directory: "/private/pa" }, online: true, runId: "run" } as const;
function snapshot(seq = 0): PersonalDesktopFrame { return { v: 1, runId: "run", subscription: "subscription", seq, type: "snapshot", timeline: { through: 1, items: [{ entry: 1, conversation: 0, kind: "pi.user", role: "user", text: "原输入", partial: false, truncated: false, timestamp: 1 }], nextCursor: "older" }, live: { tools: [], toolCount: 0, inbox: [], inboxCount: 0 } }; }
function fixture(request: DesktopBridge["request"] = async (_target, op, params) => op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null)) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const state = new PersonalState({ request: async (target, op, params) => { calls.push({ op, params }); return request(target, op, params); } }, () => {});
  state.update({ type: "personal_identity", identity }); state.update({ type: "state", state: "online" }); state.frame(snapshot());
  return { state, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
let server: ViteDevServer, Chat: ComponentType<{ model: PersonalState; onConnect: () => void }>;
before(async () => { server = await createServer({ configFile: false, root: "apps/desktop/src/renderer", server: { middlewareMode: true, hmr: false }, esbuild: { jsx: "automatic" } }); ({ PersonalChat: Chat } = await server.ssrLoadModule("/personal-chat.tsx")); });
after(async () => { await server?.close(); });

test("PA原生状态：块替换不重复文字，原entry去重，旧订阅和断序不能推进当前投影", async t => {
  const { state, calls } = fixture(); t.after(() => state.dispose()); await settle();
  const frame = snapshot(); assert.equal(frame.type, "snapshot");
  frame.live.generation = { attempt: 1, message: { role: "assistant", text: "甲乙", partial: true, truncated: false, timestamp: 1, blocks: [{ index: 0, type: "text", text: "甲", truncated: false }, { index: 1, type: "text", text: "乙", truncated: false }] } };
  state.frame(frame);
  state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "message_update", changes: [{ type: "text_delta", contentIndex: 1, delta: "丙", truncated: false }, { type: "block", contentIndex: 1, block: { type: "text", text: "乙丙", truncated: false } }] }] });
  assert.equal(state.activeMessage?.text, "甲\n乙丙");
  const entry = { entry: 2, conversation: 0, kind: "pi.assistant", role: "assistant" as const, text: "甲乙丙", partial: false, truncated: false, timestamp: 2 };
  const completed: PersonalDesktopFrame = { v: 1, runId: "run", subscription: "subscription", seq: 2, type: "events", events: [{ type: "message_end", entry }] };
  state.frame(completed); state.frame(completed);
  assert.equal(state.timeline.length, 2); assert.equal(state.activeMessage, undefined);
  state.frame({ ...completed, subscription: "old", seq: 3 }); assert.equal(state.ready, true);
  state.frame({ ...completed, seq: 4 }); assert.equal(state.ready, false); assert.ok(calls.some(value => value.op === "reconnect"));
});

test("PA原生历史：原切点分页与长正文完整保留，档案变化后不采用迟到页或发原草稿", async t => {
  let resolve!: (value: DesktopResult<unknown>) => void;
  const f = fixture(async (_target, op, params) => {
    if (op === "desktop_personal_request" && String(params.path).startsWith("/timeline")) return new Promise(done => { resolve = done; });
    if (op === "desktop_personal_request" && String(params.path).startsWith("/history/entry")) { const offset = Number(new URL(String(params.path), "https://pa.example").searchParams.get("offset")); return ok({ entry: 1, offset, text: offset ? "后文" : "长正文", ...(offset ? {} : { nextOffset: 3 }) }); }
    return op === "desktop_personal_request" ? String(params.path) === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose());
  await f.state.body(1); assert.equal(f.state.bodies.get(1), "长正文后文");
  f.state.edit("原档案草稿"); f.state.live.generation = { attempt: 1, message: { role: "assistant", text: "原档案流式内容", partial: true, truncated: false, timestamp: 1 } }; const reading = f.state.older();
  f.state.update({ type: "personal_identity", identity: { ...identity, remoteId: "another", profile: { ...identity.profile, id: "another-profile" } } });
  resolve(ok({ through: 1, items: [{ entry: 9, text: "迟到消息" }] })); await reading;
  assert.equal(f.state.entries.size, 0); assert.equal(f.state.activeMessage, undefined); assert.equal(f.state.draft, "原档案草稿"); assert.equal(f.state.draftMismatch, true); assert.equal(f.state.canSend, false);
});

test("PA原生输入：发出后丢答只核实，明确恢复仍由宿主持有原请求，不提交第二份正文", async t => {
  const f = fixture(async (_target, op, params) => {
    if (op === "desktop_personal_input_submit") return { ok: false, error: { code: "disconnected", outcome: "unknown", message: "待核实" } };
    if (op === "desktop_personal_input_reconcile") return ok({ kind: "missing", requestId: "original" });
    if (op === "desktop_personal_input_restore") return ok({ kind: "accepted", requestId: "original", status: "queued" });
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose());
  await settle(); f.state.edit("原正文"); await f.state.send();
  f.state.update({ type: "personal_pending", record: { ...identity, requestId: "original", input: "原正文" } });
  await f.state.reconcile(); assert.equal(f.state.pendingResult?.kind, "missing"); assert.equal(f.state.canSend, false);
  await f.state.send(); assert.equal(f.calls.filter(value => value.op === "desktop_personal_input_submit").length, 1);
  await f.state.reconcile(true); assert.equal(f.state.pending, null); assert.equal(f.state.draft, "");
  assert.deepEqual(f.calls.find(value => value.op === "desktop_personal_input_restore")?.params, {});
});

test("PA原生补查：运行或未决问题无模型事件仍单飞刷新，断开停止轮询", async t => {
  let reads = 0, resolve!: (value: DesktopResult<unknown>) => void;
  const f = fixture(async (_target, op, params) => {
    if (op === "desktop_personal_request" && String(params.path).startsWith("/questions")) { reads++; return reads > 1 ? new Promise(done => { resolve = done; }) : ok({ items: [{ id: "1", version: 1, status: "pending", question: "原问题", canAnswer: false, canCancel: true }] }); }
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.dispose(); t.mock.timers.enable({ apis: ["setInterval"] }); f.state.start(); t.mock.timers.tick(5000); await settle(); assert.equal(reads, 2);
  t.mock.timers.tick(20_000); await settle(); assert.equal(reads, 2);
  f.state.update({ type: "state", state: "reconnecting" }); resolve(ok({ items: [] })); await settle();
  t.mock.timers.tick(20_000); assert.equal(reads, 2); t.mock.timers.reset();
});

test("PA写动作：IM问题可取消不代答，审批须读完原记录，工作取消不停止主后台", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  f.state.question = { id: "1", version: 3, status: "pending", questions: [{ question: "原IM问题" }], origin: { telegram: {} } }; f.state.answers = [{ text: "不应代答" }];
  await f.state.answerQuestion(); assert.equal(f.calls.some(call => call.params.path === "/question/answer"), false);
  await f.state.answerQuestion(true); const cancel = f.calls.find(call => call.params.path === "/question/cancel"); assert.ok(cancel); assert.equal((cancel.params.body as { version: number }).version, 3);
  const approval = { kind: "tools" as const, key: "tools:12", operation: 12, canDecide: false };
  f.state.approval = { value: approval, text: "原参数", complete: true }; await f.state.decide("approved");
  assert.equal(f.calls.some(call => call.params.path === "/tools/decide"), false);
  f.state.approval.value.canDecide = true; f.state.approval.complete = false; await f.state.decide("approved"); assert.equal(f.calls.some(call => call.params.path === "/tools/decide"), false);
  f.state.approval.complete = true; await f.state.decide("approved"); assert.deepEqual(f.calls.find(call => call.params.path === "/tools/decide")?.params.body, { decision: "approved", operation: 12 });
  await f.state.cancelWork({ ref: { taskId: 25, agentId: 2, requestId: "original-work" }, label: "原工作", content: "说明", state: "running", cancelRequested: false, stopVerified: false, closed: false });
  assert.ok(f.calls.some(call => call.params.path === "/work/cancel?work=25")); assert.equal(f.calls.some(call => call.params.path === "/stop"), false);
  f.state.edit("字".repeat(6000)); await f.state.send(); assert.equal(f.calls.some(call => call.op === "desktop_personal_input_submit"), false);
});

test("PA统一连接：只存规范origin，先核实未知保存，配对码提交后清空且不自动重配", async () => {
  let current: unknown = null;
  const calls: string[] = [];
  const state = new PersonalConnectionState({ request: async (_target, op, params) => {
    calls.push(op);
    if (op === "desktop_personal_legacy_read") return ok({ paths: [] });
    if (op === "desktop_personal_config_read") return ok(current);
    if (op === "desktop_personal_config_save") { current = { v: 1, origin: params.origin }; return { ok: false, error: { code: "lost", outcome: "unknown", message: "应答丢失" } }; }
    return { ok: false, error: { code: "lost", outcome: "unknown", message: "配对待核实" } };
  } }, () => {});
  await state.read(); state.edit("origin", "https://server.example/path"); assert.equal(await state.save(), false); assert.ok(state.fieldErrors.origin);
  state.edit("origin", "https://server.example/"); assert.equal(await state.save(), false); assert.equal(state.phase, "unknown");
  assert.equal(await state.save(), false); await state.read(); assert.equal(state.draft.origin, "https://server.example");
  state.code = "ABCDEF234567"; state.label = "此桌面"; await state.pair(); assert.equal(state.code, ""); assert.equal(state.phase, "unknown");
  assert.equal(calls.filter(op => op === "desktop_personal_pair").length, 1); await state.pair("reconcile"); await state.pair("restore");
  assert.deepEqual(calls.filter(op => op.startsWith("desktop_personal_pair")), ["desktop_personal_pair", "desktop_personal_pair_reconcile", "desktop_personal_pair_restore"]);
});

test("PA视图：原生聊天复用消息与trace，附件/停止/Continue/Context/会话模型不出现", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  f.state.live.tools = [{ callId: "tool", name: "read_file", status: "running", output: "片段", truncated: true }]; f.state.live.toolCount = 1;
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  assert.match(markup, /原输入/); assert.match(markup, /read_file/); assert.match(markup, /发送个人消息/); assert.match(markup, /新输入的默认权限/);
  assert.doesNotMatch(markup, /附加文件|停止任务|发送并继续|Context|会话模型|Plan/);
  const settings = new SettingsState(() => {}); settings.show("personal", "pa-models"); let invalidated = false;
  settings.form = { dirty: true, phase: "ready", async save() { return true; }, discard() {}, invalidate() { invalidated = true; } };
  settings.observe("personal", { type: "personal_identity", identity } satisfies DesktopUpdate); assert.equal(invalidated, true); assert.equal(settings.form.dirty, true);
});
