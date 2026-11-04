import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { PersonalDesktopApproval, PersonalDesktopFrame, PersonalDesktopState } from "@ruukoto/view/personal-protocol.ts";
import type { DesktopBridge, DesktopResult, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { PersonalState } from "../apps/desktop/src/renderer/personal-state.ts";
import { PersonalConnectionState } from "../apps/desktop/src/renderer/personal-connection-state.ts";
import { SettingsState } from "../apps/desktop/src/renderer/settings-state.ts";

const ok = (value: unknown): DesktopResult<unknown> => ({ ok: true, value });
const identity = { v: 1, product: "ruukoto", remoteId: "remote", origin: "https://pa.example", profile: { id: "profile", directory: "/private/pa" }, online: true, runId: "run" } as const;
function snapshot(seq = 0): Extract<PersonalDesktopFrame, { type: "snapshot" }> { return { v: 1, runId: "run", subscription: "subscription", seq, type: "snapshot", timeline: { through: 1, items: [{ entry: 1, conversation: 0, kind: "pi.user", role: "user", text: "原输入", partial: false, truncated: false, timestamp: 1 }], nextCursor: "older" }, live: { tools: [], toolCount: 0, inbox: [], inboxCount: 0 } }; }
function fixture(request: DesktopBridge["request"] = async (_target, op, params) => op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null)) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const state = new PersonalState({ request: async (target, op, params) => { calls.push({ op, params }); return request(target, op, params); } }, () => {});
  state.update({ type: "personal_identity", identity }); state.update({ type: "state", state: "online" }); state.frame(snapshot());
  return { state, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function card(operation = 12): PersonalDesktopApproval { return { operation, occurrence: operation + 100, admission: operation + 100, kind: "write_file", target: "/outside/result.txt", targetTruncated: false, observed: false, approval: "pending", started: false, stopped: true, effect: "not_executed", code: "approval_pending", canDecide: true }; }
function projection(revision: number, cards: PersonalDesktopApproval[] = []): PersonalDesktopState { return { v: 1, revision, approvals: { items: cards, total: cards.length }, works: { items: [], total: 0 }, delegations: { items: [], total: 0 } }; }
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

test("PA视图：完整消息按角色气泡分组，流式片段与trace不显示，输入区保持精简", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  const timestamp = Date.UTC(2026, 0, 1, 9, 41);
  f.state.entries.set(2, { entry: 2, conversation: 0, kind: "pi.assistant", role: "assistant", text: "完整回复一", thinking: "隐藏思考", toolCalls: [{ id: "call", name: "read_file", arguments: "{}", truncated: false }], partial: false, truncated: false, timestamp: timestamp + 1000 });
  f.state.entries.set(3, { entry: 3, conversation: 0, kind: "pi.toolResult", role: "toolResult", text: "隐藏工具结果", partial: false, truncated: false, timestamp: timestamp + 2000 });
  f.state.entries.set(4, { entry: 4, conversation: 0, kind: "pi.assistant", role: "assistant", text: "完整回复二", partial: false, truncated: false, timestamp: timestamp + 3000 });
  f.state.entries.set(5, { entry: 5, conversation: 0, kind: "pi.assistant", role: "assistant", text: "", thinking: "空正文也不显示", partial: false, truncated: false, timestamp: timestamp + 4000 });
  f.state.live.generation = { attempt: 1, message: { role: "assistant", text: "流式片段", partial: true, truncated: false, timestamp: timestamp + 5000 } };
  f.state.live.tools = [{ callId: "tool", name: "read_file", status: "running", output: "片段", truncated: true }]; f.state.live.toolCount = 1;
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  assert.match(markup, /原输入/); assert.match(markup, /完整回复一/); assert.match(markup, /完整回复二/); assert.match(markup, /发送个人消息/); assert.match(markup, /aria-label="添加附件"/); assert.match(markup, /aria-description="PA 暂不支持附件"/); assert.match(markup, /rows="1"/);
  assert.doesNotMatch(markup, /read_file|流式片段|隐藏思考|隐藏工具结果|空正文也不显示|新输入的默认权限|停止任务|发送并继续|Context|会话模型|Plan/);
  assert.equal([...markup.matchAll(/class="personal-message-group /g)].length, 2);
  assert.equal([...markup.matchAll(/class="personal-message-time"/g)].length, 2);
  assert.equal([...markup.matchAll(/data-slot="bubble"/g)].length, 3);
  const settings = new SettingsState(() => {}); settings.show("personal", "pa-models"); let invalidated = false;
  settings.form = { dirty: true, phase: "ready", async save() { return true; }, discard() {}, invalidate() { invalidated = true; } };
  settings.observe("personal", { type: "personal_identity", identity } satisfies DesktopUpdate); assert.equal(invalidated, true); assert.equal(settings.form.dirty, true);
});

test("Native cards arrive in the timeline before prose and retain superseded exact content", async t => {
  const value = card(), text = JSON.stringify({ target: value.target, params: { path: value.target, content: "EXACT OLD CONTENT" } });
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/desktop/operation")) return ok({ v: 1, operation: value.operation, admission: value.admission, revision: 1, summary: value, offset: 0, text });
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "personal_state", state: projection(1, [value]) }] });
  await f.state.loadCard(value.operation);
  let markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  assert.match(markup, /EXACT OLD CONTENT/); assert.match(markup, /批准本次/); assert.doesNotMatch(markup, /核实原操作/);
  const terminal = { ...value, approval: "approved" as const, observed: true, canDecide: false, code: "tool_requirements_changed", notice: "要求已更新，这项旧操作没有执行。" };
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 2, type: "events", events: [{ type: "personal_state", state: projection(2, [terminal]) }, { type: "entry_appended", entry: { entry: 200, conversation: 0, kind: "pi.assistant", role: "assistant", text: "Later completed prose", timestamp: 2, partial: false, truncated: false } }] });
  markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  assert.ok(markup.indexOf("EXACT OLD CONTENT") < markup.indexOf("Later completed prose"));
  assert.match(markup, /要求已更新，这项旧操作没有执行/); assert.doesNotMatch(markup, /批准本次|拒绝本次/);
  assert.equal(f.state.cards.get(value.occurrence)?.approval, "approved");
  f.state.edit("Amend or query while external work waits"); assert.equal(f.state.canSend, true);
});

