import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
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
import { AgentDoc, ROOT_CONVERSATION_ID, type ConversationId, type EntryId, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalToolDoc, PersonalToolsDoc, toolOperations, toolDecide, toolGrant, toolList, personalToolRedisplay, toolRevoke, toolResolve, toolVerifyStop, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { personalControl, startPersonalServer, type PersonalInputStatus } from "../apps/ruukoto/src/personal-control.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { savePersonalTools, parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { personalServiceSourceBlocker } from "../apps/ruukoto/src/personal-service-operations.ts";
import { personalWorkResult, appendPersonalWork, personalWorkNoteSource, PersonalWorkDoc, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { LocalInputDoc, personalInputDigest } from "../apps/ruukoto/src/personal-local-records.ts";
import { PersonalInspectionDoc, PersonalPendingInspectionsDoc } from "../apps/ruukoto/src/personal-service-inspection.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { readPersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { openPersonalFileIo, personalFileIoJobs, type PersonalFileIo, type PersonalFileJobMeta, type PersonalFileJobContext, type PersonalFileIoEvent } from "../apps/ruukoto/src/personal-file-io.ts";
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

test("durable file invalidation: admitted and running revalidation retain truthful stopping", { timeout: 120_000 }, async t => {
  for (const action of ["revocation", "supersession"] as const) for (const window of ["admission", "worker"] as const) await t.test(`${action} during ${window}`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    fs.mkdirSync(f.directory);
    const target = path.join(f.outside, "target.txt"), fifo = path.join(f.root, "gate"), marker = path.join(f.root, "entered");
    fs.writeFileSync(target, "original"); execFileSync("mkfifo", [fifo]);
    const writer = fs.openSync(fifo, fs.constants.O_RDWR);
    const names = ["RK_FILE_IO_HOLD", "RK_FILE_IO_FIFO", "RK_FILE_IO_MARKER", "RK_FILE_IO_PHASE", "RK_FILE_IO_BUNDLE"] as const, previous = names.map(name => process.env[name]);
    process.env.RK_FILE_IO_HOLD = target; process.env.RK_FILE_IO_FIFO = fifo; process.env.RK_FILE_IO_MARKER = marker; process.env.RK_FILE_IO_PHASE = "revalidate";
    process.env.RK_FILE_IO_BUNDLE = new URL("../worker/personal-file-worker.mjs", import.meta.url).href;
    let releaseAdmission!: () => void, admitted = false;
    const admissionGate = new Promise<void>(resolve => releaseAdmission = resolve);
    const probes: Array<[Worker, PersonalFileJobMeta]> = [];
    const inner = openPersonalFileIo({ profile: f.directory, script: fileURLToPath(new URL("./helpers/personal-file-io-fifo-worker.mjs", import.meta.url)), workerProbe: (worker, job) => probes.push([worker, job]) });
    const wrap = (ctx?: PersonalFileJobContext): PersonalFileJobContext | undefined => ctx?.record === undefined ? ctx : { ...ctx, record: async (event: PersonalFileIoEvent) => {
      await ctx.record!(event);
      if (window === "admission" && ctx.phase === "revalidate" && event.kind === "admit") { admitted = true; await admissionGate; }
    } };
    const io: PersonalFileIo = { prepare: (input, ctx) => inner.prepare(input, wrap(ctx)), execute: (request, ctx) => inner.execute(request, wrap(ctx)), reserve: (request, ctx) => inner.reserve(request, wrap(ctx)), close: () => inner.close() };
    let released = false;
    const release = () => { releaseAdmission(); if (!released) { released = true; fs.writeSync(writer, Buffer.alloc(16)); fs.closeSync(writer); } };
    t.after(async () => {
      release(); await inner.close();
      names.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
    });
    const p = await f.open({ fileIo: io });
    try {
      await mode(p, "confirm");
      await p.harness.commit(tx => toolGrant(tx, f.directory, f.outside), context);
      await p.answer("Update the target file", "tools-src");
      const work = await p.work.delegate({ requestId: "invalidated-work", sourceRequestId: "tools-src", content: invoke("write_file", { path: target, content: "replacement" }) });
      await until(async () => (await operations(p)).some(value => value.approval === "pending"));
      const pending = (await operations(p))[0];
      await p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context);
      const approved = await record(p, pending.operation);
      await until(() => window === "admission" ? admitted : fs.existsSync(marker));
      const job = (await p.harness.commit(tx => personalFileIoJobs(tx), context)).find(job => job.phase === "revalidate")!;
      assert.equal(job.starting !== undefined, window === "worker");
      if (action === "revocation") await p.harness.commit(async tx => toolRevoke(tx, (await tx.doc(PersonalToolsDoc)).grants[0].id), context);
      else assert.equal((await p.work.append(work, { requestId: "amendment", sourceRequestId: "tools-src", content: "Keep the target unchanged; report the canceled write without any external operation." })).accepted, true);
      const invalidated = await record(p, pending.operation);
      assert.equal(invalidated.started, false); assert.equal(invalidated.startEntry, undefined); assert.equal(invalidated.directoryClaim, undefined);
      assert.equal(invalidated.effect, "not_executed"); assert.equal(invalidated.code, action === "revocation" ? "tool_permission_changed" : "tool_requirements_changed");
      assert.equal(invalidated.approval, "approved"); assert.equal(invalidated.decisionEntry, approved.decisionEntry); assert.notEqual(invalidated.observation, undefined);
      assert.equal(invalidated.stopped, false);
      assert.notEqual(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "tools-src"), context), undefined);
      releaseAdmission(); await until(() => fs.existsSync(marker));
      assert.equal((await record(p, pending.operation)).stopped, false);
      const held = (await p.harness.commit(tx => personalFileIoJobs(tx), context)).find(value => value.id === job.id)!;
      assert.notEqual(held.dispatch, undefined); assert.equal(held.result, undefined); assert.equal(held.exit, undefined);
      assert.equal((await p.harness.commit(tx => toolList(tx), context)).items[0].stopped, false);
      assert.equal((await p.harness.commit(tx => toolList(tx), context)).items[0].canDecide, false);
      assert.notEqual(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "tools-src"), context), undefined);
      assert.notEqual((await p.work.status(work)).task.state.status, "terminal");
      assert.equal((await p.work.list()).find(agent => agent.id === work.agentId)?.work?.taskId, work.taskId);
      assert.equal(fs.readFileSync(target, "utf8"), "original"); assert.equal(probes.some(([, job]) => job.phase === "execute"), false);
      release();
      await until(async () => (await record(p, pending.operation)).stopped);
      const stopped = await record(p, pending.operation);
      assert.equal(stopped.observation, invalidated.observation); assert.equal(stopped.effect, "not_executed"); assert.equal(stopped.code, invalidated.code);
      assert.equal(stopped.decisionEntry, approved.decisionEntry); assert.equal(stopped.stopEvidence?.fileJob, job.id); assert.notEqual(stopped.stopEvidence?.fileEvent, undefined);
      await p.harness.waitForTask(work.taskId, context);
      assert.equal((await p.work.status(work)).stopVerified, true);
      await until(() => probes.every(([worker]) => worker.threadId < 0));
      assert.equal(probes.some(([, job]) => job.phase === "execute"), false); assert.equal(fs.readFileSync(target, "utf8"), "original");
      await p.close();
      const reopened = await f.open();
      assert.deepEqual(await record(reopened, pending.operation), stopped);
      assert.equal((await reopened.work.status(work)).stopVerified, true);
      await reopened.close();
    } finally { release(); await until(() => probes.every(([worker]) => worker.threadId < 0)); await p.close(); }
  });
});

