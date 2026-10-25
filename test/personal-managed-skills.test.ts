import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readSkill } from "@ruukoto/agent/skills.ts";
import { loadHostSkillLibrary, ManagedSkillsStore } from "@ruukoto/agent/managed-skills.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { lockPersonalProfile, PERSONAL_FORMAT } from "../apps/ruukoto/src/personal-profile.ts";
import { personalSkillStore } from "../apps/ruukoto/src/personal-skills.ts";
import { savePersonalSkills } from "../apps/ruukoto/src/personal-skills-config.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { startPersonalServer, personalControl } from "../apps/ruukoto/src/personal-control.ts";
import { readPersonalSettings, savePersonalSettings } from "../apps/ruukoto/src/personal-settings.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-pa-managed-"))), directory = path.join(root, "profile"), source = path.join(root, "alpha");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "refs"), { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: alpha\ndescription: 托管任务指引\n---\n任务正文，读取 refs/guide.md\n");
  fs.writeFileSync(path.join(source, "refs", "guide.md"), "原始引用资料");
  const profile = lockPersonalProfile(directory);
  let imported;
  try {
    const store = personalSkillStore(profile), preview = store.preview(source);
    imported = store.import({ id: preview.id, sourceDir: source, contentRevision: preview.contentRevision, expectedRevision: preview.revision });
  } finally { profile.release(); }
  const managed = path.join(directory, "managed-skills"), pkg = path.join(managed, "packages", imported.id, "alpha");
  return { root, directory, source, managed, pkg, imported };
}

test("个人托管技能：导入后重新持锁、启停和逻辑移除保留私有权限与旧引用", t => {
  const f = fixture(t), pinned = loadHostSkillLibrary(f.directory, []);
  for (const state of ["disabled", "enabled", "removed"] as const) {
    const profile = lockPersonalProfile(f.directory);
    try {
      const store = personalSkillStore(profile), expectedRevision = store.list().revision;
      const result = state === "removed" ? store.remove({ id: f.imported.id, expectedRevision }) : store.setEnabled({ id: f.imported.id, expectedRevision, enabled: state === "enabled" });
      assert.equal(result.state, state);
    } finally { profile.release(); }
    lockPersonalProfile(f.directory).release();
    assert.equal(loadHostSkillLibrary(f.directory, []).skills.length, state === "enabled" ? 1 : 0);
    assert.match(readSkill(pinned, "alpha", "refs/guide.md"), /原始引用资料/);
    for (const filename of [f.managed, path.dirname(f.pkg), f.pkg, path.join(f.pkg, "refs")]) assert.equal(fs.statSync(filename).mode & 0o777, 0o700);
    for (const filename of [path.join(f.managed, "state.json"), path.join(f.pkg, "SKILL.md"), path.join(f.pkg, "refs", "guide.md")]) assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "profile.json"), "utf8")), PERSONAL_FORMAT);
  }
  assert.equal(fs.readFileSync(path.join(f.source, "refs", "guide.md"), "utf8"), "原始引用资料");
});

test("个人托管技能：不解析部分临时清单、不选择暂存和孤立包，仍可重开", t => {
  const f = fixture(t), temporary = path.join(f.managed, "state.json.tmp");
  fs.writeFileSync(temporary, '{"version":', { mode: 0o600 });
  for (const collection of [".staging", "packages"]) {
    const pkg = path.join(f.managed, collection, randomUUID(), "unfinished");
    fs.mkdirSync(pkg, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(pkg, "SKILL.md"), "部分复制", { mode: 0o600 });
  }
  lockPersonalProfile(f.directory).release();
  assert.deepEqual(loadHostSkillLibrary(f.directory, []).skills.map(skill => skill.name), ["alpha"]);
  assert.equal(fs.readFileSync(temporary, "utf8"), '{"version":');
  assert.equal(fs.readdirSync(path.join(f.managed, "packages")).length, 2);
});

