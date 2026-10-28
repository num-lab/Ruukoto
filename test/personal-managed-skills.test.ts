import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadSkillLibrary, readSkill } from "@ruukoto/agent/skills.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalSkillsDoc } from "../apps/ruukoto/src/personal-skills.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { capturePersonalScheduleScope, verifyPersonalScheduleScope } from "../apps/ruukoto/src/personal-schedule-scope.ts";
import { appendPersonalConfiguration, effectivePersonalConfiguration, personalConfigurationContentRevision, personalConfigurationVersions, recordPersonalSettingsOperation, selectPersonalConfiguration, type PersonalSettingsReceipt } from "../apps/ruukoto/src/personal-settings-records.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { dispatchPersonalSettings, personalSettingsDirectoryIdentity, readPersonalSettings } from "../apps/ruukoto/src/personal-settings.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-pa-old-skills-"))), directory = path.join(root, "profile");
  const model = new PersonalMockModelServer(() => ({ kind: "text", text: "已收到" }));
  let current: Awaited<ReturnType<typeof openPersonalHarness>> | undefined;
  t.after(async () => { await current?.close(); await model.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const home = isolateSkillHome(t), agent = path.join(home, ".agents"), id = randomUUID(), managed = path.join(directory, "managed-skills"), pkg = path.join(managed, "packages", id, "alpha");
  lockPersonalProfile(directory).release();
  fs.mkdirSync(path.join(pkg, "refs"), { recursive: true, mode: 0o700 });
  const body = "---\nname: alpha\ndescription: 旧托管任务指引\n---\n旧任务正文\n", reference = "原始引用资料";
  fs.writeFileSync(path.join(pkg, "SKILL.md"), body, { mode: 0o600 }); fs.writeFileSync(path.join(pkg, "refs", "guide.md"), reference, { mode: 0o600 });
  const contentRevision = digest(JSON.stringify({ directories: ["refs"], files: [["SKILL.md", digest(body)], ["refs/guide.md", digest(reference)]] }));
  const state = { version: 1, packages: [{ id, directory: "alpha", contentRevision, state: "enabled" }] };
  fs.writeFileSync(path.join(managed, "state.json"), JSON.stringify({ ...state, revision: digest(JSON.stringify(state)) }) + "\n", { mode: 0o600 });
  const oldConfig = JSON.stringify({ version: 1, directory: path.join(root, "retired-library") }) + "\n";
  fs.writeFileSync(path.join(directory, "skills.json"), oldConfig, { mode: 0o600 });
  return { root, directory, agent, managed, pkg, id, contentRevision, oldConfig, model, async open(config: PersonalModelConfig, options: Pick<Parameters<typeof openPersonalHarness>[0], "openStorage"> = {}) { return current = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, ...options }); } };
}

test("个人旧技能：托管包与配置留在原处，新发现只读 HOME 目录", async t => {
  const f = fixture(t), original = loadSkillLibrary([{ dir: f.pkg, source: "managed", id: f.id, contentRevision: f.contentRevision }]);
  assert.match(readSkill(original, "alpha", "refs/guide.md"), /原始引用资料/);
  assert.deepEqual(loadSkillLibrary().skills, []);
  const snapshot = await readPersonalSettings(f.directory);
  assert.deepEqual(snapshot.skills.skills, []); assert.equal(snapshot.skills.config, null);
  assert.equal(fs.readFileSync(path.join(f.directory, "skills.json"), "utf8"), f.oldConfig);
  assert.equal(fs.readFileSync(path.join(f.pkg, "refs", "guide.md"), "utf8"), "原始引用资料");
});