test("Presence distinguishes main processing, decisions, work and reporting with independently paged members", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  const value = card(), work = { ref: { taskId: 20, agentId: 2, requestId: "assignment" }, label: "File work", content: "Original owner request", state: "running", cancelRequested: false, stopVerified: false, closed: false, delegation: 7, progress: { accepted: 2, modelRead: 2, completed: 0, accounted: 0 } };
  const group = { ref: { entryId: 7 }, content: work.content, state: "reporting", cancelRequested: false, total: 1, active: 1, unverified: 0, paused: false };
  f.state.works = [work]; f.state.delegations = [group]; f.state.cards.set(value.occurrence, value);
  assert.equal(f.state.presence, "等待你的决定");
  f.state.live.run = { inputs: [1], total: 1 }; assert.equal(f.state.presence, "正在处理");
  f.state.live.inboxCount = 1; assert.equal(f.state.presence, "消息已接纳，等待处理");
  f.state.live.inboxCount = 0; delete f.state.live.run; f.state.cards.clear(); assert.equal(f.state.presence, "工作进行中");
  f.state.works = []; assert.equal(f.state.presence, "工作进行中");
  group.active = 0; assert.equal(f.state.presence, "正在准备结果");
  group.cancelRequested = true; group.unverified = 1; group.state = "stop_unverified"; assert.equal(f.state.presence, "已请求取消，正在核实停止");
  group.unverified = 0; group.state = "canceled"; assert.equal(f.state.presence, null);
});

