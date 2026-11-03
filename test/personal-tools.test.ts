import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { isDeepStrictEqual, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { AgentDoc, ROOT_CONVERSATION_ID, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalToolDoc, PersonalToolsDoc, toolOperations, toolDecide, toolGrant, toolRevoke, toolResolve, toolVerifyStop, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { personalControl, startPersonalServer, type PersonalInputStatus } from "../apps/ruukoto/src/personal-control.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { savePersonalTools, parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { personalServiceSourceBlocker } from "../apps/ruukoto/src/personal-service-operations.ts";
import { personalWorkResult } from "../apps/ruukoto/src/personal-work.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { readPersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { openPersonalFileIo, personalFileIoJobs, type PersonalFileIo, type PersonalFileJobMeta } from "../apps/ruukoto/src/personal-file-io.ts";
import { PersonalMockModelServer as MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
let fixtureIndex = 0;
const invoke = (name: string, args: Record<string, unknown>) => `tool:${JSON.stringify({ name, args })}`;
const reviewRequest = (request: RecordedRequest) => request.system?.includes("审批审查员") === true;
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10_000; while (!await check()) { assert.ok(Date.now() < end, "等待通用工具状态超时"); await delay(5); } }
const respond: Responder = request => {
  if (reviewRequest(request)) return { kind: "text", text: '{"decision":"approve","reason":"与原请求相关的明确读取"}' };
  const last = request.messages.at(-1), text = String(last?.content);
  if (last?.role === "user" && text.startsWith("tool:")) {
    const { name, args } = JSON.parse(text.slice(5)) as { name: string; args: Record<string, unknown> };
    return { kind: "tool_calls", calls: [{ id: "general-call", name, arguments: args }] };
  }
  return { kind: "text", text: last?.role === "tool" ? text : "完成" };
};

async function fixture(t: TestContext, responder = respond, reviewError = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-tools-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  const model = new MockModelServer(responder), config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_TOOLS_MODEL_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "tools-test-first", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  const options = { directory, provider: personalProvider(config), modelId: config.modelId, tools }, index = ++fixtureIndex;
  if (reviewError) {
    const original = options.provider.streamSimple.bind(options.provider);
    options.provider.streamSimple = (model, input, settings) => {
      const stream = original(model, input, settings);
      if (JSON.stringify(input).includes("审批审查员")) {
        const push = stream.push.bind(stream);
        stream.push = event => push(event.type === "done" ? { type: "error", reason: "error", error: { ...event.message, stopReason: "error", errorMessage: "审查流未正常结束" } } : event);
      }
      return stream;
    };
  }
  let current: PersonalHarness | undefined;
  t.after(async () => {
    await current?.close(); await model.close();
    if (process.env.RUUKOTO_TOOLS_EVIDENCE) { fs.mkdirSync(process.env.RUUKOTO_TOOLS_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.RUUKOTO_TOOLS_EVIDENCE, `requests-${index}.json`), JSON.stringify({ test: t.name, requests: model.calls }, null, 2) + "\n"); }
    if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, workspace, outside, tools, model, config, options, async open(overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) { return current = await openPersonalHarness({ ...options, ...overrides }); } };
}
async function mode(p: PersonalHarness, mode: "auto-review" | "confirm" | "full_access") { await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = mode; doc.version++; }, context); }
async function operations(p: PersonalHarness) { return p.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context); }
async function record(p: PersonalHarness, id: TaskId) { return (await p.harness.snapshot(PersonalToolDoc, String(id), context))!.operation!; }
async function first(p: PersonalHarness) { await until(async () => (await operations(p)).length > 0); return (await operations(p))[0]; }
// 等待业务工具只保留在子 Agent：测试用委派工作驱动，与真实入口一致；子回答回显工具结果文本。
async function invoked(p: PersonalHarness, input: string, requestId: string, sourceRequestId: string, agentId?: ConversationId) {
  const work = await p.work.delegate({ requestId, sourceRequestId, content: input, ...(agentId === undefined ? {} : { agentId }) });
  await p.harness.waitForTask(work.taskId, context);
  let text = "", offset: number | undefined = 0;
  do { const page = await p.harness.commit(tx => personalWorkResult(tx, work, offset), context); text += page.text ?? ""; offset = page.nextOffset; } while (offset !== undefined);
  return { work, text };
}
async function remote(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${address.port}`;
}

test("durable 工具：网络与完全访问文件不检查无关资料目录或保护树", { timeout: 60_000 }, async t => {
  const f = await fixture(t), secret = "isolated-search-key", previous = process.env.TOOLS_SCOPE_TEST_KEY;
  process.env.TOOLS_SCOPE_TEST_KEY = secret;
  t.after(() => { if (previous === undefined) delete process.env.TOOLS_SCOPE_TEST_KEY; else process.env.TOOLS_SCOPE_TEST_KEY = previous; t.mock.restoreAll(); syncBuiltinESMExports(); });
  let searches = 0, requests = 0;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if ((input instanceof Request ? input.url : String(input)) !== "https://api.tavily.com/search") return originalFetch(input, init);
    searches++; assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    return new Response(JSON.stringify({ results: [{ url: "https://example.com/result", title: "结果", content: "摘要" }] }), { headers: { "content-type": "application/json" } });
  });
  const url = await remote(t, (_request, response) => { requests++; response.end("local-response"); });
  const p = await f.open({ tools: { ...f.tools, search: { apiKeyEnv: "TOOLS_SCOPE_TEST_KEY" } } });
  await p.answer("工具来源", "tools-src");
  const readdir = nodeFs.readdirSync;
  let scans = 0;
  t.mock.method(nodeFs, "readdirSync", (...args: Parameters<typeof nodeFs.readdirSync>) => {
    if (String(args[0]) === f.directory) { scans++; throw new Error("不应枚举无关保护树"); }
    return Reflect.apply(readdir, nodeFs, args);
  }); syncBuiltinESMExports();
  const target = path.join(f.outside, "data.txt"); fs.writeFileSync(target, "original");
  // 来源输入在接纳时冻结当前模式；每个模式先提交新来源，工作的权限才沿用该模式。
  for (const moved of [false, true]) {
    if (moved) fs.renameSync(f.workspace, f.workspace + "-moved");
    await mode(p, "full_access"); await p.answer("工具来源", `file-src-${moved}`);
    assert.equal(JSON.parse((await invoked(p, invoke("read_file", { path: target }), `read-${moved}`, `file-src-${moved}`)).text).code, "file_returned");
    assert.equal(JSON.parse((await invoked(p, invoke("write_file", { path: target, content: "updated" }), `write-${moved}`, `file-src-${moved}`)).text).code, "file_returned");
    for (const access of ["auto-review", "full_access"] as const) {
      await mode(p, access); await p.answer("工具来源", `net-src-${access}-${moved}`);
      assert.equal(JSON.parse((await invoked(p, invoke("http_request", { url }), `http-${access}-${moved}`, `net-src-${access}-${moved}`)).text).code, "http_returned");
      assert.equal(JSON.parse((await invoked(p, invoke("web_search", { query: "scope" }), `search-${access}-${moved}`, `net-src-${access}-${moved}`)).text).code, "returned");
    }
  }
  assert.equal(scans, 0); assert.equal(requests, 4); assert.equal(searches, 4); assert.equal(fs.readFileSync(target, "utf8"), "updated");
});

test("durable 完全访问检索：不扫描保护树，仍核实逻辑cwd身份", { timeout: 30_000 }, async t => {
  const f = await fixture(t), p = await f.open(); await mode(p, "full_access"); await p.answer("工具来源", "tools-src");
  fs.writeFileSync(path.join(f.outside, "visible.txt"), "visible");
  const readdir = nodeFs.readdirSync; let scans = 0;
  t.mock.method(nodeFs, "readdirSync", (...args: Parameters<typeof nodeFs.readdirSync>) => {
    if (String(args[0]) === f.directory) { scans++; throw new Error("不应枚举无关保护树"); }
    return Reflect.apply(readdir, nodeFs, args);
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const listed = JSON.parse((await invoked(p, invoke("list_files", { path: f.outside }), "full-search", "tools-src")).text);
  assert.equal(listed.effect, "returned"); assert.deepEqual(listed.result.entries, [{ path: "visible.txt" }]); assert.equal(scans, 0);
  fs.renameSync(f.workspace, f.workspace + "-original"); fs.mkdirSync(f.workspace);
  const changed = JSON.parse((await invoked(p, invoke("list_files", { path: f.outside }), "replaced-cwd", "tools-src")).text);
  assert.equal(changed.code, "tools_directory_changed"); assert.equal(changed.effect, "not_executed"); assert.equal(scans, 0);
});

test("durable 文件检索：资料根、撤权、子来源、原流产物与重开", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(); await p.answer("工具来源", "tools-src");
  fs.writeFileSync(path.join(f.workspace, "source.txt"), "needle first\nneedle second\n");
  fs.writeFileSync(path.join(f.outside, "private.txt"), "outside needle\n");
  const listed = JSON.parse((await invoked(p, invoke("list_files", {}), "list-source", "tools-src")).text) as { operation: TaskId; artifact: string; result: { root: string; scanComplete: boolean; entries: Array<{ path: string }> } };
  assert.equal(listed.result.root, f.workspace); assert.equal(listed.result.scanComplete, true); assert.deepEqual(listed.result.entries, [{ path: "source.txt" }]);
  const searched = await invoked(p, invoke("search_files", { query: "needle", limit: 1 }), "search-source", "tools-src");
  const found = JSON.parse(searched.text) as { artifact: string; result: { capturedCount: number; previewTruncated: boolean; partial: boolean; entries: Array<{ path: string; line: number }> } };
  assert.deepEqual(found.result.entries.map(value => [value.path, value.line]), [["source.txt", 1]]); assert.equal(found.result.capturedCount, 2); assert.equal(found.result.previewTruncated, true); assert.equal(found.result.partial, false);
  // 产物只对本会话可读：沿用产生产物的子 Agent 身份读取原流。
  assert.match((await invoked(p, invoke("read_artifact", { artifact: found.artifact }), "read-search-proof", "tools-src", searched.work.agentId)).text, /needle second/);
  assert.match((await invoked(p, invoke("list_files", { path: f.outside }), "deny-outside", "tools-src")).text, /file_search_path_denied/);
  assert.equal((await operations(p)).length, 2);
  await p.harness.commit(tx => toolGrant(tx, f.directory, f.outside), context);
  const granted = JSON.parse((await invoked(p, invoke("search_files", { path: f.outside, query: "outside" }), "granted-search", "tools-src")).text) as { result: { entries: Array<{ path: string }> } };
  assert.deepEqual(granted.result.entries.map(value => value.path), ["private.txt"]);
  await p.harness.commit(async tx => toolRevoke(tx, (await tx.doc(PersonalToolsDoc)).grants[0].id), context);
  assert.match((await invoked(p, invoke("list_files", { path: f.outside }), "revoked-search", "tools-src")).text, /file_search_path_denied/);
  await p.answer("检索子工作资料", "child-search-owner");
  const child = await p.work.delegate({ requestId: "child-search", sourceRequestId: "child-search-owner", content: invoke("search_files", { query: "needle" }) });
  await p.harness.waitForTask(child.taskId, context);
  const childOp = (await operations(p)).find(value => value.origin.conversationId === child.agentId)!;
  assert.equal(childOp.kind, "search_files"); assert.equal(childOp.effect, "returned"); assert.equal(childOp.origin.work!.ref.taskId, child.taskId);
  await p.close(); const restored = await f.open(); assert.equal((await operations(restored)).length, 4);
  const requests = f.model.calls.filter(request => request.messages.at(-1)?.role === "user");
  assert.ok(requests.some(request => JSON.stringify(request.tools).includes("list_files")));
  await restored.harness.commit(async tx => { const doc = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(doc.extensions)); doc.extensions = doc.extensions.filter(name => name !== "personal-file-search"); }, context);
  await restored.close(); await assert.rejects(f.open(), code("file_search_record_invalid"));
});

test("durable 通用工具：主子会话沿目录权限读写，二进制产物分页与请求输入可重建", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(), target = path.join(f.workspace, "data");
  await p.answer("工具来源", "tools-src");
  const bytes = Buffer.concat([Buffer.from([0, 255, 0xc3, 0x28]), Buffer.from("长原文".repeat(1500))]); fs.writeFileSync(target, bytes);
  const readCall = await invoked(p, invoke("read_file", { path: target }), "main-read", "tools-src");
  const read = JSON.parse(readCall.text) as { operation: TaskId; artifact: string; base64: string; nextOffset: number };
  const chunks = [Buffer.from(read.base64, "base64")];
  for (let offset: number | undefined = read.nextOffset; offset !== undefined;) {
    const page = JSON.parse((await invoked(p, invoke("read_artifact", { artifact: read.artifact, offset }), `artifact:${offset}`, "tools-src", readCall.work.agentId)).text) as { base64: string; nextOffset?: number };
    chunks.push(Buffer.from(page.base64, "base64")); offset = page.nextOffset;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.equal((await record(p, read.operation)).approval, "unneeded");
  assert.equal(JSON.parse((await invoked(p, invoke("write_file", { path: target, content: "主会话修改" }), "main-write", "tools-src")).text).effect, "returned");
  assert.equal(fs.readFileSync(target, "utf8"), "主会话修改");
  await p.answer("拥有者交给子工作读写", "owner-source");
  const childRead = await p.work.delegate({ requestId: "child-read", sourceRequestId: "owner-source", content: invoke("read_file", { path: target }) });
  await p.harness.waitForTask(childRead.taskId, context);
  const childWrite = await p.work.delegate({ requestId: "child-write", sourceRequestId: "owner-source", content: invoke("write_file", { path: target, content: "子会话修改" }), agentId: childRead.agentId });
  await p.harness.waitForTask(childWrite.taskId, context);
  assert.equal(fs.readFileSync(target, "utf8"), "子会话修改");
  const childOps = (await operations(p)).filter(value => value.origin.conversationId === childRead.agentId);
  assert.deepEqual(childOps.map(value => value.effect), ["returned", "returned"]); assert.deepEqual(childOps.map(value => value.origin.work!.ref.taskId), [childRead.taskId, childWrite.taskId]);
  for (const request of f.model.calls.filter(request => request.system?.includes("你是个人助手的子 Agent"))) assert.match(JSON.stringify(request.tools), /read_file/);
  for (const request of f.model.calls.filter(request => !request.system?.includes("你是个人助手的子 Agent"))) assert.doesNotMatch(JSON.stringify(request.tools), /read_file|write_file|http_request|web_search|read_artifact|list_files|search_files/);
  const entries = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const payloads = entries.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence).flatMap(value => value.payload === undefined ? [] : [value.payload]);
  const mainCalls = f.model.calls.filter(request => !request.system?.includes("你是个人助手的子 Agent"));
  const requests = mainCalls.map(request => request.raw);
  if (process.env.RUUKOTO_TOOLS_EVIDENCE) { fs.mkdirSync(process.env.RUUKOTO_TOOLS_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.RUUKOTO_TOOLS_EVIDENCE, "comparison.json"), JSON.stringify({ payloads, requests }, null, 2) + "\n"); }
  // 原生重试可在 HTTP 到达前重复准备同一 payload；快照记录不表示请求已送达。
  const adjacent = (values: unknown[]) => values.filter((value, index) => index === 0 || !isDeepStrictEqual(value, values[index - 1]));
  assert.deepEqual(adjacent(payloads), adjacent(requests));
  for (const request of requests) assert.ok(payloads.some(payload => isDeepStrictEqual(payload, request)));
  await p.close(); const reopened = await f.open(); assert.equal((await operations(reopened)).length, 4);
});

for (const outcome of ["approve", "reject", "invalid", "failure", "length", "error"] as const) test(`durable 自动审查：${outcome} 使用无工具独立请求，落盘输入与实际payload一致`, { timeout: 60_000 }, async t => {
  const f = await fixture(t, request => {
    if (!reviewRequest(request)) return respond(request, 0);
    if (outcome === "failure") throw new Error("审查服务不可用");
    if (outcome === "length") return { kind: "text", text: '{"decision":"approve","reason":"不能接受未完整结束的批准"}', finishReason: "length" };
    return { kind: "text", text: outcome === "invalid" ? "无效审查回复" : JSON.stringify({ decision: outcome === "error" ? "approve" : outcome, reason: "审查理由" }) };
  }, outcome === "error");
  const p = await f.open(), target = path.join(f.outside, "data"); fs.writeFileSync(target, "外部原文");
  await p.answer("工具来源", "tools-src");
  const input = invoke("read_file", { path: target }), answer = invoked(p, input, "review-source", "tools-src");
  void answer.catch(() => undefined);
  const initial = await first(p);
  await until(async () => !!(await record(p, initial.operation)).review?.decision);
  const reviewed = await record(p, initial.operation);
  if (outcome === "invalid" || outcome === "failure" || outcome === "length" || outcome === "error") {
    assert.equal(reviewed.review!.decision, "ask_owner"); assert.equal(reviewed.approval, "pending"); assert.equal(reviewed.started, false);
    await p.harness.commit(tx => toolDecide(tx, initial.operation, "rejected", f.directory), context);
  }
  const completed = await answer;
  const result = JSON.parse(completed.text) as { effect: string; preview?: string };
  assert.equal(result.effect, outcome === "approve" ? "returned" : "not_executed");
  if (outcome === "approve") assert.equal(result.preview, "外部原文");
  const calls = f.model.calls.filter(reviewRequest); assert.equal(calls.length, 1); assert.deepEqual(calls[0].tools ?? [], []);
  const child = (await p.harness.conversation(completed.work.agentId, context))!;
  const entries = (await child.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.tool-review");
  const payloads = entries.map(entry => entry.data).filter((data): data is { [key: string]: JsonValue } => !!data && typeof data === "object" && !Array.isArray(data) && "payload" in data);
  assert.equal(payloads.length, 1); assert.deepEqual(payloads[0].payload, calls[0].raw); assert.match(JSON.stringify(payloads[0].input), /外部原文|read_file/); assert.ok(JSON.stringify(payloads[0].input).includes("工具来源"));
  await p.close(); await f.open();
});

test("durable file review: pending owner approval survives restart", { timeout: 60_000 }, async t => {
  for (const changed of [false, true]) await t.test(changed ? "target changed while waiting" : "unchanged target", async t => {
    const f = await fixture(t, request => reviewRequest(request) ? { kind: "text", text: '{"decision":"ask_owner","reason":"Needs owner approval"}' } : respond(request, 0));
    fs.mkdirSync(f.directory);
    const workers: PersonalFileJobMeta[] = [];
    const open = () => f.open({ fileIo: openPersonalFileIo({ profile: fs.realpathSync(f.directory), workerProbe: (_worker, job) => workers.push(job) }) });
    const p = await open(), target = path.join(f.outside, "pending-review"), bytes = Buffer.from("owner-approved original bytes");
    fs.writeFileSync(target, bytes);
    assert.equal((await p.harness.snapshot(PersonalPermissionsDoc, context))!.mode, "auto-review");
    await p.answer("工具来源", "tools-src");
    const input = invoke("read_file", { path: target }), answer = invoked(p, input, "pending-review", "tools-src");
    void answer.catch(() => undefined);
    const initial = await first(p);
    await until(async () => { const value = await record(p, initial.operation); return value.review?.decision === "ask_owner" && value.approval === "pending"; });
    await until(async () => (await p.harness.commit(tx => personalFileIoJobs(tx), context)).every(job => job.exit !== undefined));
    const reviewed = await record(p, initial.operation), jobs = await p.harness.commit(tx => personalFileIoJobs(tx), context);
    assert.ok(reviewed.origin.work);
    const originalWork = reviewed.origin.work.ref;
    assert.equal(reviewed.started, false); assert.equal(reviewed.startEntry, undefined); assert.equal(reviewed.observation, undefined); assert.equal(reviewed.decisionEntry, undefined);
    assert.deepEqual(jobs.map(job => job.phase), ["prepare", "revalidate"]);
    assert.ok(jobs.every(job => job.operation === reviewed.operation));
    const revalidated = jobs.find(job => job.phase === "revalidate")!;
    assert.equal(revalidated.result?.ok, true); assert.equal(revalidated.settle?.outcome, "result"); assert.equal(revalidated.settle?.code, "returned");
    assert.ok(reviewed.review && revalidated.settle!.entry < reviewed.review.claim);
    assert.equal(workers.filter(job => job.phase === "execute").length, 0);
    assert.equal(f.model.calls.filter(reviewRequest).length, 1);
    if (changed) fs.writeFileSync(target, "modified while waiting for owner approval");
    await p.close(); await assert.rejects(answer);

    const reopened = await open(), restored = await record(reopened, reviewed.operation);
    assert.equal(restored.operation, reviewed.operation); assert.equal(restored.admission, reviewed.admission); assert.equal(restored.decisionEntry, reviewed.decisionEntry); assert.deepEqual(restored.review, reviewed.review);
    assert.deepEqual(restored.origin.work!.ref, originalWork); assert.equal((await reopened.work.status(originalWork)).task.id, originalWork.taskId);
    assert.equal(restored.approval, "pending");
    assert.equal(restored.observation, undefined, "Waiting for owner approval must not become a failed execution on restart.");
    assert.equal(restored.started, false); assert.equal(restored.startEntry, undefined);
    assert.equal((await reopened.harness.commit(tx => personalFileIoJobs(tx), context)).filter(job => job.phase === "execute").length, 0);
    assert.equal(f.model.calls.filter(reviewRequest).length, 1);
    const resumed = invoked(reopened, input, "pending-review", "tools-src");
    void resumed.catch(() => undefined);
    await until(async () => (await reopened.harness.getTask(restored.operation, context))?.state.status === "running");
    await reopened.harness.commit(tx => toolDecide(tx, restored.operation, "approved", f.directory), context);
    const completed = await resumed, result = JSON.parse(completed.text) as { operation: TaskId; effect: string; code: string; base64?: string };
    assert.deepEqual(completed.work, originalWork);
    assert.equal(result.operation, reviewed.operation); assert.equal(result.effect, changed ? "not_executed" : "returned"); assert.equal(result.code, changed ? "tool_target_changed" : "file_returned");
    if (changed) assert.equal(result.base64, undefined);
    else { assert.ok(result.base64); assert.deepEqual(Buffer.from(result.base64, "base64"), bytes); }
    const finished = await record(reopened, reviewed.operation);
    assert.equal(finished.admission, reviewed.admission); assert.equal(finished.approval, "approved"); assert.notEqual(finished.decisionEntry, undefined); assert.deepEqual(finished.review, reviewed.review); assert.deepEqual(finished.origin.work!.ref, originalWork);
    assert.equal(finished.started, !changed); if (changed) assert.equal(finished.startEntry, undefined);
    const completedJobs = await reopened.harness.commit(tx => personalFileIoJobs(tx), context), validations = completedJobs.filter(job => job.phase === "revalidate");
    assert.equal(validations.length, 2); assert.equal(validations[0].id, revalidated.id); assert.ok(validations[1].admission > finished.decisionEntry!);
    assert.equal(f.model.calls.filter(reviewRequest).length, 1); assert.equal(workers.filter(job => job.phase === "execute").length, changed ? 0 : 1);
    await reopened.close();
    const again = await open(), persisted = await record(again, reviewed.operation), replayed = await invoked(again, input, "pending-review", "tools-src");
    assert.equal(persisted.admission, reviewed.admission); assert.equal(persisted.observation, finished.observation); assert.equal(persisted.effect, result.effect); assert.equal(persisted.code, result.code); assert.deepEqual(persisted.review, reviewed.review);
    assert.deepEqual(replayed.work, originalWork); assert.equal(replayed.text, completed.text);
    assert.equal(f.model.calls.filter(reviewRequest).length, 1); assert.equal(workers.filter(job => job.phase === "execute").length, changed ? 0 : 1);
  });
});

test("durable 确认与资料授权：逐次批准消费一次，撤销后读取重新等待且旧批准失效", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(), target = path.join(f.outside, "data"); fs.writeFileSync(target, "owner-only"); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const answer = invoked(p, invoke("read_file", { path: target }), "approved", "tools-src");
  void answer.catch(() => undefined);
  const pending = await first(p); assert.equal(pending.started, false); assert.equal(pending.approval, "pending");
  await p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context);
  assert.equal(JSON.parse((await answer).text).preview, "owner-only");
  await assert.rejects(p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context), code("tool_decision_invalid"));
  await p.harness.commit(tx => toolGrant(tx, f.directory, f.outside), context);
  assert.equal(JSON.parse((await invoked(p, invoke("read_file", { path: target }), "granted", "tools-src")).text).approval, "unneeded");
  const id = (await p.harness.snapshot(PersonalToolsDoc, context))!.grants[0].id;
  await p.harness.commit(tx => toolRevoke(tx, id), context);
  const revokedAnswer = invoked(p, invoke("read_file", { path: target }), "revoked", "tools-src");
  void revokedAnswer.catch(() => undefined);
  await until(async () => (await operations(p)).length === 3);
  const revoked = (await operations(p))[2]; assert.equal(revoked.started, false); assert.equal(revoked.approval, "pending");
  await p.harness.commit(tx => toolGrant(tx, f.directory, f.outside), context);
  await assert.rejects(p.harness.commit(tx => toolDecide(tx, revoked.operation, "approved", f.directory), context), code("tool_permission_changed"));
  await p.close(); await revokedAnswer.then(() => undefined, () => undefined);
});

test("durable 产物：会话不能读其他会话产物，原字节损坏时恢复明确拒绝", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(), target = path.join(f.workspace, "data"); fs.writeFileSync(target, "original-bytes");
  await p.answer("工具来源", "tools-src");
  const firstRead = JSON.parse((await invoked(p, invoke("read_file", { path: target }), "artifact-source", "tools-src")).text) as { artifact: string };
  const work = await p.work.delegate({ requestId: "artifact-bypass", sourceRequestId: "tools-src", content: invoke("read_artifact", { artifact: firstRead.artifact }) });
  await p.harness.waitForTask(work.taskId, context);
  const result = await p.harness.commit(tx => personalWorkResult(tx, work), context); assert.match(result.text ?? "", /artifact_forbidden/);
  await p.close(); fs.writeFileSync(path.join(f.directory, "artifacts", `${firstRead.artifact}.bin`), "corrupt");
  await assert.rejects(f.open(), code("artifact_unavailable"));
});

test("durable HTTP：响应后观察提交前强杀，恢复不重发并暂停同来源新工作", { timeout: 60_000 }, async t => {
  let calls = 0;
  const endpoint = await remote(t, (_req, res) => { calls++; res.end("effect-applied"); }), f = await fixture(t);
  const input = invoke("http_request", { method: "POST", url: endpoint, body: "one-write" });
  const script = `
    import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
    import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
    import { PersonalPermissionsDoc } from './apps/ruukoto/src/personal-permissions.ts';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    const input = JSON.parse(process.env.RUUKOTO_TOOLS_CRASH);
    const p = await openPersonalHarness({directory:input.directory,provider:personalProvider(input.model),modelId:input.model.modelId,tools:input.tools,
      openStorage: async filename => {
        const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
        storage.commit = async (writes, context) => {
          const observation = writes.find(write => write.type === 'entry' && write.value.kind === 'ruukoto.tool-observation');
          if (observation) { process.stdout.write('observation-gap:'+JSON.stringify(observation.value.data)+'\\n'); await new Promise(() => {}); }
          return commit(writes, context);
        }; return storage;
      }});
    await p.harness.commit(async tx => {(await tx.doc(PersonalPermissionsDoc)).mode='full_access';}, BACKGROUND_CONTEXT);
    await p.answer('工具来源','owner-source');
    await p.work.delegate({requestId:'crash-tool',sourceRequestId:'owner-source',content:input.content});
  `;
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_TOOLS_CRASH: JSON.stringify({ directory: f.directory, model: f.config, tools: f.tools, content: input }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; worker.stdout.on("data", value => { output += String(value); }); worker.stderr.on("data", value => { errors += String(value); });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
  await until(() => { assert.equal(worker.exitCode, null, errors); return output.includes("observation-gap"); });
  const exit = once(worker, "exit"); worker.kill("SIGKILL"); await exit; assert.equal(calls, 1, output);
  const p = await f.open(), saved = await first(p);
  await until(async () => (await record(p, saved.operation)).code === "interrupted");
  const restored = await record(p, saved.operation);
  assert.equal(restored.effect, "effect_unknown"); assert.equal(restored.stopped, false); assert.equal(calls, 1);
  assert.deepEqual(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "owner-source"), context), { tool: String(saved.operation), admission: saved.admission });
  await assert.rejects(p.work.delegate({ requestId: "command-bypass", sourceRequestId: "owner-source", content: invoke("run_command", { command: "touch should-not-run" }) }), code("work_source_paused"));
  assert.equal(await p.answer("独立新工作仍可交谈", "independent"), "完成"); assert.equal(calls, 1);
  await p.harness.commit(tx => toolResolve(tx, saved.operation, "applied", "服务记录核实原写入已生效"), context);
  assert.ok(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "owner-source"), context));
  await p.harness.commit(tx => toolVerifyStop(tx, saved.operation, "服务管理侧核实原请求已结束"), context);
  assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "owner-source"), context), undefined);
  await p.close(); await f.open(); assert.equal(calls, 1);
});

test("durable 模型快照：主子三模式保留实际工具定义与启用前后估算", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  let p = await f.open({ tools: undefined });
  await p.answer("启用前基线", "before-source");
  const beforeMain = f.model.calls.at(-1)!;
  const beforeWork = await p.work.delegate({ requestId: "before-work", sourceRequestId: "before-source", content: "子快照" });
  await p.harness.waitForTask(beforeWork.taskId, context);
  const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent") === true;
  const beforeChild = f.model.calls.findLast(child)!;
  const estimate = (request: RecordedRequest) => ({ systemPrompt: Math.ceil((request.system?.length ?? 0) / 4), toolSchemas: Math.ceil(JSON.stringify(request.tools ?? []).length / 4) });
  const evidence: { before: { main: ReturnType<typeof estimate>; child: ReturnType<typeof estimate> }; after: Record<string, { main: ReturnType<typeof estimate>; child: ReturnType<typeof estimate> }> } = { before: { main: estimate(beforeMain), child: estimate(beforeChild) }, after: {} };
  await p.close(); p = await f.open();
  for (const access of ["auto-review", "confirm", "full_access"] as const) {
    await mode(p, access); await p.answer(`当前模式 ${access}`, `mode-${access}`);
    const mainCall = f.model.calls.findLast(request => !child(request))!;
    const work = await p.work.delegate({ requestId: `snapshot-${access}`, sourceRequestId: `mode-${access}`, content: "子快照", agentId: beforeWork.agentId });
    await p.harness.waitForTask(work.taskId, context);
    const childCall = f.model.calls.findLast(child)!;
    // 等待业务工具已移交子会话：主请求不再提供，子请求保留完整清单。
    for (const name of ["read_file", "write_file", "http_request", "web_search", "read_artifact"]) {
      assert.ok(JSON.stringify(childCall.tools).includes(JSON.stringify(name)));
      assert.ok(!JSON.stringify(mainCall.tools).includes(JSON.stringify(name)));
    }
    evidence.after[access] = { main: estimate(mainCall), child: estimate(childCall) };
  }
  for (const request of [beforeMain, beforeChild]) assert.doesNotMatch(JSON.stringify(request.tools ?? []), /read_file|write_file|http_request|web_search/);
  assert.doesNotMatch(JSON.stringify(beforeMain.tools ?? []), /read_artifact/);
  assert.ok(!beforeChild.tools?.some(tool => (tool.function as { name: string }).name === "read_artifact"));
  t.diagnostic(JSON.stringify({ estimatedTokens: evidence }));
});

test("durable HTTP：未知写入禁止原来源改用 MCP，独立来源可用同端点", { timeout: 60_000 }, async t => {
  let writes = 0, mcpRequests = 0;
  const endpoint = await remote(t, (req, res) => {
    if (req.url === "/write") { writes++; req.resume(); req.once("end", () => req.socket.destroy()); }
    else { mcpRequests++; res.writeHead(500).end(); }
  });
  const mcpArgs = { service: "test", tool: "act", arguments: {} };
  const f = await fixture(t, request => {
    const last = request.messages.at(-1);
    if (last?.role === "tool" && String(last.content).includes('"effect":"effect_unknown"')) return { kind: "tool_calls", calls: [{ id: "mcp-bypass", name: "mcp_call", arguments: mcpArgs }] };
    return respond(request, 0);
  });
  const mcp = parsePersonalMcp({ version: 4, generation: "test-mcp", services: [{ id: "test", label: "测试服务", endpoint: endpoint + "/mcp", enabled: true, tools: [{ name: "act", inputSchema: { type: "object", properties: {}, additionalProperties: false } }], toolEffects: { act: "unknown" } }] });
  const p = await f.open({ mcp }); await mode(p, "full_access"); await p.answer("工具来源", "tools-src");
  // 原工作在自己的未知写入核实前被暂停：子会话的下一个模型请求在准备阶段被拒绝，MCP 绕行永远到不了端点。
  await p.work.delegate({ requestId: "source", sourceRequestId: "tools-src", content: invoke("http_request", { url: endpoint + "/write", method: "POST", body: "write" }) });
  await until(async () => !!(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "tools-src"), context)) && writes === 1);
  assert.equal(writes, 1); assert.equal(mcpRequests, 0);
  assert.match(await p.answer(invoke("mcp_call", mcpArgs), "independent-same-endpoint"), /connect_failed/);
  assert.ok(mcpRequests > 0); assert.equal((await first(p)).effect, "effect_unknown");
});

test("durable 工具恢复：SDK转换后的数字文本写入与原始调用可跨重启核实", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(), target = path.join(f.workspace, "data"); fs.writeFileSync(target, "before");
  await p.answer("工具来源", "tools-src");
  const result = JSON.parse((await invoked(p, invoke("write_file", { path: target, content: 123 }), "coerced-write", "tools-src")).text) as { operation: TaskId; effect: string };
  assert.equal(result.effect, "returned"); assert.equal(fs.readFileSync(target, "utf8"), "123");
  assert.equal((await record(p, result.operation)).params.content, "123");
  await p.close(); const restored = await f.open(); assert.equal((await record(restored, result.operation)).effect, "returned"); assert.equal(fs.readFileSync(target, "utf8"), "123");
});

test("durable 搜索：SDK失败意图计入5次额度，普通视图有界且原JSON可核实", { timeout: 60_000 }, async t => {
  const secret = "search-test-private-key", previous = process.env.TOOLS_SEARCH_TEST_KEY; process.env.TOOLS_SEARCH_TEST_KEY = secret;
  t.after(() => { if (previous === undefined) delete process.env.TOOLS_SEARCH_TEST_KEY; else process.env.TOOLS_SEARCH_TEST_KEY = previous; });
  let fetches = 0;
  const raw: string[] = [], originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target !== "https://api.tavily.com/search") return originalFetch(input, init);
    fetches++; assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    const results = Array.from({ length: 7 }, (_, index) => ({ url: `https://example.com/${index}`, title: `标题${index}`, content: "长摘要".repeat(1000), published_date: "2026-10-17" }));
    if (query === "invalid-url") results[0].url = "javascript:dangerous";
    const body = JSON.stringify({ request_id: `search-${fetches}`, results, provider_metadata: "原始字段保留" }); raw.push(body);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  });
  const f = await fixture(t, request => {
    if (request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "five-invalid-then-valid") return { kind: "tool_calls", calls: [...Array.from({ length: 5 }, (_, index) => ({ id: `invalid-${index}`, name: "web_search", arguments: { query: "q", max_results: 0 } })), { id: "legal-sixth", name: "web_search", arguments: { query: "q" } }] };
    return respond(request, 0);
  });
  const tools = parsePersonalTools({ ...f.tools, search: { apiKeyEnv: "TOOLS_SEARCH_TEST_KEY" } }), p = await f.open({ tools });
  await p.answer("工具来源", "tools-src");
  assert.match((await invoked(p, "five-invalid-then-valid", "quota-source", "tools-src")).text, /search_limit/); assert.equal(fetches, 0);
  const first = JSON.parse((await invoked(p, invoke("web_search", { query: "valid" }), "search-valid", "tools-src")).text) as { operation: TaskId; artifact: string; result: { items: { url: string; summary: string }[]; totalResults: number; fieldsTruncated: boolean }; preview?: string; base64?: string };
  assert.equal(first.result.items.length, 5); assert.equal(first.result.totalResults, 7); assert.equal(first.result.fieldsTruncated, true); assert.equal(first.preview, undefined); assert.equal(first.base64, undefined);
  assert.ok(first.result.items.every(item => item.summary.length === 2000));
  const second = JSON.parse((await invoked(p, invoke("web_search", { query: "invalid-url" }), "search-invalid-url", "tools-src")).text) as { result: { items: { url: string }[]; dropped: number } };
  assert.equal(second.result.items.length, 4); assert.equal(second.result.dropped, 1); assert.ok(second.result.items.every(item => item.url.startsWith("https://"))); assert.equal(fetches, 2);
  const saved = await record(p, first.operation); assert.deepEqual(saved.view, first.result);
  const chunks: Buffer[] = []; let offset: number | undefined = 0;
  do { const page = await readPersonalArtifact(f.directory, saved.artifact!, offset); chunks.push(Buffer.from(page.base64, "base64")); offset = page.nextOffset; } while (offset !== undefined);
  assert.equal(Buffer.concat(chunks).toString(), raw[0]); assert.ok(raw[0].includes("原始字段保留"));
  await p.close(); await f.open({ tools }); assert.equal(fetches, 2);
});

