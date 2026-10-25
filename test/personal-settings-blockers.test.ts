import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ManagedSkillsStore } from "@ruukoto/agent/managed-skills.ts";
import { dispatchPersonalSettings, executePersonalSettings, personalSettingsIdentity, type PersonalSettingsIdentity } from "../apps/ruukoto/src/personal-settings.ts";
import { personalSettingsExternalBlockers } from "../apps/ruukoto/src/personal-settings-blockers.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { savePersonalSkills } from "../apps/ruukoto/src/personal-skills-config.ts";
import { savePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { savePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { acquirePersonalDirectory, releasePersonalDirectory } from "../apps/ruukoto/src/personal-directory-claims.ts";
import { cancelPersonalQuestion, personalQuestionList, PersonalQuestionDoc, PersonalQuestionsDoc } from "../apps/ruukoto/src/personal-questions.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import type { PersonalSettingsReceipt } from "../apps/ruukoto/src/personal-settings-records.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-settings-blockers-")), directory = path.join(root, "p"), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "mock-model", apiKeyEnv: `SETTINGS_BLOCKER_${randomUUID().replaceAll("-", "_").toUpperCase()}`, contextWindow: 4096, maxTokens: 128 };
  process.env[config.apiKeyEnv] = "test-only";
  await savePersonalConfig(directory, config);
  t.after(() => { delete process.env[config.apiKeyEnv]; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, workspace, config };
}

test("设置在线查询：不扫描无关待答问题与目录认领，损坏引用在原问题入口报告", async t => {
  const f = await fixture(t), model = new PersonalMockModelServer(request => request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ question: "是否继续" }] } }] } : { kind: "text", text: "等待回答" });
  f.config.baseUrl = await model.start(); await savePersonalConfig(f.directory, f.config); t.after(() => model.close());
  const profile = lockPersonalProfile(f.directory), instance = await openPersonalHarness({ profile, provider: personalProvider(f.config), modelId: f.config.modelId });
  t.after(() => instance.close());
  const read = () => dispatchPersonalSettings({ profile, instance }, { v: 1, op: "settings.read" }) as Promise<{ blockers: { kind: string }[] }>;
  await instance.answer("发起提问", "settings-pending-question");
  const id = (await instance.harness.snapshot(PersonalQuestionsDoc, context))!.ids[0], question = (await instance.harness.snapshot(PersonalQuestionDoc, id, context))!.question!;
  assert.equal(question.status, "pending"); assert.equal((await instance.harness.inspect(context)).tasks.length, 0);
  assert.deepEqual((await read()).blockers, []);
  await instance.harness.commit(tx => cancelPersonalQuestion(tx, { question: id, version: question.version, requestId: randomUUID() }, { kind: "local" }), context);
  assert.deepEqual((await read()).blockers, []);
  const owner = { kind: "background" as const, operation: question.operation }, stat = fs.statSync(f.workspace);
  await instance.harness.commit(tx => acquirePersonalDirectory(tx, owner, { path: f.workspace, dev: stat.dev, ino: stat.ino }), context);
  assert.equal((await instance.harness.inspect(context)).tasks.length, 0);
  assert.deepEqual((await read()).blockers, []);
  await instance.harness.commit(tx => releasePersonalDirectory(tx, owner), context);
  assert.deepEqual((await read()).blockers, []);
  await instance.harness.commit(async tx => { (await tx.doc(PersonalQuestionsDoc)).ids.push("missing-question"); }, context);
  assert.deepEqual((await read()).blockers, []);
  await assert.rejects(instance.harness.commit(tx => personalQuestionList(tx), context), code("question_missing"));
});

