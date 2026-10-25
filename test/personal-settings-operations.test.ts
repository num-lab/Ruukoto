import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, createSession, ROOT_CONVERSATION_ID, SessionFailed, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { lockPersonalProfile, LEGACY_PERSONAL_FORMAT, PERSONAL_FORMAT } from "../apps/ruukoto/src/personal-profile.ts";
import { dispatchPersonalSettings, executePersonalSettings, personalSettingsIdentity, type PersonalSettingsContext, type PersonalSettingsSnapshot } from "../apps/ruukoto/src/personal-settings.ts";
import { PersonalConfigurationDoc, PersonalSettingsOperationDoc, PERSONAL_CONFIGURATION_FILES, PersonalFormatDoc, initializePersonalSettings, personalConfigurationVersions, readPersonalConfigurationFile, type PersonalSettingsReceipt } from "../apps/ruukoto/src/personal-settings-records.ts";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalModel, personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalMcpConfigDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp, type PersonalMcpConfig } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { recoverPersonalSettings } from "../apps/ruukoto/src/personal-settings-operations.ts";
import { advancePersonalSettingsOperation, appendPersonalConfiguration, personalConfigurationDigest, recordPersonalSettingsOperation, selectPersonalConfiguration } from "../apps/ruukoto/src/personal-settings-records.ts";
import { readPersonalServices, type PersonalServiceConfig } from "../apps/ruukoto/src/personal-service-config.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";

const model = { api: "openai-completions", baseUrl: "https://model.example.test", modelId: "test", apiKeyEnv: "ABSENT_CONFIGURATION_TEST_KEY", contextWindow: 4096, maxTokens: 32 };
function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk-config-save-")), profile = lockPersonalProfile(directory);
  t.after(() => { profile.release(); fs.rmSync(directory, { recursive: true, force: true }); });
  const save = (value = model, expectedRevision = "missing", id = randomUUID()) => ({ v: 2, id, profile: personalSettingsIdentity(profile), expectedRevision, op: { kind: "config.save", target: "model", value } });
  return { directory, profile, save, dispatch: (request: unknown, checkpoint?: PersonalSettingsContext["checkpoint"]) => dispatchPersonalSettings({ profile, checkpoint }, request) as Promise<PersonalSettingsReceipt> };
}

