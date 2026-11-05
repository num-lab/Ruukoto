import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type EntryId, type TaskId, type Task } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { mcpUnresolved, mcpSourceBlocker, PersonalMcpDoc, verifyMcp, waitWorkMcp, PersonalMcpConfigDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { mcpResponseEnded } from "@ruukoto/agent/mcp/transport.ts";
import { personalCuaLinux, type CuaLinuxGeneration } from "../apps/ruukoto/src/personal-cua-linux.ts";
import { personalWorkExecutionFacts, personalWorkResult, requestPersonalWorkCancel, PersonalWorkDoc, PersonalWorkTask, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { personalSettingsExternalBlockers } from "../apps/ruukoto/src/personal-settings-blockers.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { PersonalInteractiveResourceDoc, verifyPersonalInteractive } from "../apps/ruukoto/src/personal-interactive.ts";
const context = BACKGROUND_CONTEXT;
const definitions = ["computer_screenshot", "computer_click", "computer_shell"].map(name => ({ name, inputSchema: { type: "object", properties: { sandbox: { type: "string" }, session: { type: "string" }, hang: { type: "boolean" }, bad: { type: "string" } }, additionalProperties: false } }));
async function fixture(t: TestContext, images = true, cua = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "personal-cua-"))), directory = path.join(root, "profile"), sent = path.join(root, "sent.jsonl"), schema = path.join(root, "tools.json");
  fs.writeFileSync(schema, JSON.stringify(definitions)); fs.writeFileSync(sent, "");
  const config = parsePersonalMcp({ version: cua ? 3 : 4, generation: "cua-first", services: [{ id: "desktop", label: "电脑", ...(cua ? { cua: { kind: "cua-linux", executable: "/usr/local/bin/cua", version: "0.7.0", sha256: "a".repeat(64), sandbox: "local:desktop", sandboxId: "b".repeat(64) } } : { endpoint: "http://127.0.0.1:9/mcp" }), enabled: true, tools: definitions, ...(!cua ? { toolEffects: Object.fromEntries(definitions.map(tool => [tool.name, "unknown"])) } : {}) }] });
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace); const stat = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "tool-first", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
  let generation: CuaLinuxGeneration = { containerId: "b".repeat(64), startedAt: "2026-10-23T01:00:00Z", bootId: "c".repeat(36), pid: 42, processIdentity: "10" }, stopped = false, sequence = 0;
  let programFailure = false; const stoppedScopes: string[] = [];
  const host: ReturnType<typeof personalCuaLinux> = { ...personalCuaLinux(), verifyTarget() {}, async generation() { return generation; }, async stopped() { return stopped; }, async stop() { stopped = true; return true; }, async restart() { stopped = false; generation = { ...generation, startedAt: "2026-10-23T02:00:00Z" }; return generation; }, prepare(program) { return { scope: `scope-${++sequence}`, description: "test", program }; }, async execution(scope, description) { return { scope, description, invocationId: "test", group: "/test", dev: 1, ino: 1 }; }, async stopCli() { return true; }, async stopPrepared(scope) { stoppedScopes.push(scope); return true; }, async program() { return { command: process.execPath, args: programFailure ? ["-e", "process.exit(2)"] : [fileURLToPath(new URL("./helpers/personal-cua-stdio-fixture.mjs", import.meta.url)), sent, schema], env: { PATH: "/usr/bin:/bin", HOME: directory } }; } };
  let releaseChild: (() => void) | undefined, closing = false;
  const model = new PersonalMockModelServer(async request => {
    const tail = request.messages.at(-1), last = tail?.role === "user" && Array.isArray(tail.content) ? request.messages.findLast(message => message.role === "tool") : tail, content = String(last?.content);
    if (last?.role === "user" && content.startsWith("HTTP:")) return { kind: "tool_calls", calls: [{ id: "http", name: "http_request", arguments: { url: content.slice(5), method: "GET" } }] };
    if (last?.role === "user" && content === "工具清单") return { kind: "tool_calls", calls: [{ id: "list", name: "mcp_tools", arguments: {} }] };
    if (last?.role === "user" && content.startsWith("调用:")) return { kind: "tool_calls", calls: [{ id: "call", name: "mcp_call", arguments: JSON.parse(content.slice(3)) }] };
    if (request.system?.includes("你是个人助手的子 Agent") && last?.role === "tool" && String(last.content).includes("remoteEnded") && !closing) await new Promise<void>(resolve => { releaseChild = resolve; });
    return { kind: "text", text: last?.role === "tool" ? content : "完成" };
  });
  process.env.RUUKOTO_CUA_MODEL_TEST_KEY = "test-only";
  const provider = personalProvider({ api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_CUA_MODEL_TEST_KEY", contextWindow: 128000, maxTokens: 8192, imageInput: images });
  let current: PersonalHarness | undefined, holdActions = false, releaseAction: (() => void) | undefined;
  const open = async () => {
    current = await openPersonalHarness({ directory, provider, modelId: "mock-model", mcp: config, tools, mcpCuaHost: host, mcpTimeouts: { callTimeoutMs: 100 } });
    // The registry erases SDK task types. Gate its invocation before the action-start transaction.
    const task = current.desktopActions.extension.tasks![0] as Task<{ requestId: string }, { phase: "run" }, null, object>, run = task.definition.phases.run;
    Object.defineProperty(task.definition.phases, "run", { value: async (...args: Parameters<typeof run>) => { if (holdActions) await new Promise<void>(resolve => { releaseAction = resolve; }); return run(...args); } });
    return current;
  };
  t.after(async () => { closing = true; releaseChild?.(); await current?.close(); await model.close(); delete process.env.RUUKOTO_CUA_MODEL_TEST_KEY; fs.rmSync(root, { recursive: true, force: true }); });
  const calls = () => fs.readFileSync(sent, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(item => item.method === "tools/call");
  let work: PersonalWorkRef | undefined;
  async function waitUntil(check: () => boolean | Promise<boolean>) {
    const end = Date.now() + 10000;
    while (!await check()) { assert.ok(Date.now() < end, "waiting for Cua work"); await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  async function answer(p: PersonalHarness, content: string, requestId: string) {
    if (!content.startsWith("调用:")) return p.answer(content, requestId);
    await p.answer("电脑工作", requestId);
    const previous = (await p.harness.snapshot(PersonalMcpConfigDoc, context))!.operations.slice(), modelBefore = model.calls.length;
    if (work && (await p.harness.commit(tx => tx.task(work!.taskId), context))?.state.status !== "terminal") {
      await p.work.append(work, { requestId: `cua-note:${requestId}`, sourceRequestId: requestId, content });
      await waitUntil(async () => (await p.harness.snapshot(PersonalWorkDoc, work!.requestId, context))!.notes!.at(-1)!.submissionId !== undefined);
      await waitUntil(() => releaseChild !== undefined);
      const release = releaseChild; releaseChild = undefined; release?.();
    } else work = await p.work.delegate({ requestId: `cua-work:${requestId}`, sourceRequestId: requestId, content });
    let operation: TaskId | undefined;
    await waitUntil(async () => {
      for (const id of (await p.harness.snapshot(PersonalMcpConfigDoc, context))!.operations) if (!previous.includes(id)) {
        const value = (await p.harness.snapshot(PersonalMcpDoc, String(id), context))!.operation!;
        if (value.origin.work?.ref.taskId === work!.taskId) { operation = id; return value.observation !== undefined && (releaseChild !== undefined || !value.remoteEnded && value.started || value.takeover !== undefined); }
      }
      const live = await p.harness.commit(tx => tx.task(work!.taskId), context);
      return live?.state.status === "terminal" || model.calls.slice(modelBefore).some(request => request.system?.includes("你是个人助手的子 Agent") && request.messages.at(-1)?.role === "tool");
    });
    if (operation === undefined) {
      const failed = model.calls.slice(modelBefore).findLast(request => request.system?.includes("你是个人助手的子 Agent") && request.messages.at(-1)?.role === "tool");
      return typeof failed?.messages.at(-1)?.content === "string" ? failed.messages.at(-1)!.content as string : (await p.harness.commit(tx => personalWorkResult(tx, work!), context)).text ?? "";
    }
    const saved = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
    return JSON.stringify({ operation, effect: saved.effect, code: saved.code, remoteEnded: saved.remoteEnded });
  }
  return { holdActions(value: boolean) { holdActions = value; if (!value) { releaseAction?.(); releaseAction = undefined; } }, answer, release() { const release = releaseChild; releaseChild = undefined; release?.(); }, currentWork: () => work, holdCall() { fs.writeFileSync(sent + ".hold", ""); }, releaseCall() { fs.writeFileSync(sent + ".release", ""); }, async finish(p: PersonalHarness) { if (!work) return; closing = true; releaseChild?.(); await p.harness.waitForTask(work.taskId, context); closing = false; work = undefined; }, directory, config, model, host, open, calls, stoppedScopes, setDefinitions(tools: object[]) { fs.writeFileSync(schema, JSON.stringify(tools)); }, failProgram(value = true) { programFailure = value; }, setImageMode(mode: string) { fs.writeFileSync(sent + ".mode", mode); }, async full(p: PersonalHarness) { await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context); } };
}
const input = (tool: string, args: Record<string, unknown> = {}) => "调用:" + JSON.stringify({ service: "desktop", tool, arguments: args });

test("Personal Cua：持续连接、真实固定目标与受限定义进入模型历史，旧证据不串调用", async t => {
  const baseline = await fixture(t, true, false), plain = await baseline.open(); await baseline.full(plain);
  await plain.answer("工具清单", "baseline-list");
  const before = baseline.model.calls.at(-1)!;
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await p.answer("工具清单", "list");
  await f.answer(p, input("computer_screenshot"), "observe");
  const original = (await p.mcp!.list()).items[0];
  const next = JSON.parse(await f.answer(p, input("computer_click"), "click"));
  assert.equal(original.effect, "returned"); assert.equal(next.effect, "returned");
  assert.equal(f.calls().length, 2); assert.equal(f.calls()[0].pid, f.calls()[1].pid);
  assert.deepEqual(f.calls()[1].params.arguments, { sandbox: "local:desktop" });
  const saved = (await p.harness.snapshot(PersonalMcpDoc, String(next.operation), context))!.operation!;
  assert.equal(JSON.parse(saved.evidence.request!).params.name, "computer_click");
  assert.equal(JSON.parse(saved.evidence.response!).id, JSON.parse(saved.evidence.request!).id);
  const requestWithDefinition = f.model.calls.find(request => request.messages.some(message => message.role === "tool" && String(message.content).includes('"tools":[')))!;
  const listResult = requestWithDefinition.messages.find(message => message.role === "tool" && String(message.content).includes('"tools":['))!;
  const exposed = JSON.parse(String(listResult.content)).tools[0].definition;
  assert.equal(exposed.inputSchema.properties.sandbox, undefined); assert.equal(exposed.inputSchema.properties.session, undefined);
  const restricted = JSON.parse(saved.modelDefinition!); assert.deepEqual(restricted.inputSchema.properties, { hang: { type: "boolean" }, bad: { type: "string" } });
  assert.ok(JSON.stringify(f.model.calls.at(-1)!.raw).includes("电脑连接在同一工作内跨调用保留"));
  const estimate = (request: typeof before) => ({ systemPrompt: Math.ceil((request.system?.length ?? 0) / 4), toolSchemas: Math.ceil(JSON.stringify(request.tools ?? []).length / 4) });
  t.diagnostic(JSON.stringify({ estimatedTokens: { before: estimate(before), after: estimate(f.model.calls.at(-1)!) } }));
  await f.answer(p, input("computer_click", { sandbox: "local:other" }), "override"); assert.equal(f.calls().length, 2);
});
test("Personal Cua：恢复允许描述变化，参数 schema 改变仍拒绝", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const { operation } = JSON.parse(await f.answer(p, input("computer_click", { hang: true }), "lost"));
  await p.mcp!.recoverCua(operation, "stop");
  f.setDefinitions(definitions.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, required: ["sandbox"] } })));
  await assert.rejects(p.mcp!.recoverCua(operation, "observe"), { code: "cua_definition_changed" });
  assert.equal(f.calls().length, 2);
  f.setDefinitions(definitions.map(tool => ({ ...tool, description: "更新后的工具描述" })));
  await p.mcp!.recoverCua(operation, "observe");
  await p.mcp!.recoverCua(operation, "accept", (await p.mcp!.detail(operation)).summary.cuaObservation);
  assert.equal((await p.mcp!.detail(operation)).summary.cuaRecovery, "accepted");
  assert.equal(f.calls().length, 3);
});
test("Personal Cua：文本模型在电脑动作前拒绝且零发送", async t => {
  const f = await fixture(t, false), p = await f.open(); await f.full(p);
  const answer = await f.answer(p, input("computer_screenshot"), "text-model");
  assert.ok(answer.includes("model_image_unsupported")); assert.equal(f.calls().length, 0);
});
test("Personal Cua：丢答冷恢复保留unknown和remoteEnded，接受新观察才释放全部原等待", async t => {
  const f = await fixture(t); let p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const answer = JSON.parse(await f.answer(p, input("computer_click", { hang: true }), "lost")), operation = answer.operation;
  assert.equal(answer.effect, "effect_unknown"); assert.equal(f.calls().length, 2);
  await p.close(); p = await f.open();
  assert.equal(mcpUnresolved((await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!), true);
  assert.ok(await p.harness.commit(tx => mcpSourceBlocker(tx, "lost"), context));
  await assert.rejects(p.mcp!.recoverCua(operation, "observe"));
  await assert.rejects(p.mcp!.recoverCua(operation, "accept"));
  await p.mcp!.recoverCua(operation, "stop"); await p.mcp!.recoverCua(operation, "observe");
  assert.equal(f.calls().length, 3);
  const unknownFacts = await p.harness.commit(tx => personalWorkExecutionFacts(tx, f.currentWork()!.taskId, 8), context);
  assert.deepEqual(unknownFacts.factCounts!.mcp, { total: 2, pending: 1, unknown: 1 });
  await p.mcp!.recoverCua(operation, "accept", (await p.mcp!.detail(operation)).summary.cuaObservation);
  const original = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
  assert.equal(original.remoteEnded, false); assert.equal(original.effect, "effect_unknown"); assert.equal(mcpUnresolved(original), false);
  assert.equal(await p.harness.commit(tx => mcpSourceBlocker(tx, "lost"), context), undefined);
  await waitWorkMcp(p.harness, [operation], context);
  await p.harness.waitForTask(f.currentWork()!.taskId, context);
  const recoveredFacts = await p.harness.commit(tx => personalWorkExecutionFacts(tx, f.currentWork()!.taskId, 8), context);
  assert.deepEqual(recoveredFacts.factCounts!.mcp, { total: 2, pending: 0, unknown: 0 });
  assert.doesNotMatch(recoveredFacts.notice!, /同一来源不再执行/);
  const recoveredPage = await p.harness.commit(tx => personalWorkExecutionFacts(tx, f.currentWork()!.taskId), context);
  assert.match(recoveredPage.notice!, /原电脑调用结果未知已保留，恢复的新观察已接受/);
  assert.doesNotMatch(recoveredPage.notice!, /同一来源不再执行/);
  assert.deepEqual(await personalSettingsExternalBlockers({ harness: p.harness }), []);
  assert.equal((await p.mcp!.detail(operation)).summary.cuaRecovery, "accepted");
  await f.answer(p, input("computer_screenshot"), "new-work-observe");
  await f.answer(p, input("computer_click"), "new-work"); assert.equal(f.calls().length, 5);
  await f.finish(p);
  await p.close(); p = await f.open();
  assert.equal(mcpUnresolved((await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!), false);
});

for (const bad of ["empty", "invalid", "error"]) test(`Personal Cua：${bad} 截图不能开放点击`, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot", { bad }), "bad-image");
  await f.answer(p, input("computer_click"), "blocked-click");
  assert.equal(f.calls().length, 1);
  assert.equal((await p.mcp!.list()).items[0].code, "cua_observation_required");
});
test("Personal Cua：未决电脑调用不会破坏独立HTTP目标检查，恢复失败仍不接受旧图", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const unknown = JSON.parse(await f.answer(p, input("computer_click", { hang: true }), "lost"));
  const server = http.createServer((_request, response) => response.end("独立HTTP成功")); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  // HTTP 请求只保留在子 Agent：独立目标检查经委派工作驱动。
  await p.answer("独立HTTP检查", "independent");
  const httpWork = await p.work.delegate({ requestId: "independent-http", sourceRequestId: "independent", content: `HTTP:http://127.0.0.1:${address.port}/independent` });
  await p.harness.waitForTask(httpWork.taskId, context);
  const answer = await p.harness.commit(tx => personalWorkResult(tx, httpWork), context).then(value => value.text ?? "");
  assert.ok(answer.includes("独立HTTP成功"), answer);
  await p.mcp!.recoverCua(unknown.operation, "stop");
  f.setImageMode("invalid"); await assert.rejects(p.mcp!.recoverCua(unknown.operation, "observe"));
  await assert.rejects(p.mcp!.recoverCua(unknown.operation, "accept"));
  assert.equal((await p.mcp!.detail(unknown.operation)).summary.cuaRecovery, "begun");
});