test("durable 审查证据：独立损坏档案启动拒绝且不增加模型请求", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(), target = path.join(f.outside, "data"); fs.writeFileSync(target, "reviewed");
  await p.answer("工具来源", "tools-src");
  const result = JSON.parse((await invoked(p, invoke("read_file", { path: target }), "review-source", "tools-src")).text) as { operation: TaskId; effect: string };
  assert.equal(result.effect, "returned");
  const payloadEntry = (await record(p, result.operation)).review?.payloadEntry; assert.ok(payloadEntry);
  await p.close();
  const database = path.join(f.directory, "personal.sqlite"), snapshot = path.join(f.root, "baseline.sqlite"), requests = f.model.calls.length;
  fs.copyFileSync(database, snapshot);
  for (const damage of ["missing", "payload"] as const) await t.test(damage, async () => {
    fs.copyFileSync(snapshot, database);
    if (damage === "missing") {
      const restored = await f.open();
      await restored.harness.commit(async tx => { delete (await tx.doc(PersonalToolDoc, String(result.operation), null)).operation!.review!.payloadEntry; }, context);
      await restored.close();
    } else {
      const db = new DatabaseSync(database);
      try {
        assert.equal(db.prepare("UPDATE entries SET record = json_remove(record, '$.data.payload') WHERE id = ? AND json_type(record, '$.data.payload') IS NOT NULL").run(payloadEntry).changes, 1);
      } finally { db.close(); }
    }
    await assert.rejects(f.open(), code("tool_record_invalid"));
    assert.equal(f.model.calls.length, requests);
  });
});