const held = () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); return { gate, release }; };
const childConversation = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent") === true;
const noteSubmission = (p: PersonalHarness, work: PersonalWorkRef, requestId: string) => p.harness.commit(tx => tx.submissionByRequest(work.agentId, `personal-work:${work.taskId}:note:${requestId}`), context);

test("durable 要求更新：接纳中的说明使待批准旧操作失效且原决定保留，同一子会话按新目标写一次", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const oldPath = path.join(f.outside, "old.txt"), newPath = path.join(f.outside, "new.txt");
  fs.writeFileSync(newPath, "");
  const original = invoke("write_file", { path: oldPath, content: "旧内容" }), amended = invoke("write_file", { path: newPath, content: "新内容" });
  const answer = invoked(p, original, "amend-work", "tools-src"); void answer.catch(() => undefined);
  const pending = await first(p);
  assert.equal(pending.approval, "pending"); assert.equal(pending.started, false); assert.equal(pending.observation, undefined);
  const work = pending.origin.work!.ref;
  await p.work.append(work, { requestId: "amend-1", content: amended, sourceRequestId: "tools-src" });
  const note = await noteSubmission(p, work, "amend-1");
  assert.ok(note === undefined || note.entry === undefined, "说明已接纳但仍未下发到子会话");
  const stale = await record(p, pending.operation);
  assert.equal(stale.started, false); assert.equal(stale.effect, "not_executed"); assert.equal(stale.code, "tool_requirements_changed");
  assert.equal(stale.approval, "pending"); assert.notEqual(stale.observation, undefined); assert.equal(stale.superseded?.reason, "requirements_changed");
  assert.equal(stale.stopped, true);
  assert.equal((await p.harness.commit(tx => toolList(tx), context)).items.find(item => item.operation === pending.operation)?.canDecide, false);
  await assert.rejects(p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context), code("tool_decision_invalid"));
  await until(async () => (await operations(p)).length === 2);
  const fresh = (await operations(p)).at(-1)!;
  assert.notEqual(fresh.operation, pending.operation); assert.equal(fresh.approval, "pending"); assert.equal(fresh.started, false); assert.equal(fresh.superseded, undefined);
  assert.equal(fresh.prepared.kind === "file" ? fresh.prepared.request.path : "", newPath);
  await p.harness.commit(tx => toolDecide(tx, fresh.operation, "approved", f.directory), context);
  const outcome = await answer;
  assert.equal(fs.existsSync(oldPath), false); assert.equal(fs.readFileSync(newPath, "utf8"), "新内容");
  assert.equal(outcome.text.length > 0, true);
  const staleAdmitted = await record(p, pending.operation), admitted = await record(p, fresh.operation);
  assert.equal(staleAdmitted.instructions?.version, 1); assert.equal(admitted.instructions?.version, 1);
  const staleSnapshot = staleAdmitted.instructions!.snapshot, freshSnapshot = admitted.instructions!.snapshot;
  assert.equal(staleSnapshot.work.taskId, work.taskId); assert.equal(freshSnapshot.work.taskId, work.taskId);
  assert.equal(staleSnapshot.notes.length, 0); assert.equal(staleSnapshot.nativeInputs.length, 1); assert.equal(staleSnapshot.original.submissionId, staleSnapshot.nativeInputs[0]);
  assert.equal(freshSnapshot.notes.length, 1); assert.equal(freshSnapshot.notes[0]!.requestId, "amend-1"); assert.equal(freshSnapshot.nativeInputs.length, 2);
  assert.ok(staleSnapshot.cutoff < freshSnapshot.cutoff);
  const requestEntry = await p.harness.commit(async tx => tx.entry(staleAdmitted.instructions!.requestEntry), context);
  assert.equal(requestEntry?.conversationId, work.agentId);
  const evidence = requestEntry?.data as { references: Record<string, unknown>; input: { messages: Array<{ sections?: Record<string, string> }> } };
  assert.deepEqual(evidence.references.instructions, staleSnapshot);
  const section = evidence.input.messages[0]?.sections?.["personal-work-instructions"];
  assert.notEqual(section, undefined); assert.match(section!, /当前后台工作要求参考/);
  assert.deepEqual(JSON.parse(section!.split("\n").find(line => line.startsWith('{"work":'))!), { work: work.taskId, instructions: [original] });
  const latest = f.model.calls.filter(childConversation).at(-1)!;
  assert.deepEqual(JSON.parse(latest.system!.split("\n").find(line => line.startsWith('{"work":'))!), { work: work.taskId, instructions: [original, amended] });
});

test("durable 要求更新：本机说明来源同样使旧操作失效并在重开后保留", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const oldPath = path.join(f.outside, "old.txt"), newPath = path.join(f.outside, "new.txt");
  fs.writeFileSync(newPath, "");
  const original = invoke("write_file", { path: oldPath, content: "旧内容" }), amended = invoke("write_file", { path: newPath, content: "新内容" });
  const answer = invoked(p, original, "amend-local", "tools-src"); void answer.catch(() => undefined);
  const pending = await first(p); const work = pending.origin.work!.ref;
  await p.harness.commit(async tx => {
    const intent = await tx.doc(LocalInputDoc, "local-amend", personalInputDigest(amended, work.taskId));
    intent.work = work.taskId;
    await appendPersonalWork(tx, work, { requestId: "local-amend", content: amended, source: { kind: "local" } });
  }, context);
  const stale = await record(p, pending.operation);
  assert.equal(stale.code, "tool_requirements_changed"); assert.equal(stale.superseded?.reason, "requirements_changed"); assert.notEqual(stale.superseded?.note, undefined);
  await until(async () => (await operations(p)).length === 2);
  const fresh = (await operations(p)).at(-1)!;
  await p.harness.commit(tx => toolDecide(tx, fresh.operation, "approved", f.directory), context);
  await answer;
  assert.equal(fs.existsSync(oldPath), false); assert.equal(fs.readFileSync(newPath, "utf8"), "新内容");
  await p.close();
  const restored = await f.open();
  const reopened = await record(restored, pending.operation);
  assert.equal(reopened.code, "tool_requirements_changed"); assert.equal(reopened.superseded?.reason, "requirements_changed");
  assert.equal((await record(restored, fresh.operation)).effect, "returned");
});