test("Personal Cua：成功观察后再次观察失败，冷启动可继续恢复且不接受旧截图", async t => {
  const f = await fixture(t); let p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const unknown = JSON.parse(await f.answer(p, input("computer_click", { hang: true }), "lost"));
  await p.mcp!.recoverCua(unknown.operation, "stop"); await p.mcp!.recoverCua(unknown.operation, "observe");
  const old = (await p.mcp!.detail(unknown.operation)).summary.cuaObservation;
  f.setImageMode("empty"); await assert.rejects(p.mcp!.recoverCua(unknown.operation, "observe"));
  await p.close(); p = await f.open();
  assert.equal((await p.mcp!.detail(unknown.operation)).summary.cuaRecovery, "begun");
  await assert.rejects(p.mcp!.recoverCua(unknown.operation, "accept", old));
  f.setImageMode(""); await p.mcp!.recoverCua(unknown.operation, "observe");
  const current = (await p.mcp!.detail(unknown.operation)).summary.cuaObservation;
  assert.notEqual(current, old);
  await assert.rejects(p.mcp!.recoverCua(unknown.operation, "accept", old));
  await p.mcp!.recoverCua(unknown.operation, "accept", current);
});
for (const [mode, code] of [["error", "cua_observation_failed"], ["invalid", "cua_observation_invalid"], ["empty", "cua_observation_missing"]]) test(`Personal Cua：恢复 ${mode} 原应答跨冷启和再次观察保留，失败不开放接受`, async t => {
  const f = await fixture(t); let p = await f.open(); await f.full(p);
  let stops = 0, restarts = 0; const stop = f.host.stop, restart = f.host.restart;
  f.host.stop = async execution => { stops++; return stop(execution); };
  f.host.restart = async execution => { restarts++; return restart(execution); };
  await f.answer(p, input("computer_screenshot"), "initial");
  const unknown = JSON.parse(await f.answer(p, input("computer_click", { hang: true }), "lost"));
  await p.mcp!.recoverCua(unknown.operation, "stop");
  f.setImageMode(mode); await assert.rejects(p.mcp!.recoverCua(unknown.operation, "observe"), { code });
  const failed = (await p.harness.snapshot(PersonalMcpDoc, String(unknown.operation), context))!.operation!, recovery = failed.cua!.recovery!;
  assert.equal(failed.effect, "effect_unknown"); assert.equal(failed.remoteEnded, false); assert.equal(mcpUnresolved(failed), true);
  assert.equal(recovery.observation, undefined); assert.equal(recovery.responses?.length, 1);
  await assert.rejects(p.mcp!.recoverCua(unknown.operation, "accept"), { code: "cua_observation_stale" });
  const response = (await p.harness.commit(tx => tx.entry(recovery.responses![0]), context))!;
  const request = recovery.pendingObservation!, calls = f.calls();
  const expected = { operation: unknown.operation, execution: failed.cua!.execution, action: "observe-response", requestEntry: request.entry, nextExecution: request.execution, evidence: { request: request.request, response: JSON.stringify({ jsonrpc: "2.0", id: calls[2].id, result: { content: mode === "empty" ? [{ type: "text", text: "无图" }] : [{ type: "image", data: mode === "invalid" ? "aGVsbG8=" : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", mimeType: "image/png" }], ...(mode === "error" ? { isError: true } : {}) } }) } };
  assert.deepEqual(response.data, expected); assert.equal(mcpResponseEnded(expected.evidence.response), true);
  assert.equal(JSON.parse(request.request).id, calls[2].id); assert.ok(response.id > request.entry);
  async function detail() {
    let text = "", offset: number | undefined = 0;
    do { const page = await p.mcp!.detail(unknown.operation, offset); text += page.text; offset = page.nextOffset; } while (offset !== undefined);
    return JSON.parse(text);
  }
  assert.deepEqual((await detail()).cuaResponses, [{ entry: response.id, ...expected }]);
  if (mode === "error") {
    const keys = (await p.mcp!.list()).items.map(item => String(item.operation));
    await p.harness.commit(async tx => { delete (await tx.doc(PersonalMcpDoc, String(unknown.operation), null)).operation!.cua!.recovery!.responses; }, context);
    await assert.rejects(p.harness.commit(tx => verifyMcp(tx, keys), context), { code: "mcp_record_invalid" });
    await p.harness.commit(async tx => { (await tx.doc(PersonalMcpDoc, String(unknown.operation), null)).operation!.cua!.recovery!.responses = [response.id]; }, context);
  }
  await p.close(); p = await f.open();
  assert.deepEqual((await detail()).cuaResponses, [{ entry: response.id, ...expected }]);
  f.setImageMode(""); await p.mcp!.recoverCua(unknown.operation, "observe");
  const current = (await p.mcp!.detail(unknown.operation)).summary.cuaObservation!;
  await p.mcp!.recoverCua(unknown.operation, "accept", current);
  const accepted = (await p.harness.snapshot(PersonalMcpDoc, String(unknown.operation), context))!.operation!;
  assert.equal(accepted.effect, "effect_unknown"); assert.equal(accepted.remoteEnded, false); assert.equal(mcpUnresolved(accepted), false);
  assert.equal(accepted.cua!.recovery!.responses?.length, 2); assert.deepEqual((await detail()).cuaResponses[0], { entry: response.id, ...expected });
  assert.equal(stops, 1); assert.equal(restarts, 1); assert.equal(f.calls().length, 4);
});
for (const damage of ["missing-id", "null-response"]) test(`Personal Cua：恢复应答 ${damage} 损坏时按类型拒绝冷启动且不外调`, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const unknown = JSON.parse(await f.answer(p, input("computer_click", { hang: true }), "lost"));
  await p.mcp!.recoverCua(unknown.operation, "stop");
  f.setImageMode("error"); await assert.rejects(p.mcp!.recoverCua(unknown.operation, "observe"), { code: "cua_observation_failed" });
  const recovery = (await p.harness.snapshot(PersonalMcpDoc, String(unknown.operation), context))!.operation!.cua!.recovery!, responseId = recovery.responses![0];
  const data = JSON.parse(JSON.stringify((await p.harness.commit(tx => tx.entry(responseId), context))!.data)) as { evidence: { request: string; response: string } };
  if (damage === "missing-id") {
    const sent = JSON.parse(data.evidence.request) as Record<string, unknown>, received = JSON.parse(data.evidence.response) as Record<string, unknown>;
    delete sent.id; delete received.id; data.evidence = { request: JSON.stringify(sent), response: JSON.stringify(received) };
    await p.harness.commit(async tx => { (await tx.doc(PersonalMcpDoc, String(unknown.operation), null)).operation!.cua!.recovery!.pendingObservation!.request = data.evidence.request; }, context);
  } else data.evidence.response = "null";
  await p.close();
  const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
  try {
    db.prepare("UPDATE entries SET record = json_set(record, '$.data.evidence.request', ?, '$.data.evidence.response', ?) WHERE id = ?").run(data.evidence.request, data.evidence.response, responseId);
    db.prepare("UPDATE entries SET record = json_set(record, '$.data.evidence.request', ?) WHERE id = ?").run(data.evidence.request, recovery.pendingObservation!.entry);
  } finally { db.close(); }
  await assert.rejects(f.open(), { code: "mcp_record_invalid" }); assert.equal(f.calls().length, 3);
});
test("Personal Cua Linux：错误容器和自动重启策略拒绝，未执行Docker变更", async () => {
  const calls: string[][] = [], id = "b".repeat(64);
  for (const variant of ["identity", "restart", "namespace", "mount", "privileged", "device"]) {
    const host = personalCuaLinux(async (program, args) => {
      assert.equal(program, "/usr/bin/docker"); calls.push(args);
      return JSON.stringify([{ Id: variant === "identity" ? "c".repeat(64) : id, State: { Running: true, Restarting: false, Pid: 1, StartedAt: "original" }, HostConfig: { RestartPolicy: { Name: variant === "restart" ? "always" : "no" }, PidMode: variant === "namespace" ? "host" : "", Privileged: variant === "privileged", Devices: variant === "device" ? [{ PathOnHost: "/dev/uinput" }] : [] }, Mounts: variant === "mount" ? [{ Source: "/tmp/.X11-unix" }] : [] }]);
    });
    await assert.rejects(host.generation(id));
  }
  assert.ok(calls.every(args => args[0] === "--host" && args[1] === "unix:///var/run/docker.sock" && args[2] === "inspect"));
});

test("Personal Cua：初始化失败保留启动和停止事实，关闭后的停止证据跨冷启动保留", async t => {
  const f = await fixture(t); let p = await f.open(); await f.full(p); f.failProgram();
  await f.answer(p, input("computer_screenshot"), "init-failure");
  const operation = (await p.mcp!.list()).items[0].operation;
  const value = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
  assert.equal(value.started, false); assert.equal(value.cuaLaunches?.length, 1); assert.ok(value.cuaLaunches[0].stopped); assert.equal(f.stoppedScopes.length, 1); assert.equal(f.calls().length, 0);
  f.failProgram(false); await f.answer(p, input("computer_screenshot"), "valid-launch");
  await f.finish(p);
  await p.close(); f.host.stopPrepared = async () => false;
  p = await f.open();
  assert.equal(await p.answer("普通聊天", "chat"), "完成");
  await f.answer(p, input("computer_screenshot"), "new-observation"); assert.equal(f.calls().length, 2);
});
test("Personal Cua：空闲CLI退出后丢弃观察，新连接截图前零点击", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const originalPid = f.calls()[0].pid;
  process.kill(originalPid, "SIGTERM"); await new Promise(resolve => setTimeout(resolve, 50));
  await f.answer(p, input("computer_click"), "stale-click"); assert.equal(f.calls().length, 1);
  await f.answer(p, input("computer_screenshot"), "fresh"); assert.equal(f.calls().length, 2); assert.notEqual(f.calls()[1].pid, originalPid);
});

test("Personal Cua: a paused assignment requires a new bound observation across reopen", async t => {
  const f = await fixture(t); let p = await f.open(); await f.full(p);
  const original = JSON.parse(await f.answer(p, input("computer_screenshot"), "before-pause"));
  await p.mcp!.pauseCua(true);
  assert.equal((await p.mcp!.cuaStatus()).paused, true);
  const pausedFacts = await p.harness.commit(tx => personalWorkExecutionFacts(tx, f.currentWork()!.taskId, 8), context);
  assert.deepEqual(pausedFacts.factCounts!.mcp, { total: 1, pending: 1, unknown: 0 });
  assert.equal(pausedFacts.notice, undefined);
  assert.equal(await p.answer("暂停时仍可聊天", "ordinary-chat"), "完成");
  const work = f.currentWork()!;
  assert.deepEqual(await p.work.append(work, { requestId: "paused-amendment", sourceRequestId: "ordinary-chat", content: input("computer_screenshot") }), { accepted: true });
  const deadline = Date.now() + 1000;
  while ((await p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.notes!.at(-1)!.submissionId === undefined) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  f.release(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.calls().length, 1);
  assert.equal((await p.harness.commit(tx => tx.task(work.taskId), context))!.state.status, "running");
  await assert.rejects(p.mcp!.pauseCua(false), { code: "cua_frozen" });
  await p.close(); p = await f.open();
  assert.equal((await p.mcp!.cuaStatus()).paused, true);
  await p.mcp!.recoverCua(original.operation, "observe");
  const observation = (await p.mcp!.detail(original.operation)).summary.cuaObservation!;
  await assert.rejects(p.mcp!.recoverCua(original.operation, "accept", (observation - 1) as EntryId), { code: "cua_observation_stale" });
  await p.mcp!.recoverCua(original.operation, "accept", observation);
  await p.mcp!.pauseCua(false);
  const resumedDeadline = Date.now() + 1000;
  while (f.calls().length < 3) { assert.ok(Date.now() < resumedDeadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.notes!.length, 1);
  await f.finish(p);
  const click = JSON.parse(await f.answer(p, input("computer_click"), "without-new-picture"));
  assert.equal(click.code, "cua_observation_required"); assert.equal(f.calls().length, 3);
  await f.answer(p, input("computer_screenshot"), "new-picture");
  await f.answer(p, input("computer_click"), "new-click");
  assert.equal(f.calls().length, 5);
});

test("Personal Cua: unverified CLI stopping keeps the paused work until fresh observation acceptance", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const original = JSON.parse(await f.answer(p, input("computer_screenshot"), "before-pause"));
  let stops = 0; f.host.stopCli = async () => ++stops > 1;
  await assert.rejects(p.mcp!.pauseCua(true), { code: "cua_stop_unverified" });
  assert.equal((await p.mcp!.cuaStatus()).paused, true);
  await assert.rejects(p.mcp!.pauseCua(false), { code: "cua_frozen" });
  await p.mcp!.recoverCua(original.operation, "observe");
  await p.mcp!.recoverCua(original.operation, "accept", (await p.mcp!.detail(original.operation)).summary.cuaObservation);
  await p.mcp!.pauseCua(false);
  assert.equal((await p.mcp!.cuaStatus()).paused, false);
  const click = JSON.parse(await f.answer(p, input("computer_click"), "without-new-picture"));
  assert.equal(click.code, "cua_observation_required"); assert.equal(f.calls().length, 2);
  await f.answer(p, input("computer_screenshot"), "new-picture");
  await f.answer(p, input("computer_click"), "new-click"); assert.equal(f.calls().length, 4);
});

test("Personal Cua：恢复图片分页绑定最新观察，重观察启动失败使旧接受失效且保留暂停", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const unknown = JSON.parse(await f.answer(p, input("computer_click", { hang: true }), "lost"));
  await p.mcp!.pauseCua(true);
  await p.mcp!.recoverCua(unknown.operation, "stop"); await p.mcp!.recoverCua(unknown.operation, "observe");
  const detail = await p.mcp!.detail(unknown.operation), observation = detail.summary.cuaObservation!, image = detail.recoveryImages![0];
  const page = await p.mcp!.cuaImage(unknown.operation, observation, image.id);
  assert.equal(page.mime, image.mime); assert.equal(Buffer.from(page.base64, "base64").length, image.bytes);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
  await assert.rejects(p.mcp!.cuaImage(unknown.operation, (observation + 1) as EntryId, image.id));
  f.failProgram(); await assert.rejects(p.mcp!.recoverCua(unknown.operation, "observe"));
  await assert.rejects(p.mcp!.cuaImage(unknown.operation, observation, image.id));
  await assert.rejects(p.mcp!.recoverCua(unknown.operation, "accept", observation));
  assert.equal((await p.mcp!.cuaStatus()).paused, true);
  assert.equal((await p.mcp!.detail(unknown.operation)).summary.cuaRecovery, "begun");
});

test("Personal Cua：在途调用期间暂停先拒绝新发送，丢答后继续仍要求完整恢复", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const pending = f.answer(p, input("computer_click", { hang: true }), "in-flight");
  const deadline = Date.now() + 1000;
  while (f.calls().length < 2) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 2)); }
  const paused = await p.mcp!.pauseCua(true); assert.equal(paused.paused, true); assert.equal(paused.busy, true);
  assert.equal(JSON.parse(await pending).effect, "effect_unknown");
  assert.equal((await p.mcp!.cuaStatus()).busy, false);
  await assert.rejects(p.mcp!.pauseCua(false), { code: "cua_frozen" });
  assert.equal((await p.mcp!.cuaStatus()).paused, true); assert.equal(f.calls().length, 2);
});

test("Personal Cua：v3 格式迁入 v4 不改变旧执行身份或自锁，旧未知按合并观察恢复", async t => {
  const f = await fixture(t);
  const profile = lockPersonalProfile(f.directory);
  fs.writeFileSync(path.join(f.directory, "mcp.json"), JSON.stringify(f.config) + "\n", { mode: 0o600 });
  profile.release();
  let p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "initial");
  const unknown = JSON.parse(await f.answer(p, input("computer_click", { hang: true }), "lost"));
  const original = (await p.harness.snapshot(PersonalMcpDoc, String(unknown.operation), context))!.operation!;
  await p.close();
  const { migratePersonalMcp } = await import("../apps/ruukoto/src/personal-mcp-config.ts");
  await migratePersonalMcp(f.directory); p = await f.open();
  assert.equal((await p.harness.snapshot(PersonalMcpConfigDoc, context))!.config!.version, 4);
  assert.deepEqual((await p.harness.snapshot(PersonalMcpDoc, String(unknown.operation), context))!.operation!.cua!.execution, original.cua!.execution);
  assert.equal(f.calls().length, 2);
  await assert.rejects(p.mcp!.end(unknown.operation));
  await p.mcp!.recoverCua(unknown.operation, "stop"); await p.mcp!.recoverCua(unknown.operation, "observe");
  const detail = await p.mcp!.detail(unknown.operation);
  await p.mcp!.recoverCua(unknown.operation, "accept", detail.summary.cuaObservation);
  assert.equal((await p.mcp!.detail(unknown.operation)).summary.cuaRecovery, "accepted");
  assert.equal((await p.harness.snapshot(PersonalMcpDoc, String(unknown.operation), context))!.operation!.remoteEnded, false);
  assert.equal(f.calls().length, 3);
});