test("配置操作：未知键查询不创建业务库，首次无根保存有初始化证明且不请求模型", async t => {
  const f = fixture(t);
  assert.equal(await f.dispatch({ v: 2, id: randomUUID() }), null);
  assert.equal(fs.existsSync(path.join(f.directory, "personal.sqlite")), false);
  const request = f.save(), receipt = await f.dispatch(request);
  assert.equal(receipt.status, "saved"); assert.equal(receipt.code, "settings_saved_offline"); assert.equal(receipt.effectiveRevision, null);
  assert.equal(receipt.savedRevision, readPersonalConfigurationFile(f.profile, "model").revision);
  assert.deepEqual(await f.dispatch({ v: 2, id: request.id }), receipt);
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite")), session = createSession(storage);
  try {
    assert.equal(await session.commit(tx => tx.conversation(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT), undefined);
    assert.equal((await session.snapshot(PersonalConfigurationDoc, BACKGROUND_CONTEXT))?.initializedWithoutRoot, true);
    assert.deepEqual(await session.snapshot(PersonalFormatDoc, BACKGROUND_CONTEXT), PERSONAL_FORMAT);
  } finally { await session.close(BACKGROUND_CONTEXT); }
  assert.equal(JSON.stringify(receipt).includes(model.baseUrl), false);
});

test("配置操作：意图后未替换记未保存；替换后丢失回执按原键核实而不再次写文件", async t => {
  for (const crash of ["intent", "file", "saved"] as const) {
    const f = fixture(t), request = f.save();
    await assert.rejects(f.dispatch(request, stage => { if (stage === crash) throw new Error("injected crash"); }));
    const filename = path.join(f.directory, "model.json"), before = fs.existsSync(filename) ? fs.statSync(filename).ino : undefined;
    const receipt = await f.dispatch({ v: 2, id: request.id });
    assert.equal(receipt.status, crash === "intent" ? "rejected" : "saved");
    assert.equal(fs.existsSync(filename) ? fs.statSync(filename).ino : undefined, before);
    assert.deepEqual(await f.dispatch({ v: 2, id: request.id }), receipt);
  }
});

test("配置操作：同键异参和并发旧修订拒绝，离线连续保存保留链且旧键不覆盖新选择", async t => {
  const f = fixture(t), first = f.save(), a = await f.dispatch(first);
  await assert.rejects(f.dispatch({ ...first, op: { ...first.op, value: { ...model, maxTokens: 64 } } }), (error: unknown) => error instanceof PersonalError && error.code === "settings_request_conflict");
  const second = f.save({ ...model, maxTokens: 64 }, a.savedRevision!), b = await f.dispatch(second);
  const old = await f.dispatch(first);
  assert.equal(old.status, "superseded"); assert.equal(old.savedRevision, a.savedRevision); assert.equal(old.supersededBy, second.id);
  assert.equal(readPersonalConfigurationFile(f.profile, "model").revision, b.savedRevision);
  await assert.rejects(f.dispatch(f.save(model, a.savedRevision!)), (error: unknown) => error instanceof PersonalError && error.code === "settings_revision_changed");
  const session = createSession(await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite")));
  try { assert.deepEqual((await session.commit(tx => personalConfigurationVersions(tx, "model"), BACKGROUND_CONTEXT)).map(value => value.revision), ["missing", a.savedRevision, b.savedRevision]); }
  finally { await session.close(BACKGROUND_CONTEXT); }
});

test("配置迁移：标记已保存但事务未提交的空库可恢复，缺证明的旧无根库拒绝", async t => {
  const f = fixture(t), id = randomUUID();
  const revisions = (Object.keys(PERSONAL_CONFIGURATION_FILES) as (keyof typeof PERSONAL_CONFIGURATION_FILES)[]).map(target => ({ target, revision: readPersonalConfigurationFile(f.profile, target).revision }));
  fs.writeFileSync(path.join(f.directory, "profile.json"), JSON.stringify({ ...LEGACY_PERSONAL_FORMAT, configurationMigration: { from: LEGACY_PERSONAL_FORMAT, to: PERSONAL_FORMAT, id, revisions } }) + "\n", { mode: 0o600 });
  await (await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"))).close(BACKGROUND_CONTEXT);
  assert.equal((await f.dispatch(f.save())).status, "saved");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "profile.json"), "utf8")), PERSONAL_FORMAT);
  const broken = fixture(t), session = createSession(await openNodeSqliteStorage(path.join(broken.directory, "personal.sqlite")));
  await session.commit(tx => tx.doc(PersonalFormatDoc), BACKGROUND_CONTEXT);
  await assert.rejects(initializePersonalSettings(broken.profile, session), (error: unknown) => error instanceof PersonalError && error.code === "settings_history_invalid");
  await session.close(BACKGROUND_CONTEXT);
});

test("旧客户端写入明确要求升级，不执行停存启", async t => {
  const f = fixture(t);
  await assert.rejects(executePersonalSettings(f.profile, { v: 1, profile: personalSettingsIdentity(f.profile), op: "config.save", target: "model", expectedRevision: "missing", value: model }), (error: unknown) => error instanceof PersonalError && error.code === "settings_upgrade_required");
  assert.equal(fs.existsSync(path.join(f.directory, "model.json")), false);
});