test("Delegation layout shows each member once and retains off-page work and whole-assignment cancellation", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  const work = { ref: { taskId: 20, agentId: 2, requestId: "assignment" }, label: "Visible member", content: "Repeated owner content", state: "running", cancelRequested: false, stopVerified: false, closed: false, delegation: 7, progress: { accepted: 2, modelRead: 1, completed: 0, accounted: 0 } };
  f.state.works = [work, { ...work, ref: { ...work.ref, taskId: 21 }, delegation: 9, label: "Off-page group member" }, { ...work, ref: { ...work.ref, taskId: 22 }, delegation: undefined, label: "Standalone work" }];
  f.state.delegations = [{ ref: { entryId: 7 }, content: work.content, state: "reporting", cancelRequested: false, total: 1, active: 1, unverified: 0, paused: false }, { ref: { entryId: 8 }, content: "Assignment without loaded members", state: "active", cancelRequested: false, total: 1, active: 1, unverified: 0, paused: false }];
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  for (const label of ["Visible member", "Off-page group member", "Standalone work", "Assignment without loaded members"]) assert.equal(markup.split(label).length - 1, 1);
  assert.doesNotMatch(markup, /Repeated owner content|正在准备结果/);
  assert.equal(markup.split("取消整项工作").length - 1, 2); assert.equal(markup.split("取消此工作").length - 1, 1);
  assert.equal(markup.split("查看状态").length - 1, 3); assert.equal(markup.split("已接纳").length - 1, 3);
});

test("Cancellation rejection remains visible while another pending card is inspected", async t => {
  const value = card(), group = { ref: { entryId: 7 }, content: "Original assignment", state: "reporting", cancelRequested: false, total: 1, active: 1, unverified: 0, paused: false }; let rejected = true;
  const f = fixture(async (_target, op, params) => {
    if (params.path === "/delegation/cancel?delegation=7") return rejected ? { ok: false, error: { code: "remote_request_invalid", outcome: "rejected", message: "Cancellation was not accepted" } } : ok({ cancelRequested: true });
    if (params.path === "/desktop/state") return ok({ ...projection(2, [value]), delegations: { items: [group], total: 1 } });
    if (String(params.path).startsWith("/desktop/operation")) return ok({ v: 1, operation: value.operation, admission: value.admission, revision: 2, summary: value, offset: 0, text: JSON.stringify({ target: value.target, params: { path: value.target, content: "Exact" } }) });
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: { ...projection(1, [value]), delegations: { items: [group], total: 1 } } });
  await f.state.cancelDelegation(group); await f.state.loadCard(value.operation);
  assert.equal(f.state.message, "Cancellation was not accepted"); assert.equal(f.state.delegations[0].cancelRequested, false);
  rejected = false; await f.state.cancelDelegation(group); assert.equal(f.state.message, null);
});

test("A lost native decision inspects its canonical operation and stays locked through failed reads and reconnect", async t => {
  const value = card(); let summary = value, lost = false, inspectionFails = false, posts = 0;
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/desktop/operation")) return inspectionFails ? { ok: false, error: { code: "read_lost", outcome: "not_sent", message: "Inspection failed" } } : ok({ v: 1, operation: value.operation, admission: value.admission, revision: 4, summary, offset: 0, text: JSON.stringify({ target: value.target, params: { path: value.target, content: "One write" } }) });
    if (params.path === "/tools/decide") { posts++; lost = true; inspectionFails = true; return { ok: false, error: { code: "response_lost", outcome: "unknown", message: "Decision response lost" } }; }
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(1, [value]) }); await f.state.loadCard(value.operation);
  await f.state.decideCard(value, "approved"); assert.equal(lost, true); assert.equal(posts, 1);
  assert.equal(f.state.uncertainDecisions.has(value.operation), true); assert.ok(f.state.cards.has(value.occurrence));
  f.state.frame({ ...snapshot(), state: projection(4, [value]) }); await f.state.decideCard(value, "approved"); assert.equal(posts, 1);
  inspectionFails = false; summary = { ...value, approval: "approved", canDecide: false };
  await f.state.loadCard(value.operation); assert.equal(f.state.uncertainDecisions.has(value.operation), false);
  assert.equal(f.state.cards.get(value.occurrence)?.approval, "approved"); await f.state.decideCard(value, "approved"); assert.equal(posts, 1);
});

