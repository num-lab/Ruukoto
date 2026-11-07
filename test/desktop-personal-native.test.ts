import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { PersonalDesktopApproval, PersonalDesktopAttachment, PersonalDesktopFrame, PersonalDesktopState, PersonalTimelineEntry } from "@ruukoto/view/personal-protocol.ts";
import type { DesktopBridge, DesktopResult, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { PersonalState, personalCardKey } from "../apps/desktop/src/renderer/personal-state.ts";
import { PersonalConnectionState } from "../apps/desktop/src/renderer/personal-connection-state.ts";
import { SettingsState } from "../apps/desktop/src/renderer/settings-state.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { parsePersonalSettingsRequest } from "../apps/ruukoto/src/personal-settings.ts";

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

test("Personal composer retains text, attachment actions and native draft guards in its compact layout", async t => {
  const { state } = fixture(); t.after(() => state.dispose()); await settle();
  const render = () => renderToStaticMarkup(createElement(Chat, { model: state, onConnect() {} }));
  for (const text of ["", "短消息", "first\nsecond", "long input ".repeat(4), "较长的中文消息".repeat(3)]) {
    state.edit(text);
    const markup = render();
    assert.match(markup, /aria-label="输入个人消息"/); assert.equal(state.draft, text);
    assert.match(markup, /class="[^"]*personal-attach[^"]*"/); assert.match(markup, /class="[^"]*personal-send[^"]*"/);
  }
  const attachment: PersonalDesktopAttachment = { id: "3b7a00d1-8815-41a2-b0e9-467b79d8521a", name: "report.txt", size: 9, mime: "text/plain", sha256: "a".repeat(64) };
  state.update({ type: "personal_draft", draft: { v: 1, id: "draft", origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, input: "", attachments: [attachment], failed: false } });
  assert.match(render(), /personal-composer is-expanded/); assert.match(render(), /移除附件 report.txt/); assert.equal(state.canSend, true);
  state.update({ type: "personal_identity", identity: { ...identity, profile: { ...identity.profile, id: "other" } } });
  assert.equal(state.canSend, false); assert.match(render(), /草稿属于原连接/);
});

test("Attachment-only owner bubbles keep refs and names; persisted failure disables sending after reload", async t => {
  const ref: PersonalDesktopAttachment = { id: "3b7a00d1-8815-41a2-b0e9-467b79d8521a", name: "original.csv", size: 909, mime: "text/csv", sha256: "a".repeat(64) };
  const f = fixture(async (_target, op, params) => op === "desktop_personal_input_submit" ? ok({ kind: "pending", requestId: "original" }) : op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null)); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(0) });
  const draft = { v: 1 as const, id: "draft", origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, input: "", attachments: [ref], failed: false };
  f.state.update({ type: "personal_draft", draft }); assert.equal(f.state.canSend, true);
  await f.state.send(); const submitted = f.calls.find(call => call.op === "desktop_personal_input_submit")!; assert.deepEqual(submitted.params, { text: "", attachments: [ref], draftId: draft.id });
  f.state.update({ type: "personal_pending", record: { v: 1, origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, requestId: "original", input: "", attachments: [ref] } });
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} })); assert.match(markup, /original.csv/); assert.equal(f.state.timeline.filter(entry => entry.requestKey === "original").length, 1); assert.deepEqual(f.state.timeline.find(entry => entry.requestKey === "original")!.attachments, [ref]);
  const reloaded = fixture(); t.after(() => reloaded.state.dispose()); await settle(); reloaded.state.update({ type: "personal_draft", draft: { ...draft, input: "Keep text", failed: true } });
  assert.equal(reloaded.state.draft, "Keep text"); assert.deepEqual(reloaded.state.attachments, [ref]); assert.equal(reloaded.state.canSend, false); await reloaded.state.send(); assert.equal(reloaded.calls.some(call => call.op === "desktop_personal_input_submit"), false);
  const failedMarkup = renderToStaticMarkup(createElement(Chat, { model: reloaded.state, onConnect() {} })); assert.doesNotMatch(failedMarkup, /附件未完整准备|重新选择附件|放弃草稿/); assert.match(failedMarkup, /添加附件/); assert.match(failedMarkup, /移除附件 original.csv/); assert.equal(reloaded.state.canAttach, true);
});

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

test("Personal bubble motion belongs to live visible arrivals, not history or reopening", async t => {
  const f = fixture(async (_target, op, params) => op === "desktop_personal_request" && String(params.path).startsWith("/timeline") ? ok({ through: 1, items: [{ entry: 0, conversation: 0, kind: "pi.user", role: "user", text: "Older message", partial: false, truncated: false, timestamp: 0 }] }) : op === "desktop_personal_request" && params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }));
  t.after(() => f.state.dispose()); await settle(); f.state.visible();
  const take = (entry: number) => f.state.takeMessageAnimation(f.state.entries.get(entry)?.displayKey ?? entry);
  assert.equal(take(1), false, "Initial history stays still");
  await f.state.older(); assert.equal(f.state.entries.has(0), true); assert.equal(take(0), false);
  let seq = 0;
  const append = (entry: PersonalTimelineEntry) => f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: ++seq, type: "events", events: [{ type: "entry_appended", entry }] });
  const incoming: PersonalTimelineEntry = { entry: 10, conversation: 0, kind: "pi.assistant", role: "assistant", text: "New reply", partial: false, truncated: false, timestamp: 10 };
  append(incoming); assert.equal(take(10), true); assert.equal(take(10), false, "One arrival has one opportunity");
  append(incoming); assert.equal(take(10), false, "Repeated entry events stay still");
  append({ ...incoming, entry: 11, partial: true }); assert.equal(take(11), false);
  append({ ...incoming, entry: 11 }); assert.equal(take(11), true, "Completion first makes the reply visible");
  append({ ...incoming, entry: 12, text: "" }); assert.equal(take(12), false);
  append({ ...incoming, entry: 13, role: "toolResult" }); assert.equal(take(13), false);
  append({ ...incoming, entry: 14 }); f.state.hidden(); f.state.visible(); assert.equal(take(14), false, "Reopening does not replay an unconsumed arrival");
  f.state.hidden(); append({ ...incoming, entry: 15 }); f.state.visible(); assert.equal(take(15), false, "Hidden arrivals become history on entry");
  append({ ...incoming, entry: 16 }); f.state.frame({ ...snapshot(seq), timeline: { through: 16, items: [...f.state.entries.values()] } });
  assert.equal(take(16), false, "Resynchronization does not replay arrivals");
});

