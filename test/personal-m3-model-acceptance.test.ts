import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Cursor } from "@earendil-works/pi-durable";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalModel, personalProvider, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalQuestionsDoc, personalQuestion, answerPersonalQuestion, type PersonalOwnerAnswer, type PersonalQuestion } from "../apps/ruukoto/src/personal-questions.ts";
import { PersonalWorkDoc, personalWorkStatus } from "../apps/ruukoto/src/personal-work.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
type Catalog = { providers: Record<string, { api?: string; baseUrl: string; apiKey?: string; headers?: Record<string, string>; models: { id: string; api?: string; contextWindow?: number; maxTokens?: number; input?: string[] }[] }> };
function selectedAnswer(question: PersonalQuestion, index: number): PersonalOwnerAnswer[] {
  return question.questions.map(item => {
    const options = item.options;
    assert.ok(options?.[index], "The configured model must present the requested choices");
    const label = typeof options[index] === "string" ? options[index] : options[index].label;
    return { text: label, ...(item.multiple ? { options: [index] } : { option: index }) };
  });
}
function estimates(evidence: RequestEvidence) {
  const messages = (evidence.input as { messages: { role: string }[] }).messages;
  const estimate = (text: string) => Math.ceil(text.length / 4) + Math.ceil([...text].filter(character => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)).length * 3 / 4);
  return { systemPrompt: estimate(getCurrentSystemPrompt(messages)), toolSchemas: estimate(JSON.stringify(getCurrentTools(messages).map(({ name, description, parameters }) => ({ name, description, parameters })))) };
}

