import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { parsePersonalMcp, checkPersonalMcpEnablement } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { mcpUnresolved, mcpSourceBlocker, PersonalMcpDoc, waitWorkMcp } from "../apps/ruukoto/src/personal-mcp.ts";
import { personalCuaLinux, type CuaLinuxGeneration } from "../apps/ruukoto/src/personal-cua-linux.ts";
import { personalSettingsExternalBlockers } from "../apps/ruukoto/src/personal-settings-blockers.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
const context = BACKGROUND_CONTEXT;
const definitions = ["computer_screenshot", "computer_click", "computer_shell"].map(name => ({ name, inputSchema: { type: "object", properties: { sandbox: { type: "string" }, session: { type: "string" }, hang: { type: "boolean" }, bad: { type: "string" } }, additionalProperties: false } }));
async function fixture(t: TestContext, images = true, cua = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "personal-cua-"))), directory = path.join(root, "profile"), sent = path.join(root, "sent.jsonl"), schema = path.join(root, "tools.json");
  fs.writeFileSync(schema, JSON.stringify(definitions)); fs.writeFileSync(sent, "");
  const config = parsePersonalMcp({ version: cua ? 3 : 2, generation: "cua-first", services: [{ id: "desktop", label: "电脑", ...(cua ? { cua: { kind: "cua-linux", executable: "/usr/local/bin/cua", version: "0.7.0", sha256: "a".repeat(64), sandbox: "local:desktop", sandboxId: "b".repeat(64) } } : { endpoint: "http://127.0.0.1:9/mcp" }), enabled: true, tools: definitions }] });
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace); const stat = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "tool-first", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
  let generation: CuaLinuxGeneration = { containerId: "b".repeat(64), startedAt: "2026-10-23T01:00:00Z", bootId: "c".repeat(36), pid: 42, processIdentity: "10" }, stopped = false, sequence = 0;
  let programFailure = false; const stoppedScopes: string[] = [];
  const host: ReturnType<typeof personalCuaLinux> = { ...personalCuaLinux(), verifyTarget() {}, async generation() { return generation; }, async stopped() { return stopped; }, async stop() { stopped = true; return true; }, async restart() { stopped = false; generation = { ...generation, startedAt: "2026-10-23T02:00:00Z" }; return generation; }, prepare(program) { return { scope: `scope-${++sequence}`, description: "test", program }; }, async execution(scope, description) { return { scope, description, invocationId: "test", group: "/test", dev: 1, ino: 1 }; }, async stopCli() { return true; }, async stopPrepared(scope) { stoppedScopes.push(scope); return true; }, async program() { return { command: process.execPath, args: programFailure ? ["-e", "process.exit(2)"] : [fileURLToPath(new URL("./helpers/personal-cua-stdio-fixture.mjs", import.meta.url)), sent, schema], env: { PATH: "/usr/bin:/bin", HOME: directory } }; } };
  const model = new PersonalMockModelServer(request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user" && content.startsWith("HTTP:")) return { kind: "tool_calls", calls: [{ id: "http", name: "http_request", arguments: { url: content.slice(5), method: "GET" } }] };
    if (last?.role === "user" && content === "工具清单") return { kind: "tool_calls", calls: [{ id: "list", name: "mcp_tools", arguments: {} }] };
    if (last?.role === "user" && content.startsWith("调用:")) return { kind: "tool_calls", calls: [{ id: "call", name: "mcp_call", arguments: JSON.parse(content.slice(3)) }] };
    return { kind: "text", text: last?.role === "tool" ? content : "完成" };
  });
  process.env.RUUKOTO_CUA_MODEL_TEST_KEY = "test-only";
  const provider = personalProvider({ api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_CUA_MODEL_TEST_KEY", contextWindow: 128000, maxTokens: 8192, imageInput: images });
  let current: PersonalHarness | undefined;
  const open = async () => current = await openPersonalHarness({ directory, provider, modelId: "mock-model", mcp: config, tools, mcpCuaHost: host, mcpTimeouts: { callTimeoutMs: 100 } });
  t.after(async () => { await current?.close(); await model.close(); delete process.env.RUUKOTO_CUA_MODEL_TEST_KEY; fs.rmSync(root, { recursive: true, force: true }); });
  const calls = () => fs.readFileSync(sent, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(item => item.method === "tools/call");
  return { directory, config, model, host, open, calls, stoppedScopes, failProgram(value = true) { programFailure = value; }, setImageMode(mode: string) { fs.writeFileSync(sent + ".mode", mode); }, async full(p: PersonalHarness) { await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context); } };
}
const input = (tool: string, args: Record<string, unknown> = {}) => "调用:" + JSON.stringify({ service: "desktop", tool, arguments: args });
test("Personal Cua：持续连接、真实固定目标与受限定义进入模型历史，旧证据不串调用", async t => {
  const baseline = await fixture(t, true, false), plain = await baseline.open(); await baseline.full(plain);
  await plain.answer("工具清单", "baseline-list");
  const before = baseline.model.calls.at(-1)!;
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await p.answer("工具清单", "list");
  await p.answer(input("computer_screenshot"), "observe");
  const original = (await p.mcp!.list()).items[0];
  const next = JSON.parse(await p.answer(input("computer_click"), "click"));
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
  assert.ok(JSON.stringify(f.model.calls.at(-1)!.raw).includes("电脑连接跨调用保留"));
  const estimate = (request: typeof before) => ({ systemPrompt: Math.ceil((request.system?.length ?? 0) / 4), toolSchemas: Math.ceil(JSON.stringify(request.tools ?? []).length / 4) });
  t.diagnostic(JSON.stringify({ estimatedTokens: { before: estimate(before), after: estimate(f.model.calls.at(-1)!) } }));
  await p.answer(input("computer_click", { sandbox: "local:other" }), "override"); assert.equal(f.calls().length, 2);
});
test("Personal Cua：文本模型在电脑动作前拒绝且零发送", async t => {
  const f = await fixture(t, false), p = await f.open(); await f.full(p);
  const answer = await p.answer(input("computer_screenshot"), "text-model");
  assert.ok(answer.includes("model_image_unsupported")); assert.equal(f.calls().length, 0);
});
test("Personal Cua：丢答冷恢复保留unknown和remoteEnded，接受新观察才释放全部原等待", async t => {
  const f = await fixture(t); let p = await f.open(); await f.full(p);
  await p.answer(input("computer_screenshot"), "initial");
  const answer = JSON.parse(await p.answer(input("computer_click", { hang: true }), "lost")), operation = answer.operation;
  assert.equal(answer.effect, "effect_unknown"); assert.equal(f.calls().length, 2);
  await p.close(); p = await f.open();
  assert.equal(mcpUnresolved((await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!), true);
  assert.ok(await p.harness.commit(tx => mcpSourceBlocker(tx, "lost"), context));
  await assert.rejects(p.mcp!.recoverCua(operation, "begin"));
  await assert.rejects(p.mcp!.recoverCua(operation, "accept"));
  await p.mcp!.recoverCua(operation, "stop"); await p.mcp!.recoverCua(operation, "begin"); await p.mcp!.recoverCua(operation, "observe");
  assert.equal(f.calls().length, 3);
  await p.mcp!.recoverCua(operation, "accept", (await p.mcp!.detail(operation)).summary.cuaObservation);
  const original = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
  assert.equal(original.remoteEnded, false); assert.equal(original.effect, "effect_unknown"); assert.equal(mcpUnresolved(original), false);
  assert.equal(await p.harness.commit(tx => mcpSourceBlocker(tx, "lost"), context), undefined);
  await waitWorkMcp(p.harness, [operation], context);
  assert.deepEqual(await personalSettingsExternalBlockers({ harness: p.harness }), []);
  assert.equal((await p.mcp!.detail(operation)).summary.cuaRecovery, "accepted");
  await p.answer(input("computer_screenshot"), "new-work-observe");
  await p.answer(input("computer_click"), "new-work"); assert.equal(f.calls().length, 5);
  await p.close(); p = await f.open();
  assert.equal(mcpUnresolved((await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!), false);
  await p.close(); const profile = lockPersonalProfile(f.directory); try { await checkPersonalMcpEnablement(profile); } finally { profile.release(); }
});

for (const bad of ["empty", "invalid", "error"]) test(`Personal Cua：${bad} 截图不能开放点击`, async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await p.answer(input("computer_screenshot", { bad }), "bad-image");
  await p.answer(input("computer_click"), "blocked-click");
  assert.equal(f.calls().length, 1);
  assert.equal((await p.mcp!.list()).items[0].code, "cua_observation_required");
});
test("Personal Cua：未决电脑调用不会破坏独立HTTP目标检查，恢复失败仍不接受旧图", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await p.answer(input("computer_screenshot"), "initial");
  const unknown = JSON.parse(await p.answer(input("computer_click", { hang: true }), "lost"));
  const server = http.createServer((_request, response) => response.end("独立HTTP成功")); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const answer = await p.answer(`HTTP:http://127.0.0.1:${address.port}/independent`, "independent");
  assert.ok(answer.includes("独立HTTP成功"), answer);
  await p.mcp!.recoverCua(unknown.operation, "stop"); await p.mcp!.recoverCua(unknown.operation, "begin");
  f.setImageMode("invalid"); await assert.rejects(p.mcp!.recoverCua(unknown.operation, "observe"));
  await assert.rejects(p.mcp!.recoverCua(unknown.operation, "accept"));
  assert.equal((await p.mcp!.detail(unknown.operation)).summary.cuaRecovery, "begun");
});

test("Personal Cua：成功观察后再次观察失败，冷启动可继续恢复且不接受旧截图", async t => {
  const f = await fixture(t); let p = await f.open(); await f.full(p);
  await p.answer(input("computer_screenshot"), "initial");
  const unknown = JSON.parse(await p.answer(input("computer_click", { hang: true }), "lost"));
  await p.mcp!.recoverCua(unknown.operation, "stop"); await p.mcp!.recoverCua(unknown.operation, "begin"); await p.mcp!.recoverCua(unknown.operation, "observe");
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

test("Personal Cua：初始化失败保留启动和停止事实，冷核实失败只禁电脑不禁聊天", async t => {
  const f = await fixture(t); let p = await f.open(); await f.full(p); f.failProgram();
  await p.answer(input("computer_screenshot"), "init-failure");
  const operation = (await p.mcp!.list()).items[0].operation;
  const value = (await p.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!;
  assert.equal(value.started, false); assert.equal(value.cuaLaunches?.length, 1); assert.ok(value.cuaLaunches[0].stopped); assert.equal(f.stoppedScopes.length, 1); assert.equal(f.calls().length, 0);
  f.failProgram(false); await p.answer(input("computer_screenshot"), "valid-launch");
  await p.close(); f.host.stopPrepared = async () => false;
  p = await f.open();
  assert.equal(await p.answer("普通聊天", "chat"), "完成");
  await p.answer(input("computer_screenshot"), "blocked"); assert.equal(f.calls().length, 1);
});
test("Personal Cua：空闲CLI退出后丢弃观察，新连接截图前零点击", async t => {
  const f = await fixture(t), p = await f.open(); await f.full(p);
  await p.answer(input("computer_screenshot"), "initial");
  const originalPid = f.calls()[0].pid;
  process.kill(originalPid, "SIGTERM"); await new Promise(resolve => setTimeout(resolve, 50));
  await p.answer(input("computer_click"), "stale-click"); assert.equal(f.calls().length, 1);
  await p.answer(input("computer_screenshot"), "fresh"); assert.equal(f.calls().length, 2); assert.notEqual(f.calls()[1].pid, originalPid);
});