for (const streamFirst of [false, true]) test(`Personal local bubble keeps one motion through admission (stream first: ${streamFirst})`, async t => {
  let receipt!: (result: DesktopResult<unknown>) => void;
  const f = fixture(async (_target, op, params) => op === "desktop_personal_input_submit" ? new Promise(resolve => { receipt = resolve; }) : op === "desktop_personal_request" && params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }));
  t.after(() => f.state.dispose()); await settle(); f.state.frame({ ...snapshot(), state: projection(0) }); f.state.visible();
  f.state.edit("ping"); const sending = f.state.send();
  const key = f.state.timeline.at(-1)!.displayKey!;
  assert.equal(f.state.takeMessageAnimation(key), true);
  const record = { v: 1 as const, origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, requestId: "original", input: "ping" };
  const canonical: PersonalTimelineEntry = { entry: 10, conversation: 0, kind: "ruukoto.owner-input-display", role: "user", text: "ping", partial: false, truncated: false, timestamp: 10, input: { requestId: "original", submission: 11, status: "queued" } };
  let seq = 0;
  if (streamFirst) {
    f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: ++seq, type: "events", events: [{ type: "entry_appended", entry: canonical }] });
    assert.equal(f.state.takeMessageAnimation(10), false, "Defer owner-display motion until the original request is known");
  }
  f.state.update({ type: "personal_pending", record });
  assert.equal(f.state.timeline.at(-1)!.displayKey, key);
  assert.equal(f.state.takeMessageAnimation(key), false);
  for (const status of ["queued", "placed", "done"] as const) {
    f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: ++seq, type: "events", events: [{ type: "entry_appended", entry: { ...canonical, input: { ...canonical.input!, status } } }] });
    assert.equal(f.state.timeline.at(-1)!.displayKey, key);
    assert.equal(f.state.takeMessageAnimation(key), false, status);
  }
  receipt(ok({ kind: "accepted", requestId: "original", status: "done" })); await sending;
  assert.equal(f.state.timeline.filter(entry => entry.text === "ping").length, 1);
});

test("Published files stay with completed timeline entries and use only native identity-bound output actions", async t => {
  const value = { v: 1 as const, publication: 200, output: 100, name: "final.txt", mime: "text/plain", bytes: 12, sha256: "a".repeat(64), partial: false };
  const f = fixture(async (_target, op, params) => op === "desktop_personal_output_save" || op === "desktop_personal_output_preview" ? ok({ state: op.endsWith("save") ? "saved" : "previewed" }) : op === "desktop_personal_request" && params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] })); t.after(() => f.state.dispose()); await settle();
  f.state.entries.set(value.publication, { entry: value.publication, conversation: 0, kind: "ruukoto.report-publication", role: "assistant", text: "", partial: false, truncated: false, timestamp: 1, outputs: [value] });
  let markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} })); assert.match(markup, /final.txt/); assert.match(markup, /预览/); assert.match(markup, /下载/); assert.doesNotMatch(markup, /download=|data:application|blob:/);
  await f.state.output(value, "preview"); await f.state.output(value, "save");
  assert.deepEqual(f.calls.filter(call => call.op.startsWith("desktop_personal_output_")), ["preview", "save"].map(action => ({ op: `desktop_personal_output_${action}`, params: { origin: identity.origin, remoteId: identity.remoteId, profileId: identity.profile.id, publication: value.publication, output: value.output } })));
  assert.equal(f.state.outputStatus.get("200:100"), "文件已保存");
  f.state.entries.get(value.publication)!.outputs = [{ ...value, partial: true }];
  markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} })); assert.match(markup, /不完整或超过 8 MiB/); assert.doesNotMatch(markup, />预览<|>下载</);
  await f.state.output({ ...value, partial: true }, "save"); await f.state.output({ ...value, bytes: 8 * 1024 * 1024 + 1 }, "save"); assert.equal(f.calls.filter(call => call.op.startsWith("desktop_personal_output_")).length, 2);
});

test("Late native file results do not appear under another profile and never trigger business retries", async t => {
  let release!: (value: DesktopResult<unknown>) => void;
  const value = { v: 1 as const, publication: 201, output: 101, name: "final.txt", mime: "text/plain", bytes: 12, sha256: "a".repeat(64), partial: false };
  const f = fixture(async (_target, op, params) => op === "desktop_personal_output_save" ? new Promise(resolve => { release = resolve; }) : op === "desktop_personal_request" && params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] })); t.after(() => f.state.dispose()); await settle();
  f.state.entries.set(value.publication, { entry: value.publication, conversation: 0, kind: "ruukoto.report-publication", role: "assistant", text: "Saved business result", partial: false, truncated: false, timestamp: 1, outputs: [value] });
  const saving = f.state.output(value, "save"); f.state.update({ type: "personal_identity", identity: { ...identity, remoteId: "other", profile: { ...identity.profile, id: "other" } } });
  release(ok({ state: "saved" })); await saving;
  assert.equal(f.state.outputStatus.size, 0); assert.equal(f.state.outputBusy, false); assert.equal(f.calls.filter(call => call.op === "desktop_personal_output_save").length, 1); assert.equal(f.calls.filter(call => call.params.method === "POST").length, 0);
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
  await settle(); f.state.frame({ ...snapshot(), state: projection(0) }); f.state.edit("原正文"); await f.state.send();
  f.state.update({ type: "personal_pending", record: { ...identity, requestId: "original", input: "原正文" } });
  assert.match(renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} })), /personal-input-loading/);
  await f.state.reconcile(); assert.equal(f.state.pendingResult?.kind, "missing"); assert.equal(f.state.canSend, false);
  await f.state.send(); assert.equal(f.calls.filter(value => value.op === "desktop_personal_input_submit").length, 1);
  await f.state.reconcile(true); assert.equal(f.state.pending, null); assert.equal(f.state.draft, "");
  assert.doesNotMatch(renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} })), /personal-input-loading/);
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
  assert.match(markup, /原输入/); assert.match(markup, /完整回复一/); assert.match(markup, /完整回复二/); assert.match(markup, /发送个人消息/); assert.match(markup, /aria-label="添加附件"/); assert.doesNotMatch(markup, /PA 暂不支持附件/); assert.match(markup, /rows="1"/);
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
  await f.state.loadCard(value);
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

test("Personal processing and admission do not add composer status notices", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  const value = card(), work = { ref: { taskId: 20, agentId: 2, requestId: "assignment" }, label: "File work", content: "Original owner request", state: "running", cancelRequested: false, stopVerified: false, closed: false, delegation: 7, progress: { accepted: 2, modelRead: 2, completed: 0, accounted: 0 } };
  const group = { ref: { entryId: 7 }, content: work.content, state: "reporting", cancelRequested: false, total: 1, active: 1, unverified: 0, paused: false };
  f.state.works = [work]; f.state.delegations = [group]; f.state.cards.set(value.occurrence, value);
  f.state.live.run = { inputs: [1], total: 1 }; f.state.live.inboxCount = 1;
  f.state.update({ type: "personal_pending", record: { ...identity, requestId: "original", input: "ping" } });
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  const composer = markup.slice(markup.indexOf('class="composer-wrap'));
  assert.doesNotMatch(composer, /task-notice|正在处理|工作进行中|正在准备结果|结果待核实|核实原输入/);
});

