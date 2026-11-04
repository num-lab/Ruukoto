import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { TaskId } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import type { PersonalDesktopFrame, PersonalDesktopOperation, PersonalDesktopState, PersonalTimelineEntry, PersonalTimelinePage } from "@ruukoto/view/personal-protocol.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, readPersonalToken, startPersonalServer, type PersonalInputStatus } from "../apps/ruukoto/src/personal-control.ts";
import { savePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer, type RecordedRequest } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import { initializePersonalRemote, startPersonalRemote } from "../apps/ruukoto/src/personal-remote.ts";
import { personalSettingsDirectoryIdentity } from "../apps/ruukoto/src/personal-settings.ts";
import { PersonalController } from "../apps/desktop/src/main/personal-controller.ts";
import { PersonalState } from "../apps/desktop/src/renderer/personal-state.ts";
import { personalTestCertificate, personalTestKey } from "./helpers/personal-https.ts";

function gate(t: TestContext) {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  return { promise, release };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < end, "The desktop file loop did not reach its expected state"); await delay(5); }
}
const tool = (name: string, args: Record<string, unknown>) => `tool:${JSON.stringify({ name, args })}`;
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent") === true;
const summary = (request: RecordedRequest) => String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考");
function state(frames: PersonalDesktopFrame[]): PersonalDesktopState {
  for (const frame of [...frames].reverse()) {
    if (frame.type === "snapshot" && frame.state) return frame.state;
    if (frame.type === "events") for (const event of [...frame.events].reverse()) if (event.type === "personal_state") return event.state;
  }
  throw new Error("The server did not supply canonical desktop state");
}
function entries(frames: PersonalDesktopFrame[]): PersonalTimelineEntry[] {
  const all = frames.flatMap(frame => frame.type === "snapshot" ? frame.timeline.items : frame.events.flatMap(event => event.type === "entry_appended" || event.type === "message_end" ? [event.entry] : []));
  return [...new Map(all.map(entry => [entry.entry, entry])).values()];
}
async function fixture(t: TestContext, hold?: { main?: ReturnType<typeof gate>; report?: ReturnType<typeof gate> }) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-desktop-loop-")), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  let holdMain = false, firstDelegate = true, reportStarted = false;
  const model = new PersonalMockModelServer(async request => {
    const last = request.messages.at(-1), text = String(last?.content);
    if (child(request)) {
      if (last?.role === "user" && text.startsWith("tool:")) {
        const call = JSON.parse(text.slice(5)) as { name: string; args: Record<string, unknown> };
        return { kind: "tool_calls", calls: [{ id: "ordinary-operation", name: call.name, arguments: call.args }] };
      }
      return { kind: "text", text };
    }
    if (summary(request)) { reportStarted = true; await hold?.report?.promise; return { kind: "text", text: "CURRENT_PUBLICATION" }; }
    if (last?.role === "tool") {
      if (holdMain) { holdMain = false; await hold?.main?.promise; }
      return { kind: "text", text: `Grounded: ${text}` };
    }
    const input = text.replace(/^【本轮拥有者输入，独立于此前宿主汇总参考】\n/, "").replace(/\n【本轮拥有者输入结束】$/, "");
    if (!input.startsWith("{")) return { kind: "text", text: `Ordinary: ${input}` };
    const action = JSON.parse(input) as { action: string; [key: string]: unknown };
    const calls = [{ id: "owner-action", name: "background_work", arguments: action }];
    if (action.action === "delegate" && firstDelegate && hold?.main) { firstDelegate = false; holdMain = true; calls.push({ id: "owner-query", name: "background_work", arguments: { action: "list" } }); }
    return { kind: "tool_calls", calls };
  });
  const apiKeyEnv = "PERSONAL_DESKTOP_LOOP_KEY", previous = process.env[apiKeyEnv]; process.env[apiKeyEnv] = "test-only";
  const clients: WebSocket[] = [];
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => { for (const client of clients) client.terminate(); await server?.stop(); await model.close(); if (previous === undefined) delete process.env[apiKeyEnv]; else process.env[apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  isolateSkillHome(t);
  await savePersonalConfig(directory, { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv, contextWindow: 128000, maxTokens: 8192 });
  const identity = fs.statSync(workspace);
  await savePersonalTools(directory, { version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  server = await startPersonalServer(directory, { development: true });
  await personalControl(directory, "POST", "/permissions", { mode: "confirm" });
  const requestIds = new Map<string, string>();
  const requestId = (name: string) => { let id = requestIds.get(name); if (!id) { id = randomUUID(); requestIds.set(name, id); } return id; };
  const read = <T>(route: string) => personalControl<T>(directory, "GET", route.replace(/requestId=([^&]+)/, (_match, name: string) => `requestId=${requestId(name)}`));
  const connect = async () => {
    const client = new WebSocket(`ws+unix:${path.join(directory, "control.sock")}:/events`, { headers: { authorization: `Bearer ${readPersonalToken(directory)}` } }), frames: PersonalDesktopFrame[] = [];
    clients.push(client); client.on("message", data => frames.push(JSON.parse(data.toString()) as PersonalDesktopFrame));
    await once(client, "open"); await until(() => frames.length > 0);
    return { client, frames };
  };
  const send = (name: string, action: Record<string, unknown>) => personalControl<PersonalInputStatus>(directory, "POST", "/inputs", { requestId: requestId(name), input: JSON.stringify(action) });
  const answer = async (requestId: string) => { let input: PersonalInputStatus | undefined; await until(async () => { input = await read(`/input?requestId=${requestId}`); return input?.status === "done"; }); return input!; };
  const decide = (operation: number) => personalControl(directory, "POST", "/tools/decide", { operation: operation as TaskId, decision: "approved" });
  const parameters = async (operation: number) => {
    let text = "", offset: number | undefined = 0, first: PersonalDesktopOperation | undefined;
    while (offset !== undefined) { const page: PersonalDesktopOperation = await read(`/desktop/operation?operation=${operation}&offset=${offset}`); first ??= page; assert.equal(page.admission, first.admission); text += page.text; offset = page.nextOffset; }
    return { value: JSON.parse(text) as Record<string, unknown>, first: first! };
  };
  return { root, directory, outside, model, read, send, answer, decide, parameters, connect, requestId, get reportStarted() { return reportStarted; } };
}

test("Personal desktop file loop: child cards precede final prose, amendments retain old decisions, and one write is published", { timeout: 60_000 }, async t => {
  const main = gate(t), report = gate(t), f = await fixture(t, { main, report }), live = await f.connect();
  const oldPath = path.join(f.outside, "old.txt"), currentPath = path.join(f.outside, "current.txt");
  fs.writeFileSync(oldPath, "UNCHANGED"); fs.writeFileSync(currentPath, "UNCHANGED");
  const assignment = { action: "delegate", content: tool("write_file", { path: oldPath, content: "OLD" }) };
  await f.send("assign", assignment);
  await until(() => state(live.frames).approvals.items.some(card => card.canDecide));
  const old = state(live.frames).approvals.items[0], work = state(live.frames).works.items[0];
  assert.equal((await f.read<PersonalInputStatus>("/input?requestId=assign")).status, "placed");
  assert.equal(entries(live.frames).some(entry => entry.role === "assistant" && entry.text.trim()), false);
  assert.equal(entries(live.frames).find(entry => entry.input?.requestId === f.requestId("assign"))?.text, JSON.stringify(assignment));
  main.release(); await f.answer("assign");
  await f.send("query", { action: "operations", work: work.ref.taskId }); assert.match((await f.answer("query")).answer!, /Grounded:.*operations/);
  assert.equal(state(live.frames).approvals.items.find(card => card.operation === old.operation)?.canDecide, true);
  await f.send("redisplay", { action: "redisplay", operation: old.operation }); await f.answer("redisplay");
  await until(() => state(live.frames).approvals.items.filter(card => card.operation === old.operation).length === 2);
  assert.deepEqual((await f.parameters(old.operation)).value, { target: oldPath, params: { path: oldPath, content: "OLD" } });
  await f.send("amend", { action: "append", work: work.ref.taskId, content: tool("write_file", { path: currentPath, content: "CURRENT" }) }); await f.answer("amend");
  await until(() => state(live.frames).approvals.items.some(card => card.operation !== old.operation && card.canDecide));
  const amended = state(live.frames), fresh = amended.approvals.items.find(card => card.operation !== old.operation && card.canDecide)!;
  assert.equal(fresh.work, work.ref.taskId); assert.deepEqual(amended.works.items[0].ref, work.ref);
  for (const stale of amended.approvals.items.filter(card => card.operation === old.operation)) { assert.equal(stale.canDecide, false); assert.equal(stale.code, "tool_requirements_changed"); assert.equal(stale.effect, "not_executed"); assert.equal(stale.started, false); assert.match(stale.notice!, /要求已更新.*没有执行/); }
  assert.equal(amended.works.items[0].progress.accepted, 2); assert.ok(amended.works.items[0].progress.modelRead <= 2); assert.ok(amended.works.items[0].progress.completed < 2);
  await assert.rejects(f.decide(old.operation), error => error instanceof PersonalError && error.code === "tool_decision_invalid");
  assert.deepEqual((await f.parameters(fresh.operation)).value, { target: currentPath, params: { path: currentPath, content: "CURRENT" } });
  const decisions = await Promise.allSettled([f.decide(fresh.operation), f.decide(fresh.operation)]);
  assert.equal(decisions.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(decisions.some(result => result.status === "rejected" && result.reason instanceof PersonalError && result.reason.code === "tool_decision_invalid"));
  await until(() => f.reportStarted);
  assert.equal(entries(live.frames).some(entry => entry.kind === "ruukoto.report-publication"), false);
  report.release(); await until(() => entries(live.frames).some(entry => entry.kind === "ruukoto.report-publication"));
  await until(() => state(live.frames).works.items.find(item => item.ref.taskId === work.ref.taskId)?.progress.completed === 2);
  const published = entries(live.frames).filter(entry => entry.kind === "ruukoto.report-publication"); assert.equal(published.length, 1); assert.equal(published[0].text, "CURRENT_PUBLICATION");
  const completed = state(live.frames); assert.equal(completed.approvals.items.filter(card => card.started).length, 1); assert.equal(completed.delegations.items[0].report?.publication, published[0].entry);
  assert.deepEqual(completed.works.items[0].progress, { accepted: 2, modelRead: 2, completed: 2, accounted: 2 });
  assert.equal(fs.readFileSync(oldPath, "utf8"), "UNCHANGED"); assert.equal(fs.readFileSync(currentPath, "utf8"), "CURRENT");
  const replay = await f.connect(), timeline = await f.read<PersonalTimelinePage>("/timeline");
  assert.equal(entries(replay.frames).filter(entry => entry.kind === "ruukoto.report-publication").length, 1);
  assert.equal(timeline.items.filter(entry => entry.input?.requestId === f.requestId("assign")).length, 1);
  assert.equal(timeline.items.some(entry => entry.role === "user" && entry.text.startsWith("宿主委托汇总参考")), false);
  const input = await f.read<{ entry: PersonalTimelineEntry }>("/desktop/input?requestId=assign"); assert.equal(input.entry.entry, timeline.items.find(entry => entry.input?.requestId === f.requestId("assign"))?.entry); assert.ok(input.entry.input?.historyEntry);
  await f.send("assign", assignment);
  assert.equal((await f.read<PersonalDesktopState>("/desktop/state")).works.total, 1);
  assert.equal((await f.read<PersonalDesktopState>("/desktop/state")).approvals.items.filter(card => card.started).length, 1);
});

test("Personal desktop whole-work cancellation keeps main responsive and never starts a held write", { timeout: 60_000 }, async t => {
  const f = await fixture(t), live = await f.connect(), target = path.join(f.outside, "canceled.txt"); fs.writeFileSync(target, "UNCHANGED");
  await f.send("assign", { action: "delegate", content: tool("write_file", { path: target, content: "DO_NOT_WRITE" }) }); await f.answer("assign");
  await until(() => state(live.frames).approvals.items.some(card => card.canDecide));
  const card = state(live.frames).approvals.items[0], work = state(live.frames).works.items[0];
  await f.send("cancel", { action: "cancel", work: work.ref.taskId }); await f.answer("cancel");
  await until(() => state(live.frames).works.items.find(item => item.ref.taskId === work.ref.taskId)?.cancelRequested === true);
  await f.send("query", { action: "result", work: work.ref.taskId }); assert.match((await f.answer("query")).answer!, /Grounded:/);
  await until(() => state(live.frames).works.items.find(item => item.ref.taskId === work.ref.taskId)?.stopVerified === true);
  const stopped = state(live.frames).works.items.find(item => item.ref.taskId === work.ref.taskId)!; assert.equal(stopped.cancelRequested, true); assert.equal(stopped.closed, false);
  assert.equal(state(live.frames).approvals.items.find(item => item.operation === card.operation)?.canDecide, false);
  await assert.rejects(f.decide(card.operation), error => error instanceof PersonalError && ["tool_decision_invalid", "tool_source_invalid", "tool_work_inactive"].includes(error.code));
  assert.equal(fs.readFileSync(target, "utf8"), "UNCHANGED"); assert.equal(state(live.frames).approvals.items.some(item => item.started), false);
});

test("Native cancellation crosses the authenticated HTTPS remote with JSON and cancels the whole assignment", { timeout: 60_000 }, async t => {
  const f = await fixture(t), target = path.join(f.outside, "cancel-native.txt"); fs.writeFileSync(target, "UNCHANGED");
  let remote: Awaited<ReturnType<typeof startPersonalRemote>> | undefined;
  const owner = "fixture@example.invalid", sockets = new Set<Duplex>();
  const proxy = https.createServer({ key: personalTestKey, cert: personalTestCertificate }, (request, response) => {
    const upstream = http.request({ socketPath: remote!.socketPath, path: request.url, method: request.method, headers: { ...request.headers, "tailscale-user-login": owner } }, result => { response.writeHead(result.statusCode!, result.headers); result.pipe(response); });
    upstream.on("error", () => response.destroy()); request.pipe(upstream);
  });
  proxy.on("upgrade", (request, socket, head) => {
    const upstream = net.createConnection(remote!.socketPath); sockets.add(upstream); sockets.add(socket);
    upstream.once("connect", () => {
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n` + Object.entries({ ...request.headers, "tailscale-user-login": owner }).map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
    upstream.once("close", () => { sockets.delete(upstream); socket.destroy(); }); socket.once("close", () => { sockets.delete(socket); upstream.destroy(); });
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const origin = `https://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, userData = path.join(f.root, "desktop"); fs.mkdirSync(userData, { mode: 0o700 });
  const agent = new https.Agent({ ca: personalTestCertificate }), requests: { method: unknown; path: unknown }[] = [];
  let credentials: string | null = null, renderer: PersonalState;
  const controller = new PersonalController({ v: 1, origin }, userData, update => renderer.update(update), { read: async () => credentials, write: async value => { credentials = value; }, remove: async () => { credentials = null; } }, { agent });
  renderer = new PersonalState({ request: async (_target, op, params) => {
    if (op === "desktop_personal_input_reconcile") return { ok: true, value: await controller.reconcileInput() };
    assert.equal(op, "desktop_personal_request"); requests.push({ method: params.method, path: params.path });
    try { return { ok: true, value: await controller.business(params.method, params.path, params.body) }; }
    catch (error) { return { ok: false, error: { code: "request_failed", message: error instanceof Error ? error.message : "Request failed", outcome: "rejected" } }; }
  } }, () => {});
  t.after(async () => { renderer.dispose(); await controller.close(); for (const socket of sockets) socket.destroy(); await remote?.stop(); agent.destroy(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  await initializePersonalRemote({ v: 1, origin, owner, profile: personalSettingsDirectoryIdentity(f.directory) }, () => f.root);
  remote = await startPersonalRemote({ home: () => f.root });
  const opened = await new Promise<{ result: { code: string } }>((resolve, reject) => {
    const request = http.request({ socketPath: remote!.adminPath, path: "/pair/open", method: "POST", headers: { "content-type": "application/json" } }, response => { const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.once("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString()))); });
    request.on("error", reject); request.end("{}");
  });
  await controller.pair(opened.result.code, "Native cancellation fixture"); await until(() => renderer.online);
  await f.send("assign-native", { action: "delegate", content: tool("write_file", { path: target, content: "DO_NOT_WRITE" }) }); await f.answer("assign-native");
  await until(() => renderer.delegations.length > 0 && [...renderer.cards.values()].some(card => card.canDecide));
  const group = renderer.delegations[0], work = renderer.works[0];
  await renderer.cancelDelegation(group);
  assert.equal(renderer.message, null);
  await until(() => renderer.delegations.find(value => value.ref.entryId === group.ref.entryId)?.state === "canceled");
  assert.equal(requests.filter(request => request.method === "POST" && request.path === `/delegation/cancel?delegation=${group.ref.entryId}`).length, 1);
  assert.equal(renderer.works.find(value => value.ref.taskId === work.ref.taskId)?.cancelRequested, true);
  assert.equal([...renderer.cards.values()].some(card => card.canDecide || card.started), false); assert.equal(fs.readFileSync(target, "utf8"), "UNCHANGED");
  assert.deepEqual(await controller.business("POST", `/work/cancel?work=${work.ref.taskId}`), { cancelRequested: true });
});

test("Personal desktop HTTP loop: held old approval is superseded and main answers while the current request waits", { timeout: 60_000 }, async t => {
  const response = gate(t), hits: string[] = [];
  const endpoint = http.createServer(async (request, reply) => { request.resume(); hits.push(request.url!); await response.promise; reply.end("CURRENT_HTTP_RESULT"); });
  endpoint.listen(0, "127.0.0.1"); await once(endpoint, "listening");
  t.after(async () => { endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve())); });
  const url = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`;
  const f = await fixture(t), live = await f.connect();
  await f.send("assign", { action: "delegate", content: tool("http_request", { url: `${url}/old`, method: "POST", body: "OLD" }) }); await f.answer("assign");
  await until(() => state(live.frames).approvals.items.some(card => card.canDecide));
  const old = state(live.frames).approvals.items[0], work = state(live.frames).works.items[0];
  await f.send("query-held", { action: "operations", work: work.ref.taskId }); assert.match((await f.answer("query-held")).answer!, /Grounded:.*operations/);
  assert.equal(state(live.frames).approvals.items.find(card => card.operation === old.operation)?.canDecide, true); assert.deepEqual(hits, []);
  await f.send("amend", { action: "append", work: work.ref.taskId, content: tool("http_request", { url: `${url}/current`, method: "POST", body: "CURRENT" }) }); await f.answer("amend");
  await until(() => state(live.frames).approvals.items.some(card => card.operation !== old.operation && card.canDecide));
  const fresh = state(live.frames).approvals.items.find(card => card.operation !== old.operation && card.canDecide)!;
  const stale = state(live.frames).approvals.items.find(card => card.operation === old.operation)!; assert.equal(stale.effect, "not_executed"); assert.match(stale.notice!, /要求已更新.*没有执行/); assert.equal(stale.canDecide, false);
  await assert.rejects(f.decide(old.operation), error => error instanceof PersonalError && error.code === "tool_decision_invalid"); assert.deepEqual(hits, []);
  assert.deepEqual((await f.parameters(fresh.operation)).value, { target: `${url}/current`, params: { url: `${url}/current`, method: "POST", body: "CURRENT" } });
  await f.decide(fresh.operation); await until(() => hits.length === 1);
  await f.send("query-running", { action: "operation", operation: fresh.operation }); assert.match((await f.answer("query-running")).answer!, /Grounded:.*started/);
  const running = (await f.parameters(fresh.operation)).first.summary; assert.equal(running.started, true); assert.equal(running.observed, false); assert.equal(running.stopped, false);
  response.release(); await until(() => state(live.frames).approvals.items.find(card => card.operation === fresh.operation)?.effect === "returned");
  assert.deepEqual(hits, ["/current"]); await until(() => entries(live.frames).some(entry => entry.kind === "ruukoto.report-publication"));
});