test("durable 要求更新：已批准未消费的旧操作在保留处失效且保留原批准，先开始的效果不回滚", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  fs.mkdirSync(f.directory);
  const reserve = held(), execute = held();
  let holdReserve = false, holdExecute = false, reserveCalls = 0;
  const inner = openPersonalFileIo({ profile: fs.realpathSync(f.directory) });
  const io: PersonalFileIo = {
    prepare: (input, ticketContext) => inner.prepare(input, ticketContext),
    execute: (request, ticketContext) => inner.execute(request, ticketContext),
    reserve: async (request, ticketContext) => {
      if (holdReserve) { reserveCalls++; await reserve.gate; }
      const ticket = await inner.reserve(request, ticketContext);
      if (!holdExecute) return ticket;
      return { ...ticket, execute: async () => { await execute.gate; return ticket.execute(); } };
    },
    close: () => inner.close(),
  };
  const p = await f.open({ fileIo: io }); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const pathA = path.join(f.outside, "a.txt"), pathB = path.join(f.outside, "b.txt"), pathC = path.join(f.outside, "c.txt");
  fs.writeFileSync(pathB, ""); fs.writeFileSync(pathC, "");
  const invokeA = invoke("write_file", { path: pathA, content: "A" }), invokeB = invoke("write_file", { path: pathB, content: "B" }), invokeC = invoke("write_file", { path: pathC, content: "C" });
  const answer = invoked(p, invokeA, "hold-work", "tools-src"); void answer.catch(() => undefined);
  const pendingA = await first(p);
  try {
    holdReserve = true;
    await p.harness.commit(tx => toolDecide(tx, pendingA.operation, "approved", f.directory), context);
    await until(() => reserveCalls === 1);
    await p.work.append(pendingA.origin.work!.ref, { requestId: "amend-a", content: invokeB, sourceRequestId: "tools-src" });
    const staleA = await record(p, pendingA.operation);
    assert.equal(staleA.approval, "approved"); assert.notEqual(staleA.decisionEntry, undefined);
    assert.equal(staleA.code, "tool_requirements_changed"); assert.equal(staleA.effect, "not_executed"); assert.equal(staleA.started, false); assert.equal(staleA.superseded?.reason, "requirements_changed");
    holdReserve = false; reserve.release();
    await until(async () => (await operations(p)).length === 2);
    assert.equal(fs.existsSync(pathA), false);
    const pendingB = (await operations(p)).at(-1)!;
    holdExecute = true;
    await p.harness.commit(tx => toolDecide(tx, pendingB.operation, "approved", f.directory), context);
    await until(async () => (await record(p, pendingB.operation)).started);
    await p.work.append(pendingB.origin.work!.ref, { requestId: "amend-b", content: invokeC, sourceRequestId: "tools-src" });
    const liveB = await record(p, pendingB.operation);
    assert.equal(liveB.superseded, undefined); assert.equal(liveB.started, true); assert.equal(liveB.effect, "effect_unknown"); assert.equal(liveB.approval, "approved");
    execute.release();
    await until(async () => (await record(p, pendingB.operation)).effect === "returned");
    const doneB = await record(p, pendingB.operation);
    assert.equal(doneB.code, "file_returned"); assert.equal(doneB.stopped, true); assert.notEqual(doneB.directoryClaim, undefined); assert.equal(doneB.superseded, undefined);
    assert.equal(fs.readFileSync(pathB, "utf8"), "B"); assert.equal(fs.existsSync(pathA), false);
    holdExecute = false;
  } finally { holdReserve = false; reserve.release(); holdExecute = false; execute.release(); }
  await until(async () => (await operations(p)).length === 3);
  const pendingC = (await operations(p)).at(-1)!;
  assert.equal(pendingC.prepared.kind === "file" ? pendingC.prepared.request.path : "", pathC);
  await p.harness.commit(tx => toolDecide(tx, pendingC.operation, "approved", f.directory), context);
  await answer;
  assert.equal(fs.readFileSync(pathC, "utf8"), "C");
});

test("durable 要求更新：延后的旧模型调用在边界被拒绝且新旧 HTTP 操作各自核实", { timeout: 60_000 }, async t => {
  let oldHits = 0, newHits = 0;
  const endpoint = await remote(t, (request, response) => { if (request.url === "/new") newHits++; else oldHits++; response.end("ok"); });
  const original = invoke("http_request", { url: `${endpoint}/old`, method: "POST", body: "旧" });
  const amended = invoke("http_request", { url: `${endpoint}/new`, method: "POST", body: "新" });
  const gate = held();
  const f = await fixture(t, async request => {
    if (reviewRequest(request)) return respond(request, 0);
    if (childConversation(request) && request.messages.at(-1)?.content === original) {
      await gate.gate;
      return { kind: "tool_calls", calls: [{ id: "old-http", name: "http_request", arguments: { url: `${endpoint}/old`, method: "POST", body: "旧" } }] };
    }
    return respond(request, 0);
  });
  const p = await f.open(); await mode(p, "full_access"); await p.answer("工具来源", "tools-src");
  const work = await p.work.delegate({ requestId: "delayed", sourceRequestId: "tools-src", content: original });
  await until(() => f.model.calls.some(childConversation));
  await p.work.append(work, { requestId: "amend", content: amended, sourceRequestId: "tools-src" });
  assert.equal((await noteSubmission(p, work, "amend"))?.entry, undefined);
  gate.release();
  await p.harness.waitForTask(work.taskId, context);
  const ops = await operations(p);
  assert.equal(ops.length, 1);
  const fresh = ops[0]!;
  assert.equal(fresh.prepared.kind === "http" ? fresh.prepared.request.url : "", `${endpoint}/new`);
  assert.equal(fresh.effect, "returned"); assert.equal(fresh.superseded, undefined); assert.equal(fresh.stopped, true);
  assert.equal(oldHits, 0); assert.equal(newHits, 1);
});

test("durable 要求更新：待批准与已批准 HTTP 旧操作不发出请求，已开始未知效果保留核实", { timeout: 90_000 }, async t => {
  let hits = 0, unknownServed = false;
  const endpoint = await remote(t, (request, response) => { hits++; if (request.url === "/die") { unknownServed = true; request.resume(); request.once("end", () => request.socket.destroy()); } else response.end("ok"); });
  const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const firstHttp = invoke("http_request", { url: `${endpoint}/one`, method: "POST", body: "1" });
  const answerA = invoked(p, firstHttp, "http-a", "tools-src"); void answerA.catch(() => undefined);
  const pendingA = await first(p); const workA = pendingA.origin.work!.ref;
  await p.work.append(workA, { requestId: "amend-http-a", content: invoke("http_request", { url: `${endpoint}/two`, method: "POST", body: "2" }), sourceRequestId: "tools-src" });
  const staleA = await record(p, pendingA.operation);
  assert.equal(staleA.code, "tool_requirements_changed"); assert.equal(staleA.effect, "not_executed"); assert.equal(staleA.started, false); assert.equal(hits, 0);
  await until(async () => (await operations(p)).length === 2);
  const pendingB = (await operations(p)).at(-1)!;
  const approvedB = pendingB.operation;
  await p.harness.commit(tx => toolDecide(tx, approvedB, "approved", f.directory), context);
  await p.harness.commit(async tx => appendPersonalWork(tx, workA, { requestId: "amend-http-b", content: invoke("http_request", { url: `${endpoint}/three`, method: "POST", body: "3" }), source: await personalWorkNoteSource(tx, "tools-src") }), context);
  const staleB = await record(p, approvedB);
  assert.equal(staleB.approval, "approved"); assert.equal(staleB.code, "tool_requirements_changed"); assert.equal(staleB.effect, "not_executed"); assert.equal(staleB.started, false); assert.equal(hits, 0);
  await until(async () => (await operations(p)).length === 3);
  const pendingC = (await operations(p)).at(-1)!;
  await p.harness.commit(tx => toolDecide(tx, pendingC.operation, "approved", f.directory), context);
  await until(() => hits === 1);
  await answerA;
  await mode(p, "full_access"); await p.answer("工具来源", "die-src");
  const dieWork = await p.work.delegate({ requestId: "die-work", sourceRequestId: "die-src", content: invoke("http_request", { url: `${endpoint}/die`, method: "POST", body: "x" }) });
  await until(async () => !!(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "die-src"), context)));
  const unknown = (await operations(p)).find(op => op.origin.work?.ref.taskId === dieWork.taskId)!;
  assert.equal(unknown.effect, "effect_unknown"); assert.equal(unknown.stopped, false); assert.equal(unknown.started, true);
  await until(() => unknownServed);
  await p.work.append(dieWork, { requestId: "amend-die", content: "补充说明", sourceRequestId: "die-src" });
  const preserved = await record(p, unknown.operation);
  assert.equal(preserved.superseded, undefined); assert.equal(preserved.effect, "effect_unknown"); assert.equal(preserved.stopped, false); assert.equal(preserved.started, true); assert.equal(unknownServed, true);
  assert.ok(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "die-src"), context));
  await p.harness.commit(tx => toolResolve(tx, unknown.operation, "applied", "核实已生效"), context);
  await p.harness.commit(tx => toolVerifyStop(tx, unknown.operation, "远端已结束"), context);
  assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "die-src"), context), undefined);
});