test("durable 文件写入：写后强杀保留未知，原同步调用已结束且不再次改写", { timeout: 60_000 }, async t => {
  const f = await fixture(t), target = path.join(f.workspace, "write-once"); fs.writeFileSync(target, "原文");
  const script = `
    import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
    import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
    import { PersonalPermissionsDoc } from './apps/ruukoto/src/personal-permissions.ts';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    const input = JSON.parse(process.env.RUUKOTO_TOOLS_CRASH);
    const p = await openPersonalHarness({directory:input.directory,provider:personalProvider(input.model),modelId:input.model.modelId,tools:input.tools,
      openStorage: async filename => {
        const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
        storage.commit = async (writes, context) => {
          if (writes.some(write => write.type === 'entry' && write.value.kind === 'ruukoto.tool-observation')) { process.stdout.write('file-observation-gap\\n'); await new Promise(() => {}); }
          return commit(writes, context);
        }; return storage;
      }});
    await p.harness.commit(async tx => {(await tx.doc(PersonalPermissionsDoc)).mode='full_access';}, BACKGROUND_CONTEXT);
    await p.answer('工具来源','file-owner-source');
    await p.work.delegate({requestId:'write-tool',sourceRequestId:'file-owner-source',content:input.content});
  `;
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_TOOLS_CRASH: JSON.stringify({ directory: f.directory, model: f.config, tools: f.tools, content: invoke("write_file", { path: target, content: "已写入一次" }) }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; worker.stdout.on("data", value => { output += String(value); }); worker.stderr.on("data", value => { errors += String(value); });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
  await until(() => { assert.equal(worker.exitCode, null, errors); return output.includes("file-observation-gap"); });
  assert.equal(fs.readFileSync(target, "utf8"), "已写入一次");
  const exit = once(worker, "exit"); worker.kill("SIGKILL"); await exit;
  fs.writeFileSync(target, "拥有者独立核实后保留的内容");
  const p = await f.open(), value = await first(p);
  await until(async () => (await record(p, value.operation)).code === "interrupted");
  const restored = await record(p, value.operation);
  assert.equal(restored.effect, "effect_unknown"); assert.equal(restored.stopped, true);
  assert.equal(fs.readFileSync(target, "utf8"), "拥有者独立核实后保留的内容");
  assert.ok(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "file-owner-source"), context));
  await p.harness.commit(tx => toolResolve(tx, value.operation, "applied", "核实原文件已写入，后续内容由拥有者另行修改"), context);
  assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "file-owner-source"), context), undefined);
});