test("Personal send shows its bubble before the host responds and removes only the loader on acceptance", async t => {
  for (const streamFirst of [false, true]) {
    let receipt!: (value: DesktopResult<unknown>) => void;
    const f = fixture(async (_target, op, params) => op === "desktop_personal_input_submit" ? new Promise(resolve => { receipt = resolve; }) : op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null));
    t.after(() => f.state.dispose()); await settle(); f.state.frame({ ...snapshot(), state: projection(0) });
    const render = () => renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
    f.state.edit("ping"); const sending = f.state.send();
    assert.equal(f.state.timeline.filter(entry => entry.text === "ping").length, 1, "bubble exists before host pending or RPC receipt");
    assert.match(render(), /class="[^"]*personal-input-loading/); assert.doesNotMatch(render(), /正在核实接纳|结果待核实/);
    const anchor = f.state.timeline.at(-1)!.entry;
    f.state.update({ type: "personal_pending", record: { ...identity, requestId: "original", input: "ping" } });
    assert.equal(f.state.timeline.filter(entry => entry.text === "ping").length, 1); assert.equal(f.state.timeline.at(-1)!.entry, anchor);
    const history = { entry: 10, conversation: 0, kind: "ruukoto.owner-input-display", role: "user" as const, text: "ping", partial: false, truncated: false, timestamp: 100, input: { requestId: "original", submission: 11, status: "queued" as const } };
    if (streamFirst) { f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "entry_appended", entry: history }] }); assert.doesNotMatch(render(), /personal-input-loading/); }
    f.state.update({ type: "personal_pending", record: null, result: { kind: "accepted", requestId: "original", status: "queued" } });
    receipt(ok({ kind: "accepted", requestId: "original", status: "queued" })); await sending;
    assert.equal(f.state.timeline.filter(entry => entry.text === "ping").length, 1); assert.doesNotMatch(render(), /personal-input-loading|正在核实接纳|等待处理/);
    if (!streamFirst) f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "entry_appended", entry: history }] });
    assert.equal(f.state.timeline.filter(entry => entry.text === "ping").length, 1);
    assert.equal(f.calls.filter(call => call.op === "desktop_personal_input_submit").length, 1);
  }
});

test("Provisional Personal bubbles retain attachment-only input and clear on rejection or connection change", async t => {
  for (const changeConnection of [false, true]) {
    let receipt!: (value: DesktopResult<unknown>) => void;
    const f = fixture(async (_target, op, params) => op === "desktop_personal_input_submit" ? new Promise(resolve => { receipt = resolve; }) : op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null));
    t.after(() => f.state.dispose()); await settle(); f.state.frame({ ...snapshot(), state: projection(0) });
    const attachment: PersonalDesktopAttachment = { id: "3b7a00d1-8815-41a2-b0e9-467b79d8521a", name: "report.txt", size: 9, mime: "text/plain", sha256: "a".repeat(64) };
    f.state.update({ type: "personal_draft", draft: { v: 1, id: "draft", origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, input: "", attachments: [attachment], failed: false } });
    const sending = f.state.send();
    assert.deepEqual(f.state.timeline.find(entry => entry.kind === "local-input")?.attachments, [attachment], "attachment bubble exists before draft writes settle");
    await settle();
    if (changeConnection) {
      f.state.update({ type: "personal_identity", identity: { ...identity, remoteId: "other" } });
      assert.equal(f.state.timeline.length, 0);
    } else {
      f.state.update({ type: "personal_pending", record: { ...identity, requestId: "original", input: "", attachments: [attachment] } });
      f.state.update({ type: "personal_pending", record: null });
    }
    receipt({ ok: false, error: { code: "rejected", outcome: "rejected", message: "Submission rejected" } }); await sending;
    assert.equal(f.state.timeline.some(entry => entry.kind === "local-input"), false);
    assert.deepEqual(f.state.attachments, [attachment]);
  }
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
  await f.state.cancelDelegation(group); await f.state.loadCard(value);
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
  f.state.frame({ ...snapshot(), state: projection(1, [value]) }); await f.state.loadCard(value);
  await f.state.decideCard(value, "approved"); assert.equal(lost, true); assert.equal(posts, 1);
  assert.equal(f.state.uncertainDecisions.has(value.operation), true); assert.ok(f.state.cards.has(value.occurrence));
  f.state.frame({ ...snapshot(), state: projection(4, [value]) }); await f.state.decideCard(value, "approved"); assert.equal(posts, 1);
  inspectionFails = false; summary = { ...value, approval: "approved", canDecide: false };
  await f.state.loadCard(value); assert.equal(f.state.uncertainDecisions.has(value.operation), false);
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
  f.state.frame({ ...snapshot(), state: projection(1, [value]) }); const reading = f.state.loadCard(value);
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "personal_state", state: projection(2, [{ ...value, approval: "approved", canDecide: false }]) }] });
  release(ok({ v: 1, operation: value.operation, admission: value.admission, revision: 1, summary: value, offset: 0, text })); await reading;
  assert.equal(f.state.details.get(personalCardKey(value))?.complete, true); assert.equal(f.state.cards.get(value.occurrence)?.canDecide, false);
  hold = false; f.state.frame({ ...snapshot(), state: projection(10, []) }); await settle();
  assert.equal(f.state.refreshingCards.has(personalCardKey(value)), false); assert.equal(f.state.uncertainDecisions.has(value.operation), false); assert.equal(f.state.cards.get(value.occurrence)?.canDecide, true);
});

test("A same-run reconnect replaces a held detail read without letting the old request erase the new load", async t => {
  const value = card(), text = JSON.stringify({ target: value.target, params: { path: value.target, content: "Current" } });
  const reads: ((value: DesktopResult<unknown>) => void)[] = [];
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/desktop/operation")) return new Promise(resolve => { reads.push(resolve); });
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(1, [value]) }); const old = f.state.loadCard(value);
  f.state.update({ type: "state", state: "reconnecting" }); f.state.update({ type: "personal_identity", identity }); f.state.update({ type: "state", state: "online" });
  f.state.frame({ ...snapshot(), state: projection(2, [value]) }); const current = f.state.loadCard(value);
  assert.equal(reads.length, 2);
  reads[0](ok({ v: 1, operation: value.operation, admission: value.admission, revision: 1, summary: value, offset: 0, text })); await old;
  const joined = f.state.loadCard(value); assert.equal(reads.length, 2);
  reads[1](ok({ v: 1, operation: value.operation, admission: value.admission, revision: 2, summary: value, offset: 0, text })); await current;
  await joined;
  assert.equal(f.state.details.get(personalCardKey(value))?.complete, true);
});