test("Personal Cua: two assignments keep serial ownership until the original CLI stop is verified", { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "serial-first");
  const original = f.currentWork()!;
  await p.answer("另一个电脑任务", "serial-second");
  const next = await p.work.delegate({ requestId: "cua-serial-second", sourceRequestId: "serial-second", content: input("computer_screenshot") });
  const { PersonalInteractiveResourceDoc } = await import("../apps/ruukoto/src/personal-interactive.ts");
  const resource = `cua:${"b".repeat(64)}`, deadline = Date.now() + 2000;
  while ((await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))?.claims.length !== 2) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(f.calls().length, 1);
  const claims = (await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!;
  assert.equal(claims.owner, claims.claims[0].claim);
  assert.equal(claims.claims[1].acquired, undefined);
  f.host.stopCli = async () => false; f.host.stopPrepared = async () => false;
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, original), context);
  await p.harness.abortTask(original.taskId, context);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.calls().length, 1);
  assert.equal((await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!.owner, claims.claims[0].claim);
  assert.equal((await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!.claims[1].acquired, undefined);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, original.requestId, context))!.cancelRequested, true);
  assert.equal(await p.answer("核实时还能聊天", "serial-chat"), "完成");
  f.host.stopCli = async () => true; f.host.stopPrepared = async () => true;
  const originalOperation = (await p.mcp!.list()).items.find(item => item.started)!.operation;
  await p.mcp!.recoverCua(originalOperation, "stop");
  const nextDeadline = Date.now() + 2000;
  while (f.calls().length < 2) { assert.ok(Date.now() < nextDeadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  const after = (await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!;
  assert.ok(after.claims[0].released); assert.equal(after.owner, after.claims[1].claim); assert.ok(after.claims[1].acquired! > after.claims[0].released!);
  assert.equal((await p.harness.snapshot(PersonalMcpDoc, String((await p.mcp!.list()).items[0].operation), context))!.operation!.origin.work!.ref.taskId, next.taskId);
});

test("Personal Cua: reopening rejects a released claim without the owned CLI stop evidence", { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "evidence-owner");
  const work = f.currentWork()!; await f.finish(p);
  const { PersonalInteractiveResourceDoc } = await import("../apps/ruukoto/src/personal-interactive.ts");
  const resource = `cua:${"b".repeat(64)}`;
  const claim = (await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!.claims[0];
  assert.ok(claim.released); assert.ok(claim.stopped?.length);
  const operation = (await p.mcp!.list()).items[0].operation;
  const saved = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
  assert.equal(saved.origin.work!.ref.taskId, work.taskId);
  await p.harness.commit(async tx => { (await tx.doc(PersonalInteractiveResourceDoc, resource, null)).claims[0].stopped = []; }, context);
  await p.close(); await assert.rejects(f.open(), { code: "mcp_record_invalid" });
  assert.equal(f.calls().length, 1);
});

test("Personal Cua: a later takeover preserves the prior accepted choice and requires its own observation", { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const original = JSON.parse(await f.answer(p, input("computer_screenshot"), "twice-owner"));
  assert.equal((await p.mcp!.cuaStatus()).operations.length, 0, "ordinary persistent CLI is not unverified stopping");
  await p.mcp!.pauseCua(true); await p.mcp!.recoverCua(original.operation, "observe");
  const first = (await p.mcp!.detail(original.operation)).summary.cuaObservation!;
  await p.mcp!.recoverCua(original.operation, "accept", first); await p.mcp!.pauseCua(false);
  await p.mcp!.pauseCua(true);
  await assert.rejects(p.mcp!.recoverCua(original.operation, "accept", first), { code: "cua_observation_stale" });
  await p.mcp!.recoverCua(original.operation, "observe");
  const second = (await p.mcp!.detail(original.operation)).summary.cuaObservation!;
  assert.notEqual(second, first);
  await p.mcp!.recoverCua(original.operation, "accept", second); await p.mcp!.pauseCua(false);
  const saved = (await p.harness.snapshot(PersonalMcpDoc, String(original.operation), context))!.operation!;
  assert.equal(saved.previousTakeovers?.length, 1); assert.equal(saved.previousTakeovers[0].observation!.entry, first);
  await f.finish(p); await p.close(); const reopened = await f.open();
  assert.deepEqual((await reopened.harness.snapshot(PersonalMcpDoc, String(original.operation), context))!.operation!.previousTakeovers, saved.previousTakeovers);
  assert.equal(f.calls().length, 3);
});


test("Personal Cua: takeover during a successful in-flight call requires a new exact observation", { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await f.answer(p, input("computer_screenshot"), "inflight-start");
  f.holdCall();
  const pending = f.answer(p, input("computer_click"), "inflight-click");
  const deadline = Date.now() + 1000;
  while (f.calls().length < 2) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  await p.mcp!.pauseCua(true); f.releaseCall();
  const result = JSON.parse(await pending);
  assert.equal(result.effect, "returned"); assert.equal(f.calls().length, 2);
  assert.equal((await p.mcp!.detail(result.operation)).summary.cuaRecovery, "begun");
  await assert.rejects(p.mcp!.pauseCua(false), { code: "cua_frozen" });
  await p.mcp!.recoverCua(result.operation, "observe");
  const observation = (await p.mcp!.detail(result.operation)).summary.cuaObservation!;
  await p.mcp!.recoverCua(result.operation, "accept", observation);
  const originalAcceptance = (await p.harness.snapshot(PersonalMcpDoc, String(result.operation), context))!.operation!.takeover!.accepted;
  await p.mcp!.recoverCua(result.operation, "accept", observation);
  assert.equal((await p.harness.snapshot(PersonalMcpDoc, String(result.operation), context))!.operation!.takeover!.accepted, originalAcceptance);
  await p.mcp!.pauseCua(false);
  assert.equal(f.calls().length, 3);
});

test("Personal Cua: every queued claim requires its original MCP participant", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const first = JSON.parse(await f.answer(p, input("computer_screenshot"), "claim-owner"));
  const resource = `cua:${"b".repeat(64)}`, state = (await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!;
  await p.harness.commit(async tx => {
    const doc = await tx.doc(PersonalInteractiveResourceDoc, resource, null), { origin, instructions } = doc.claims[0];
    const admission = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.interactive-admission", data: { version: 1, resource, origin, instructions: instructions! } });
    doc.claims.push({ claim: admission.id, origin, instructions });
  }, context);
  await p.harness.commit(tx => verifyPersonalInteractive(tx, [resource]), context);
  await assert.rejects(p.harness.commit(tx => verifyMcp(tx, [String(first.operation)]), context), { code: "mcp_record_invalid" });
  await p.harness.commit(async tx => { Object.assign(await tx.doc(PersonalInteractiveResourceDoc, resource, null), state); }, context);
});

test("Personal Cua: cancellation after accepted takeover rechecks only its original CLI", { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const first = JSON.parse(await f.answer(p, input("computer_screenshot"), "accepted-owner"));
  await p.mcp!.pauseCua(true); await p.mcp!.recoverCua(first.operation, "observe");
  const observation = (await p.mcp!.detail(first.operation)).summary.cuaObservation!;
  await p.mcp!.recoverCua(first.operation, "accept", observation); await p.mcp!.pauseCua(false);
  const original = (await p.harness.snapshot(PersonalMcpDoc, String(first.operation), context))!.operation!, work = f.currentWork()!;
  let sandboxStops = 0; f.host.stop = async () => { sandboxStops++; return true; };
  f.host.stopCli = async () => false; f.host.stopPrepared = async () => false;
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, work), context); await p.harness.abortTask(work.taskId, context);
  const deadline = Date.now() + 2000;
  while (!(await p.mcp!.detail(first.operation)).summary.cuaStopUnverified) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal((await p.mcp!.detail(first.operation)).summary.cuaRecovery, "accepted");
  assert.notEqual((await p.harness.getTask(work.taskId, context))!.state.status, "terminal");
  assert.equal(await p.answer("核实时继续聊天", "accepted-stop-chat"), "完成");
  f.host.stopCli = async () => true; f.host.stopPrepared = async () => true;
  await p.mcp!.recoverCua(first.operation, "stop"); await p.harness.waitForTask(work.taskId, context);
  const saved = (await p.harness.snapshot(PersonalMcpDoc, String(first.operation), context))!.operation!;
  assert.equal(saved.takeover!.accepted, original.takeover!.accepted); assert.equal(saved.evidence.request, original.evidence.request); assert.equal(sandboxStops, 0);
  assert.equal((await p.mcp!.detail(first.operation)).summary.cuaStopUnverified, false);
  const calls = f.calls().length; await p.mcp!.recoverCua(first.operation, "stop"); assert.equal(f.calls().length, calls);
  await p.close(); await f.open(); assert.equal(f.calls().length, calls);
});