test("durable 要求更新：工作隔离、重复说明不重复失效、伪造来源拒绝且不留痕迹", { timeout: 90_000 }, async t => {
  const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const pathA = path.join(f.outside, "a.txt"), pathB = path.join(f.outside, "b.txt");
  fs.writeFileSync(pathB, "");
  const answerA = invoked(p, invoke("write_file", { path: pathA, content: "A" }), "work-a", "tools-src"); void answerA.catch(() => undefined);
  const opA = await first(p); const workA = opA.origin.work!.ref;
  await p.answer("工具来源", "src-b");
  const answerB = invoked(p, invoke("write_file", { path: pathB, content: "B" }), "work-b", "src-b"); void answerB.catch(() => undefined);
  await until(async () => (await operations(p)).length === 2);
  const opB = (await operations(p)).at(-1)!; const workB = opB.origin.work!.ref;
  const pathA2 = path.join(f.outside, "a2.txt"); fs.writeFileSync(pathA2, "");
  await p.work.append(workA, { requestId: "amend-a", content: invoke("write_file", { path: pathA2, content: "A2" }), sourceRequestId: "tools-src" });
  const staleA = await record(p, opA.operation), liveB = await record(p, opB.operation);
  assert.equal(staleA.code, "tool_requirements_changed"); assert.equal(staleA.superseded?.reason, "requirements_changed");
  assert.equal(liveB.code, "awaiting_approval"); assert.equal(liveB.superseded, undefined); assert.equal(liveB.observation, undefined);
  const supersededEntry = staleA.superseded!.entry;
  assert.deepEqual(await p.work.append(workA, { requestId: "amend-a", content: invoke("write_file", { path: pathA2, content: "A2" }), sourceRequestId: "tools-src" }), { accepted: true });
  assert.equal((await record(p, opA.operation)).superseded!.entry, supersededEntry);
  await assert.rejects(p.harness.commit(tx => appendPersonalWork(tx, workA, { requestId: "forged", content: "伪造说明", source: { kind: "input", requestId: "tools-src", submissionId: 999 as SubmissionId, entryId: 999 as EntryId } }), context), code("work_original_entry_required"));
  assert.equal((await record(p, opA.operation)).superseded!.entry, supersededEntry); assert.equal((await record(p, opB.operation)).superseded, undefined);
  await p.harness.commit(tx => toolDecide(tx, opB.operation, "approved", f.directory), context);
  await until(() => fs.existsSync(pathB));
  await answerB;
  await until(async () => (await operations(p)).length === 3);
  const freshA = (await operations(p)).at(-1)!;
  await p.harness.commit(tx => toolDecide(tx, freshA.operation, "approved", f.directory), context);
  await answerA;
  assert.equal(fs.readFileSync(pathA2, "utf8"), "A2"); assert.equal(fs.existsSync(pathA), false);
});

test("durable 操作查询与重显示：每次请求保留独立登记，同次重放幂等且无批准权", { timeout: 90_000 }, async t => {
  const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const target = path.join(f.outside, "display.txt");
  fs.writeFileSync(target, "");
  const answer = invoked(p, invoke("write_file", { path: target, content: "x" }), "display-work", "tools-src"); void answer.catch(() => undefined);
  const pending = await first(p); const work = pending.origin.work!.ref;
  const list = JSON.parse(await p.answer(invoke("background_work", { action: "operations", work: work.taskId }), "ops-list")) as { operations: Array<{ operation: TaskId; approval: string; canDecide: boolean }> };
  assert.equal(list.operations.length, 1); assert.equal(list.operations[0]!.operation, pending.operation); assert.equal(list.operations[0]!.canDecide, true);
  assert.equal((await record(p, pending.operation)).observation, undefined);
  const detail = JSON.parse(await p.answer(invoke("background_work", { action: "operation", operation: pending.operation }), "op-detail")) as { operation: TaskId; text: string };
  assert.equal(detail.operation, pending.operation);
  const fields = JSON.parse(detail.text) as { operation: TaskId; params: { path: string }; config?: unknown; approval: string };
  assert.equal(fields.operation, pending.operation); assert.equal(fields.params.path, target); assert.equal(fields.approval, "pending"); assert.equal(fields.config, undefined);
  const first1 = JSON.parse(await p.answer(invoke("background_work", { action: "redisplay", operation: pending.operation }), "display-1")) as { operation: TaskId; display: EntryId; state: string };
  assert.equal(first1.state, "redisplay_registered"); assert.equal(first1.operation, pending.operation);
  const firstDisplay = await p.harness.commit(tx => tx.entry(first1.display), context);
  assert.ok(firstDisplay && firstDisplay.data && typeof firstDisplay.data === "object" && !Array.isArray(firstDisplay.data));
  const firstSource = firstDisplay.data.source as { requestId: string; submissionId: SubmissionId; entryId: EntryId }, firstCall = firstDisplay.data.modelCall as TaskId;
  const replay = await p.harness.commit(tx => personalToolRedisplay(tx, pending.operation, { source: firstSource }, firstCall, { local: true }), context);
  assert.equal(replay.display, first1.display);
  const second = JSON.parse(await p.answer(invoke("background_work", { action: "redisplay", operation: pending.operation }), "display-2")) as { display: EntryId; state: string };
  assert.notEqual(second.display, first1.display); assert.equal(second.state, "redisplay_registered");
  const saved = await record(p, pending.operation);
  assert.equal(saved.approval, "pending"); assert.equal(saved.redisplay, second.display); assert.deepEqual(saved.redisplays, [first1.display, second.display]); assert.equal(saved.started, false); assert.equal(saved.observation, undefined);
  await p.harness.commit(async tx => { (await tx.doc(PersonalToolDoc, String(pending.operation), null)).operation!.origin.telegram = { botId: "123", ownerId: "456", generation: randomUUID(), mode: "confirm", version: 1 }; }, context);
  assert.match(await p.answer(invoke("background_work", { action: "redisplay", operation: pending.operation }), "display-3"), /tool_original_entry/);
  await p.harness.commit(async tx => { delete (await tx.doc(PersonalToolDoc, String(pending.operation), null)).operation!.origin.telegram; }, context);
  await p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context);
  await answer;
  assert.equal(fs.readFileSync(target, "utf8"), "x");
  await p.close(); const restored = await f.open();
  assert.deepEqual((await record(restored, pending.operation)).redisplays, [first1.display, second.display]);
});