async function onlineFixture(t: TestContext, mcp?: PersonalMcpConfig, openStorage?: (filename: string) => Promise<Storage>) {
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk-config-online-")), profile = lockPersonalProfile(directory);
  fs.writeFileSync(path.join(directory, "model.json"), JSON.stringify(model) + "\n", { mode: 0o600 });
  if (mcp) fs.writeFileSync(path.join(directory, "mcp.json"), JSON.stringify(mcp) + "\n", { mode: 0o600 });
  const instance = await openPersonalHarness({ profile, provider: personalProvider(parsePersonalModel(model)), modelId: model.modelId, mcp, openStorage });
  t.after(async () => { await instance.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const dispatch = (request: unknown, checkpoint?: PersonalSettingsContext["checkpoint"]) => dispatchPersonalSettings({ profile, instance, checkpoint }, request) as Promise<PersonalSettingsReceipt>;
  const write = (op: unknown, expectedRevision: string, id = randomUUID()) => ({ v: 2, id, profile: personalSettingsIdentity(profile), expectedRevision, op });
  return { directory, profile, instance, dispatch, write };
}

const mcpConfig = () => parsePersonalMcp({ version: 2, generation: randomUUID(), services: ["a", "b"].map(id => ({ id, label: id, enabled: true, endpoint: `http://127.0.0.1:${id === "a" ? 1 : 2}/mcp`, tools: [{ name: "read", inputSchema: { type: "object" } }] })) });

test("配置操作：相同内容的意图失败可按原键证明保存，文件不替换", async t => {
  const f = fixture(t), first = await f.dispatch(f.save()), filename = path.join(f.directory, "model.json"), inode = fs.statSync(filename).ino;
  const request = f.save(model, first.savedRevision!);
  await assert.rejects(f.dispatch(request, stage => { if (stage === "intent") throw new Error("no-op intent crash"); }));
  const result = await f.dispatch({ v: 2, id: request.id });
  assert.equal(result.status, "saved"); assert.equal(result.savedRevision, first.savedRevision); assert.equal(fs.statSync(filename).ino, inode);
  assert.deepEqual(await f.dispatch(request), result);
});

test("配置操作：持久选择已改变但对象发布失败，原键仍核实实际对象后才记生效", async t => {
  const f = await onlineFixture(t), update = f.instance.updateModel.bind(f.instance);
  let first = true, calls = 0;
  t.mock.method(f.instance, "updateModel", async (config: PersonalModelConfig, version: string) => {
    calls++;
    if (first) { first = false; await f.instance.harness.commit(tx => selectPersonalConfiguration(tx, "model", "*", version), BACKGROUND_CONTEXT); throw new PersonalError("publisher_injected", "对象发布失败"); }
    await update(config, version);
  });
  const request = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "next" } }, readPersonalConfigurationFile(f.profile, "model").revision);
  const failed = await f.dispatch(request); assert.equal(failed.status, "failed");
  assert.equal((await f.instance.harness.snapshot(AgentDoc, f.instance.main.id, BACKGROUND_CONTEXT))?.model?.modelId, model.modelId);
  const active = await f.dispatch({ v: 2, id: request.id });
  assert.equal(active.status, "active"); assert.equal(calls, 2);
  assert.equal((await f.instance.harness.snapshot(AgentDoc, f.instance.main.id, BACKGROUND_CONTEXT))?.model?.modelId, "next");
  assert.equal(f.instance.isSettingsSuspended("model"), false);
});

test("配置操作：发布完成后回执丢失，原键完成回执且重复查询不重新发布", async t => {
  const f = await onlineFixture(t), request = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "next" } }, readPersonalConfigurationFile(f.profile, "model").revision);
  await assert.rejects(f.dispatch(request, stage => { if (stage === "published") throw new Error("lost acknowledgement"); }));
  const filename = path.join(f.directory, "model.json"), inode = fs.statSync(filename).ino;
  const update = t.mock.method(f.instance, "updateModel", f.instance.updateModel.bind(f.instance));
  const receipt = await f.dispatch({ v: 2, id: request.id }); assert.equal(receipt.status, "active");
  assert.equal(update.mock.callCount(), 1); assert.equal(fs.statSync(filename).ino, inode);
  assert.deepEqual(await f.dispatch({ v: 2, id: request.id }), receipt); assert.equal(update.mock.callCount(), 1);
});