test("Personal Cua: rejecting another sandbox keeps the current assignment connection", async t => {
  const f = await fixture(t), firstService = f.config.services[0];
  f.config.services.push({ ...firstService, id: "second-desktop", cua: { ...firstService.cua!, sandbox: "local:second", sandboxId: "d".repeat(64) } });
  const p = await f.open(); await f.full(p);
  const first = JSON.parse(await f.answer(p, input("computer_screenshot"), "first-desktop-owner"));
  let stops = 0; f.host.stopCli = async () => { stops++; return true; };
  await p.answer("另一台电脑的工作", "second-desktop-owner");
  const second = await p.work.delegate({ requestId: "second-desktop-work", sourceRequestId: "second-desktop-owner", content: "调用:" + JSON.stringify({ service: "second-desktop", tool: "computer_screenshot", arguments: {} }) });
  const deadline = Date.now() + 2000;
  while (!(await p.mcp!.list()).items.some(item => item.service === "电脑" && item.operation !== first.operation && item.code === "cua_binding_busy")) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  const other = (await p.mcp!.list()).items.find(item => item.operation !== first.operation)!;
  await p.harness.waitForTask(other.operation, context);
  assert.equal(stops, 0); assert.equal(f.calls().length, 1);
  const resource = (await p.harness.snapshot(PersonalInteractiveResourceDoc, `cua:${"b".repeat(64)}`, context))!;
  assert.ok(resource.owner); assert.equal(resource.claims[0].released, undefined);
  assert.equal((await p.harness.snapshot(PersonalMcpDoc, String(other.operation), context))!.operation!.origin.work!.ref.taskId, second.taskId);
});