test("durable 重显示登记：每次原请求及模型调用均须保留可核实的唯一来源", { timeout: 90_000 }, async t => {
  for (const damage of ["missing-first", "duplicate", "earlier-owner-source"] as const) await t.test(damage, async t => {
    const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
    const target = path.join(f.outside, "display-record.txt"); fs.writeFileSync(target, "");
    const answer = invoked(p, invoke("write_file", { path: target, content: "x" }), "display-record-work", "tools-src"); void answer.catch(() => undefined);
    const pending = await first(p);
    const firstDisplay = JSON.parse(await p.answer(invoke("background_work", { action: "redisplay", operation: pending.operation }), "display-first")) as { display: EntryId };
    const lastDisplay = JSON.parse(await p.answer(invoke("background_work", { action: "redisplay", operation: pending.operation }), "display-last")) as { display: EntryId };
    assert.notEqual(firstDisplay.display, lastDisplay.display);
    const owner = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "tools-src"), context); assert.ok(owner?.entry);
    await p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context); await answer;
    if (damage !== "earlier-owner-source") await p.harness.commit(async tx => {
      const operation = (await tx.doc(PersonalToolDoc, String(pending.operation), null)).operation!;
      operation.redisplays = damage === "missing-first" ? [lastDisplay.display] : [firstDisplay.display, firstDisplay.display, lastDisplay.display];
    }, context);
    await p.close();
    if (damage === "earlier-owner-source") {
      const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
      try {
        const altered = { requestId: "tools-src", submissionId: owner.id, entryId: owner.entry };
        assert.equal(db.prepare("UPDATE entries SET record = json_set(record, '$.data.source', json(?)) WHERE id = ?").run(JSON.stringify(altered), firstDisplay.display).changes, 1);
      } finally { db.close(); }
    }
    await assert.rejects(f.open(), code("tool_record_invalid"));
  });
});

test("durable 要求更新：指令、失效与重显示证据损坏拒绝重开", { timeout: 120_000 }, async t => {
  for (const damage of ["request-instructions", "request-text", "snapshot-version", "superseded-link", "superseded-orphan", "redisplay-link", "request-native", "native-inputs", "out-of-cutoff", "earlier-request", "redisplay-entry", "redisplay-source"] as const) await t.test(damage, async t => {
    const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
    const target = path.join(f.outside, "corrupt.txt"), freshPath = path.join(f.outside, "fresh.txt");
    fs.writeFileSync(target, ""); fs.writeFileSync(freshPath, "");
    const answer = invoked(p, invoke("write_file", { path: target, content: "c" }), `corrupt-${damage}`, "tools-src"); void answer.catch(() => undefined);
    const pending = await first(p); const work = pending.origin.work!.ref;
    await p.work.append(work, { requestId: `note-${damage}`, content: invoke("write_file", { path: freshPath, content: "n" }), sourceRequestId: "tools-src" });
    const stale = await record(p, pending.operation);
    assert.equal(stale.code, "tool_requirements_changed"); assert.notEqual(stale.instructions, undefined);
    let displayEntry: EntryId | undefined;
    if (damage.startsWith("redisplay-")) { await p.answer(invoke("background_work", { action: "redisplay", operation: pending.operation }), "corrupt-display"); await until(async () => (displayEntry = (await record(p, pending.operation)).redisplay) !== undefined); }
    await until(async () => (await operations(p)).length === 2);
    const fresh = (await operations(p)).at(-1)!;
    await p.harness.commit(tx => toolDecide(tx, fresh.operation, "approved", f.directory), context);
    await answer;
    await p.close();
    if (damage === "request-instructions" || damage === "request-text" || damage === "request-native" || damage === "redisplay-source") {
      const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
      try {
        if (damage === "redisplay-source") assert.equal(db.prepare("UPDATE entries SET record = json_replace(record, '$.data.source.submissionId', 999999) WHERE id = ?").run(displayEntry!).changes, 1);
        else if (damage === "request-text") assert.equal(db.prepare("UPDATE entries SET record = json_replace(record, '$.data.input.messages[0].sections.\"personal-work-instructions\"', 'altered requirements') WHERE id = ?").run(stale.instructions!.requestEntry).changes, 1);
        else assert.equal(db.prepare(damage === "request-instructions" ? "UPDATE entries SET record = json_remove(record, '$.data.references.instructions') WHERE id = ?" : "UPDATE entries SET record = json_replace(record, '$.data.references.instructions.nativeInputs', '[424242]') WHERE id = ?").run(stale.instructions!.requestEntry).changes, 1);
      } finally { db.close(); }
    } else {
      const restored = await f.open();
      await restored.harness.commit(async tx => {
        const op = (await tx.doc(PersonalToolDoc, String(pending.operation), null)).operation!;
        if (damage === "snapshot-version") (op.instructions!.snapshot as { version: number }).version = 2;
        else if (damage === "superseded-link") op.superseded!.entry = (op.superseded!.entry + 100000) as EntryId;
        else if (damage === "superseded-orphan") delete op.superseded;
        else if (damage === "redisplay-link") op.redisplay = 424242 as EntryId;
        else if (damage === "redisplay-entry") op.redisplay = stale.superseded!.entry;
        else if (damage === "native-inputs") op.instructions!.snapshot.nativeInputs = [424242 as SubmissionId];
        else if (damage === "out-of-cutoff") op.instructions!.snapshot.cutoff = 0 as EntryId;
        else op.instructions!.requestEntry = op.admission;
      }, context);
      await restored.close();
    }
    await assert.rejects(f.open(), code("tool_record_invalid"));
  });
});