test("配置操作：A 等待时 B 保存，A 沿共享文件保存链生效并保留 B", async t => {
  const f = await onlineFixture(t, mcpConfig()), update = f.instance.updateMcp.bind(f.instance);
  let waiting = true;
  t.mock.method(f.instance, "updateMcp", async (...args: [PersonalMcpConfig, string, string, string]) => args[1] === "a" && waiting ? { effectiveRevision: null, code: "related_operation_pending", relatedOperations: [{ kind: "mcp", id: "old-a" }] } : update(...args));
  const a = f.write({ kind: "mcp.set-enabled", id: "a", enabled: false }, readPersonalConfigurationFile(f.profile, "mcp").revision), savedA = await f.dispatch(a);
  assert.equal(savedA.status, "waiting");
  const b = f.write({ kind: "mcp.set-enabled", id: "b", enabled: false }, savedA.savedRevision!), activeB = await f.dispatch(b);
  assert.equal(activeB.status, "active");
  let current = await f.instance.harness.snapshot(PersonalMcpConfigDoc, BACKGROUND_CONTEXT);
  assert.equal(current?.config?.services.find(service => service.id === "a")?.enabled, true); assert.equal(current?.config?.services.find(service => service.id === "b")?.enabled, false);
  const snapshot = await dispatchPersonalSettings({ profile: f.profile, instance: f.instance }, { v: 1, op: "settings.read" }) as PersonalSettingsSnapshot;
  assert.equal(snapshot.revisions.mcp, activeB.savedRevision);
  assert.notEqual(snapshot.effective.find(item => item.target === "mcp" && item.scope === "a")?.revision, savedA.savedRevision);
  assert.equal(snapshot.effective.find(item => item.target === "mcp" && item.scope === "b")?.revision, activeB.effectiveRevision);
  waiting = false;
  const activeA = await f.dispatch({ v: 2, id: a.id }); assert.equal(activeA.status, "active"); assert.equal(activeA.savedRevision, savedA.savedRevision);
  current = await f.instance.harness.snapshot(PersonalMcpConfigDoc, BACKGROUND_CONTEXT);
  assert.equal(current?.config?.services.find(service => service.id === "a")?.enabled, false); assert.equal(current?.config?.services.find(service => service.id === "b")?.enabled, false);
  assert.equal(readPersonalConfigurationFile(f.profile, "mcp").revision, activeB.savedRevision);
});

test("配置读取：回执按稳定索引分页，超过32笔仍能查询早期未结和后续更改", async t => {
  const f = fixture(t);
  let revision = "missing";
  const ids = [];
  for (let index = 0; index < 34; index++) {
    const request = f.save({ ...model, modelId: `model-${index}` }, revision);
    revision = (await f.dispatch(request)).savedRevision!; ids.push(request.id);
  }
  const read = (operationsOffset = 0) => dispatchPersonalSettings({ profile: f.profile }, { v: 1, op: "settings.read", operationsOffset }) as Promise<PersonalSettingsSnapshot>;
  const first = await read(), second = await read(first.operationsNextOffset);
  assert.equal(first.operations.length, 32); assert.equal(first.operationsNextOffset, 32);
  assert.deepEqual([...first.operations, ...second.operations].map(item => item.id), ids);
  assert.equal(second.operationsNextOffset, undefined); assert.equal(second.operations.at(-1)?.status, "saved");
  assert.equal((await f.dispatch({ v: 2, id: ids[0] })).status, "superseded");
});

test("配置操作：A 的首次待生效更改可从全局基线撤回，旧键不覆盖 B", async t => {
  const f = await onlineFixture(t, mcpConfig()), update = f.instance.updateMcp.bind(f.instance);
  let waiting = true;
  t.mock.method(f.instance, "updateMcp", async (...args: [PersonalMcpConfig, string, string, string]) => args[1] === "a" && waiting ? { effectiveRevision: null, code: "related_operation_pending", relatedOperations: [] } : update(...args));
  const a = f.write({ kind: "mcp.set-enabled", id: "a", enabled: false }, readPersonalConfigurationFile(f.profile, "mcp").revision), savedA = await f.dispatch(a);
  const b = await f.dispatch(f.write({ kind: "mcp.set-enabled", id: "b", enabled: false }, savedA.savedRevision!));
  assert.equal((await f.dispatch({ v: 2, id: a.id })).status, "waiting");
  waiting = false;
  const withdraw = f.write({ kind: "settings.withdraw", id: a.id }, b.savedRevision!), receipt = await f.dispatch(withdraw); assert.equal(receipt.status, "active");
  const old = await f.dispatch({ v: 2, id: a.id }); assert.equal(old.status, "superseded"); assert.equal(old.savedRevision, savedA.savedRevision); assert.equal(old.supersededBy, withdraw.id);
  const actual = await f.instance.harness.snapshot(PersonalMcpConfigDoc, BACKGROUND_CONTEXT);
  assert.equal(actual?.config?.services.find(service => service.id === "a")?.enabled, true); assert.equal(actual?.config?.services.find(service => service.id === "b")?.enabled, false);
  assert.equal(readPersonalConfigurationFile(f.profile, "mcp").revision, receipt.savedRevision);
});