test("Personal Cua: an amendment during resource collection retains the claim until final completion", { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const resource = `cua:${"b".repeat(64)}`, original = PersonalWorkTask.definition.phases.run;
  let work: PersonalWorkRef | undefined;
  let collecting!: () => void, releaseCollect!: () => void;
  const reached = new Promise<void>(resolve => { collecting = resolve; }), held = new Promise<void>(resolve => { releaseCollect = resolve; });
  t.after(releaseCollect);
  let paused = false;
  t.mock.method(PersonalWorkTask.definition.phases, "run", async (...[task, runtime, context]: Parameters<typeof original>) => original(task, { ...runtime, hooks: { each: async (name, invoke) => {
    await runtime.hooks.each(name, invoke);
    if (!paused && task.id === work?.taskId && name === "settleResources") { paused = true; collecting(); await held; }
  } } }, context));
  const first = JSON.parse(await f.answer(p, input("computer_screenshot"), "collect-owner"));
  work = f.currentWork()!;
  await p.answer("原工作收尾时新增要求", "collect-amend-owner");
  const second = await p.work.delegate({ requestId: "collect-waiter", sourceRequestId: "collect-amend-owner", content: input("computer_screenshot") });
  const deadline = Date.now() + 2000;
  while ((await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!.claims.length !== 2) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  f.release(); await reached;
  await p.work.append(work, { requestId: "collect-amendment", sourceRequestId: "collect-amend-owner", content: input("computer_screenshot") });
  const before = (await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!;
  assert.equal(before.owner, before.claims[0].claim); assert.equal(before.claims[0].released, undefined); assert.equal(before.claims[1].acquired, undefined);
  releaseCollect();
  const freshDeadline = Date.now() + 2000;
  let fresh = false;
  while (!fresh) {
    for (const item of (await p.mcp!.list()).items) if (item.operation !== first.operation && item.effect === "returned" && (await p.harness.snapshot(PersonalMcpDoc, String(item.operation), context))!.operation!.origin.work?.ref.taskId === work.taskId) fresh = true;
    assert.ok(Date.now() < freshDeadline); if (!fresh) await new Promise(resolve => setTimeout(resolve, 5));
  }
  const final = (await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!;
  assert.equal(final.claims.length, 2); assert.equal(final.owner, final.claims[0].claim); assert.equal(final.claims[1].acquired, undefined); assert.equal(f.calls().length, 2);
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, second), context); await p.harness.abortTask(second.taskId, context); await p.harness.waitForTask(second.taskId, context);
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, work), context); await p.harness.abortTask(work.taskId, context); await p.harness.waitForTask(work.taskId, context);
  assert.equal((await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!.claims[0].released !== undefined, true);
});
test("Personal Cua: closing the original connection cannot bind another target before exact stop", { timeout: 20000 }, async t => {
  const f = await fixture(t), firstService = f.config.services[0];
  f.config.services.push({ ...firstService, id: "second-desktop", cua: { ...firstService.cua!, sandbox: "local:second", sandboxId: "d".repeat(64) } });
  const p = await f.open(); await f.full(p);
  const first = JSON.parse(await f.answer(p, input("computer_screenshot"), "closing-owner")), originalWork = f.currentWork()!;
  const firstValue = (await p.harness.snapshot(PersonalMcpDoc, String(first.operation), context))!.operation!;
  let enterStop!: () => void, releaseStop!: () => void;
  const entered = new Promise<void>(resolve => { enterStop = resolve; }), stopped = new Promise<void>(resolve => { releaseStop = resolve; });
  t.after(() => releaseStop());
  const stopCli = f.host.stopCli;
  let hold = true;
  f.host.stopCli = async value => { if (hold) { hold = false; enterStop(); await stopped; } return stopCli(value); };
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, originalWork), context); await p.harness.abortTask(originalWork.taskId, context); await entered;
  await p.answer("another independent target", "closing-next-owner");
  const next = await p.work.delegate({ requestId: "closing-next-work", sourceRequestId: "closing-next-owner", content: "调用:" + JSON.stringify({ service: "second-desktop", tool: "computer_screenshot", arguments: {} }) });
  const deadline = Date.now() + 2000;
  let second: TaskId | undefined;
  while (second === undefined || !(await p.harness.snapshot(PersonalMcpDoc, String(second), context))!.operation!.observation) {
    second = (await p.harness.snapshot(PersonalMcpConfigDoc, context))!.operations.find(id => id !== first.operation);
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
  }
  const value = (await p.harness.snapshot(PersonalMcpDoc, String(second), context))!.operation!;
  const callsBeforeStop = f.calls().length;
  releaseStop(); await p.harness.waitForTask(originalWork.taskId, context);
  assert.equal(callsBeforeStop, 1, "The singleton cannot launch another target while its original stop is pending.");
  assert.equal(value.started, false);
  assert.equal(value.code, "cua_binding_busy");
  const final = (await p.harness.snapshot(PersonalMcpDoc, String(first.operation), context))!.operation!;
  assert.equal(final.cuaLaunches![0].entry, firstValue.cuaLaunches![0].entry);
  assert.ok(final.cuaLaunches![0].stopped); assert.equal(value.cuaLaunches, undefined);
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, next), context); await p.harness.abortTask(next.taskId, context); await p.harness.waitForTask(next.taskId, context);
});