test("durable 要求更新：查询不失效操作，把状态问题误当追加仍保守失效原操作", { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const target = path.join(f.outside, "status.txt"); fs.writeFileSync(target, "");
  const answer = invoked(p, invoke("write_file", { path: target, content: "x" }), "status-work", "tools-src"); void answer.catch(() => undefined);
  const pending = await first(p); const work = pending.origin.work!.ref;
  const listed = JSON.parse(await p.answer(invoke("background_work", { action: "operations", work: work.taskId }), "q-ops")) as { operations: Array<{ operation: TaskId; version: number; canDecide: boolean }> };
  assert.equal(listed.operations.length, 1); assert.equal(listed.operations[0]!.version, 1); assert.equal(listed.operations[0]!.canDecide, true);
  const result = JSON.parse(await p.answer(invoke("background_work", { action: "result", work: work.taskId }), "q-result")) as { tools?: { items: Array<{ operation: TaskId; canDecide: boolean }> } };
  assert.equal(result.tools?.items[0]?.operation, pending.operation); assert.equal(result.tools?.items[0]?.canDecide, true);
  const reference = await p.main.submit({ type: "input", content: invoke("background_work", { action: "operations", work: work.taskId }), requestId: "q-reference", entry: { kind: "ruukoto.work-report" } }, context);
  const referenceResult = await reference.wait(context);
  assert.ok(referenceResult.type === "input" && referenceResult.status === "done");
  const referenceAnswer = await p.harness.commit(tx => tx.entry(referenceResult.answer), context);
  const referenceText = referenceAnswer?.model?.flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : []).join("");
  const readOnly = JSON.parse(referenceText!) as { operations: Array<{ operation: TaskId; canDecide: boolean }> };
  assert.equal(readOnly.operations[0].operation, pending.operation); assert.equal(readOnly.operations[0].canDecide, false);
  const unchanged = await record(p, pending.operation);
  assert.equal(unchanged.observation, undefined); assert.equal(unchanged.approval, "pending"); assert.equal(unchanged.started, false); assert.equal(unchanged.superseded, undefined);
  await p.work.append(work, { requestId: "status-note", content: "进度如何？", sourceRequestId: "tools-src" });
  const stale = await record(p, pending.operation);
  assert.equal(stale.code, "tool_requirements_changed"); assert.equal(stale.superseded?.reason, "requirements_changed"); assert.equal(stale.approval, "pending"); assert.equal(stale.observation !== undefined, true);
  await answer;
  assert.equal((await operations(p)).length, 1); assert.equal(fs.readFileSync(target, "utf8"), "");
});

test("durable 要求更新：延后的旧调用在同一共享门禁被拒绝，仅新说明目标执行", { timeout: 120_000 }, async t => {
  const kinds = {
    read_file: { name: "read_file", old: (f: Awaited<ReturnType<typeof fixture>>) => ({ path: path.join(f.outside, "old-read.txt") }), fresh: (f: Awaited<ReturnType<typeof fixture>>) => ({ path: path.join(f.outside, "new-read.txt") }), key: "path" as const },
    list_files: { name: "list_files", old: (f: Awaited<ReturnType<typeof fixture>>) => ({ path: "." }), fresh: (f: Awaited<ReturnType<typeof fixture>>) => ({ path: "listed-sub" }), key: "path" as const },
    search_files: { name: "search_files", old: (_f: Awaited<ReturnType<typeof fixture>>) => ({ query: "old-token-zz" }), fresh: (_f: Awaited<ReturnType<typeof fixture>>) => ({ query: "new-token-zz" }), key: "query" as const },
    web_search: { name: "web_search", old: (_f: Awaited<ReturnType<typeof fixture>>) => ({ query: "旧检索词" }), fresh: (_f: Awaited<ReturnType<typeof fixture>>) => ({ query: "新检索词" }), key: "query" as const },
  };
  for (const kind of Object.values(kinds)) await t.test(kind.name, async t => {
    const gate = held();
    let oldArgs: Record<string, unknown> | undefined, freshArgs: Record<string, unknown> | undefined, content = "";
    const f = await fixture(t, async request => {
      if (reviewRequest(request)) return respond(request, 0);
      if (childConversation(request) && request.messages.at(-1)?.content === content) { await gate.gate; return { kind: "tool_calls", calls: [{ id: "old-call", name: kind.name, arguments: oldArgs! }] }; }
      return respond(request, 0);
    });
    oldArgs = kind.old(f); freshArgs = kind.fresh(f); content = invoke(kind.name, oldArgs);
    if (kind.name === "list_files") fs.mkdirSync(path.join(f.workspace, "listed-sub"));
    for (const file of [oldArgs.path, freshArgs.path]) if (kind.name === "read_file" && typeof file === "string") fs.writeFileSync(file, "x");
    let searches = 0; const previous = process.env.TOOLS_LATE_SEARCH_KEY;
    if (kind.name === "web_search") {
      process.env.TOOLS_LATE_SEARCH_KEY = "late-search-key";
      const originalFetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if ((input instanceof Request ? input.url : String(input)) !== "https://api.tavily.com/search") return originalFetch(input, init);
        searches++; return new Response(JSON.stringify({ results: [{ url: "https://example.com/late", title: "新", content: "摘要" }] }), { headers: { "content-type": "application/json" } });
      });
      t.after(() => { if (previous === undefined) delete process.env.TOOLS_LATE_SEARCH_KEY; else process.env.TOOLS_LATE_SEARCH_KEY = previous; });
    }
    const p = await f.open({ tools: kind.name === "web_search" ? { ...f.tools, search: { apiKeyEnv: "TOOLS_LATE_SEARCH_KEY" } } : f.tools });
    await mode(p, "full_access"); await p.answer("工具来源", "tools-src");
    const work = await p.work.delegate({ requestId: `delayed-${kind.name}`, sourceRequestId: "tools-src", content });
    await until(() => f.model.calls.some(request => childConversation(request) && request.messages.at(-1)?.content === content));
    await p.work.append(work, { requestId: `amend-${kind.name}`, content: invoke(kind.name, freshArgs), sourceRequestId: "tools-src" });
    assert.equal((await noteSubmission(p, work, `amend-${kind.name}`))?.entry, undefined);
    gate.release();
    await p.harness.waitForTask(work.taskId, context);
    const ops = await operations(p);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.params[kind.key], freshArgs[kind.key]); assert.equal(ops[0]!.superseded, undefined); assert.equal(ops[0]!.stopped, true);
    if (kind.name === "web_search") assert.equal(searches, 1);
  });
});

test("durable 要求更新：已拒绝的旧操作在说明接纳后保留原决定，未变成要求更新", { timeout: 60_000 }, async t => {
  const final = held();
  const f = await fixture(t, async request => {
    if (childConversation(request) && request.messages.at(-1)?.role === "tool" && String(request.messages.at(-1)?.content).includes('"code":"rejected"')) await final.gate;
    return respond(request, 0);
  }), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const oldPath = path.join(f.outside, "rejected.txt"), newPath = path.join(f.outside, "rejected-new.txt");
  fs.writeFileSync(newPath, "");
  const answer = invoked(p, invoke("write_file", { path: oldPath, content: "旧" }), "reject-work", "tools-src"); void answer.catch(() => undefined);
  const pending = await first(p); const work = pending.origin.work!.ref;
  await p.harness.commit(tx => toolDecide(tx, pending.operation, "rejected", f.directory), context);
  await until(async () => (await record(p, pending.operation)).observation !== undefined);
  const refused = await record(p, pending.operation);
  assert.equal(refused.approval, "rejected"); assert.equal(refused.code, "rejected"); assert.notEqual(refused.decisionEntry, undefined);
  try {
    assert.deepEqual(await p.work.append(work, { requestId: "reject-note", content: invoke("write_file", { path: newPath, content: "新" }), sourceRequestId: "tools-src" }), { accepted: true });
  } finally { final.release(); }
  const preserved = await record(p, pending.operation);
  assert.equal(preserved.approval, "rejected"); assert.equal(preserved.superseded, undefined); assert.equal(preserved.code, "rejected"); assert.equal(preserved.observation, refused.observation); assert.equal(preserved.decisionEntry, refused.decisionEntry);
  await until(async () => (await operations(p)).length === 2);
  const freshOp = (await operations(p)).at(-1)!.operation;
  await p.harness.commit(tx => toolDecide(tx, freshOp, "approved", f.directory), context);
  await answer;
  assert.equal(fs.existsSync(oldPath), false); assert.equal(fs.readFileSync(newPath, "utf8"), "新");
});