test("配置操作：首次新增 MCP 服务等待时可撤回到无服务并保留后续服务", async t => {
  const f = await onlineFixture(t), original = mcpConfig(), update = f.instance.updateMcp.bind(f.instance);
  let waiting = true;
  t.mock.method(f.instance, "updateMcp", async (...args: [PersonalMcpConfig, string, string, string]) => args[1] === "a" && waiting ? { effectiveRevision: null, code: "related_operation_pending", relatedOperations: [] } : update(...args));
  const service = (id: string) => ({ ...original.services.find(service => service.id === id)!, authentication: "anonymous" });
  const a = f.write({ kind: "mcp.save-service", service: service("a") }, "missing"), savedA = await f.dispatch(a);
  const b = await f.dispatch(f.write({ kind: "mcp.save-service", service: service("b") }, savedA.savedRevision!));
  waiting = false;
  const receipt = await f.dispatch(f.write({ kind: "settings.withdraw", id: a.id }, b.savedRevision!)); assert.equal(receipt.status, "active");
  assert.deepEqual((await f.instance.harness.snapshot(PersonalMcpConfigDoc, BACKGROUND_CONTEXT))?.config?.services.map(service => service.id), ["b"]);
});

test("配置恢复：先暂停未知文件和各待生效对象，核实后仅保留仍未核实的目标", async t => {
  const f = await onlineFixture(t), request = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "next" } }, readPersonalConfigurationFile(f.profile, "model").revision);
  await assert.rejects(f.dispatch(request, stage => { if (stage === "intent") throw new Error("intent interrupted"); }));
  const receipts = await recoverPersonalSettings({ profile: f.profile, instance: f.instance });
  assert.equal(receipts[0].status, "rejected"); assert.equal(f.instance.isSettingsSuspended("model"), false);
  const unknown = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "unknown" } }, readPersonalConfigurationFile(f.profile, "model").revision);
  await assert.rejects(f.dispatch(unknown, stage => { if (stage === "intent") throw new Error("intent interrupted"); }));
  fs.writeFileSync(path.join(f.directory, "model.json"), JSON.stringify({ ...model, modelId: "external" }) + "\n", { mode: 0o600 });
  const pending = await recoverPersonalSettings({ profile: f.profile, instance: f.instance });
  assert.equal(pending[0].status, "unknown"); assert.equal(f.instance.isSettingsSuspended("model"), true); assert.equal(f.instance.isSettingsSuspended("mcp"), false);
});

test("配置操作：共享存储保存失败关闭原 Harness，重开后从候选文件核实原键", async t => {
  const failure = new Error("settings storage failed"); let injected = false;
  const f = await onlineFixture(t, undefined, async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = (writes, context) => {
      if (!injected && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.settings-saved")) { injected = true; return Promise.reject(failure); }
      return commit(writes, context);
    };
    return storage;
  });
  const request = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "after-storage-recovery" } }, readPersonalConfigurationFile(f.profile, "model").revision);
  await assert.rejects(f.dispatch(request), error => error === failure || error instanceof SessionFailed);
  assert.equal(injected, true); assert.equal((await f.instance.harness.closed).reason, "failed");
  await f.instance.close();
  const profile = lockPersonalProfile(f.directory), config = parsePersonalModel(readPersonalConfigurationFile(profile, "model").config);
  const reopened = await openPersonalHarness({ profile, provider: personalProvider(config), modelId: config.modelId });
  try {
    const operation = (await reopened.harness.snapshot(PersonalSettingsOperationDoc, request.id, BACKGROUND_CONTEXT))?.operation;
    assert.equal(operation?.receipt.id, request.id); assert.equal(operation?.receipt.status, "active"); assert.equal(operation?.candidate.version, request.id);
    assert.deepEqual(await recoverPersonalSettings({ profile, instance: reopened }), []);
    assert.equal((await reopened.harness.snapshot(AgentDoc, reopened.main.id, BACKGROUND_CONTEXT))?.model?.modelId, "after-storage-recovery");
  } finally { await reopened.close(); }
});

test("配置撤回：等待同对象的原发布完成，期间不占住其他目标保存", async t => {
  const f = await onlineFixture(t), request = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "published-before-withdraw" } }, readPersonalConfigurationFile(f.profile, "model").revision);
  let release!: () => void, published!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { published = resolve; });
  const saving = f.dispatch(request, async stage => { if (stage === "published") { published(); await hold; } });
  await ready;
  const withdrawal = f.dispatch(f.write({ kind: "settings.withdraw", id: request.id }, readPersonalConfigurationFile(f.profile, "model").revision));
  try {
    const other = await f.dispatch(f.write({ kind: "config.save", target: "web-search", value: { version: 1, enabled: false } }, "missing"));
    assert.equal(other.status, "active");
  } finally { release(); }
  assert.equal((await saving).status, "active");
  await assert.rejects(withdrawal, (error: unknown) => error instanceof PersonalError && error.code === "settings_withdraw_unavailable");
  assert.equal((await f.instance.harness.snapshot(AgentDoc, f.instance.main.id, BACKGROUND_CONTEXT))?.model?.modelId, "published-before-withdraw");
});