test("durable 本机入口：真实认证接口完成工具审批、授权撤销与原产物导出", { timeout: 60_000 }, async t => {
  const f = await fixture(t), target = path.join(f.outside, "api-source"); fs.writeFileSync(target, "本机接口原字节");
  const p = await f.open(); await mode(p, "confirm"); await p.close();
  await savePersonalConfig(f.directory, f.config); await savePersonalTools(f.directory, f.tools);
  const server = await startPersonalServer(f.directory);
  try {
    const requestId = randomUUID();
    // 业务工具由主输入的委派批让出后落到子工作执行；原输入以交接事实收尾。
    await personalControl(f.directory, "POST", "/inputs", { requestId, input: invoke("background_work", { action: "delegate", content: invoke("read_file", { path: target }) }) });
    let id: TaskId | undefined;
    await until(async () => { const page = await personalControl<{ items: Array<{ operation: TaskId; canDecide: boolean }> }>(f.directory, "GET", "/tools/operations?offset=0"); id = page.items[0]?.operation; return !!page.items[0]?.canDecide; });
    const detail = await personalControl<{ summary: { operation: TaskId }; text: string }>(f.directory, "GET", `/tools/operation?operation=${id}&offset=0`);
    assert.equal(detail.summary.operation, id); assert.ok(detail.text);
    // 审批后工具会同步核实文件，真实客户端进程独立消费已提交应答。
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      `import { personalControl } from ${JSON.stringify(new URL("../apps/ruukoto/src/personal-control.ts", import.meta.url).href)}; await personalControl(process.argv[1], "POST", "/tools/decide", { operation: Number(process.argv[2]), decision: "approved" });`,
      f.directory, String(id),
    ], { signal: t.signal, timeout: 15_000, killSignal: "SIGKILL" });
    await until(async () => (await personalControl<PersonalInputStatus>(f.directory, "GET", `/input?requestId=${requestId}`)).status === "done");
    let artifacts: { items: Array<{ artifact: string; partial: boolean }> } = { items: [] };
    await until(async () => { artifacts = await personalControl<{ items: Array<{ artifact: string; partial: boolean }> }>(f.directory, "GET", "/tools/artifacts?offset=0"); return artifacts.items.length === 1; });
    assert.equal(artifacts.items[0].partial, false);
    const destination = path.join(f.root, "api-export");
    await personalControl(f.directory, "POST", "/tools/export", { artifact: artifacts.items[0].artifact, destination });
    assert.equal(fs.readFileSync(destination, "utf8"), "本机接口原字节");
    await assert.rejects(personalControl(f.directory, "POST", "/tools/export", { artifact: artifacts.items[0].artifact, destination }), code("artifact_destination_exists"));
    await personalControl(f.directory, "POST", "/tools/grant", { path: f.outside });
    const grants = await personalControl<{ items: Array<{ id: string; revoked: boolean }> }>(f.directory, "GET", "/tools/grants?offset=0");
    assert.equal(grants.items.length, 1); assert.equal(grants.items[0].revoked, false);
    await personalControl(f.directory, "POST", "/tools/revoke", { id: grants.items[0].id });
    assert.equal((await personalControl<typeof grants>(f.directory, "GET", "/tools/grants?offset=0")).items[0].revoked, true);
  } finally { await server.stop(); }
});