test("个人旧技能：旧快照可重开核实，退役配置和损坏旧包不暂停新请求", async t => {
  const f = fixture(t), key = "RUUKOTO_OLD_SKILL_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await f.model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 };
  await savePersonalConfig(f.directory, config);
  let current = await f.open(config);
  const library = loadSkillLibrary([{ dir: f.pkg, source: "managed", id: f.id, contentRevision: f.contentRevision }]), value = { config: null, identity: null, library };
  const saved = { ...value, version: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  const original = await current.harness.commit(async tx => {
    await appendPersonalConfiguration(tx, { target: "skills", version: "legacy-skills", revision: digest(f.oldConfig), previousRevision: null, previousVersion: null, config: JSON.parse(f.oldConfig), content: f.oldConfig });
    await selectPersonalConfiguration(tx, "skills", "*", "legacy-skills");
    const doc = await tx.doc(PersonalSkillsDoc), entry = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.skills-snapshot", data: JSON.parse(JSON.stringify(saved)) });
    doc.snapshots.push({ ...saved, entry: entry.id, conversationId: ROOT_CONVERSATION_ID });
    const selected = doc.current.find(item => item.conversationId === ROOT_CONVERSATION_ID)!;
    selected.version = saved.version; selected.snapshotEntry = entry.id;
    return entry;
  }, context);
  await current.close();
  fs.writeFileSync(path.join(f.managed, "state.json"), "{retired"); fs.writeFileSync(path.join(f.directory, "skills.json"), "{retired");
  fs.mkdirSync(path.join(f.agent, "skills", "current"), { recursive: true }); fs.writeFileSync(path.join(f.agent, "skills", "current", "SKILL.md"), "---\ndescription: 当前固定来源\n---\n新正文\n");
  current = await f.open(config); await current.answer("/skill:current 当前输入", "current-source");
  assert.equal(f.model.calls.length, 1); assert.match(JSON.stringify(f.model.calls[0].raw), /新正文/);
  assert.doesNotMatch(JSON.stringify(f.model.calls[0].system), /旧托管任务指引/);
  assert.deepEqual(await current.harness.commit(tx => tx.entry(original.id), context), original);
  const versions = await current.harness.commit(tx => personalConfigurationVersions(tx, "skills"), context);
  assert.equal(versions.length, 1); assert.equal(versions[0].content, f.oldConfig);
  await current.close();
  assert.deepEqual((await readPersonalSettings(f.directory)).fileIssues, []);
  assert.equal(fs.readFileSync(path.join(f.managed, "state.json"), "utf8"), "{retired");
  assert.equal(fs.readFileSync(path.join(f.pkg, "refs", "guide.md"), "utf8"), "原始引用资料");
});

test("个人技能真实请求：准备后正文变化沿本次快照发送，下一请求刷新，发送边界不重读", async t => {
  const f = fixture(t), skill = path.join(f.agent, "skills", "mutable"), body = path.join(skill, "SKILL.md");
  fs.mkdirSync(skill, { recursive: true });
  const write = (text: string) => fs.writeFileSync(body, `---\nname: mutable\ndescription: 当前任务指引\n---\n${text}\n`);
  write("INITIAL_BODY");
  const key = "RUUKOTO_PINNED_SKILL_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await f.model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 };
  let current: Awaited<ReturnType<typeof openPersonalHarness>> | undefined, armed = false, changed = false, reads = 0;
  t.after(async () => { await current?.close(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  current = await f.open(config, { openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, context) => {
      const result = await commit(writes, context);
      if (armed && !changed && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.skills-snapshot")) { changed = true; write("NEXT_BODY"); }
      return result;
    };
    return storage;
  } });
  write("PINNED_BODY"); armed = true;
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
    if (String(args[0]) === body) reads++;
    return Reflect.apply(original, fs, args);
  }); syncBuiltinESMExports();
  try {
    await current.answer("/skill:mutable 本次", "pinned");
    assert.equal(changed, true); assert.equal(reads, 2);
    assert.match(JSON.stringify(f.model.calls[0].raw), /PINNED_BODY/); assert.doesNotMatch(JSON.stringify(f.model.calls[0].raw), /NEXT_BODY/);
    reads = 0;
    await current.answer("/skill:mutable 下次", "next");
    assert.equal(reads, 2); assert.match(JSON.stringify(f.model.calls[1].raw), /NEXT_BODY/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const entries = (await current.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const requests = entries.filter(entry => entry.kind === "ruukoto.model-request");
  assert.equal(requests.length, 4); assert.match(JSON.stringify(requests.slice(0, 2)), /PINNED_BODY/); assert.doesNotMatch(JSON.stringify(requests.slice(0, 2)), /NEXT_BODY/);
  assert.match(JSON.stringify(entries.filter(entry => entry.kind === "ruukoto.skills-snapshot")), /PINNED_BODY.*NEXT_BODY/s);
});

for (const target of ["skills", "managed-skills"] as const) for (const status of ["saved", "waiting"] as const) test(`个人旧技能 ${target}/${status}：查询只核实保存，不发布退役来源或改生效版本`, async t => {
  const f = fixture(t), config: PersonalModelConfig = { api: "openai-completions", baseUrl: await f.model.start(), modelId: "mock-model", apiKeyEnv: "ABSENT_RETIRED_SKILL_KEY", contextWindow: 128000, maxTokens: 1024 };
  await savePersonalConfig(f.directory, config);
  const current = await f.open(config), id = randomUUID(), profile = personalSettingsDirectoryIdentity(f.directory);
  const content = fs.readFileSync(path.join(f.directory, target === "skills" ? "skills.json" : "managed-skills/state.json"), "utf8"), revision = personalConfigurationContentRevision(target, content);
  const candidate = { target, version: id, revision, previousRevision: null, previousVersion: null, config: JSON.parse(content), content };
  const receipt: PersonalSettingsReceipt = { v: 2, id, profile, target: "skills", scope: target === "skills" ? "*" : "managed", requestDigest: "1".repeat(64), status, savedRevision: revision, effectiveRevision: null, code: "settings_saved_offline", relatedOperations: [] };
  await current.harness.commit(async tx => {
    await appendPersonalConfiguration(tx, candidate);
    await recordPersonalSettingsOperation(tx, { candidate, receipt, expectedRevision: "missing", facts: [{ status, code: receipt.code, savedRevision: revision, effectiveRevision: null }] });
  }, context);
  assert.equal(await current.harness.commit(tx => effectivePersonalConfiguration(tx, target, receipt.scope), context), undefined);
  const queried = await dispatchPersonalSettings({ profile: { directory: f.directory, release() {} }, instance: current }, { v: 2, id });
  assert.deepEqual(queried, receipt);
  assert.equal(await current.harness.commit(tx => effectivePersonalConfiguration(tx, target, receipt.scope), context), undefined);
  assert.equal(fs.readFileSync(path.join(f.directory, target === "skills" ? "skills.json" : "managed-skills/state.json"), "utf8"), content);
  assert.equal(f.model.calls.length, 0);
});

test("个人技能定时范围：正文更新可继续，不同旧来源明确拒绝", async t => {
  const f = fixture(t), key = "RUUKOTO_SKILL_SCOPE_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await f.model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 };
  const directory = path.join(f.agent, "skills", "current"); fs.mkdirSync(directory, { recursive: true });
  const body = path.join(directory, "SKILL.md"); fs.writeFileSync(body, "---\ndescription: 定时资料指引\n---\n原正文\n");
  const current = await f.open(config), scope = await current.harness.commit(tx => capturePersonalScheduleScope(tx), context);
  assert.ok(scope.snapshot && typeof scope.snapshot === "object" && !Array.isArray(scope.snapshot));
  assert.deepEqual(scope.snapshot.skills, { version: 1, directory: f.agent });
  fs.appendFileSync(body, "更新正文\n");
  await current.harness.commit(tx => current.skills.prepare(tx, ROOT_CONVERSATION_ID), context);
  await current.harness.commit(tx => verifyPersonalScheduleScope(tx, scope), context);
  const legacy = { ...scope, snapshot: { ...scope.snapshot, skills: { version: 1, directory: f.root } } };
  await assert.rejects(current.harness.commit(tx => verifyPersonalScheduleScope(tx, legacy), context), (error: unknown) => error instanceof PersonalError && error.code === "schedule_scope_changed");
  assert.equal(f.model.calls.length, 0);
});