test("An accepted receipt preserves the complete owner bubble under both RPC and stream ordering", async t => {
  for (const streamFirst of [false, true]) {
    let receipt!: (value: DesktopResult<unknown>) => void;
    const f = fixture(async (_target, op, params) => op === "desktop_personal_input_submit" ? new Promise(resolve => { receipt = resolve; }) : op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null));
    t.after(() => f.state.dispose()); await settle(); f.state.frame({ ...snapshot(), state: projection(0) }); const text = "Owner text 🙂 ".repeat(550);
    f.state.edit(text); const sending = f.state.send();
    const entry = { entry: 10, conversation: 0, kind: "ruukoto.owner-input-display", role: "user" as const, text: text.slice(0, 4096), partial: false, truncated: true, timestamp: 1, input: { requestId: "original", submission: 11, status: "queued" as const } };
    if (streamFirst) f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "entry_appended", entry }] });
    receipt(ok({ kind: "accepted", requestId: "original", status: "queued" })); await sending;
    assert.equal(f.state.draft, ""); assert.equal(f.state.timeline.filter(entry => entry.requestKey === "original").length, 1);
    if (!streamFirst) { assert.equal(f.state.timeline.find(entry => entry.requestKey === "original")?.text, text); f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "entry_appended", entry }] }); }
    assert.equal(f.state.bodies.get(10), text); assert.equal(f.state.timeline.filter(entry => entry.requestKey === "original").length, 1);
  }
});

test("Legacy Personal history renders one owner bubble after a successful native submission", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  const record = { v: 1 as const, origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, requestId: "original", input: "ping" };
  f.state.update({ type: "personal_pending", record });
  f.state.update({ type: "personal_pending", record: null, result: { kind: "accepted", requestId: record.requestId, status: "placed" } });
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "entry_appended", entry: { entry: 10, conversation: 0, kind: "pi.user", role: "user", text: "ping", partial: false, truncated: false, timestamp: 100 } }] });
  assert.equal(f.state.timeline.filter(entry => entry.text === "ping").length, 1);
  assert.equal(f.state.timeline.some(entry => entry.kind === "local-input"), false);
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  assert.doesNotMatch(markup, /正在核实接纳/);
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 2, type: "events", events: [{ type: "entry_appended", entry: { entry: 11, conversation: 0, kind: "pi.user", role: "user", text: "ping", partial: false, truncated: false, timestamp: 101 } }] });
  assert.equal(f.state.timeline.filter(entry => entry.text === "ping").length, 2, "identical real submissions remain distinct");
});

test("Accepted Personal input status is never presented as uncertain admission", async t => {
  for (const status of ["queued", "placed", "done", "unanswered"] as const) {
    const f = fixture(async (_target, op, params) => op === "desktop_personal_input_submit" ? ok({ kind: "accepted", requestId: "original", status }) : op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null));
    t.after(() => f.state.dispose());
    f.state.frame({ ...snapshot(), state: projection(0) }); await settle();
    f.state.edit("ping"); await f.state.send();
    assert.equal(f.state.timeline.filter(entry => entry.requestKey === "original").length, 1);
    const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
    assert.doesNotMatch(markup, /正在核实接纳/, status);
    assert.doesNotMatch(markup, /personal-input-loading|等待处理/);
    if (status === "unanswered") assert.match(markup, /未完成处理/);
  }
});

test("A legacy reconnect resets owner display capability without merging identical messages", async t => {
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(0) });
  f.state.update({ type: "personal_pending", record: { v: 1, origin: identity.origin, remoteId: identity.remoteId, profile: identity.profile, requestId: "original", input: "ping" } });
  assert.equal(f.state.timeline.filter(entry => entry.kind === "local-input").length, 1);
  const history = { entry: 10, conversation: 0, kind: "pi.user", role: "user" as const, text: "ping", partial: false, truncated: false, timestamp: 100 };
  f.state.frame({ ...snapshot(), timeline: { through: history.entry, items: [history] } });
  assert.equal(f.state.projection, false);
  assert.equal(f.state.timeline.filter(entry => entry.text === "ping").length, 1);
  assert.equal(f.state.timeline.some(entry => entry.kind === "local-input"), false);
});

test("A pending owner message stays before later child cards and late legacy work queries cannot replace grouped state", async t => {
  let release!: (value: DesktopResult<unknown>) => void;
  const f = fixture(async (_target, op, params) => String(params.path).startsWith("/works") ? new Promise(resolve => { release = resolve; }) : op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null));
  t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(0) });
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
  f.state.details.set(personalCardKey(value), { admission: value.admission, text: JSON.stringify({ target, params: { path: "/short-alias/result", content: "" } }), complete: true });
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
  f.state.frame({ ...snapshot(), state: projection(0) });
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

function workQuestion(id: string, occurrence = Number(id) + 400): import("@ruukoto/view/personal-protocol.ts").PersonalDesktopQuestion { return { id, admission: occurrence, occurrence, version: 1, status: "pending", question: `Question ${id}`, canAnswer: true, canCancel: true, work: Number(id) + 10 }; }

test("Concurrent native work questions retain separate drafts, submit one single choice directly and keep multi-select pending until Done", async t => {
  const first = workQuestion("51"), second = workQuestion("52"), posted: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction[] = [];
  const questions = new Map([[first.id, { ...first, questions: [{ question: "Select one", options: ["First", "Second"] }], origin: {} }], [second.id, { ...second, questions: [{ question: "Select several", options: ["Red", "Green", "Blue"], multiple: true }], origin: {} }]]);
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/question?")) return ok(questions.get(new URL(String(params.path), identity.origin).searchParams.get("question")!));
    if (params.method === "POST" && params.path === "/desktop/action") { const request = params.body as import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction; posted.push(request); return ok({ v: 1, request, entry: 700 + posted.length, state: "completed" }); }
    if (params.path === "/desktop/state") return ok({ ...projection(2), questions: { items: [first, second], total: 2 } });
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: { ...projection(1), questions: { items: [first, second], total: 2 } } });
  await f.state.loadQuestion(first); await f.state.loadQuestion(second);
  f.state.chooseQuestion(second, [2, 0]); assert.equal(posted.length, 0); assert.deepEqual(f.state.questionDraft(second).answers, [{ text: "Red\nBlue", options: [0, 2] }]);
  f.state.chooseQuestion(first, 1); await settle(); assert.equal(posted.length, 1); assert.equal(posted[0].operation, 51); assert.equal(posted[0].occurrence, first.occurrence); assert.deepEqual(posted[0].answers, [{ text: "Second", option: 1 }]);
  assert.deepEqual(f.state.questionDraft(second).answers, [{ text: "Red\nBlue", options: [0, 2] }]);
  f.state.nextQuestion(second); await settle(); assert.equal(posted.length, 2); assert.equal(posted[1].operation, 52); assert.deepEqual(posted[1].answers, [{ text: "Red\nBlue", options: [0, 2] }]);
  f.state.edit("Main stays usable"); assert.equal(f.state.canSend, true);
});