for (const duringWait of ["continue", "amend", "cancel"] as const) test(`Personal Cua: queued exact-stop recovery completion handles ${duringWait} without stale execution`, { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const first = JSON.parse(await f.answer(p, input("computer_screenshot"), "recovery-tail-first")), work = f.currentWork()!;
  await p.answer("Queue another computer assignment", "recovery-tail-next");
  const next = await p.work.delegate({ requestId: "recovery-tail-next-work", sourceRequestId: "recovery-tail-next", content: input("computer_screenshot") });
  const resource = `cua:${"b".repeat(64)}`;
  const until = async (check: () => boolean | Promise<boolean>) => { const deadline = Date.now() + 2000; while (!await check()) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); } };
  await until(async () => (await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!.claims.length === 2);
  const second = (await p.mcp!.list()).items.find(value => value.operation !== first.operation)!.operation;
  f.host.stopCli = async () => false; f.host.stopPrepared = async () => false;
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, work), context); await p.harness.abortTask(work.taskId, context);
  await until(async () => (await p.mcp!.detail(first.operation)).summary.cuaStopUnverified);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  f.host.stopCli = async () => true;
  f.host.stopPrepared = async () => { entered(); await held; return true; };
  const recovering = p.mcp!.recoverCua(first.operation, "stop");
  t.after(async () => { release(); await recovering; }); await reached;
  await p.harness.waitForTask(work.taskId, context);
  await until(async () => (await p.harness.snapshot(PersonalInteractiveResourceDoc, resource, context))!.claims[1].acquired !== undefined);
  assert.equal(await p.answer("Main while exact-stop recovery finishes", "recovery-tail-chat"), "完成");
  const waiting = (await p.harness.snapshot(PersonalMcpDoc, String(second), context))!.operation!;
  assert.equal(waiting.started, false); assert.equal(waiting.observation, undefined); assert.equal(f.calls().length, 1);
  if (duringWait === "amend") await p.work.append(next, { requestId: "recovery-tail-amendment", sourceRequestId: "recovery-tail-chat", content: "Updated requirement; make no computer calls." });
  if (duringWait === "cancel") { await p.harness.commit(tx => requestPersonalWorkCancel(tx, next), context); await p.harness.abortTask(next.taskId, context); }
  release(); await recovering;
  await until(async () => (await p.harness.snapshot(PersonalMcpDoc, String(second), context))!.operation!.observation !== undefined);
  const final = (await p.harness.snapshot(PersonalMcpDoc, String(second), context))!.operation!;
  if (duringWait === "continue") { assert.equal(final.code, "returned"); assert.equal(f.calls().length, 2); }
  else { assert.equal(final.started, false); assert.equal(final.effect, "not_executed"); assert.equal(f.calls().length, 1); if (duringWait === "amend") assert.equal(final.code, "tool_requirements_changed"); }
  await p.harness.commit(tx => requestPersonalWorkCancel(tx, next), context); await p.harness.abortTask(next.taskId, context); await p.harness.waitForTask(next.taskId, context);
});