test("配置恢复：迟到旧 scope 的保存回执不覆盖已经发布的后继版本", async t => {
  const f = await onlineFixture(t), request = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "old-publication" } }, readPersonalConfigurationFile(f.profile, "model").revision);
  await assert.rejects(f.dispatch(request, stage => { if (stage === "published") throw new Error("old receipt lost"); }));
  const newerId = randomUUID(), config = { ...model, modelId: "newer-publication" }, content = JSON.stringify(config) + "\n", revision = personalConfigurationDigest(content);
  await f.instance.harness.commit(async tx => {
    const previous = (await personalConfigurationVersions(tx, "model")).at(-1)!;
    const candidate = { target: "model" as const, version: newerId, revision, previousRevision: previous.revision, previousVersion: previous.version, config, content };
    await appendPersonalConfiguration(tx, candidate);
    const receipt: PersonalSettingsReceipt = { v: 2, id: newerId, profile: personalSettingsIdentity(f.profile), target: "model", scope: "*", requestDigest: "f".repeat(64), status: "active", savedRevision: revision, effectiveRevision: revision, code: "settings_active", relatedOperations: [] };
    await recordPersonalSettingsOperation(tx, advancePersonalSettingsOperation({ receipt, candidate, expectedRevision: previous.revision, facts: [] }, {}));
    await selectPersonalConfiguration(tx, "model", "*", newerId);
  }, BACKGROUND_CONTEXT);
  fs.writeFileSync(path.join(f.directory, "model.json"), content, { mode: 0o600 });
  await f.instance.updateModel(parsePersonalModel(config), newerId);
  const update = t.mock.method(f.instance, "updateModel", f.instance.updateModel.bind(f.instance));
  const old = await f.dispatch({ v: 2, id: request.id }); assert.equal(old.status, "superseded"); assert.equal(old.supersededBy, newerId); assert.equal(update.mock.callCount(), 0); assert.equal(f.instance.isSettingsSuspended("model"), false);
  assert.equal((await f.instance.harness.snapshot(AgentDoc, f.instance.main.id, BACKGROUND_CONTEXT))?.model?.modelId, "newer-publication");
});

test("配置操作：新 HTTP MCP 服务仍需显式选择匿名认证", async t => {
  const f = fixture(t), value = mcpConfig();
  const request = { ...f.save(), op: { kind: "config.save", target: "mcp", value } };
  await assert.rejects(f.dispatch(request), (error: unknown) => error instanceof PersonalError && error.code === "mcp_credentials_required");
  assert.equal(fs.existsSync(path.join(f.directory, "mcp.json")), false);
  const receipt = await f.dispatch({ ...request, op: { ...request.op, value: { ...value, services: value.services.map(service => ({ ...service, authentication: "anonymous" })) } } });
  assert.equal(receipt.status, "saved");
});

test("配置读取：坏 JSON 返回类型化错误且不留下无法再次初始化的空库", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, "model.json"), "{invalid-json", { mode: 0o600 });
  await assert.rejects(f.dispatch(f.save()), (error: unknown) => error instanceof PersonalError && error.code === "settings_config_invalid" && error.cause instanceof SyntaxError);
  assert.equal(fs.existsSync(path.join(f.directory, "personal.sqlite")), false);
  fs.writeFileSync(path.join(f.directory, "model.json"), JSON.stringify(model) + "\n", { mode: 0o600 });
  assert.equal((await f.dispatch(f.save(model, readPersonalConfigurationFile(f.profile, "model").revision))).status, "saved");
});

test("配置读取：坏 SQLite 返回类型化打开错误并保留原字节", async t => {
  const f = fixture(t), filename = path.join(f.directory, "personal.sqlite"), bytes = Buffer.from("invalid personal sqlite");
  fs.writeFileSync(filename, bytes, { mode: 0o600 });
  await assert.rejects(f.dispatch(f.save()), (error: unknown) => error instanceof PersonalError && error.code === "settings_storage_unavailable" && error.cause instanceof Error);
  assert.deepEqual(fs.readFileSync(filename), bytes);
});