test("设置独立保存：HTTP 写断线保留未知效果，在线模型和离线其他配置不受无关占用阻止", async t => {
  const f = await fixture(t), endpoint = http.createServer((request, _response) => { request.resume(); request.once("end", () => request.socket.destroy()); });
  endpoint.listen(0, "127.0.0.1"); await once(endpoint, "listening");
  t.after(async () => { endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve())); });
  const address = endpoint.address(); assert.ok(address && typeof address === "object");
  const model = new PersonalMockModelServer(request => request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [{ id: "http-unknown", name: "http_request", arguments: { method: "POST", url: `http://127.0.0.1:${address.port}/write`, body: "one-write" } }] } : { kind: "text", text: "完成" });
  f.config.baseUrl = await model.start(); await savePersonalConfig(f.directory, f.config); t.after(() => model.close());
  const stat = fs.statSync(f.workspace), tools = { version: 1 as const, generation: "tools-first", workspace: f.workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] };
  await savePersonalTools(f.directory, tools);
  const library = path.join(f.root, "library"); fs.mkdirSync(path.join(library, "skills"), { recursive: true }); const skills = { version: 1 as const, directory: library }; await savePersonalSkills(f.directory, skills);
  const mcp = { version: 2 as const, generation: "mcp-first", services: [] }; await savePersonalMcp(f.directory, mcp);
  const source = path.join(f.root, "source"); fs.mkdirSync(source, { mode: 0o700 }); fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: settings-regression\ndescription: 保留原托管状态\n---\n技能正文\n", { mode: 0o600 });
  const profile = lockPersonalProfile(f.directory), store = new ManagedSkillsStore(f.directory, [path.join(library, "skills")]), preview = store.preview(source), skillId = randomUUID();
  await dispatchPersonalSettings({ profile }, { v: 2, id: randomUUID(), profile: personalSettingsIdentity(profile), expectedRevision: store.list().revision, op: { kind: "skills.import", id: skillId, directory: source, contentRevision: preview.contentRevision } });
  const instance = await openPersonalHarness({ profile, provider: personalProvider(f.config), modelId: f.config.modelId, tools, mcp });
  t.after(() => instance.close());
  await instance.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  await instance.answer("执行拥有者明确选择的写入", "original-http-write");
  const operations = await instance.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as { operation: number; effect: string; stopped: boolean }[], context);
  const operation = operations[0]; assert.equal(operation.effect, "effect_unknown"); assert.equal(operation.stopped, false);
  await instance.harness.commit(async tx => { assert.equal((await tx.task(operation.operation as Parameters<typeof tx.task>[0]))?.state.status, "terminal"); }, context);
  type Snapshot = { profile: PersonalSettingsIdentity; revisions: { model: string; skills: string; mcp: string }; skills: { revision: string }; blockers: { kind: string; operation?: number }[] };
  const online = await dispatchPersonalSettings({ profile, instance }, { v: 1, op: "settings.read" }) as Snapshot;
  assert.deepEqual(online.blockers, []);
  const onlineSaved = await dispatchPersonalSettings({ profile, instance }, { v: 2, id: randomUUID(), profile: online.profile, expectedRevision: online.revisions.model, op: { kind: "config.save", target: "model", value: f.config } }) as PersonalSettingsReceipt;
  assert.equal(onlineSaved.status, "active");
  assert.deepEqual(await personalSettingsExternalBlockers({ harness: instance.harness }), [{ kind: "tool-unresolved", operation: operation.operation }]);
  await instance.close();
  const offline = await executePersonalSettings(f.directory, { v: 1, op: "settings.read" }) as Snapshot;
  assert.deepEqual(offline.blockers, []);
  for (const [target, value] of [["model", f.config], ["skills", skills], ["mcp", mcp]] as const) {
    const receipt = await executePersonalSettings(f.directory, { v: 2, id: randomUUID(), profile: offline.profile, expectedRevision: offline.revisions[target], op: { kind: "config.save", target, value } }) as PersonalSettingsReceipt;
    assert.equal(receipt.status, "saved"); assert.ok(receipt.savedRevision);
  }
  const disabled = await executePersonalSettings(f.directory, { v: 2, id: randomUUID(), profile: offline.profile, expectedRevision: offline.skills.revision, op: { kind: "skills.set-enabled", id: skillId, enabled: false } }) as PersonalSettingsReceipt;
  assert.equal(disabled.status, "saved");
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
  try {
    assert.deepEqual(await personalSettingsExternalBlockers({ storage }), [{ kind: "tool-unresolved", operation: operation.operation }]);
    const ref = await storage.findDocument({ kind: "ruukoto.tool-operation", scope: { kind: "session" }, key: String(operation.operation) }, "current", context), original = ref && await storage.document(ref.id, "current", context);
    assert.equal((original?.value.operation as typeof operation).effect, "effect_unknown"); assert.equal((original?.value.operation as typeof operation).stopped, false);
  } finally { await storage.close(context); }
});