test("Immutable detail pages survive newer canonical states and an untouched old card is inspected on reconnect", async t => {
  const value = card(), text = JSON.stringify({ target: value.target, params: { path: value.target, content: "Long current content" } }); let release!: (value: DesktopResult<unknown>) => void, hold = true;
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/desktop/operation")) {
      if (hold) return new Promise(resolve => { release = resolve; });
      return ok({ v: 1, operation: value.operation, admission: value.admission, revision: 10, summary: value, offset: 0, text });
    }
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(1, [value]) }); const reading = f.state.loadCard(value.operation);
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "personal_state", state: projection(2, [{ ...value, approval: "approved", canDecide: false }]) }] });
  release(ok({ v: 1, operation: value.operation, admission: value.admission, revision: 1, summary: value, offset: 0, text })); await reading;
  assert.equal(f.state.details.get(value.operation)?.complete, true); assert.equal(f.state.cards.get(value.occurrence)?.canDecide, false);
  hold = false; f.state.frame({ ...snapshot(), state: projection(10, []) }); await settle();
  assert.equal(f.state.refreshingCards.has(value.operation), false); assert.equal(f.state.uncertainDecisions.has(value.operation), false); assert.equal(f.state.cards.get(value.occurrence)?.canDecide, true);
});

test("A same-run reconnect replaces a held detail read without letting the old request erase the new load", async t => {
  const value = card(), text = JSON.stringify({ target: value.target, params: { path: value.target, content: "Current" } });
  const reads: ((value: DesktopResult<unknown>) => void)[] = [];
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/desktop/operation")) return new Promise(resolve => { reads.push(resolve); });
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(1, [value]) }); const old = f.state.loadCard(value.operation);
  f.state.update({ type: "state", state: "reconnecting" }); f.state.update({ type: "personal_identity", identity }); f.state.update({ type: "state", state: "online" });
  f.state.frame({ ...snapshot(), state: projection(2, [value]) }); const current = f.state.loadCard(value.operation);
  assert.equal(reads.length, 2);
  reads[0](ok({ v: 1, operation: value.operation, admission: value.admission, revision: 1, summary: value, offset: 0, text })); await old;
  const joined = f.state.loadCard(value.operation); assert.equal(reads.length, 2);
  reads[1](ok({ v: 1, operation: value.operation, admission: value.admission, revision: 2, summary: value, offset: 0, text })); await current;
  await joined;
  assert.equal(f.state.details.get(value.operation)?.complete, true);
});

test("An accepted receipt preserves the complete owner bubble under both RPC and stream ordering", async t => {
  for (const streamFirst of [false, true]) {
    let receipt!: (value: DesktopResult<unknown>) => void;
    const f = fixture(async (_target, op, params) => op === "desktop_personal_input_submit" ? new Promise(resolve => { receipt = resolve; }) : op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null));
    t.after(() => f.state.dispose()); await settle(); const text = "Owner text 🙂 ".repeat(550);
    f.state.edit(text); const sending = f.state.send();
    const entry = { entry: 10, conversation: 0, kind: "ruukoto.owner-input-display", role: "user" as const, text: text.slice(0, 4096), partial: false, truncated: true, timestamp: 1, input: { requestId: "original", submission: 11, status: "queued" as const } };
    if (streamFirst) f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "entry_appended", entry }] });
    receipt(ok({ kind: "accepted", requestId: "original", status: "queued" })); await sending;
    assert.equal(f.state.draft, ""); assert.equal(f.state.timeline.filter(entry => entry.requestKey === "original").length, 1);
    if (!streamFirst) { assert.equal(f.state.timeline.find(entry => entry.requestKey === "original")?.text, text); f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "entry_appended", entry }] }); }
    assert.equal(f.state.bodies.get(10), text); assert.equal(f.state.timeline.filter(entry => entry.requestKey === "original").length, 1);
  }
});