test("Personal M3 real model: concurrent questions resume their own work once and cancellation rejects late answers", { skip: process.env.RUN_MODEL_CHECK !== "1" ? "Requires explicit real-model opt-in" : false, timeout: 360000 }, async t => {
  const sourceFile = process.env.RUN_PERSONAL_M3_MODELS_FILE;
  assert.ok(sourceFile && path.isAbsolute(sourceFile), "Set an absolute RUN_PERSONAL_M3_MODELS_FILE");
  let source: Buffer, catalog: Catalog;
  try { source = fs.readFileSync(sourceFile); catalog = JSON.parse(source.toString("utf8")) as Catalog; }
  catch { throw new Error("The selected models configuration could not be read or parsed."); }
  const candidates = Object.entries(catalog.providers).flatMap(([id, provider]) => provider.models.map(model => ({ id, provider, model })));
  const selected = process.env.RUN_PERSONAL_M3_MODEL ? candidates.find(value => `${value.id}/${value.model.id}` === process.env.RUN_PERSONAL_M3_MODEL) : candidates.length === 1 ? candidates[0] : undefined;
  assert.ok(selected, "Choose RUN_PERSONAL_M3_MODEL when the file contains several models");
  assert.ok(selected.provider.apiKey && !selected.provider.apiKey.startsWith("!") && !Object.keys(selected.provider.headers ?? {}).length, "Use existing API key authentication without credential commands");
  const credential = process.env[selected.provider.apiKey] ?? selected.provider.apiKey, credentialName = "PERSONAL_M3_ACCEPTANCE_KEY", previous = process.env[credentialName];
  process.env[credentialName] = credential;
  const config = parsePersonalModel({ api: selected.model.api ?? selected.provider.api, baseUrl: selected.provider.baseUrl, modelId: selected.model.id, apiKeyEnv: credentialName, contextWindow: selected.model.contextWindow ?? 128000, maxTokens: Math.min(selected.model.maxTokens ?? 4096, 4096), imageInput: selected.model.input?.includes("image") ?? false });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-m3-model-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), evidenceDirectory = fs.mkdtempSync(path.join(tmpdir(), "rk-m3-model-evidence-"));
  fs.mkdirSync(workspace, { mode: 0o700 });
  for (const name of ["a-before.txt", "a-after.txt", "b-before.txt", "b-after.txt", "c-after.txt"]) fs.writeFileSync(path.join(workspace, name), "UNCHANGED", { mode: 0o600 });
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  const base = personalProvider(config);
  let p: PersonalHarness | undefined, phase = "startup", requests = 0;
  const provider = { ...base, streamSimple: (...args: Parameters<typeof base.streamSimple>) => { if (++requests > 32) throw new PersonalError("acceptance_request_limit", "M3 acceptance exceeded its request budget."); return base.streamSimple(...args); } };
  const deadline = Date.now() + 330000;
  const wait = async (check: () => boolean | Promise<boolean>) => { while (!await check()) { assert.ok(Date.now() < deadline, `M3 acceptance did not finish during ${phase}`); await delay(50); } };
  const questions = () => p!.harness.commit(async tx => { const result: PersonalQuestion[] = []; for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) result.push(JSON.parse(JSON.stringify(await personalQuestion(tx, id))) as PersonalQuestion); return result; }, context);
  const open = async () => p = await openPersonalHarness({ directory, provider, modelId: config.modelId, tools });
  t.after(async () => {
    try {
      if (p) {
        const file = path.join(evidenceDirectory, "entries.jsonl"), metrics: { conversation: number; entry: number; systemPrompt: number; toolSchemas: number }[] = [];
        fs.writeFileSync(file, "", { mode: 0o600 });
        let conversations: Cursor | undefined;
        do {
          const page = await p.harness.commit(tx => tx.scanConversations({}, 256, conversations), context);
          for (const conversation of page.items) {
            let cursor: Cursor | undefined;
            do {
              const entries = await p.harness.commit(tx => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, cursor), context);
              for (const entry of entries.items) { fs.appendFileSync(file, JSON.stringify(entry).replaceAll(credential, "[redacted]") + "\n"); if (entry.kind === "ruukoto.model-request") metrics.push({ conversation: conversation.id, entry: entry.id, ...estimates(entry.data as RequestEvidence) }); }
              cursor = entries.next;
            } while (cursor);
          }
          conversations = page.next;
        } while (conversations);
        fs.writeFileSync(path.join(evidenceDirectory, "metrics.json"), JSON.stringify(metrics) + "\n", { mode: 0o600 });
      }
      process.stdout.write(JSON.stringify({ evidenceDirectory, phase, requests }) + "\n");
    } finally { await p?.close(); fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous; }
  });
  isolateSkillHome(t);
  try {
    await open();
    await p!.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "confirm"; permission.version++; }, context);
    for (const label of ["A", "B"]) {
      phase = `delegate ${label}`;
      const prefix = label.toLowerCase();
      await p!.answer(`请安排一项独立后台工作${label}，立即交给子 Agent：先把完整文本 BEFORE_${label} 写入已有文件 ${path.join(workspace, `${prefix}-before.txt`)}；然后必须调用 ask_user 问一题「工作${label}的最终内容选哪一个？」，选项 ${JSON.stringify([`${label}_FIRST`, `${label}_SECOND`])}，${label === "B" ? "multiple为true，允许多选" : "单选"}。等待原问题的真实回答；回答后只把所选选项文本写入已有文件 ${path.join(workspace, `${prefix}-after.txt`)}，报告结果。只写这两个文件；待答前不得写最终文件，不把业务澄清当批准。`, `m3-${label}`);
      await wait(async () => (await questions()).some(value => value.status === "pending" && value.questions[0].question.includes(`工作${label}`)));
    }
    const pending = (await questions()).filter(value => value.status === "pending"), a = pending.find(value => value.questions[0].question.includes("工作A"))!, b = pending.find(value => value.questions[0].question.includes("工作B"))!;
    assert.ok(a.origin.work && b.origin.work); assert.notEqual(a.origin.work.ref.taskId, b.origin.work.ref.taskId);
    assert.equal(a.origin.permission.mode, "confirm"); assert.equal(b.origin.permission.mode, "confirm");
    assert.equal(fs.readFileSync(path.join(workspace, "a-before.txt"), "utf8"), "BEFORE_A"); assert.equal(fs.readFileSync(path.join(workspace, "b-before.txt"), "utf8"), "BEFORE_B");
    phase = "main query during two waits";
    assert.ok((await p!.answer("刚才A和B两个后台工作进展如何？只查询原工作和待决定事项，不追加或改变要求。", "m3-progress")).trim());
    assert.equal((await questions()).filter(value => value.status === "pending").length, 2);
    await p!.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context);
    phase = "answer B before A";
    const answerB = { question: b.id, version: b.version, requestId: randomUUID(), answers: selectedAnswer(b, 1) };
    const receipt = await p!.harness.commit(tx => answerPersonalQuestion(tx, answerB, { kind: "local" }), context);
    assert.deepEqual(await p!.harness.commit(tx => answerPersonalQuestion(tx, answerB, { kind: "local" }), context), receipt);
    await wait(async () => (await p!.harness.commit(tx => personalWorkStatus(tx, b.origin.work!.ref), context)).task.state.status === "terminal");
    assert.equal(fs.readFileSync(path.join(workspace, "b-after.txt"), "utf8"), "B_SECOND"); assert.equal(fs.readFileSync(path.join(workspace, "a-after.txt"), "utf8"), "UNCHANGED");
    assert.equal((await questions()).find(value => value.id === a.id)?.status, "pending");
    phase = "answer A";
    await p!.harness.commit(tx => answerPersonalQuestion(tx, { question: a.id, version: a.version, requestId: randomUUID(), answers: selectedAnswer(a, 1) }, { kind: "local" }), context);
    await wait(async () => (await p!.harness.commit(tx => personalWorkStatus(tx, a.origin.work!.ref), context)).task.state.status === "terminal");
    assert.equal(fs.readFileSync(path.join(workspace, "a-after.txt"), "utf8"), "A_SECOND");
    const writes = await p!.harness.commit(async tx => (await toolOperations(tx)).map(value => ({ kind: value.kind, started: value.started, permission: value.origin.permission.mode })), context);
    assert.equal(writes.filter(value => value.kind === "write_file" && value.started).length, 4); assert.ok(writes.every(value => value.permission === "confirm"));
    phase = "cancel waiting C";
    await p!.answer(`请安排独立后台工作C：子 Agent先调用 ask_user 问一题「工作C继续吗？」，选项继续、结束；真实回答后才把文本 C_DONE 写入已有文件 ${path.join(workspace, "c-after.txt")}。未回答前只等待原问题。`, "m3-C");
    let c: PersonalQuestion | undefined;
    await wait(async () => { c = (await questions()).find(value => value.status === "pending" && value.questions[0].question.includes("工作C")); return !!c; });
    assert.ok(c?.origin.work);
    await p!.answer("取消刚才工作C及全部剩余步骤，A和B已完成结果保留。不要更改C要求或另建工作重试。", "m3-cancel-C");
    assert.equal((await p!.harness.snapshot(PersonalWorkDoc, c.origin.work.ref.requestId, context))?.cancelRequested, true);
    await wait(async () => (await p!.harness.commit(tx => personalWorkStatus(tx, c!.origin.work!.ref), context)).stopVerified);
    await assert.rejects(p!.harness.commit(tx => answerPersonalQuestion(tx, { question: c!.id, version: c!.version, requestId: randomUUID(), answers: selectedAnswer(c!, 0) }, { kind: "local" }), context), error => error instanceof PersonalError);
    assert.equal(fs.readFileSync(path.join(workspace, "c-after.txt"), "utf8"), "UNCHANGED");
    phase = "reopen without replay";
    const before = await questions(); await p!.close(); await open(); assert.deepEqual(await questions(), before);
    assert.equal(await p!.harness.commit(async tx => (await toolOperations(tx)).filter(value => value.kind === "write_file" && value.started).length, context), 4);
    assert.equal(createHash("sha256").update(fs.readFileSync(sourceFile)).digest("hex"), createHash("sha256").update(source).digest("hex"));
    phase = "passed";
    process.stdout.write(JSON.stringify({ status: "passed", model: `${selected.id}/${selected.model.id}`, requests, completedWrites: 4, concurrentQuestions: 2, originalPermission: "confirm", sourceSha256: createHash("sha256").update(source).digest("hex") }) + "\n");
  } catch (error) { throw new Error(`M3 model acceptance failed during ${phase}: ${error instanceof Error ? error.message.replaceAll(credential, "[redacted]") : "unknown failure"}`); }
});