test("Several native questions finish with review and free text stays on its exact question", async t => {
  const question = workQuestion("61"), posted: unknown[] = [];
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/question?")) return ok({ ...question, questions: [{ question: "One", options: ["A", "B"] }, { question: "Two" }], origin: {} });
    if (params.method === "POST" && params.path === "/desktop/action") { posted.push(params.body); return ok({ v: 1, request: params.body, entry: 800, state: "completed" }); }
    if (params.path === "/desktop/state") return ok({ ...projection(3), questions: { items: [question], total: 1 } });
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: { ...projection(1), questions: { items: [question], total: 1 } } }); await f.state.loadQuestion(question);
  f.state.chooseQuestion(question, 0); assert.equal(f.state.questionDraft(question).index, 1); assert.equal(posted.length, 0);
  f.state.editQuestion(question, "Exact free answer"); f.state.nextQuestion(question); assert.equal(f.state.questionDraft(question).review, true); assert.equal(posted.length, 0);
  await f.state.answerCard(question); assert.equal(posted.length, 1); assert.deepEqual((posted[0] as { answers: unknown }).answers, [{ text: "A", option: 0 }, { text: "Exact free answer" }]);
  question.canAnswer = false; await f.state.answerCard(question); assert.equal(posted.length, 1);
});

test("Lost native work answers keep their original request through failed inspection and another question's response", async t => {
  const question = workQuestion("71"), other = workQuestion("72"); let request: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction | undefined, posts = 0, inspected = false;
  const terminal = { ...question, version: 2, status: "answered" as const, canAnswer: false, canCancel: false };
  const reads: string[] = [], newest = [other, ...Array.from({ length: 7 }, (_, index) => workQuestion(String(200 + index)))];
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/question?")) { const id = new URL(String(params.path), identity.origin).searchParams.get("question")!; reads.push(id); return ok({ ...(id === question.id ? inspected ? terminal : question : other), questions: [{ question: "Business detail" }], origin: {}, ...(id === question.id && inspected ? { answer: { answers: [{ text: "Original answer" }] } } : {}) }); }
    if (params.method === "POST" && params.path === "/desktop/action") { posts++; request = params.body as typeof request; return { ok: false, error: { code: "lost", outcome: "unknown", message: "Original answer pending" } }; }
    if (String(params.path).startsWith("/desktop/action?")) return inspected ? ok({ v: 1, request, entry: 900, state: "completed" }) : { ok: false, error: { code: "read_lost", outcome: "not_sent", message: "Inspection unavailable" } };
    if (params.path === "/desktop/state") return ok({ ...projection(inspected ? 4 : 3), questions: { items: newest, total: newest.length + 1, nextOffset: 8 } });
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: { ...projection(1), questions: { items: [question, other], total: 2 } } }); await f.state.loadQuestion(question); await f.state.loadQuestion(other);
  f.state.editQuestion(question, "Original answer"); await f.state.answerCard(question); assert.equal(posts, 1); assert.equal(f.state.actionBlocked("questions", 71), true);
  await f.state.answerCard(question); assert.equal(posts, 1);
  f.state.update({ type: "personal_actions", items: [request!] });
  assert.equal(f.state.questionDraft(question).answers[0].text, "Original answer"); assert.equal(f.state.actionBlocked("questions", 71), true); assert.equal(f.state.actionBlocked("questions", 72), false);
  f.state.editQuestion(other, "Independent unsent answer"); const readsBefore = reads.length;
  inspected = true; await f.state.inspectAction(request!); assert.equal(f.state.actionBlocked("questions", 71), false); assert.equal(f.state.questionCards.get(question.occurrence)?.status, "answered"); assert.equal(f.state.questionDetails.get(question.id)?.version, 2); assert.ok(reads.length > readsBefore); assert.ok(reads.slice(readsBefore).every(id => id === question.id));
  await f.state.answerCard(question); assert.equal(posts, 1); assert.equal(f.state.questionDraft(other).answers[0].text, "Independent unsent answer");
});

test("Terminal native action receipts refresh their original card without WebSocket events or replay", async t => {
  for (const mode of ["receipt inspection", "restored host removal"] as const) await t.test(mode, async t => {
    const value: PersonalDesktopApproval = { ...card(171), family: "mcp", kind: "cua", approval: "unneeded", canDecide: false, started: true, observed: true, effect: "returned", code: "returned", observation: 1400, actions: ["resume"] };
    const inspection: PersonalDesktopApproval = { ...value, family: "inspections", kind: "service_inspect", admission: 272, occurrence: 272, actions: ["cleanup"] };
    const reads: string[] = [], posted: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction[] = [];
    let original: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction | undefined, completed = false, release!: () => void;
    const f = fixture(async (_target, op, params) => {
      if (String(params.path).startsWith("/desktop/operation")) {
        const family = new URL(String(params.path), identity.origin).searchParams.get("family")!; reads.push(family);
        const summary = family === "mcp" ? completed ? { ...value, actions: [] } : value : inspection;
        if (completed && family === "mcp") await new Promise<void>(resolve => { release = resolve; });
        return ok({ v: 1, revision: completed ? 2 : 1, operation: summary.operation, admission: summary.admission, summary, offset: 0, text: JSON.stringify({ target: summary.target, params: { original: family } }) });
      }
      if (params.method === "POST" && params.path === "/desktop/action") { original = params.body as typeof original; posted.push(original!); return ok({ v: 1, request: original, entry: 1500, state: "admitted" }); }
      if (String(params.path).startsWith("/desktop/action?")) {
        assert.equal(new URL(String(params.path), identity.origin).searchParams.get("requestId"), original?.requestId);
        return ok({ v: 1, request: original, entry: 1500, state: completed ? "completed" : "admitted" });
      }
      return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
    }); t.after(() => f.state.dispose()); await settle();
    f.state.frame({ ...snapshot(), state: projection(1, [value, inspection]) }); await f.state.loadCard(value); await f.state.loadCard(inspection);
    if (mode === "receipt inspection") await f.state.cardAction(value, "resume");
    else { original = { v: 1, requestId: "e555342d-eb18-4094-939f-6e8cfb960ff9", family: "mcp", operation: value.operation, admission: value.admission, occurrence: value.occurrence, action: "resume" }; f.state.update({ type: "personal_actions", items: [original] }); }
    assert.equal(f.state.actionBlocked("mcp", value.operation), true); assert.deepEqual(f.state.cards.get(value.occurrence)?.actions, ["resume"]);
    const readsBefore = reads.length, postsBefore = posted.length; completed = true;
    const refreshing = mode === "receipt inspection" ? f.state.inspectAction(original!) : (f.state.update({ type: "personal_actions", items: [] }), settle());
    await settle(); assert.deepEqual(reads.slice(readsBefore), ["mcp"]); assert.equal(f.state.actionBlocked("mcp", value.operation), true);
    await f.state.cardAction(value, "resume"); assert.equal(posted.length, postsBefore);
    release(); await refreshing; await settle();
    assert.deepEqual(f.state.cards.get(value.occurrence)?.actions, []); assert.deepEqual(f.state.cards.get(inspection.occurrence)?.actions, ["cleanup"]); assert.equal(f.state.actionBlocked("mcp", value.operation), false);
    await f.state.cardAction(value, "resume"); assert.equal(posted.length, postsBefore);
    if (posted.length) assert.deepEqual(posted[0], original);
  });
});