test("个人托管技能：根、嵌套、清单及包文件的公开权限和链接拒绝且不自动修复", async t => {
  const f = fixture(t);
  for (const node of ["root", "nested", "manifest", "file"] as const) for (const violation of ["public", "symlink", "owner"] as const) await t.test(`${node}/${violation}`, t => {
    const filename = node === "root" ? f.managed : node === "nested" ? path.join(f.pkg, "refs") : node === "manifest" ? path.join(f.managed, "state.json") : path.join(f.pkg, "refs", "guide.md");
    const directory = node === "root" || node === "nested", originalNode = path.join(f.root, "original");
    if (violation === "public") fs.chmodSync(filename, directory ? 0o755 : 0o644);
    else if (violation === "symlink") {
      fs.renameSync(filename, originalNode); fs.symlinkSync(originalNode, filename);
    } else {
      const original = fs.lstatSync;
      t.mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
        const stat = Reflect.apply(original, fs, args);
        if (String(args[0]) === filename && stat) stat.uid = (process.getuid?.() ?? 0) + 1;
        return stat;
      }); syncBuiltinESMExports();
    }
    try {
      assert.throws(() => lockPersonalProfile(f.directory), code(node === "root" ? "profile_unrecognized" : violation === "symlink" && node !== "manifest" ? "skills_source_unsafe" : "skills_layout_invalid"));
      if (violation === "public") assert.equal(fs.statSync(filename).mode & 0o777, directory ? 0o755 : 0o644);
      if (violation === "symlink") assert.equal(fs.lstatSync(filename).isSymbolicLink(), true);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (violation === "public") fs.chmodSync(filename, directory ? 0o700 : 0o600);
      if (violation === "symlink") { fs.unlinkSync(filename); fs.renameSync(originalNode, filename); }
    }
    lockPersonalProfile(f.directory).release();
  });
});

test("个人托管技能：硬链接、未知管理节点/顶层及清单版本继续拒绝", async t => {
  const f = fixture(t), manifest = path.join(f.managed, "state.json"), original = fs.readFileSync(manifest);
  for (const violation of ["manifest-hardlink", "file-hardlink", "unknown-node", "unknown-top", "version"] as const) await t.test(violation, () => {
    if (violation.endsWith("hardlink")) fs.linkSync(violation === "manifest-hardlink" ? path.join(f.managed, "state.json") : path.join(f.pkg, "refs", "guide.md"), path.join(f.root, "hardlink"));
    if (violation === "unknown-node") fs.mkdirSync(path.join(f.managed, "other"), { mode: 0o700 });
    if (violation === "unknown-top") fs.mkdirSync(path.join(f.directory, "other"), { mode: 0o700 });
    if (violation === "version") { const state = JSON.parse(original.toString("utf8")); state.version = 2; fs.writeFileSync(manifest, JSON.stringify(state)); }
    const expected = violation === "unknown-top" ? "profile_unrecognized" : violation === "version" ? "skills_state_version_unknown" : violation === "file-hardlink" ? "skills_source_unsafe" : "skills_layout_invalid";
    try { assert.throws(() => lockPersonalProfile(f.directory), code(expected)); }
    finally {
      if (violation.endsWith("hardlink")) fs.unlinkSync(path.join(f.root, "hardlink"));
      if (violation === "unknown-node") fs.rmdirSync(path.join(f.managed, "other"));
      if (violation === "unknown-top") fs.rmdirSync(path.join(f.directory, "other"));
      if (violation === "version") fs.writeFileSync(manifest, original);
    }
    lockPersonalProfile(f.directory).release();
  });
});

