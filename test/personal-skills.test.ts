import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, wrapTool, LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { personalSkills, PersonalSkillsDoc, PersonalSkillExpansionDoc, PERSONAL_SKILL_TOOLS } from "../apps/ruukoto/src/personal-skills.ts";
import { expandSkillCommandLegacy, loadSkillLibrary } from "@ruukoto/agent/skills.ts";
import { showPersonalSkills } from "../apps/ruukoto/src/personal-skills-cli.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalFormatDoc } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, recordedModels, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
function writeSkill(agent: string, name: string, body: string, explicit = false) {
  const directory = path.join(agent, "skills", name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}的任务指引\n${explicit ? "disable-model-invocation: true\n" : ""}allowed-tools: bash\n---\n${body}`);
  return directory;
}
async function fixture(t: TestContext, withSkills = true, holdLoad = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-skills-"))), directory = path.join(root, "profile");
  const key = "RUUKOTO_SKILLS_TEST_KEY", previous = process.env[key]; process.env[key] = "test-only";
  let harness!: Harness, lock!: ReturnType<typeof lockPersonalProfile>, failEvidence = false;
  const model = new MockModelServer(request => {
    const last = request.messages.at(-1), value = String(last?.content);
    if (last?.role === "user" && value.startsWith("skill:")) return { kind: "tool_calls", calls: [{ id: "skill-call", name: "skill", arguments: JSON.parse(value.slice(6)) }] };
    return { kind: "text", text: value };
  });
  t.after(async () => { if (harness) await harness.close(context); await model.close(); lock?.release(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const home = isolateSkillHome(t), agent = path.join(home, ".agents"), alpha = path.join(agent, "skills", "alpha");
  if (withSkills) {
    writeSkill(agent, "alpha", "任务正文：读取 refs/guide.md；不要扩大权限。"); writeSkill(agent, "explicit", "拥有者显式正文", true);
    fs.mkdirSync(path.join(alpha, "refs")); fs.writeFileSync(path.join(alpha, "refs", "guide.md"), "原始引用资料");
  }
  lock = lockPersonalProfile(directory);
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 2048 };
  const skills = personalSkills(), registry = createRegistry(); registry.install(skills.extension);
  let loaded!: () => void; const didLoad = new Promise<void>(resolve => { loaded = resolve; });
  const observer = defineExtension({ name: "skills-test-observer", wraps: [wrapTool(skills.extension.tools![0], tool => ({ ...tool, async execute(args, api, toolContext) {
    const result = await tool.execute(args, api, toolContext);
    if (holdLoad) { holdLoad = false; loaded(); const signal = toolContext.abortSignal; assert.ok(signal); await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); }); }
    return result;
  } }))] }); registry.install(observer);
  const requests: RequestEvidence[] = [];
  const open = async () => {
    harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "personal.sqlite")), {
      registry,
      models: recordedModels(personalProvider(config), async evidence => {
        if (failEvidence) throw new Error("evidence-write-failed");
        await harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.skills-request", data: evidence }), context);
        requests.push(evidence);
      }, undefined, async input => {
        const prepared = await harness.commit(tx => skills.prepare(tx, ROOT_CONVERSATION_ID), context);
        await harness.commit(tx => skills.verify(tx, ROOT_CONVERSATION_ID, prepared.version), context);
        const live = await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context), source = live?.run?.inputs.length === 1 ? await harness.submission(live.run.inputs[0], context) : undefined, record = await source?.status(context);
        const currentEntry = record && "entry" in record ? record.entry : undefined;
        const transcript = await harness.commit(tx => skills.prepareTranscript(tx, ROOT_CONVERSATION_ID, input, currentEntry), context);
        if (transcript.skillFailure) throw new PersonalError(transcript.skillFailure.code, transcript.skillFailure.message);
        return { input: { ...transcript, messages: [...transcript.messages, { role: "system" as const, content: prepared.text, timestamp: 0 }] }, references: { conversationId: ROOT_CONVERSATION_ID, memory: [], skills: { version: prepared.version, snapshotEntry: prepared.snapshotEntry } } };
      }),
    }, context);
    const main = await harness.root(context, { agent: { model: { provider: "personal", modelId: config.modelId }, extensions: [skills.extension, observer], tools: skills.extension.tools }, init: async tx => { await tx.doc(PersonalFormatDoc); } });
    return main;
  };
  let main = await open();
  return { directory, agent, alpha, skills, model, requests, registry, didLoad, unlock: () => lock.release(), get harness() { return harness; }, get main() { return main; }, failEvidence: () => { failEvidence = true; }, async reopen() { await harness.close(context); main = await open(); }, async answer(content: string, requestId: string) { return (await main.submit({ type: "input", content, requestId }, context)).wait(context); } };
}

test("个人技能：目录、全文与身份先留不可改快照，后续变化保留版本和原正文", async t => {
  const f = await fixture(t);
  const first = await f.harness.commit(tx => f.skills.prepare(tx, ROOT_CONVERSATION_ID), context);
  assert.match(first.text, /alpha的任务指引/); assert.doesNotMatch(first.text, /任务正文|explicit|\/tmp|bash|只作为文本提供/);
  assert.match(first.text, /可委派子 Agent 按其目录路径执行/, "主会话目录给出委派执行指引");
  assert.deepEqual([...PERSONAL_SKILL_TOOLS], ["skill"]);
  const doc = (await f.harness.snapshot(PersonalSkillsDoc, context))!;
  assert.equal(doc.snapshots.length, 1); assert.match(doc.snapshots[0].library.skills[0].body, /任务正文/);
  const entry = await f.harness.commit(tx => tx.entry(first.snapshotEntry), context); assert.equal(entry?.kind, "ruukoto.skills-snapshot");
  await f.harness.commit(tx => f.skills.verify(tx, ROOT_CONVERSATION_ID, first.version), context);
  writeSkill(f.agent, "alpha", "修改后正文");
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
    assert.ok(!String(args[0]).startsWith(path.join(f.agent, "skills")), "两个发送边界使用已保存快照，不重读正文");
    return Reflect.apply(original, fs, args);
  }); syncBuiltinESMExports();
  try {
    await f.harness.commit(tx => f.skills.verify(tx, ROOT_CONVERSATION_ID, first.version), context);
    await f.harness.commit(tx => f.skills.verify(tx, ROOT_CONVERSATION_ID, first.version), context);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.match(first.library.skills[0].body, /任务正文/);
  const next = await f.harness.commit(tx => f.skills.prepare(tx, ROOT_CONVERSATION_ID), context); assert.notEqual(next.version, first.version);
  const saved = (await f.harness.snapshot(PersonalSkillsDoc, context))!; assert.equal(saved.snapshots.length, 2); assert.match(saved.snapshots[0].library.skills[0].body, /任务正文/);
  await f.reopen(); await f.harness.commit(tx => f.skills.verify(tx, ROOT_CONVERSATION_ID, next.version), context);
});

test("个人技能：准备后的目录变化不改写原请求快照，下一请求固定新选择", async t => {
  const f = await fixture(t), first = await f.harness.commit(tx => f.skills.prepare(tx, ROOT_CONVERSATION_ID), context), previous = `${f.agent}-previous`;
  fs.renameSync(f.agent, previous); fs.mkdirSync(path.join(f.agent, "skills"), { recursive: true });
  await f.harness.commit(tx => f.skills.verify(tx, ROOT_CONVERSATION_ID, first.version, first.snapshotEntry), context);
  fs.rmdirSync(path.join(f.agent, "skills")); fs.rmdirSync(f.agent); fs.renameSync(previous, f.agent);
  writeSkill(f.agent, "alpha", "下一请求的新正文");
  fs.writeFileSync(path.join(f.directory, "skills.json"), JSON.stringify({ version: 1, directory: f.alpha }), { mode: 0o600 });
  const next = await f.harness.commit(tx => f.skills.prepare(tx, ROOT_CONVERSATION_ID), context);
  assert.notEqual(next.version, first.version);
  await f.harness.commit(tx => f.skills.verify(tx, ROOT_CONVERSATION_ID, first.version, first.snapshotEntry), context);
});

test("个人技能：没有来源元数据的旧快照原样核实，新选择只追加快照", async t => {
  const f = await fixture(t), config = { version: 1 as const, directory: f.agent }, { dev, ino } = fs.statSync(path.join(f.agent, "skills")), identity = { dev, ino }, library = loadSkillLibrary(f.agent);
  for (const skill of library.skills) { delete skill.id; delete skill.source; delete skill.readOnly; delete skill.contentRevision; }
  const value = { config, identity, library }, saved = { version: createHash("sha256").update(JSON.stringify(value)).digest("hex"), ...value };
  const original = await f.harness.commit(async tx => {
    const doc = await tx.doc(PersonalSkillsDoc), entry = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.skills-snapshot", data: JSON.parse(JSON.stringify(saved)) });
    doc.config = config; doc.snapshots.push({ ...saved, entry: entry.id, conversationId: ROOT_CONVERSATION_ID });
    doc.current.push({ conversationId: ROOT_CONVERSATION_ID, version: saved.version, snapshotEntry: entry.id }); return entry;
  }, context);
  await f.reopen(); await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
  const next = await f.harness.commit(tx => f.skills.prepare(tx, ROOT_CONVERSATION_ID), context);
  assert.notEqual(next.snapshotEntry, original.id); assert.notEqual(next.version, saved.version);
  assert.deepEqual(await f.harness.commit(tx => tx.entry(original.id), context), original);
  assert.equal((await f.harness.snapshot(PersonalSkillsDoc, context))!.snapshots.length, 2);
  await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
});

test("个人技能：原生工具加载正文和引用，缺文件、逃逸、显式技能不扩大权限", async t => {
  const f = await fixture(t);
  await f.answer('skill:{"name":"alpha"}', "body");
  assert.match(JSON.stringify(f.model.calls.at(-1)!.raw), /任务正文/);
  assert.deepEqual(f.model.calls[0].tools!.map(tool => (tool.function as { name: string }).name), ["skill"]);
  await f.answer('skill:{"name":"alpha","path":"refs/guide.md"}', "ref");
  assert.match(JSON.stringify(f.model.calls.at(-1)!.raw), /原始引用资料/);
  const count = (await f.main.entries({}, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.skill-load").length;
  fs.symlinkSync(path.join(f.agent, "skills", "explicit", "SKILL.md"), path.join(f.alpha, "escape.md"));
  for (const [requestId, params] of [["missing", { name: "alpha", path: "missing.md" }], ["escape", { name: "alpha", path: "escape.md" }], ["traversal", { name: "alpha", path: "../explicit/SKILL.md" }], ["explicit", { name: "explicit" }]] as const) await f.answer(`skill:${JSON.stringify(params)}`, requestId);
  const entries = (await f.main.entries({}, 256, undefined, context)).items;
  assert.equal(entries.filter(entry => entry.kind === "ruukoto.skill-load").length, count);
  const errors = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult" && message.isError); assert.equal(errors.length, 4);
  assert.ok(f.requests.some(request => request.payload && JSON.stringify(request.payload).includes("原始引用资料")));
  await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
});

test("个人技能：safe工具在加载提交后重开，沿原调用返回原引用文本", async t => {
  const f = await fixture(t, true, true);
  const submitted = await f.main.submit({ type: "input", content: 'skill:{"name":"alpha","path":"refs/guide.md"}', requestId: "replay-load" }, context);
  const waiting = submitted.wait(context); await f.didLoad;
  // 关闭使旧等待句柄失效，重开后只用原 submission 重新取得等待。
  await f.harness.close(context); await waiting.catch(() => undefined);
  fs.writeFileSync(path.join(f.alpha, "refs", "guide.md"), "新的引用资料");
  await f.reopen(); const restored = await f.harness.submission(submitted.id, context); assert.ok(restored);
  assert.equal((await restored.wait(context)).status, "done");
  const entries = (await f.main.entries({}, 256, undefined, context)).items, loads = entries.filter(entry => entry.kind === "ruukoto.skill-load");
  assert.equal(loads.length, 1); assert.match(JSON.stringify(f.model.calls.at(-1)!.raw), /原始引用资料/); assert.doesNotMatch(JSON.stringify(f.model.calls.at(-1)!.raw), /新的引用资料/);
  await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
});

test("个人技能：移除加载索引不能隐藏原生工具已读取的资料", async t => {
  const f = await fixture(t); await f.answer('skill:{"name":"alpha"}', "indexed-load");
  await f.harness.commit(async tx => { (await tx.doc(PersonalSkillsDoc)).loads.length = 0; }, context);
  await assert.rejects(f.harness.commit(tx => f.skills.verifyRecords(tx), context), code("skill_snapshot_invalid"));
});

test("个人技能：SDK规范化后的名称和路径可核实并重开", async t => {
  const f = await fixture(t), numeric = writeSkill(f.agent, "42", "数字名技能正文"); fs.writeFileSync(path.join(numeric, "7"), "数字名引用");
  await f.answer('skill:{"name":42,"path":7}', "normalized-skill");
  assert.match(JSON.stringify(f.model.calls.at(-1)!.raw), /数字名引用/);
  await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
  await f.reopen(); await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
  await f.answer("重开后继续", "after-normalized-skill");
});

test("个人技能：未知显式命令保留失败事实，只拦原输入，后续聊天和重开继续", async t => {
  const f = await fixture(t);
  assert.equal((await f.answer("/skill:missing 参数", "unknown-explicit")).status, "unanswered"); assert.equal(f.model.calls.length, 0);
  const doc = (await f.harness.snapshot(PersonalSkillsDoc, context))!; assert.equal(doc.expansions.length, 1);
  await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
  assert.equal((await f.answer("继续正常聊天", "after-unknown")).status, "done"); assert.equal(f.model.calls.length, 1);
  assert.match(JSON.stringify(f.model.calls[0].raw), /此前显式技能调用未执行/);
  writeSkill(f.agent, "missing", "后来新增的技能正文");
  await f.reopen(); await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
  assert.equal((await f.answer("重开后继续", "reopen-after-unknown")).status, "done");
  assert.doesNotMatch(JSON.stringify(f.model.calls.at(-1)!.raw), /后来新增的技能正文/);
});

test("个人技能：显式输入只在主会话展开，快照损坏阻断后续调用", async t => {
  const f = await fixture(t);
  await f.answer("/skill:explicit 参数", "explicit-input");
  assert.match(JSON.stringify(f.model.calls[0].raw), /拥有者显式正文/); assert.match(JSON.stringify(f.model.calls[0].raw), /参数/);
  assert.match(JSON.stringify(f.model.calls[0].raw), /· 目录 \//, "展开给出可执行的技能目录");
  assert.match(JSON.stringify(f.model.calls[0].raw), /按其目录路径执行/);
  const source = (await f.main.entries({}, 256, undefined, context)).items.find(entry => entry.kind === "pi.user")!;
  assert.equal(source.model![0].role === "user" && source.model![0].content, "/skill:explicit 参数");
  await f.harness.commit(tx => f.skills.verifyRecords(tx), context);
  writeSkill(f.agent, "explicit", "更新后的显式正文", true);
  await f.answer("普通后续输入", "after-explicit-change");
  assert.match(JSON.stringify(f.model.calls.at(-1)!.raw), /拥有者显式正文/); assert.doesNotMatch(JSON.stringify(f.model.calls.at(-1)!.raw), /更新后的显式正文/);
  const prepared = await f.harness.commit(tx => f.skills.prepare(tx, ROOT_CONVERSATION_ID), context);
  await f.harness.commit(async tx => { (await tx.doc(PersonalSkillsDoc)).snapshots[0].library.skills[0].body = "伪造正文"; }, context);
  await assert.rejects(f.harness.commit(tx => f.skills.verifyRecords(tx), context), code("skill_snapshot_invalid"));
  const count = f.model.calls.length; await f.answer("后续调用", "corrupt"); assert.equal(f.model.calls.length, count);
});

test("个人技能：冻结旧格式展开按原字节接受，伪造展开拒绝", async t => {
  const f = await fixture(t);
  await f.answer("/skill:explicit 参数", "legacy-explicit");
  const source = (await f.main.entries({}, 256, undefined, context)).items.find(entry => entry.kind === "pi.user")!;
  const saved = (await f.harness.snapshot(PersonalSkillsDoc, context))!.snapshots[0];
  const legacy = expandSkillCommandLegacy(saved.library, "/skill:explicit 参数");
  assert.doesNotMatch(legacy, /· 目录 \//, "旧格式不含目录与执行指引");
  for (const [name, expanded] of [["legacy", legacy], ["forged", "伪造的展开内容"]] as const) await t.test(name, async () => {
    // doc 与 entry 同步改写成目标格式：旧格式逐字节重建通过，非任一格式拒绝
    await f.harness.commit(async tx => {
      const doc = await tx.doc(PersonalSkillExpansionDoc, String(source.id), null);
      doc.expansion!.expanded = expanded;
    }, context);
    const entryId = await f.harness.commit(async tx => (await tx.doc(PersonalSkillExpansionDoc, String(source.id), null)).expansion!.entry, context);
    const db = new DatabaseSync(path.join(f.directory, "personal.sqlite"));
    try {
      db.prepare("UPDATE entries SET record = json_set(record, '$.data.expanded', ?) WHERE id = ?").run(expanded, entryId);
    } finally { db.close(); }
    const verify = () => f.harness.commit(tx => f.skills.verifyRecords(tx), context);
    if (name === "legacy") await verify();
    else await assert.rejects(verify, code("skill_snapshot_invalid"));
  });
});

test("个人技能：固定目录缺失为空库，证据失败仍阻止模型请求", async t => {
  const f = await fixture(t, false), prepared = await f.harness.commit(tx => f.skills.prepare(tx, ROOT_CONVERSATION_ID), context);
  assert.equal(prepared.text, "");
  const saved = (await f.harness.snapshot(PersonalSkillsDoc, context))!.snapshots[0];
  assert.deepEqual(saved.config, { version: 1, directory: f.agent }); assert.equal(saved.identity, null);
  assert.equal(fs.existsSync(path.join(f.agent, "skills")), false);
  assert.equal((await f.answer("空技能库也可聊天", "missing-root")).status, "done"); assert.equal(f.model.calls.length, 1);
  f.failEvidence(); await f.answer("证据失败", "evidence"); assert.equal(f.model.calls.length, 1);
});

test("个人技能：固定目录不是目录时不发送请求", async t => {
  const f = await fixture(t, false); fs.mkdirSync(f.agent); fs.writeFileSync(path.join(f.agent, "skills"), "不是目录");
  await f.answer("检查技能库", "invalid-root"); assert.equal(f.model.calls.length, 0);
});

test("个人技能查看：直接显示固定目录与诊断，不提问或写技能配置", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-skills-cli-"))), directory = path.join(root, "profile");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(isolateSkillHome(t), ".agents"); writeSkill(agent, "guide", "正文");
  let output = "";
  await showPersonalSkills({ question: async () => assert.fail("查看技能无需选择目录"), write: text => { output += text; } }, directory);
  assert.match(output, /guide的任务指引/); assert.doesNotMatch(output, /选择|保存/);
  assert.equal(fs.existsSync(path.join(directory, "skills.json")), false);
});