test("Personal Cua: a stopped interrupted read awaits fresh recovery without an unknown effect", { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const result = JSON.parse(await f.answer(p, input("computer_screenshot", { hang: true }), "read-recovery"));
  const work = f.currentWork()!;
  const before = (await p.harness.snapshot(PersonalMcpDoc, String(result.operation), context))!.operation!;
  assert.equal(before.effect, "no_write"); assert.equal(before.remoteEnded, false);
  const pendingFacts = await p.harness.commit(tx => personalWorkExecutionFacts(tx, work.taskId, 8), context);
  assert.deepEqual(pendingFacts.factCounts!.mcp, { total: 1, pending: 1, unknown: 1 });
  await p.mcp!.recoverCua(result.operation, "stop");
  const stopped = (await p.harness.snapshot(PersonalMcpDoc, String(result.operation), context))!.operation!;
  assert.ok(stopped.cua!.recovery!.stopped); assert.ok(stopped.cuaLaunches!.every(launch => launch.stopped));
  const facts = await p.harness.commit(tx => personalWorkExecutionFacts(tx, work.taskId, 8), context);
  assert.deepEqual(facts.factCounts!.mcp, { total: 1, pending: 1, unknown: 0 });
});

test("Native Cua cleanup preserves the sandbox until its separate explicit choice", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  let cliStops = 0, sandboxStops = 0;
  const stopCli = f.host.stopCli, stopPrepared = f.host.stopPrepared, stopSandbox = f.host.stop;
  f.host.stopCli = async value => { cliStops++; return stopCli(value); };
  f.host.stopPrepared = async (scope, description) => { cliStops++; return stopPrepared(scope, description); };
  f.host.stop = async value => { sandboxStops++; return stopSandbox(value); };
  const result = JSON.parse(await f.answer(p, input("computer_screenshot", { hang: true }), "native-recovery")), operation = result.operation as TaskId;
  const { personalDesktopTarget } = await import("../apps/ruukoto/src/personal-desktop-actions.ts"), { randomUUID } = await import("node:crypto");
  const { summary } = await p.harness.commit(async tx => JSON.parse(JSON.stringify(await personalDesktopTarget(tx, "mcp", operation))), context);
  assert.equal(summary.code, "timeout"); assert.ok(summary.actions.includes("stop_sandbox"));
  await p.mcp!.cleanupCua(operation); assert.ok(cliStops > 0); assert.equal(sandboxStops, 0);
  const value = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
  assert.equal(value.cua?.recovery?.stopped, undefined); assert.equal(mcpUnresolved(value), true);
  const request = { v: 1 as const, requestId: randomUUID(), family: "mcp" as const, operation, admission: value.admission, occurrence: value.admission, action: "stop_sandbox" as const };
  await p.harness.commit(tx => p.desktopActions.admit(tx, request), context); p.harness.resume();
  await f.host.generation(f.config.services[0].cua!.sandboxId);
  const end = Date.now() + 5000;
  while ((await p.harness.commit(tx => p.desktopActions.receipt(tx, request.requestId), context))?.state === "admitted") { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 5)); }
  const receipt = (await p.harness.commit(tx => p.desktopActions.receipt(tx, request.requestId), context))!;
  assert.equal(receipt.state, "completed"); assert.equal(sandboxStops, 1);
  await p.harness.commit(tx => p.desktopActions.admit(tx, request), context); assert.equal(sandboxStops, 1);
  await p.harness.commit(tx => p.desktopActions.verify(tx, true), context);
});