test("个人托管技能：真实后台重开与有历史档案启停，实际目录/正文/引用保留请求证据", async t => {
  const f = fixture(t), key = "RUUKOTO_PERSONAL_MANAGED_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
  const model = new PersonalMockModelServer(request => {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "读取引用") return { kind: "tool_calls", calls: [{ id: "read-alpha", name: "skill", arguments: { name: "alpha", path: "refs/guide.md" } }] };
    return { kind: "text", text: "已收到" };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 };
  let current: Awaited<ReturnType<typeof openPersonalHarness>> | undefined, server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => { await current?.close(); await server?.stop(); await model.close(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  await savePersonalConfig(f.directory, config);
  server = await startPersonalServer(f.directory); assert.equal((await personalControl<{ model: string }>(f.directory, "GET", "/status")).model, "mock-model"); await server.stop();
  const open = () => openPersonalHarness({ directory: f.directory, provider: personalProvider(config), modelId: config.modelId });
  current = await open();
  await current.answer("/skill:alpha 执行", "body"); await current.answer("读取引用", "reference");
  assert.match(JSON.stringify(model.calls), /任务正文/); assert.match(JSON.stringify(model.calls), /原始引用资料/);
  const history = (await current.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const snapshots = history.filter(entry => entry.kind === "ruukoto.skills-snapshot");
  assert.match(JSON.stringify(snapshots), /managed/); assert.match(JSON.stringify(snapshots), new RegExp(f.imported.id));
  assert.ok(history.some(entry => entry.kind === "ruukoto.model-request" && JSON.stringify(entry.data).includes("原始引用资料")));
  await current.close();
  for (const removed of [false, true]) {
    const profile = lockPersonalProfile(f.directory);
    try {
      const store = personalSkillStore(profile), expectedRevision = store.list().revision;
      const snapshot = await readPersonalSettings(profile);
      const receipt = await savePersonalSettings(profile, snapshot, expectedRevision, removed ? { kind: "skills.remove", id: f.imported.id } : { kind: "skills.set-enabled", id: f.imported.id, enabled: false });
      assert.equal(receipt.status, "saved");
    } finally { profile.release(); }
    current = await open();
    const count = model.calls.length;
    assert.equal((await (await current.submit("/skill:alpha 新调用", `disabled-${removed}`)).wait(context)).status, "unanswered");
    assert.equal(model.calls.length, count);
    await current.answer("继续", `continue-${removed}`);
    const after = (await current.main.entries({ order: "ascending" }, 256, undefined, context)).items;
    assert.deepEqual(after.filter(entry => history.some(original => original.id === entry.id)), history);
    await current.close();
    server = await startPersonalServer(f.directory); await server.stop();
  }
  assert.equal(fs.readFileSync(path.join(f.pkg, "refs", "guide.md"), "utf8"), "原始引用资料");
});

test("个人技能真实请求：准备后正文变化沿本次快照发送，下一请求刷新，发送边界不重读", async t => {
  const f = fixture(t), external = path.join(f.root, "external"), skill = path.join(external, "skills", "mutable"), body = path.join(skill, "SKILL.md");
  fs.mkdirSync(skill, { recursive: true });
  const write = (text: string) => fs.writeFileSync(body, `---\nname: mutable\ndescription: 外部任务指引\n---\n${text}\n`);
  write("INITIAL_BODY"); await savePersonalSkills(f.directory, { version: 1, directory: external });
  const key = "RUUKOTO_PERSONAL_MANAGED_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
  const model = new PersonalMockModelServer(() => ({ kind: "text", text: "已收到" }));
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 };
  let current: Awaited<ReturnType<typeof openPersonalHarness>> | undefined, armed = false, changed = false, reads = 0;
  t.after(async () => { await current?.close(); await model.close(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  current = await openPersonalHarness({ directory: f.directory, provider: personalProvider(config), modelId: config.modelId, openStorage: async filename => {
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
    assert.match(JSON.stringify(model.calls[0].raw), /PINNED_BODY/); assert.doesNotMatch(JSON.stringify(model.calls[0].raw), /NEXT_BODY/);
    reads = 0;
    await current.answer("/skill:mutable 下次", "next");
    assert.equal(reads, 2); assert.match(JSON.stringify(model.calls[1].raw), /NEXT_BODY/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const entries = (await current.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const requests = entries.filter(entry => entry.kind === "ruukoto.model-request");
  assert.equal(requests.length, 4); assert.match(JSON.stringify(requests.slice(0, 2)), /PINNED_BODY/); assert.doesNotMatch(JSON.stringify(requests.slice(0, 2)), /NEXT_BODY/);
  assert.match(JSON.stringify(entries.filter(entry => entry.kind === "ruukoto.skills-snapshot")), /PINNED_BODY.*NEXT_BODY/s);
});

test("个人托管技能真实请求：准备后停用或移除保留本次目录，后续请求撤下选择", async t => {
  for (const boundary of ["input", "payload"] as const) for (const state of ["disabled", "removed"] as const) await t.test(`${boundary}/${state}`, async t => {
    const f = fixture(t), external = path.join(f.root, "external"), skill = path.join(external, "skills", "mutable"), body = path.join(skill, "SKILL.md");
    fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(body, "---\ndescription: 触发新快照\n---\ninitial\n");
    await savePersonalSkills(f.directory, { version: 1, directory: external });
    const key = "RUUKOTO_PERSONAL_MANAGED_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
    const model = new PersonalMockModelServer(() => ({ kind: "text", text: "请求已固定" }));
    const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 };
    const provider = personalProvider(config);
    let current: Awaited<ReturnType<typeof openPersonalHarness>> | undefined, armed = false, changed = false;
    const revoke = () => {
      if (!armed || changed) return;
      changed = true;
      const store = new ManagedSkillsStore(f.directory, [path.join(external, "skills")]), expectedRevision = store.list().revision;
      if (state === "disabled") store.setEnabled({ id: f.imported.id, enabled: false, expectedRevision });
      else store.remove({ id: f.imported.id, expectedRevision });
    };
    t.after(async () => { await current?.close(); await model.close(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    current = await openPersonalHarness({ directory: f.directory, provider: { ...provider, streamSimple: (model, input, options) => provider.streamSimple(model, input, { ...options, onPayload: async payload => {
      if (boundary === "payload") revoke();
      return await options?.onPayload?.(payload, model) ?? payload;
    } }) }, modelId: config.modelId, openStorage: async filename => {
      const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
      storage.commit = async (writes, context) => {
        const result = await commit(writes, context);
        if (boundary === "input" && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.skills-snapshot")) revoke();
        return result;
      };
      return storage;
    } });
    armed = true; fs.appendFileSync(body, "changed\n");
    assert.equal((await (await current.submit("使用当前技能", `${boundary}-${state}`)).wait(context)).status, "done");
    assert.equal(changed, true); assert.equal(model.calls.length, 1);
    assert.match(JSON.stringify(model.calls[0].system), /alpha/);
    await current.answer("使用更新后的技能", `${boundary}-${state}-next`);
    assert.doesNotMatch(JSON.stringify(model.calls[1].system), /alpha/);
    const entries = (await current.main.entries({ order: "ascending" }, 256, undefined, context)).items;
    assert.equal(entries.filter(entry => entry.kind === "ruukoto.model-request").length, 4);
  });
});

test("个人托管技能：停用前已准备的响应不能开始新的技能加载", async t => {
  const f = fixture(t), key = "RUUKOTO_MANAGED_LOAD_UPDATE_KEY", previous = process.env[key]; process.env[key] = "test-only";
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { received = resolve; });
  const model = new PersonalMockModelServer(async request => {
    const last = request.messages.at(-1);
    if (last?.role === "user") { received(); await held; return { kind: "tool_calls", calls: [{ id: "old-skill-load", name: "skill", arguments: { name: "alpha" } }] }; }
    return { kind: "text", text: String(last?.content) };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 };
  const current = await openPersonalHarness({ directory: f.directory, provider: personalProvider(config), modelId: config.modelId });
  t.after(async () => { release(); await current.close(); await model.close(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const pending = current.answer("加载原技能", "held-skill-request"); await started;
  const store = new ManagedSkillsStore(f.directory, []); store.setEnabled({ id: f.imported.id, enabled: false, expectedRevision: store.list().revision });
  release(); assert.match(await pending, /原技能已停用或变更/);
  assert.match(String(model.calls[0].system), /alpha/); assert.doesNotMatch(String(model.calls[1].system), /alpha/);
  const entries = (await current.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.equal(entries.some(entry => entry.kind === "ruukoto.skill-load"), false);
});