test("durable 要求更新：并行压缩请求不会替换工具所属的实际要求快照", { timeout: 90_000 }, async t => {
  const gate = held(); let compactions = 0;
  const f = await fixture(t, async request => {
    if (request.system?.includes("context summarization assistant")) { compactions++; return { kind: "text", text: "Original work context retained." }; }
    if (childConversation(request) && request.messages.at(-1)?.content === "context-seed") return { kind: "text", text: "history ".repeat(14000) };
    if (childConversation(request) && request.messages.at(-1)?.role === "user" && String(request.messages.at(-1)?.content).startsWith("tool:")) await gate.gate;
    return respond(request, 0);
  });
  const p = await f.open(); await mode(p, "full_access"); await p.answer("工具来源", "tools-src");
  const seed = await p.work.delegate({ requestId: "compact-seed", sourceRequestId: "tools-src", content: "context-seed" });
  await p.harness.waitForTask(seed.taskId, context);
  const target = path.join(f.workspace, "compact-read.txt"); fs.writeFileSync(target, "original bytes");
  const content = invoke("read_file", { path: target });
  const work = await p.work.delegate({ requestId: "compact-read", sourceRequestId: "tools-src", agentId: seed.agentId, content });
  await until(() => f.model.calls.some(request => childConversation(request) && request.messages.at(-1)?.content === content));
  try {
    const child = await p.harness.conversation(work.agentId, context); assert.ok(child);
    await p.harness.waitForTask(await child.compact(undefined, context), context);
    assert.equal(compactions, 1);
  } finally { gate.release(); }
  await p.harness.waitForTask(work.taskId, context);
  const currentOperations = await operations(p); assert.equal(currentOperations.length, 1);
  const operation = currentOperations[0]; assert.equal(operation.kind, "read_file"); assert.equal(operation.effect, "returned");
  const entry = await p.harness.commit(tx => tx.entry(operation.instructions!.requestEntry), context);
  const data = entry?.data as { input: { messages: { sections?: Record<string, unknown> }[] }; references: { instructions?: unknown } };
  assert.notEqual(data.input.messages[0]?.sections?.subagent, undefined); assert.deepEqual(data.references.instructions, operation.instructions!.snapshot);
  await p.close(); const restored = await f.open(); assert.equal((await record(restored, operation.operation)).effect, "returned");
});

test("durable 要求更新：原输入完成后的说明轮次以说明自身为原生输入，新操作照常批准执行", { timeout: 90_000 }, async t => {
  const f = await fixture(t), p = await f.open(); await mode(p, "confirm"); await p.answer("工具来源", "tools-src");
  const target = path.join(f.outside, "note-only.txt"); fs.writeFileSync(target, "");
  const note = invoke("write_file", { path: target, content: "说明内容" });
  const answer = invoked(p, invoke("write_file", { path: target, content: "原内容" }), "note-only-work", "tools-src"); void answer.catch(() => undefined);
  const initial = await first(p); const work = initial.origin.work!.ref;
  await p.harness.commit(async tx => {
    (await tx.doc(PersonalInspectionDoc, String(work.taskId), null)).inspection = { taskId: work.taskId, conversationId: work.agentId, taskKind: "test-inspection", unit: "held", machineId: "held", inspectionId: "inspect_held", sources: [], admission: 1 as EntryId, stopped: false, work: { ref: { ...work }, permission: { mode: "confirm", version: 2 }, inputs: [] } };
    (await tx.doc(PersonalPendingInspectionsDoc)).tasks.push(work.taskId);
  }, context);
  await p.harness.commit(tx => toolDecide(tx, initial.operation, "approved", f.directory), context);
  await until(async () => (await p.harness.commit(tx => tx.submissionByRequest(work.agentId, `personal-work:${work.taskId}`), context))?.status === "done");
  try {
    await p.work.append(work, { requestId: "note-only", content: note, sourceRequestId: "tools-src" });
    await p.harness.commit(async tx => { (await tx.doc(PersonalPendingInspectionsDoc)).tasks = []; }, context);
    const noteSub = await until(async () => (await noteSubmission(p, work, "note-only"))?.entry !== undefined).then(() => noteSubmission(p, work, "note-only"));
    await until(async () => (await operations(p)).length === 2);
    const pending = (await operations(p)).at(-1)!;
    assert.equal(pending.instructions?.version, 1);
    assert.notEqual(pending.instructions!.snapshot.original.submissionId, undefined);
    assert.deepEqual(pending.instructions!.snapshot.nativeInputs, [noteSub!.id]);
    assert.equal(pending.instructions!.snapshot.nativeInputs.includes(pending.instructions!.snapshot.original.submissionId), false);
    assert.equal(pending.instructions!.snapshot.notes.length, 1); assert.equal(pending.instructions!.snapshot.notes[0]!.submissionId, noteSub!.id);
    await p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context);
  } finally { await p.harness.commit(async tx => { (await tx.doc(PersonalPendingInspectionsDoc)).tasks = []; }, context).catch(() => undefined); }
  await answer;
  assert.equal(fs.readFileSync(target, "utf8"), "说明内容");
});

test("durable 要求更新：已开始未观察的操作接纳说明后强杀，重开按原未知效果恢复而非记录无效", { timeout: 90_000 }, async t => {
  const endpoint = await remote(t, (request, response) => { if (request.url === "/hang") request.resume(); else response.end("ok"); });
  const f = await fixture(t);
  const script = `
    import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
    import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
    import { PersonalPermissionsDoc } from './apps/ruukoto/src/personal-permissions.ts';
    import { appendPersonalWork, personalWorkNoteSource } from './apps/ruukoto/src/personal-work.ts';
    import { toolOperations } from './apps/ruukoto/src/personal-tools.ts';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    const input = JSON.parse(process.env.RUUKOTO_TOOLS_CRASH);
    const p = await openPersonalHarness({directory:input.directory,provider:personalProvider(input.model),modelId:input.model.modelId,tools:input.tools});
    await p.harness.commit(async tx => {(await tx.doc(PersonalPermissionsDoc)).mode='full_access';}, BACKGROUND_CONTEXT);
    await p.answer('工具来源','hang-src');
    const work = await p.work.delegate({requestId:'hang-work',sourceRequestId:'hang-src',content:input.content});
    for (;;) {
      const ops = await p.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))), BACKGROUND_CONTEXT);
      if (ops.length && ops[0].started) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const op = (await p.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))), BACKGROUND_CONTEXT))[0];
    await p.harness.commit(async tx => appendPersonalWork(tx, op.origin.work.ref, {requestId:'hang-note', content:'kill-note', source: await personalWorkNoteSource(tx, 'hang-src')}), BACKGROUND_CONTEXT);
    process.stdout.write('started-amended\\n');
  `;
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_TOOLS_CRASH: JSON.stringify({ directory: f.directory, model: f.config, tools: f.tools, content: invoke("http_request", { url: `${endpoint}/hang`, method: "POST", body: "x" }) }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; worker.stdout.on("data", value => { output += String(value); }); worker.stderr.on("data", value => { errors += String(value); });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
  await until(() => { assert.equal(worker.exitCode, null, errors); return output.includes("started-amended"); });
  const exit = once(worker, "exit"); worker.kill("SIGKILL"); await exit;
  const p = await f.open();
  const saved = (await operations(p)).find(op => op.prepared.kind === "http")!;
  await until(async () => (await record(p, saved.operation)).code === "interrupted");
  const restored = await record(p, saved.operation);
  assert.equal(restored.effect, "effect_unknown"); assert.equal(restored.stopped, false); assert.equal(restored.started, true); assert.equal(restored.superseded, undefined); assert.equal(restored.approval, "unneeded");
  assert.ok(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "hang-src"), context));
  await p.harness.commit(tx => toolResolve(tx, saved.operation, "not_applied", "远端未收到完整请求"), context);
  await p.harness.commit(tx => toolVerifyStop(tx, saved.operation, "远端连接已断开"), context);
  assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "hang-src"), context), undefined);
});