test("A terminal native receipt waits for an older detail read and retries a failed canonical refresh", async t => {
  for (const mode of ["in-flight detail", "failed refresh"] as const) await t.test(mode, async t => {
    const value: PersonalDesktopApproval = { ...card(172), family: "mcp", kind: "cua", approval: "unneeded", canDecide: false, started: true, observed: true, effect: "returned", code: "returned", observation: 1401, actions: ["resume"] };
    let original: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction | undefined, completed = false, holdOld = false, failRead = mode === "failed refresh", releaseOld!: () => void, reads = 0, posts = 0;
    const f = fixture(async (_target, op, params) => {
      if (String(params.path).startsWith("/desktop/operation")) {
        assert.equal(new URL(String(params.path), identity.origin).searchParams.get("family"), "mcp"); reads++;
        const summary = completed ? { ...value, actions: [] } : value, revision = completed ? 2 : 1;
        if (holdOld && !completed) await new Promise<void>(resolve => { releaseOld = resolve; });
        if (completed && failRead) return { ok: false, error: { code: "read_lost", outcome: "not_sent", message: "Original detail unavailable" } };
        return ok({ v: 1, revision, operation: value.operation, admission: value.admission, summary, offset: 0, text: JSON.stringify({ target: value.target, params: { original: "mcp" } }) });
      }
      if (params.method === "POST" && params.path === "/desktop/action") { original = params.body as typeof original; posts++; return ok({ v: 1, request: original, entry: 1501, state: "admitted" }); }
      if (String(params.path).startsWith("/desktop/action?")) { assert.equal(new URL(String(params.path), identity.origin).searchParams.get("requestId"), original?.requestId); return ok({ v: 1, request: original, entry: 1501, state: completed ? "completed" : "admitted" }); }
      return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
    }); t.after(() => f.state.dispose()); await settle(); f.state.frame({ ...snapshot(), state: projection(1, [value]) }); await f.state.loadCard(value); await f.state.cardAction(value, "resume");
    assert.equal(posts, 1); assert.equal(f.state.actionBlocked("mcp", value.operation), true);
    const readsBefore = reads; holdOld = mode === "in-flight detail"; const older = holdOld ? f.state.loadCard(value) : undefined;
    completed = true; const refreshing = f.state.inspectAction(original!); await settle();
    if (older) {
      assert.equal(reads, readsBefore + 1); assert.equal(f.state.actionBlocked("mcp", value.operation), true);
      releaseOld(); await older; await refreshing;
      assert.equal(reads, readsBefore + 2);
    } else {
      await refreshing; assert.equal(reads, readsBefore + 1); assert.equal(f.state.actionBlocked("mcp", value.operation), true); assert.match(f.state.details.get(personalCardKey(value))?.error ?? "", /unavailable/);
      await f.state.cardAction(value, "resume"); assert.equal(posts, 1); failRead = false; await f.state.inspectAction(original!); assert.equal(reads, readsBefore + 2);
    }
    assert.deepEqual(f.state.cards.get(value.occurrence)?.actions, []); assert.equal(f.state.actionBlocked("mcp", value.operation), false);
    await f.state.cardAction(value, "resume"); assert.equal(posts, 1);
  });
});

test("A terminal action diagnostic cannot cross a profile switch during canonical refresh", async t => {
  const value: PersonalDesktopApproval = { ...card(173), family: "mcp", kind: "cua", approval: "unneeded", canDecide: false, actions: ["resume"] };
  let refreshing = false, release!: () => void, posts = 0;
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/desktop/operation")) {
      if (refreshing) await new Promise<void>(resolve => { release = resolve; });
      return ok({ v: 1, revision: refreshing ? 2 : 1, operation: value.operation, admission: value.admission, summary: value, offset: 0, text: JSON.stringify({ target: value.target, params: { original: "mcp" } }) });
    }
    if (params.method === "POST" && params.path === "/desktop/action") { posts++; refreshing = true; return ok({ v: 1, request: params.body, entry: 1502, state: "failed" }); }
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle(); f.state.frame({ ...snapshot(), state: projection(1, [value]) }); await f.state.loadCard(value);
  const action = f.state.cardAction(value, "resume"); await settle(); assert.equal(posts, 1); assert.equal(typeof release, "function");
  f.state.update({ type: "personal_identity", identity: { ...identity, remoteId: "new-remote", profile: { ...identity.profile, id: "new-profile" } } });
  f.state.message = "Current profile diagnostic"; release(); await action;
  assert.equal(f.state.message, "Current profile diagnostic"); assert.equal(f.state.cards.size, 0); assert.equal(f.state.uncertainActions.size, 0); assert.equal(posts, 1);
});