test("配置核实：共享文件被改回旧候选不等于原操作可发布，恢复最后保存版本才缩小暂停", async t => {
  const f = await onlineFixture(t, mcpConfig()), update = f.instance.updateMcp.bind(f.instance);
  const mocked = t.mock.method(f.instance, "updateMcp", async (...args: [PersonalMcpConfig, string, string, string]) => args[1] === "a" ? { effectiveRevision: null, code: "related_operation_pending", relatedOperations: [] } : update(...args));
  const a = f.write({ kind: "mcp.set-enabled", id: "a", enabled: false }, readPersonalConfigurationFile(f.profile, "mcp").revision), savedA = await f.dispatch(a);
  await f.dispatch(f.write({ kind: "mcp.set-enabled", id: "b", enabled: false }, savedA.savedRevision!));
  const versions = await f.instance.harness.commit(tx => personalConfigurationVersions(tx, "mcp"), BACKGROUND_CONTEXT), filename = path.join(f.directory, "mcp.json"), calls = mocked.mock.callCount();
  fs.writeFileSync(filename, versions.find(value => value.version === a.id)!.content!, { mode: 0o600 });
  const unknown = await f.dispatch({ v: 2, id: a.id }); assert.equal(unknown.status, "unknown"); assert.equal(unknown.code, "settings_file_unverified"); assert.equal(mocked.mock.callCount(), calls);
  assert.equal(f.instance.isSettingsSuspended("mcp", "b"), true);
  fs.writeFileSync(filename, versions.at(-1)!.content!, { mode: 0o600 });
  assert.equal((await f.dispatch({ v: 2, id: a.id })).status, "waiting");
  assert.equal(f.instance.isSettingsSuspended("mcp", "a"), true); assert.equal(f.instance.isSettingsSuspended("mcp", "b"), false);
});


test("配置撤回：首次服务启用等待可回到受证明的未配置状态，普通保存不接受 null", async t => {
  const f = await onlineFixture(t), update = f.instance.updateServices.bind(f.instance);
  t.mock.method(f.instance, "updateServices", async (config: PersonalServiceConfig | null, version: string, revision: string) => config === null ? update(config, version, revision) : { effectiveRevision: null, code: "services_busy", relatedOperations: [] });
  await assert.rejects(f.dispatch(f.write({ kind: "config.save", target: "services", value: null }, "missing")), (error: unknown) => error instanceof PersonalError && error.code === "service_config_invalid");
  assert.equal(fs.existsSync(path.join(f.directory, "service.json")), false);
  const request = f.write({ kind: "config.save", target: "services", value: { version: 1, helperPath: "/missing/helper", policyPath: "/missing/policy", sudoPath: "/usr/bin/sudo" } }, "missing"), saved = await f.dispatch(request);
  assert.equal(saved.status, "waiting");
  const withdrawn = await f.dispatch(f.write({ kind: "settings.withdraw", id: request.id }, saved.savedRevision!)); assert.equal(withdrawn.status, "active");
  assert.equal(fs.readFileSync(path.join(f.directory, "service.json"), "utf8"), "null\n"); assert.equal(readPersonalServices(f.profile), undefined);
  assert.equal((await f.dispatch({ v: 2, id: request.id })).status, "superseded"); assert.equal(f.instance.service, undefined);
});


test("配置读取：超过 4 MiB 的既有合法 MCP 文件仍可核实修订", t => {
  const f = fixture(t), tools = Array.from({ length: 34 }, (_, index) => ({ name: `tool_${index}`, description: "d".repeat(4000), inputSchema: { type: "object" } }));
  const config = parsePersonalMcp({ version: 2, generation: randomUUID(), services: Array.from({ length: 34 }, (_, index) => ({ id: `service_${index}`, label: `服务${index}`, enabled: true, endpoint: "https://mcp.example.test/api", tools })) });
  const content = JSON.stringify(config) + "\n"; assert.ok(Buffer.byteLength(content) > 4 * 1024 * 1024);
  fs.writeFileSync(path.join(f.directory, "mcp.json"), content, { mode: 0o600 });
  const saved = readPersonalConfigurationFile(f.profile, "mcp"); assert.equal(saved.revision, personalConfigurationDigest(content)); assert.deepEqual(saved.config, config);
});