test("A pending owner message stays before later child cards and late legacy work queries cannot replace grouped state", async t => {
  let release!: (value: DesktopResult<unknown>) => void;
  const f = fixture(async (_target, op, params) => String(params.path).startsWith("/works") ? new Promise(resolve => { release = resolve; }) : op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null));
  t.after(() => f.state.dispose()); await settle();
  f.state.update({ type: "personal_pending", record: { v: 1, origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, requestId: "owner", input: "New requirement" } });
  const anchor = f.state.timeline.find(entry => entry.requestKey === "owner")!.entry, value = card(3);
  const work = { ref: { taskId: 20, agentId: 2, requestId: "assignment" }, label: "Current work", content: "One assignment", state: "running", cancelRequested: false, stopVerified: false, closed: false, delegation: 7, progress: { accepted: 2, modelRead: 1, completed: 0, accounted: 0 } };
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "personal_state", state: { ...projection(1, [value]), works: { items: [work], total: 1 } } }] });
  assert.equal(f.state.timeline.find(entry => entry.requestKey === "owner")?.entry, anchor); assert.ok(anchor < value.occurrence);
  const { delegation: _delegation, progress: _progress, ...legacy } = work;
  release(ok({ items: [legacy] })); await settle();
  assert.equal(f.state.works[0].delegation, 7); assert.deepEqual(f.state.works[0].progress, work.progress);
});

test("Write cards display the full resolved target and clearly identify an empty replacement", async t => {
  const target = `/outside/${"segment/".repeat(70)}EXACT-TAIL.txt`, value = { ...card(), target: target.slice(0, 512), targetTruncated: true };
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(1, [value]) });
  f.state.details.set(value.operation, { admission: value.admission, text: JSON.stringify({ target, params: { path: "/short-alias/result", content: "" } }), complete: true });
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  assert.match(markup, /EXACT-TAIL\.txt/); assert.match(markup, /文件内容将清空/); assert.match(markup, /批准本次/);
});

test("Restored host decisions lock cards and legacy modal decisions inspect canonical state after reply loss", async t => {
  let summary = { operation: 12, canDecide: true, decision: "pending" }, posts = 0;
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/mcp/operation")) return ok({ summary, text: "Original exact MCP request" });
    if (String(params.path).startsWith("/mcp/decide")) { posts++; return { ok: false, error: { code: "response_lost", outcome: "unknown", message: "Decision response lost" } }; }
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  const value = card(); f.state.update({ type: "personal_decisions", items: [{ kind: "tools", operation: 12, decision: "approved" }] });
  f.state.frame({ ...snapshot(), state: projection(1, [value]) }); assert.equal(f.state.uncertainDecisions.has(12), true);
  const modal = { kind: "mcp" as const, key: "mcp:12", ...summary };
  await f.state.selectApproval(modal); await f.state.decide("approved");
  assert.equal(posts, 1); assert.equal(f.state.approval?.value.key, modal.key); assert.equal(f.state.uncertainApprovals.has(modal.key), true);
  await f.state.decide("approved"); assert.equal(posts, 1);
  summary = { operation: 12, canDecide: false, decision: "approved" }; await f.state.selectApproval(modal);
  assert.equal(f.state.approval?.value.canDecide, false); assert.equal(f.state.uncertainApprovals.has(modal.key), false);
});

test("Identical queued owner messages keep distinct request keys and full local bodies through history association", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  const text = "Same full owner body".repeat(500), owner = (id: number, key: string, status: "queued" | "done", historyEntry?: number) => ({ entry: id, conversation: 0, kind: "ruukoto.owner-input-display", role: "user" as const, text: text.slice(0, 4096), partial: false, truncated: true, timestamp: 100, input: { requestId: key, submission: id + 1, status, historyEntry } });
  f.state.update({ type: "personal_pending", record: { v: 1, origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, requestId: "one", input: text } });
  assert.equal(f.state.timeline.at(-1)?.requestKey, "one");
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "entry_appended", entry: owner(20, "one", "queued") }, { type: "entry_appended", entry: owner(30, "two", "queued") }] });
  assert.equal(f.state.timeline.filter(value => value.requestKey === "one").length, 1); assert.equal(f.state.bodies.get(20), text);
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 2, type: "events", events: [{ type: "entry_appended", entry: { ...owner(40, "one", "done"), kind: "pi.user", input: undefined, text } }, { type: "entry_appended", entry: owner(20, "one", "done", 40) }] });
  assert.equal(f.state.timeline.filter(value => value.role === "user").length, 3);
  assert.deepEqual(f.state.timeline.filter(value => value.input).map(value => value.requestKey), ["one", "two"]);
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} })); assert.ok(markup.includes(text));
});