test("A restored terminal answer outside the newest question page recreates its original card", async t => {
  const question = workQuestion("73"), newest = Array.from({ length: 8 }, (_, index) => workQuestion(String(300 + index))), text = "Exact original answer\nSecond line";
  const request: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction = { v: 1, requestId: "fa0bd78a-bc2a-4dd8-b54c-2571f59c7c91", family: "questions", operation: Number(question.id), admission: question.admission, occurrence: question.occurrence, action: "answer", questionVersion: 1, answers: [{ text }] };
  const reads: string[] = []; let posts = 0;
  const f = fixture(async (_target, op, params) => {
    if (op === "desktop_personal_request") {
      if (params.method === "POST") { posts++; return ok(null); }
      const path = String(params.path);
      if (path.startsWith("/desktop/action?")) { assert.equal(new URL(path, identity.origin).searchParams.get("requestId"), request.requestId); return ok({ v: 1, request, entry: 1503, state: "completed" }); }
      if (path.startsWith("/question?")) { reads.push(path); assert.equal(path, `/question?question=${question.id}`); return ok({ id: question.id, admission: question.admission, version: 2, status: "answered", questions: [{ question: "Original work question" }], origin: {}, answer: { answers: [{ text }] } }); }
      if (path.startsWith("/desktop/operation")) throw new Error("Restored question must not read an operation family");
      if (path === "/desktop/state") return ok({ ...projection(1), questions: { items: newest, total: newest.length + 1, nextOffset: 8 } });
      return path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] });
    }
    return ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: { ...projection(1), questions: { items: newest, total: newest.length + 1, nextOffset: 8 } } });
  f.state.update({ type: "personal_actions", items: [request] }); assert.equal(f.state.questionCards.has(question.occurrence), false); assert.equal(f.state.actionBlocked("questions", Number(question.id)), true);
  await f.state.inspectAction(request);
  const restored = f.state.questionCards.get(question.occurrence); assert.ok(restored); assert.equal(restored.id, question.id); assert.equal(restored.admission, question.admission); assert.equal(restored.status, "answered"); assert.equal(restored.version, 2); assert.equal(restored.canAnswer, false); assert.equal(restored.canCancel, false);
  assert.deepEqual(f.state.questionDetails.get(question.id)?.answer?.answers, [{ text }]); assert.deepEqual(reads, [`/question?question=${question.id}`]); assert.equal(f.state.actionBlocked("questions", Number(question.id)), false);
  await f.state.answerCard(question); assert.equal(posts, 0);
});

test("All-family recovery cards retain claims, current observations and explicit sandbox choice before completed prose", async t => {
  const value = { ...card(81), family: "mcp" as const, kind: "cua" as const, canDecide: false, started: true, stopped: false, approval: "approved" as const, effect: "effect_unknown" as const, code: "interrupted", actions: ["cleanup", "observe", "claim_applied", "claim_not_applied", "stop_sandbox"] as import("@ruukoto/view/personal-protocol.ts").PersonalDesktopActionName[], check: { entry: 1100, kind: "observation" as const, code: "observed", text: "Current target is healthy" }, claim: { entry: 1101, effect: "applied" as const, at: 1000 } };
  const f = fixture(); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(1, [value]) }); f.state.details.set(personalCardKey(value), { admission: value.admission, family: "mcp", complete: true, text: JSON.stringify({ target: value.target, params: { action: "Original click" } }) });
  f.state.entries.set(400, { entry: 400, conversation: 0, kind: "pi.assistant", role: "assistant", text: "Later prose", partial: false, truncated: false, timestamp: 1000 });
  const markup = renderToStaticMarkup(createElement(Chat, { model: f.state, onConnect() {} }));
  assert.ok(markup.indexOf("Original click") < markup.indexOf("Later prose")); assert.match(markup, /当前观察：Current target is healthy/); assert.match(markup, /你的记录：已生效/); assert.match(markup, /停止原执行|查看新现场|停止整个原沙箱/); assert.doesNotMatch(markup, /确认停止整个原沙箱/);
});

test("A native canceled question and a stale recovery card cannot send their former actions", async t => {
  const question = workQuestion("91"), recovery = { ...card(92), family: "browser" as const, kind: "browser" as const, actions: ["resume"] as import("@ruukoto/view/personal-protocol.ts").PersonalDesktopActionName[] }; let posts = 0;
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/question?")) return ok({ ...question, questions: [{ question: "Original question" }], origin: {} });
    if (params.method === "POST") { posts++; return ok({}); }
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: { ...projection(1, [recovery]), questions: { items: [question], total: 1 } } }); await f.state.loadQuestion(question); f.state.editQuestion(question, "Late answer");
  f.state.details.set(personalCardKey(recovery), { admission: recovery.admission, family: "browser", complete: true, text: JSON.stringify({ target: recovery.target, params: { action: "pause" } }) });
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "personal_state", state: { ...projection(2, [{ ...recovery, actions: [] }]), questions: { items: [{ ...question, version: 2, status: "canceled", canAnswer: false, canCancel: false }], total: 1 } } }] });
  await f.state.answerCard(question); await f.state.cardAction(recovery, "resume"); assert.equal(posts, 0);
});

