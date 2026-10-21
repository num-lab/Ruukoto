import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../../../../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, parsePersonalModel } from "../../../../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../../../../apps/ruukoto/src/personal-permissions.ts";
import { parsePersonalTools } from "../../../../apps/ruukoto/src/personal-tools-config.ts";
import { answerPersonalQuestion, personalQuestionDetail, personalQuestionList } from "../../../../apps/ruukoto/src/personal-questions.ts";
import { toolOperations } from "../../../../apps/ruukoto/src/personal-tools.ts";

const context = BACKGROUND_CONTEXT, credentialName = "PERSONAL_QUESTION_ACCEPTANCE_MODEL_KEY";
const raw = JSON.parse(fs.readFileSync("/Users/eitrous/.ruukoto/agent/models.json", "utf8"));
const selected = raw.providers.deepseek, model = selected.models.find((item: { id: string }) => item.id === "deepseek-flash");
assert.ok(model && selected.apiKey && !selected.apiKey.startsWith("!")); assert.ok(!selected.headers || !Object.keys(selected.headers).length);
const previous = process.env[credentialName]; process.env[credentialName] = process.env[selected.apiKey] ?? selected.apiKey;
const config = parsePersonalModel({ api: model.api ?? selected.api, baseUrl: selected.baseUrl, modelId: model.id, apiKeyEnv: credentialName, contextWindow: model.contextWindow, maxTokens: 4096 });
const directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-question-real-"))), profile = path.join(directory, "profile"), workspace = path.join(directory, "workspace"); fs.mkdirSync(workspace);
const target = path.join(workspace, "acceptance.txt"), before = `ORIGINAL_${randomUUID()}`, marker = `PERSONAL_ANSWER_${randomUUID().replaceAll("-", "")}`; fs.writeFileSync(target, before);
const stat = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
const questions = [{ question: "执行哪些验收动作？", options: [{ label: "读入原资料", description: "读取已经存在的验收文件", recommended: true }, { label: "写入验收回执", description: "把验收口令写回该文件" }], multiple: true }, { question: "可选备注。" }, { question: "验收口令是什么？" }];
const output = new URL("./result.json", import.meta.url);
let p: Awaited<ReturnType<typeof openPersonalHarness>> | undefined, timer: ReturnType<typeof setTimeout> | undefined, passed = false;
try {
  p = await openPersonalHarness({ directory: profile, provider: personalProvider(config), modelId: config.modelId, tools });
  timer = setTimeout(() => { void p?.close(); }, 240000);
  await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "confirm"; permission.version++; }, context);
  await p.answer(`这是独立个人工具验收。请只调用一次 ask_user，questions参数严格使用${JSON.stringify(questions)}。成功登记后输出一句说明并结束本轮，不调用业务工具。收到专用问题入口的实际三题回答后，若选择读入原资料和写入验收回执，请先用read_file读取${target}，再用write_file将同一文件完整内容覆盖为第三题实际验收口令，不加换行；这两个文件工具都必须实际调用。然后最终只回复验收口令。本轮没有答案前不得预填，也不得提前读写文件。其他普通聊天独立处理，不消费原问题。`, "real-question");
  const page = await p.harness.commit(tx => personalQuestionList(tx), context); assert.equal(page.items.length, 1);
  const question = await p.harness.commit(tx => personalQuestionDetail(tx, page.items[0].id), context); assert.equal(question.status, "pending"); assert.deepEqual(question.questions, questions); assert.equal(fs.readFileSync(target, "utf8"), before);
  const ordinary = await p.answer("这是一条单独的普通聊天。请只回复 PERSONAL_CHAT_OK，不调用工具；此前的问题保持待答。", "real-ordinary"); assert.match(ordinary, /PERSONAL_CHAT_OK/); assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, question.id), context)).status, "pending");
  await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context);
  const input = { question: question.id, version: question.version, requestId: randomUUID(), answers: [{ text: "读入原资料\n写入验收回执", options: [0, 1] }, { text: "" }, { text: marker }] };
  const receipt = await p.harness.commit(tx => answerPersonalQuestion(tx, input, { kind: "local" }), context);
  const replay = await p.harness.commit(tx => answerPersonalQuestion(tx, input, { kind: "local" }), context); assert.equal(replay.taskId, receipt.taskId); p.harness.resume(); await p.harness.waitForTask(receipt.taskId!, context);
  const answered = await p.harness.commit(tx => personalQuestionDetail(tx, question.id), context); assert.equal(answered.answer?.delivery, "local"); assert.deepEqual(answered.answer.answers, input.answers); assert.equal(answered.answer.permission.mode, "full_access"); assert.equal(fs.readFileSync(target, "utf8"), marker);
  const operations = await p.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))), context);
  assert.deepEqual(operations.map((operation: { kind: string }) => operation.kind), ["read_file", "write_file"]);
  for (const operation of operations) { assert.equal(operation.origin.permission.mode, "full_access"); assert.equal(operation.origin.source.requestId, `personal-question:${receipt.taskId}`); assert.equal(operation.effect, "returned"); }
  const entries = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items, requests = entries.filter(entry => entry.kind === "ruukoto.model-request");
  assert.equal(entries.filter(entry => entry.kind === "ruukoto.question-answer").length, 1); assert.ok(JSON.stringify(requests).includes(marker)); assert.ok(JSON.stringify(requests).includes("读入原资料"));
  const initial = requests[0].data as { input: { messages: { role: string; toolsAdded?: { name: string }[]; sections?: Record<string, string> }[] } }, schemas = initial.input.messages.flatMap(message => message.toolsAdded ?? []), system = initial.input.messages.filter(message => message.role === "system");
  const estimates = { toolSchemasBefore: Math.ceil(JSON.stringify(schemas.filter(tool => tool.name !== "ask_user")).length / 4), toolSchemasAfter: Math.ceil(JSON.stringify(schemas).length / 4), systemPromptBefore: Math.ceil(JSON.stringify(system.map(({ toolsAdded: _, ...message }) => message)).length / 4), systemPromptAfter: Math.ceil(JSON.stringify(system.map(({ toolsAdded: _, ...message }) => message)).length / 4) };
  fs.writeFileSync(output, JSON.stringify({ passed: true, provider: "deepseek", model: model.id, profile, target, marker, question: answered, receipt, operations, estimates, requests, entries }, null, 2) + "\n");
  passed = true;
} finally {
  if (timer) clearTimeout(timer); await p?.close(); if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous;
  process.stdout.write(JSON.stringify({ passed, profile, evidence: output.pathname }) + "\n");
}