test("durable 重显示登记：登记提交即崩时重开容忍未完结调用，登记事实保留", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const script = `
    import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
    import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
    import { PersonalPermissionsDoc } from './apps/ruukoto/src/personal-permissions.ts';
    import { toolOperations } from './apps/ruukoto/src/personal-tools.ts';
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    const input = JSON.parse(process.env.RUUKOTO_TOOLS_CRASH);
    let seen = false;
    const p = await openPersonalHarness({directory:input.directory,provider:personalProvider(input.model),modelId:input.model.modelId,tools:input.tools,
      openStorage: async filename => {
        const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
        storage.commit = async (writes, context) => {
          const result = await commit(writes, context);
          if (writes.some(write => write.type === 'entry' && write.value.kind === 'ruukoto.tool-redisplay') && !seen) { seen = true; process.stdout.write('display-admission\\n'); await new Promise(() => {}); }
          return result;
        }; return storage;
      }});
    await p.harness.commit(async tx => {(await tx.doc(PersonalPermissionsDoc)).mode='confirm';}, BACKGROUND_CONTEXT);
    await p.answer('工具来源','display-src');
    await p.work.delegate({requestId:'display-work',sourceRequestId:'display-src',content:input.content});
    let op;
    for (;;) {
      const ops = await p.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))), BACKGROUND_CONTEXT);
      if (ops.length && ops[0].approval === 'pending') { op = ops[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await p.answer('tool:' + JSON.stringify({name:'background_work', args:{action:'redisplay', operation: op.operation}}), 'display-query');
  `;
  const displayTarget = path.join(f.outside, "display-pending.txt"); fs.writeFileSync(displayTarget, "");
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_TOOLS_CRASH: JSON.stringify({ directory: f.directory, model: f.config, tools: f.tools, content: invoke("write_file", { path: displayTarget, content: "x" }) }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; worker.stdout.on("data", value => { output += String(value); }); worker.stderr.on("data", value => { errors += String(value); });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
  await until(() => { assert.equal(worker.exitCode, null, errors); return output.includes("display-admission"); });
  const exit = once(worker, "exit"); worker.kill("SIGKILL"); await exit;
  const p = await f.open(); await mode(p, "confirm");
  const saved = (await operations(p))[0]!;
  assert.notEqual(saved.redisplay, undefined); assert.equal(saved.approval, "pending"); assert.equal(saved.observation, undefined); assert.equal(saved.started, false);
});

test("durable 操作查询与重显示：同一 IM 原入口有权查询登记，异入口与本机查询只读不授权", { timeout: 90_000 }, async t => {
  const previous = process.env.RUUKOTO_IM_QUERY_KEY; process.env.RUUKOTO_IM_QUERY_KEY = "123:test-token";
  let sent = 1000;
  const bot = http.createServer(async (request, response) => { for await (const _chunk of request) { /* 替身只完成读取 */ } response.end(JSON.stringify({ ok: true, result: { message_id: ++sent, chat: { id: 456, type: "private" } } })); });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); if (previous === undefined) delete process.env.RUUKOTO_IM_QUERY_KEY; else process.env.RUUKOTO_IM_QUERY_KEY = previous; });
  const telegram = { version: 1 as const, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "RUUKOTO_IM_QUERY_KEY", tokenDigest: createHash("sha256").update("123:test-token").digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  const f = await fixture(t), p = await f.open({ telegram }); await mode(p, "confirm");
  let message = 0;
  const receive = async (text: string) => {
    const id = ++message;
    await p.telegram.receive({ update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text } });
    const key = `telegram:123:456:${id}`, value = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p.harness.waitForTask(value.taskId, context);
    return key;
  };
  const source = await receive("工具来源");
  const target = path.join(f.outside, "im-display.txt"); fs.writeFileSync(target, "");
  const answer = invoked(p, invoke("write_file", { path: target, content: "x" }), "im-work", source); void answer.catch(() => undefined);
  const pending = await first(p);
  await receive(invoke("background_work", { action: "operations" }));
  const mainCall = f.model.calls.filter(request => !childConversation(request) && !reviewRequest(request)).at(-1)!;
  const listed = JSON.parse(String(mainCall.messages.at(-1)!.content)) as { operations: Array<{ operation: TaskId; canDecide: boolean }> };
  assert.equal(listed.operations.length, 1); assert.equal(listed.operations[0]!.operation, pending.operation); assert.equal(listed.operations[0]!.canDecide, true);
  await receive(invoke("background_work", { action: "redisplay", operation: pending.operation }));
  const displayed = await record(p, pending.operation);
  assert.notEqual(displayed.redisplay, undefined); assert.equal(displayed.approval, "pending"); assert.equal(displayed.observation, undefined); assert.equal(displayed.started, false);
  const localList = JSON.parse(await p.answer(invoke("background_work", { action: "operations" }), "local-query")) as { operations: Array<{ canDecide: boolean }> };
  assert.equal(localList.operations.length, 1); assert.equal(localList.operations[0]!.canDecide, false);
  assert.match(await p.answer(invoke("background_work", { action: "redisplay", operation: pending.operation }), "local-deny"), /tool_original_entry/);
  const identity = displayed.origin.telegram!;
  await p.harness.commit(async tx => { (await tx.doc(PersonalToolDoc, String(pending.operation), null)).operation!.origin.telegram = { ...identity, ownerId: "789" }; }, context);
  await receive(invoke("background_work", { action: "redisplay", operation: pending.operation }));
  const denied = await record(p, pending.operation);
  assert.equal(denied.redisplay, displayed.redisplay); assert.equal(denied.approval, "pending");
  await p.harness.commit(async tx => { (await tx.doc(PersonalToolDoc, String(pending.operation), null)).operation!.origin.telegram = identity; }, context);
  await p.harness.commit(async tx => toolDecide(tx, pending.operation, "approved", f.directory, { ...identity, requestId: source }), context);
  await answer;
  assert.equal(fs.readFileSync(target, "utf8"), "x");
});