test("A native recovery screenshot must match observation, completeness, hash and actual display before acceptance", async t => {
  const profile = { ...identity.profile, id: `sha256:${"a".repeat(64)}` }, revision = `sha256:${"b".repeat(64)}`, image = "1d046568-a6ce-4339-a95d-e8d7b4df5974";
  const responseProfile = { directory: profile.directory, id: profile.id };
  const bytes = Uint8Array.from(Buffer.from("exact test image")), hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"), value = { ...card(101), family: "mcp" as const, kind: "cua" as const, actions: ["accept"] as import("@ruukoto/view/personal-protocol.ts").PersonalDesktopActionName[], observation: 1200, images: [{ id: image, mime: "image/png", bytes: bytes.length, sha256: hash, partial: false }] }; let corrupt = false, settingsReads = 0;
  const pages: { revision: string; offset: number }[] = [], parserFailures: string[] = [];
  const f = fixture(async (_target, op, params) => {
    if (op === "desktop_personal_settings_request") {
      let request: ReturnType<typeof parsePersonalSettingsRequest>;
      try { request = parsePersonalSettingsRequest(params.request); }
      catch (error) { if (!(error instanceof PersonalError)) throw error; parserFailures.push(error.code); return { ok: false, error: { code: error.code, outcome: "rejected", message: error.message } }; }
      if (request.op === "settings.read") { settingsReads++; assert.deepEqual(request, { v: 1, op: "settings.read", limit: 1 }); return ok({ profile: responseProfile, revisions: { mcp: revision } }); }
      assert.equal(request.op, "mcp.cua-image"); if (request.op !== "mcp.cua-image") throw new Error("Unexpected native image request");
      assert.deepEqual(request.profile, profile); assert.equal(request.expectedRevision, revision); assert.equal(request.operation, value.operation); assert.equal(request.observation, value.observation); assert.equal(request.image, image);
      const offset = request.offset ?? 0, content = Uint8Array.from(bytes); if (corrupt) content[0] ^= 1;
      const chunk = content.slice(offset, offset + 8), nextOffset = offset + chunk.length;
      pages.push({ revision: request.expectedRevision, offset });
      return ok({ profile: responseProfile, observation: value.observation, id: image, mime: "image/png", bytes: bytes.length, sha256: hash, offset, base64: Buffer.from(chunk).toString("base64"), ...(nextOffset < bytes.length ? { nextOffset } : {}) });
    }
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle(); f.state.update({ type: "personal_identity", identity: { ...identity, profile } }); f.state.frame({ ...snapshot(), state: projection(1, [value]) });
  await f.state.loadCuaImages(value); assert.deepEqual(parserFailures, []); assert.equal(settingsReads, 1); assert.ok(f.state.cuaImages.has(value.operation), f.state.message ?? "Native screenshot did not load"); assert.deepEqual(pages, [{ revision, offset: 0 }, { revision, offset: 8 }]);
  assert.equal(f.state.canAcceptCua(value), false); f.state.cuaImageLoaded(value, image, true); assert.equal(f.state.canAcceptCua(value), true);
  f.state.cuaImageLoaded({ ...value, observation: 1199 }, image, false); assert.equal(f.state.canAcceptCua(value), true);
  corrupt = true; await f.state.loadCuaImages(value); assert.equal(settingsReads, 2); assert.equal(f.state.canAcceptCua(value), false); assert.match(f.state.message ?? "", /完整性/);
  await f.state.loadCuaImages({ ...value, images: [{ ...value.images[0], partial: true }] }); assert.equal(f.state.canAcceptCua(value), false); assert.match(f.state.message ?? "", /不完整/); assert.equal(pages.length, 4);
});

test("A native screenshot cannot use a foreign or stale settings read", async t => {
  const profile = { ...identity.profile, id: `sha256:${"a".repeat(64)}` }, revision = `sha256:${"b".repeat(64)}`;
  const value: PersonalDesktopApproval = { ...card(102), family: "mcp", kind: "cua", actions: ["accept"], observation: 1201, images: [{ id: "0de17fd5-951a-49f0-8bc7-38f16ec16f4f", mime: "image/png", bytes: 1, sha256: "c".repeat(64), partial: false }] };
  for (const mode of ["foreign profile", "foreign directory", "new observation", "new connection"] as const) await t.test(mode, async t => {
    let release!: (result: DesktopResult<unknown>) => void, settingsReads = 0, imageReads = 0;
    const f = fixture(async (_target, op, params) => {
      if (op === "desktop_personal_settings_request") {
        const request = parsePersonalSettingsRequest(params.request);
        if (request.op === "settings.read") { settingsReads++; return new Promise(resolve => { release = resolve; }); }
        imageReads++; throw new Error("Stale settings must not request image bytes");
      }
      return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
    }); t.after(() => f.state.dispose()); await settle(); f.state.update({ type: "personal_identity", identity: { ...identity, profile } }); f.state.frame({ ...snapshot(), state: projection(1, [value]) });
    const loading = f.state.loadCuaImages(value); assert.equal(settingsReads, 1);
    if (mode === "new observation") f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "personal_state", state: projection(2, [{ ...value, observation: 1202 }]) }] });
    if (mode === "new connection") f.state.update({ type: "state", state: "reconnecting" });
    const responseProfile = { directory: mode === "foreign directory" ? "/private/other-pa" : profile.directory, id: mode === "foreign profile" ? `sha256:${"d".repeat(64)}` : profile.id };
    release(ok({ profile: responseProfile, revisions: { mcp: revision } })); await loading;
    assert.equal(imageReads, 0); assert.equal(f.state.cuaImages.size, 0); assert.equal(f.state.canAcceptCua(value), false); assert.equal(f.state.cuaImageLoading.has(value.operation), false);
    if (mode === "foreign profile" || mode === "foreign directory") assert.match(f.state.message ?? "", /原档案/);
  });
});

test("Service and inspection cards sharing a task keep independent details, revisions, reconnect reads and actions", async t => {
  const service: PersonalDesktopApproval = { ...card(151), family: "services", kind: "service_restart", target: "original.service", approval: "approved", canDecide: false, started: true, stopped: false, effect: "effect_unknown", code: "service_interrupted", actions: ["check", "cleanup"] };
  const inspection: PersonalDesktopApproval = { ...service, family: "inspections", kind: "service_inspect", admission: 252, occurrence: 252, approval: "unneeded", effect: "no_write", code: "inspection_stop_unverified", actions: ["check", "cleanup"] };
  const summaries = new Map([["services", service], ["inspections", inspection]]), reads: string[] = [], posted: import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction[] = [];
  let releaseInspection: (() => void) | undefined, holdInspection = true;
  const f = fixture(async (_target, op, params) => {
    if (String(params.path).startsWith("/desktop/operation")) {
      const url = new URL(String(params.path), identity.origin), family = url.searchParams.get("family")!, summary = summaries.get(family)!; reads.push(family);
      if (holdInspection && family === "inspections") await new Promise<void>(resolve => { releaseInspection = resolve; });
      return ok({ v: 1, operation: summary.operation, admission: summary.admission, revision: 3, summary, offset: 0, text: JSON.stringify({ target: summary.target, params: { original: family } }) });
    }
    if (params.method === "POST" && params.path === "/desktop/action") { posted.push(params.body as import("@ruukoto/view/personal-protocol.ts").PersonalDesktopAction); return ok({ v: 1, request: params.body, entry: 600, state: "completed" }); }
    return op === "desktop_personal_request" ? params.path === "/permissions" ? ok({ default: { mode: "confirm" } }) : ok({ items: [] }) : ok(null);
  }); t.after(() => f.state.dispose()); await settle();
  f.state.frame({ ...snapshot(), state: projection(1, [service, inspection]) });
  const loading = Promise.all([f.state.loadCard(service), f.state.loadCard(inspection)]);
  assert.deepEqual(reads.sort(), ["inspections", "services"]);
  const serviceCurrent = { ...service, code: "service_current" };
  summaries.set("services", serviceCurrent);
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "personal_state", state: projection(4, [serviceCurrent]) }] });
  assert.equal(f.state.cards.get(service.occurrence)?.code, "service_current");
  holdInspection = false; releaseInspection!(); await loading;
  assert.equal(f.state.cards.get(inspection.occurrence)?.code, inspection.code);
  assert.match(f.state.details.get(personalCardKey(service))?.text ?? "", /services/);
  assert.match(f.state.details.get(personalCardKey(inspection))?.text ?? "", /inspections/);
  await f.state.cardAction(service, "check"); await f.state.cardAction(inspection, "cleanup");
  assert.deepEqual(posted.map(({ family, admission, occurrence, action }) => ({ family, admission, occurrence, action })), [{ family: "services", admission: service.admission, occurrence: service.occurrence, action: "check" }, { family: "inspections", admission: inspection.admission, occurrence: inspection.occurrence, action: "cleanup" }]);
  reads.length = 0;
  f.state.frame({ ...snapshot(), state: projection(4, [serviceCurrent]) }); await settle();
  assert.deepEqual(reads, ["inspections"]);
  f.state.uncertainDecisions.add(service.operation);
  f.state.frame({ v: 1, runId: "run", subscription: "subscription", seq: 1, type: "events", events: [{ type: "personal_state", state: projection(5, [{ ...inspection, stopped: true, code: "inspection_stopped", actions: [] }]) }] });
  assert.equal(f.state.uncertainDecisions.has(service.operation), true);
  assert.equal(f.state.cards.get(service.occurrence)?.code, "service_current");
});