test("durable 文件写入：已批准执行遇到容量拒绝保留批准且不派生工作线程", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  fs.mkdirSync(f.directory);
  const outsideA = path.join(f.outside, "a"); fs.writeFileSync(outsideA, "x");
  const inside = path.join(f.workspace, "in"); fs.writeFileSync(inside, "w");
  const fifo = path.join(f.root, "gate"), filler = path.join(f.root, "filler"), marker = path.join(f.root, "entered");
  fs.writeFileSync(filler, "f"); execFileSync("mkfifo", [fifo]);
  const writer = fs.openSync(fifo, fs.constants.O_RDWR);
  const fifoNames = ["RK_FILE_IO_HOLD", "RK_FILE_IO_FIFO", "RK_FILE_IO_MARKER", "RK_FILE_IO_BUNDLE"] as const;
  const previous = fifoNames.map(name => process.env[name]);
  process.env.RK_FILE_IO_HOLD = filler; process.env.RK_FILE_IO_FIFO = fifo; process.env.RK_FILE_IO_MARKER = marker;
  process.env.RK_FILE_IO_BUNDLE = new URL("../worker/personal-file-worker.mjs", import.meta.url).href;
  const FIFO_WRAPPER = fileURLToPath(new URL("./helpers/personal-file-io-fifo-worker.mjs", import.meta.url));
  const probes: Array<[Worker, PersonalFileJobMeta]> = [], fillers: Array<[Worker, PersonalFileJobMeta]> = [];
  let fillerExits = 0;
  const profile = fs.realpathSync(f.directory);
  const inner = openPersonalFileIo({ profile, script: FIFO_WRAPPER, workerProbe: (worker, meta) => probes.push([worker, meta]) });
  const fillerIo = openPersonalFileIo({ profile, script: FIFO_WRAPPER, workerProbe: (worker, meta) => { fillers.push([worker, meta]); worker.on("exit", () => fillerExits++); } });
  t.after(async () => {
    try { fs.writeSync(writer, Buffer.alloc(64)); } catch {} try { fs.closeSync(writer); } catch {}
    await fillerIo.close().catch(() => undefined); await inner.close().catch(() => undefined);
    fifoNames.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  });
  const fill = async () => {
    await until(() => probes.length > 0 && probes.every(([worker]) => worker.threadId < 0));
    fillers.length = 0; fillerExits = 0;
    const jobs = Array.from({ length: 4 }, () => fillerIo.prepare({ path: filler, access: "read", protectedRoots: [] })); jobs.forEach(job => void job.catch(() => undefined));
    await until(() => fillers.length === 4 && fillers.every(([, meta]) => fs.existsSync(`${marker}.${meta.id}`)));
  };
  const filled = new Set<string>();
  const io: PersonalFileIo = {
    prepare: (input, ctx) => inner.prepare(input, ctx),
    execute: (request, ctx) => inner.execute(request, ctx),
    reserve: (request, ctx) => { const target = (request as { path?: string }).path; const held = (target === outsideA || target === inside) && !filled.has(target) ? (filled.add(target), fill()) : Promise.resolve(); return held.then(() => inner.reserve(request, ctx)); },
    close: () => inner.close(),
  };
  const p = await f.open({ fileIo: io });
  await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const answer = invoked(p, invoke("write_file", { path: outsideA, content: "A写" }), "cap-a", "tools-src");
  void answer.catch(() => undefined);
  const pending = await first(p); assert.equal(pending.approval, "pending");
  await p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context);
  const decided = await record(p, pending.operation);
  await until(() => probes.some(([worker, meta]) => meta.phase === "revalidate" && (meta.request as { path?: string }).path === outsideA && worker.threadId < 0));
  await until(async () => (await operations(p)).some(value => value.observation !== undefined && value.effect === "not_executed"));
  const denied = (await operations(p)).at(-1)!;
  assert.equal(denied.kind, "write_file"); assert.equal(denied.approval, "approved"); assert.equal(denied.decisionEntry, decided.decisionEntry);
  assert.equal(denied.started, false); assert.equal(denied.startEntry, undefined); assert.equal(denied.directoryClaim, undefined);
  assert.equal(denied.effect, "not_executed"); assert.equal(denied.code, "file_io_capacity_unavailable"); assert.equal(fillers.length, 4);
  fs.writeSync(writer, Buffer.alloc(4)); await until(() => fillerExits === 4);
  await assert.rejects(p.harness.commit(tx => toolDecide(tx, denied.operation, "approved", f.directory), context), code("tool_decision_invalid"));
  const replayed = await p.work.delegate({ requestId: "cap-a", sourceRequestId: "tools-src", content: invoke("write_file", { path: outsideA, content: "A写" }) });
  const aSpawned = probes.filter(([, meta]) => (meta.request as { path?: string }).path === outsideA).length;
  await delay(100); assert.equal(fs.readFileSync(outsideA, "utf8"), "x");
  assert.equal(probes.filter(([, meta]) => (meta.request as { path?: string }).path === outsideA).length, aSpawned);
  assert.equal(replayed.taskId, (await answer.catch(() => ({ work: replayed }))).work.taskId);

  await p.answer("独立来源", "b-src");
  const bAnswer = invoked(p, invoke("write_file", { path: outsideA, content: "B写" }), "cap-b", "b-src");
  void bAnswer.catch(() => undefined);
  await until(async () => (await operations(p)).some(value => value !== denied && value.observation === undefined && value.approval === "pending"));
  const bPending = (await operations(p)).find(value => value.observation === undefined && value.approval === "pending")!;
  assert.notEqual(bPending.decisionEntry, denied.decisionEntry);
  await p.harness.commit(tx => toolDecide(tx, bPending.operation, "approved", f.directory), context);
  await until(() => fs.readFileSync(outsideA, "utf8") === "B写");

  const inAnswer = invoked(p, invoke("write_file", { path: inside, content: "改" }), "cap-in", "tools-src");
  void inAnswer.catch(() => undefined);
  await until(async () => (await operations(p)).some(value => value.kind === "write_file" && value.observation !== undefined && value.effect === "not_executed" && value.approval === "unneeded"));
  const inDenied = (await operations(p)).at(-1)!;
  assert.equal(inDenied.approval, "unneeded"); assert.equal(inDenied.decisionEntry, undefined); assert.equal(inDenied.started, false);
  assert.equal(inDenied.startEntry, undefined); assert.equal(inDenied.directoryClaim, undefined); assert.equal(inDenied.code, "file_io_capacity_unavailable");
  fs.writeSync(writer, Buffer.alloc(4)); await until(() => fillerExits === 4);
  await invoked(p, invoke("write_file", { path: inside, content: "改" }), "cap-in-2", "tools-src");
  await until(() => fs.readFileSync(inside, "utf8") === "改");
  await answer.catch(() => undefined); await bAnswer.catch(() => undefined); await inAnswer.catch(() => undefined);
});