test("Native Cua accepts and resumes the exact new scene while later pauses reject the old action", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const result = JSON.parse(await f.answer(p, input("computer_screenshot"), "native-scene")), operation = result.operation as TaskId;
  await p.mcp!.pauseCua(true);
  const { personalDesktopTarget } = await import("../apps/ruukoto/src/personal-desktop-actions.ts"), { randomUUID } = await import("node:crypto");
  const make = async (action: "observe" | "accept" | "resume") => p.harness.commit(async tx => { const value = await personalDesktopTarget(tx, "mcp", operation); return { v: 1 as const, requestId: randomUUID(), family: "mcp" as const, operation, admission: value.summary.admission, occurrence: value.summary.occurrence, action, ...(action === "accept" ? { observation: value.summary.observation } : {}) }; }, context);
  const wait = async (requestId: string) => { const end = Date.now() + 5000; for (;;) { const result = await p.harness.commit(tx => p.desktopActions.receipt(tx, requestId), context); if (result?.state !== "admitted") return result!; assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 5)); } };
  const observe = await make("observe"); await p.harness.commit(tx => p.desktopActions.admit(tx, observe), context); p.harness.resume(); assert.equal((await wait(observe.requestId)).state, "completed");
  const accept = await make("accept"); await p.harness.commit(tx => p.desktopActions.admit(tx, accept), context); p.harness.resume(); assert.equal((await wait(accept.requestId)).state, "completed");
  const resume = await make("resume"); await p.harness.commit(tx => p.desktopActions.admit(tx, resume), context); p.harness.resume(); assert.equal((await wait(resume.requestId)).state, "completed");
  assert.equal((await p.mcp!.cuaStatus()).paused, false);
  await p.harness.commit(tx => p.desktopActions.verify(tx, true), context);
  await p.mcp!.pauseCua(true);
  await assert.rejects(p.harness.commit(tx => p.desktopActions.admit(tx, { ...resume, requestId: randomUUID() }), context), { code: "desktop_action_unavailable" });
  assert.equal((await p.mcp!.cuaStatus()).paused, true);
});

test("An unexpected native cleanup failure has a terminal receipt and retains original stopping", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const result = JSON.parse(await f.answer(p, input("computer_screenshot", { hang: true }), "native-failure")), operation = result.operation as TaskId;
  f.host.stop = async () => { throw new Error("injected executor failure"); };
  const { randomUUID } = await import("node:crypto"), value = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
  const request = { v: 1 as const, requestId: randomUUID(), family: "mcp" as const, operation, admission: value.admission, occurrence: value.admission, action: "stop_sandbox" as const };
  await p.harness.commit(tx => p.desktopActions.admit(tx, request), context); p.harness.resume();
  const end = Date.now() + 5000;
  while ((await p.harness.commit(tx => p.desktopActions.receipt(tx, request.requestId), context))?.state === "admitted") { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 5)); }
  const receipt = (await p.harness.commit(tx => p.desktopActions.receipt(tx, request.requestId), context))!;
  assert.equal(receipt.state, "effect_unknown"); assert.equal(receipt.code, "desktop_action_failed");
  const after = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
  assert.equal(after.cua?.recovery?.stopped, undefined); assert.equal(mcpUnresolved(after), true);
  await p.harness.commit(tx => p.desktopActions.verify(tx, true), context);
});

test("A queued native observation from an earlier pause cannot inspect the later pause", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  const result = JSON.parse(await f.answer(p, input("computer_screenshot"), "native-stale-scene")), operation = result.operation as TaskId;
  await p.mcp!.pauseCua(true);
  f.holdActions(true); t.after(() => f.holdActions(false));
  const { randomUUID } = await import("node:crypto"), original = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!, pause = original.takeover!.paused;
  const request = { v: 1 as const, requestId: randomUUID(), family: "mcp" as const, operation, admission: original.admission, occurrence: original.admission, action: "observe" as const };
  await p.harness.commit(tx => p.desktopActions.admit(tx, request), context);
  await p.mcp!.recoverCua(operation, "observe");
  const observed = (await p.mcp!.detail(operation)).summary.cuaObservation!;
  await p.mcp!.recoverCua(operation, "accept", observed); await p.mcp!.pauseCua(false); await p.mcp!.pauseCua(true);
  const latest = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!; assert.notEqual(latest.takeover!.paused, pause); assert.equal(latest.takeover!.observation, undefined);
  const calls = f.calls().length; f.holdActions(false); p.harness.resume();
  const end = Date.now() + 5000;
  while ((await p.harness.commit(tx => p.desktopActions.receipt(tx, request.requestId), context))?.state === "admitted") { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 5)); }
  const receipt = (await p.harness.commit(tx => p.desktopActions.receipt(tx, request.requestId), context))!;
  assert.equal(receipt.state, "failed"); assert.equal(receipt.code, "desktop_action_stale"); assert.equal(f.calls().length, calls);
  await p.harness.commit(tx => p.desktopActions.verify(tx, true), context);
});