test("配置恢复：已生效文件被删除或改写只暂停原目标，原回执不改写且修复后解封", async t => {
  for (const corruption of ["missing", "json", "identity", "permissions"] as const) {
    const f = await onlineFixture(t), filename = path.join(f.directory, "model.json");
    const request = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "active-before-file-loss" } }, readPersonalConfigurationFile(f.profile, "model").revision);
    const receipt = await f.dispatch(request); assert.equal(receipt.status, "active");
    const content = fs.readFileSync(filename, "utf8");
    if (corruption === "missing") fs.unlinkSync(filename);
    else if (corruption === "permissions") fs.chmodSync(filename, 0o644);
    else fs.writeFileSync(filename, corruption === "json" ? "{broken\n" : JSON.stringify({ ...model, modelId: "external" }) + "\n", { mode: 0o600 });
    assert.deepEqual(await recoverPersonalSettings({ profile: f.profile, instance: f.instance }), []);
    assert.equal(f.instance.isSettingsSuspended("model"), true); assert.equal(f.instance.isSettingsSuspended("mcp"), false);
    assert.deepEqual(await f.dispatch({ v: 2, id: request.id }), receipt);
    const snapshot = await dispatchPersonalSettings({ profile: f.profile, instance: f.instance }, { v: 1, op: "settings.read" }) as { fileIssues: { target: string; code: string; actualRevision: string | null }[]; model: unknown; revisions: Record<string, string>; revisionsUnknown: string[] };
    assert.equal(snapshot.model, null); assert.deepEqual(snapshot.fileIssues.map(issue => [issue.target, issue.code]), [["model", "settings_file_unverified"]]);
    assert.equal(snapshot.fileIssues[0].actualRevision === "missing", corruption === "missing");
    if (corruption === "permissions") { assert.equal(snapshot.revisions.model, "unverified"); assert.deepEqual(snapshot.revisionsUnknown, ["model"]); }
    const expectedRevision = corruption === "missing" ? "missing" : personalConfigurationDigest(fs.readFileSync(filename, "utf8"));
    await assert.rejects(f.dispatch(f.write({ kind: "config.save", target: "model", value: model }, expectedRevision)), (error: unknown) => error instanceof PersonalError && error.code === "settings_file_unverified");
    assert.equal((await f.dispatch(f.write({ kind: "config.save", target: "web-search", value: { version: 1, enabled: false } }, "missing"))).status, "active");
    fs.writeFileSync(filename, content, { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
    const repaired = await dispatchPersonalSettings({ profile: f.profile, instance: f.instance }, { v: 1, op: "settings.read" }) as { fileIssues: unknown[] };
    assert.deepEqual(repaired.fileIssues, []); assert.equal(f.instance.isSettingsSuspended("model"), false);
  }
});

test("配置冷恢复：仅有已生效历史时缺失文件仍封闭该目标，不伪造设置操作", async t => {
  const f = await onlineFixture(t), filename = path.join(f.directory, "model.json");
  const request = f.write({ kind: "config.save", target: "model", value: { ...model, modelId: "selected-before-loss" } }, readPersonalConfigurationFile(f.profile, "model").revision);
  const receipt = await f.dispatch(request), content = fs.readFileSync(filename, "utf8");
  const operations = (await f.instance.harness.snapshot(PersonalConfigurationDoc, BACKGROUND_CONTEXT))!.operations;
  await f.instance.close(); fs.unlinkSync(filename);
  const profile = lockPersonalProfile(f.directory), instance = await openPersonalHarness({ profile, provider: personalProvider(parsePersonalModel(model)), modelId: model.modelId });
  t.after(() => instance.close());
  assert.equal(instance.isSettingsSuspended("model"), true); assert.equal(instance.isSettingsSuspended("mcp"), false);
  assert.deepEqual((await instance.harness.snapshot(PersonalConfigurationDoc, BACKGROUND_CONTEXT))?.operations, operations);
  assert.deepEqual((await instance.harness.snapshot(PersonalSettingsOperationDoc, request.id, BACKGROUND_CONTEXT))?.operation?.receipt, receipt);
  fs.writeFileSync(filename, content, { mode: 0o600 }); await recoverPersonalSettings({ profile, instance });
  assert.equal(instance.isSettingsSuspended("model"), false);
});