const cases = [
  { kind: "ruukoto.tool-operation", property: "operation", key: "7", value: { operation: 7, started: true, stopped: false, effect: "returned" }, blocker: "tool-unresolved" },
  { kind: "ruukoto.browser-operation", property: "operation", key: "7", value: { operation: 7, started: true, stopped: true, effect: "effect_unknown" }, blocker: "browser-unresolved" },
  { kind: "ruukoto.mcp", property: "operation", key: "7", value: { operation: 7, started: true, remoteEnded: false, effect: "returned" }, blocker: "mcp-unresolved" },
  { kind: "ruukoto.command", property: "command", key: "command-request", value: { ref: { requestId: "command-request", taskId: 7 }, started: true, stopped: false, result: { effect: "returned", code: "command_returned" } }, blocker: "command-unresolved" },
  { kind: "ruukoto.service-operation", property: "operation", key: "service-request", value: { ref: { requestId: "service-request", taskId: 7 }, consumed: true, launcherStopped: false, result: { effect: "effect_unknown", code: "interrupted" } }, blocker: "service-unresolved" },
  { kind: "ruukoto.service-execution", property: "inspection", key: "7", value: { taskId: 7, stopped: false }, blocker: "inspection-unresolved" },
  { kind: "ruukoto.app-data-operation", property: "operation", key: "7", value: { operation: 7, started: 5, result: { effect: "effect_unknown", code: "receipt_missing" } }, blocker: "app-data-unresolved" },
] as const;

for (const example of cases) test(`设置占用扫描：${example.kind} 读取原持久字段，异常终态仍阻断`, async t => {
  const f = await fixture(t), p = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId });
  const doc = defineDocFamily<JsonObject, null>({ kind: example.kind, scope: "session", version: 1, family: true, initial: () => ({}) });
  await p.harness.commit(async tx => {
    Object.assign(await tx.doc(doc, example.key, null), { [example.property]: example.value });
    if (example.kind === "ruukoto.service-execution") (await tx.doc(defineDoc<JsonObject>({ kind: "ruukoto.service-executions", scope: "session", version: 1, initial: () => ({ tasks: [] }) }))).tasks = [7];
  }, context); await p.close();
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
  try { assert.deepEqual(await personalSettingsExternalBlockers({ storage }), [{ kind: example.blocker, operation: 7 }]); }
  finally { await storage.close(context); }
});

test("设置占用扫描：32条输出之后仍校验未知版本，不将不可信记录当空闲", async t => {
  const f = await fixture(t), p = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId });
  const tool = defineDocFamily<JsonObject, null>({ kind: "ruukoto.tool-operation", scope: "session", version: 1, family: true, initial: () => ({}) });
  const future = defineDocFamily<JsonObject, null>({ kind: "ruukoto.app-data-operation", scope: "session", version: 99, family: true, initial: () => ({}) });
  await p.harness.commit(async tx => {
    for (let operation = 100; operation < 135; operation++) (await tx.doc(tool, String(operation), null)).operation = { operation, started: true, stopped: false, effect: "effect_unknown" };
    (await tx.doc(future, "900", null)).operation = { operation: 900, started: 899 };
  }, context); await p.close();
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
  try { await assert.rejects(personalSettingsExternalBlockers({ storage }), code("settings_external_state_invalid")); }
  finally { await storage.close(context); }
});

test("设置占用扫描：失效调用留下的未被引用空 family 不冻结档案", async t => {
  const f = await fixture(t), p = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId });
  await p.harness.commit(async tx => {
    for (const example of cases) await tx.doc(defineDocFamily<JsonObject, null>({ kind: example.kind, scope: "session", version: 1, family: true, initial: () => ({}) }), "unreferenced-empty", null);
  }, context);
  assert.deepEqual(await personalSettingsExternalBlockers({ harness: p.harness }), []);
  await p.close();
  const read = await executePersonalSettings(f.directory, { v: 1, op: "settings.read" }) as { profile: PersonalSettingsIdentity; revisions: { model: string }; blockers: unknown[] };
  assert.deepEqual(read.blockers, []);
  assert.equal((await executePersonalSettings(f.directory, { v: 2, id: randomUUID(), profile: read.profile, expectedRevision: read.revisions.model, op: { kind: "config.save", target: "model", value: { ...f.config, maxTokens: 129 } } }) as PersonalSettingsReceipt).status, "saved");
});

for (const [index, family, property] of [["ruukoto.tools", "ruukoto.tool-operation", "operations"], ["ruukoto.browser", "ruukoto.browser-operation", "operations"], ["ruukoto.mcp-config", "ruukoto.mcp", "operations"], ["ruukoto.app-data", "ruukoto.app-data-operation", "operations"], ["ruukoto.service-executions", "ruukoto.service-execution", "tasks"]] as const) test(`设置占用扫描：${index} 引用空 family 必须拒绝`, async t => {
  const f = await fixture(t), p = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId });
  await p.harness.commit(async tx => {
    await tx.doc(defineDocFamily<JsonObject, null>({ kind: family, scope: "session", version: 1, family: true, initial: () => ({}) }), "7", null);
    (await tx.doc(defineDoc<JsonObject>({ kind: index, scope: "session", version: 1, initial: () => ({}) })))[property] = [7];
  }, context);
  await assert.rejects(personalSettingsExternalBlockers({ harness: p.harness }), code("settings_external_state_invalid")); await p.close();
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
  try { await assert.rejects(personalSettingsExternalBlockers({ storage }), code("settings_external_state_invalid")); }
  finally { await storage.close(context); }
});

test("设置占用扫描：浏览器未闭合绑定阻断，已知关闭不阻断", async t => {
  for (const state of ["paused", "closed"] as const) {
    const f = await fixture(t), p = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId });
    await p.harness.commit(async tx => {
      const doc = await tx.doc(defineDoc<JsonObject>({ kind: "ruukoto.browser", scope: "session", version: 1, initial: () => ({ operations: [] }) }));
      doc.stateJson = JSON.stringify({ version: 1, bindings: [{ sessionId: "1", state }] }); doc.bindingEntry = 7;
    }, context);
    const expected = state === "paused" ? [{ kind: "browser-session-unresolved", conversation: 1 }] : [];
    assert.deepEqual(await personalSettingsExternalBlockers({ harness: p.harness }), expected); await p.close();
    const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
    try { assert.deepEqual(await personalSettingsExternalBlockers({ storage }), expected); }
    finally { await storage.close(context); }
  }
});

test("设置占用扫描：已核实效果与停止保持原历史，全部原谓词允许后续保存", async t => {
  const f = await fixture(t), p = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId });
  const proof = { effect: "applied", evidence: "原业务与停止证据已核实", entry: 90 };
  const states = [
    ["ruukoto.tool-operation", "operation", "7", { operation: 7, started: true, stopped: true, effect: "effect_unknown", resolution: proof }],
    ["ruukoto.browser-operation", "operation", "8", { operation: 8, started: true, stopped: true, effect: "effect_unknown", resolution: proof }],
    ["ruukoto.mcp", "operation", "9", { operation: 9, started: true, remoteEnded: true, effect: "effect_unknown", resolution: proof }],
    ["ruukoto.command", "command", "known-command", { ref: { requestId: "known-command", taskId: 10 }, started: true, stopped: true, result: { effect: "effect_unknown", code: "interrupted" }, resolution: proof }],
    ["ruukoto.service-operation", "operation", "known-service", { ref: { requestId: "known-service", taskId: 11 }, consumed: true, launcherStopped: true, result: { effect: "effect_unknown", code: "interrupted" }, resolution: proof }],
    ["ruukoto.service-execution", "inspection", "12", { taskId: 12, stopped: true }],
    ["ruukoto.app-data-operation", "operation", "13", { operation: 13, started: 12, result: { effect: "committed", code: "committed" } }],
  ] as const;
  await p.harness.commit(async tx => {
    for (const [kind, property, key, value] of states) (await tx.doc(defineDocFamily<JsonObject, null>({ kind, scope: "session", version: 1, family: true, initial: () => ({}) }), key, null))[property] = value;
  }, context); await p.close();
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
  try { assert.deepEqual(await personalSettingsExternalBlockers({ storage }), []); }
  finally { await storage.close(context); }
  const snapshot = await executePersonalSettings(f.directory, { v: 1, op: "settings.read" }) as { profile: PersonalSettingsIdentity; revisions: { model: string } };
  assert.equal((await executePersonalSettings(f.directory, { v: 2, id: randomUUID(), profile: snapshot.profile, expectedRevision: snapshot.revisions.model, op: { kind: "config.save", target: "model", value: { ...f.config, maxTokens: 129 } } }) as PersonalSettingsReceipt).status, "saved");
});
