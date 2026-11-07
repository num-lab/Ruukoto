import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, ROOT_CONVERSATION_ID, type Cursor, type EntryId } from "@earendil-works/pi-durable";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { PersonalDesktopAttachment } from "@ruukoto/view/personal-protocol.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalModel, personalProvider, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { loadPersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalWorkDoc, listPersonalWorks } from "../apps/ruukoto/src/personal-work.ts";
import { personalAttachmentGrant } from "../apps/ruukoto/src/personal-media.ts";
import { answerPersonalQuestion, personalQuestion, personalQuestionList } from "../apps/ruukoto/src/personal-questions.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalOutputsDoc, personalOutputIntent, personalOutputChunk } from "../apps/ruukoto/src/personal-outputs.ts";
import { PersonalReportPublication } from "../apps/ruukoto/src/personal-report.ts";
import { personalTimeline } from "../apps/ruukoto/src/personal-history.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const estimate = (text: string) => Math.ceil(text.length / 4) + Math.ceil([...text].filter(character => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)).length * 3 / 4);
type Catalog = { providers: Record<string, { api?: string; baseUrl: string; apiKey?: string; headers?: Record<string, string>; models: { id: string; api?: string; contextWindow?: number; input?: string[] }[] }> };
const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/personal-attachments/${name}`, import.meta.url));

const modelCheck = { skip: process.env.RUN_MODEL_CHECK !== "1" ? "Requires explicit real-model opt-in" : false, timeout: 480000 };
async function modelFixture(t: TestContext) {
  const sourceFile = process.env.RUN_PERSONAL_ATTACHMENT_MODELS_FILE;
  assert.ok(sourceFile && path.isAbsolute(sourceFile), "Set an absolute RUN_PERSONAL_ATTACHMENT_MODELS_FILE");
  const source = fs.readFileSync(sourceFile), catalog = JSON.parse(source.toString("utf8")) as Catalog;
  const candidates = Object.entries(catalog.providers).flatMap(([id, provider]) => provider.models.map(model => ({ id, provider, model })));
  const selected = process.env.RUN_PERSONAL_ATTACHMENT_MODEL ? candidates.find(value => `${value.id}/${value.model.id}` === process.env.RUN_PERSONAL_ATTACHMENT_MODEL) : candidates.length === 1 ? candidates[0] : undefined;
  assert.ok(selected, "Choose RUN_PERSONAL_ATTACHMENT_MODEL when several models are configured");
  assert.ok(selected.provider.apiKey && !selected.provider.apiKey.startsWith("!") && !Object.keys(selected.provider.headers ?? {}).length, "Use an existing API key without credential commands");
  const credentialName = "PERSONAL_ATTACHMENT_ACCEPTANCE_KEY", credential = process.env[selected.provider.apiKey] ?? selected.provider.apiKey, previous = process.env[credentialName];
  process.env[credentialName] = credential;
  const config = parsePersonalModel({ api: selected.model.api ?? selected.provider.api, baseUrl: selected.provider.baseUrl, modelId: selected.model.id, apiKeyEnv: credentialName, contextWindow: selected.model.contextWindow ?? 128000, maxTokens: 16384, imageInput: false });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-attachment-model-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), evidenceDirectory = fs.mkdtempSync(path.join(tmpdir(), "rk-attachment-model-evidence-"));
  fs.mkdirSync(workspace, { mode: 0o700 });
  const target = path.join(workspace, "updated.csv"), original = fixture("input.csv"), expected = fixture("updated.csv"), binary = fixture("binary.bin");
  fs.writeFileSync(target, "UNCHANGED", { mode: 0o600 });
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  const sanitize = (value: unknown) => JSON.stringify(value).replaceAll(credential, "[redacted]");
  let p: PersonalHarness | undefined, phase = "startup";
  const deadline = Date.now() + 440000;
  const wait = async (check: () => boolean | Promise<boolean>) => { while (!await check()) { assert.ok(Date.now() < deadline, `Attachment acceptance did not finish during ${phase}`); await delay(50); } };
  const open = async () => { p = undefined; return p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools }); };
  const upload = async (name: string, mime: string, bytes: Buffer): Promise<PersonalDesktopAttachment> => {
    const id = randomUUID();
    const receipt = await p!.media.upload({ v: 1, attachmentId: id, name, mime, totalBytes: bytes.length, sha256: hash(bytes), offset: 0, base64: bytes.toString("base64") });
    assert.equal(receipt.complete, true); assert.equal(receipt.nextOffset, bytes.length);
    return { id, name, size: bytes.length, mime, sha256: hash(bytes) };
  };
  const publication = async (name: string) => {
    await wait(async () => (await p!.harness.commit(tx => personalTimeline(tx, {}), context)).items.some(entry => entry.kind === PersonalReportPublication.kind && entry.outputs?.some(output => output.name === name)));
    return p!.harness.commit(async tx => {
      const shown = (await personalTimeline(tx, {})).items.find(entry => entry.outputs?.some(output => output.name === name));
      assert.ok(shown);
      const metadata = shown.outputs!.find(output => output.name === name)!;
      const intent = await personalOutputIntent(tx, metadata.output as EntryId);
      const published = await tx.entry(PersonalReportPublication, shown.entry as EntryId);
      assert.ok(published);
      return { intent, published, metadata };
    }, context);
  };
  const outputBytes = (saved: Awaited<ReturnType<typeof publication>>) => {
    const chunks: Buffer[] = []; let offset: number | undefined = 0;
    do { const chunk = personalOutputChunk(directory, saved.published.id, saved.intent, offset); chunks.push(Buffer.from(chunk.base64, "base64")); offset = chunk.nextOffset; } while (offset !== undefined);
    return Buffer.concat(chunks);
  };
  t.after(async () => {
    try {
      if (p) {
        const metrics: { conversation: number; entry: number; systemPrompt: number; toolSchemas: number }[] = [];
        let cursor: Cursor | undefined;
        do {
          const conversations = await p.harness.commit(tx => tx.scanConversations({}, 256, cursor), context);
          for (const conversation of conversations.items) {
            let entries: Cursor | undefined;
            do {
              const page = await p.harness.commit(tx => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, entries), context);
              for (const entry of page.items) {
                fs.appendFileSync(path.join(evidenceDirectory, "entries.jsonl"), sanitize(entry) + "\n", { mode: 0o600 });
                if (entry.kind === "ruukoto.model-request") {
                  const messages = (entry.data as RequestEvidence).input as unknown as { messages: Parameters<typeof getCurrentSystemPrompt>[0] };
                  metrics.push({ conversation: conversation.id, entry: entry.id, systemPrompt: estimate(getCurrentSystemPrompt(messages.messages)), toolSchemas: estimate(JSON.stringify(getCurrentTools(messages.messages).map(({ name, description, parameters }) => ({ name, description, parameters })))) });
                }
              }
              entries = page.next;
            } while (entries);
          }
          cursor = conversations.next;
        } while (cursor);
        fs.writeFileSync(path.join(evidenceDirectory, "metrics.json"), JSON.stringify(metrics) + "\n", { mode: 0o600 });
      }
      fs.writeFileSync(path.join(evidenceDirectory, "summary.json"), sanitize({ phase, model: `${selected.id}/${selected.model.id}`, imageInput: false, fixtures: { input: hash(original), updated: hash(expected), binary: hash(binary) }, sourceSha256: hash(source) }) + "\n", { mode: 0o600 });
      process.stdout.write(JSON.stringify({ evidenceDirectory, phase }) + "\n");
      assert.equal(hash(fs.readFileSync(sourceFile)), hash(source));
    } finally { await p?.close(); fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous; }
  });
  isolateSkillHome(t);
  await open();
  await p!.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "confirm"; permission.version++; }, context);
  return { open, upload, publication, outputBytes, original, expected, binary, target, directory, wait, get p() { return p!; }, set phase(value: string) { phase = value; } };
}

test("Personal attachment real model: delegate the received CSV and binary, publish complete bytes and retain originals", modelCheck, async t => {
  const f = await modelFixture(t), { upload, publication, outputBytes, original, expected, binary, target, directory } = f;
  f.phase = "CSV admission and delegated edit";
  const csvAttachment = await upload("input.csv", "text/csv", original), csvKey = randomUUID();
  await (await f.p.submit(`请把附件 input.csv 中 id=17 的 status 从 pending 改为 done，其余字节、引号、换行和末尾换行完全保留。保存到 ${target}，并以 updated.csv 交付。安排后台工作读取所选附件，写入一次后直接登记交付。`, csvKey, [csvAttachment])).wait(context);
  const csv = await publication("updated.csv"), writes = await f.p.harness.commit(async tx => (await toolOperations(tx)).filter(value => value.kind === "write_file").length, context);
  assert.equal(writes, 1);
  assert.deepEqual(outputBytes(csv), expected); assert.deepEqual(fs.readFileSync(target), expected);
  const received = await f.p.media.message(csvKey); assert.ok(received);
  assert.deepEqual(loadPersonalArtifact(directory, received.artifacts[0]), original);
  assert.ok(csv.intent.data.origin.work);
  const assigned = (await f.p.harness.snapshot(PersonalWorkDoc, csv.intent.data.origin.work!.ref.requestId, context))!;
  assert.ok(assigned.ref && assigned.ref.agentId !== ROOT_CONVERSATION_ID);
  f.phase = "binary admission and original-byte publication";
  const binaryAttachment = await upload("binary.bin", "application/octet-stream", binary), binaryKey = randomUUID();
  await (await f.p.submit("请安排一项新的后台工作，把这条消息的 binary.bin 原附件原样交付给我。不要解释或修改它，也不要进行文件或网络写入。", binaryKey, [binaryAttachment])).wait(context);
  const returned = await publication("binary.bin");
  assert.deepEqual(outputBytes(returned), binary);
  assert.deepEqual(loadPersonalArtifact(directory, (await f.p.media.message(binaryKey))!.artifacts[0]), binary);
  await f.p.harness.waitForTask(returned.published.data.taskId, context);
  const before = await f.p.harness.commit(async tx => copyJson(await listPersonalWorks(tx)), context);
  f.phase = "reopen original request and attachment association";
  await f.p.close(); await f.open();
  assert.deepEqual(await f.p.harness.commit(async tx => copyJson(await listPersonalWorks(tx)), context), before);
  assert.deepEqual(loadPersonalArtifact(directory, (await f.p.media.message(csvKey))!.artifacts[0]), original);
  assert.deepEqual(loadPersonalArtifact(directory, (await f.p.media.message(binaryKey))!.artifacts[0]), binary);
  assert.equal((await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, csvKey), context))?.status, "done");
  assert.deepEqual(outputBytes(csv), expected); assert.deepEqual(outputBytes(returned), binary);
  f.phase = "passed";
});

for (const order of ["file first", "instruction first"] as const) test(`Personal attachment-only real model: ${order}, return the original binary with its work grant`, modelCheck, async t => {
  const f = await modelFixture(t), attachmentKey = randomUUID();
  if (order === "instruction first") {
    f.phase = "explicit task awaiting the next attachment";
    const waiting = await f.p.answer("我下一条消息会只发送一个文件。收到后，请安排后台工作，把那条消息的原附件原样以 binary.bin 交付给我。不要修改它，不进行文件或网络写入。在收到文件前先确认等待，不启动工作。", randomUUID());
    assert.ok(waiting.trim());
    assert.equal((await f.p.harness.commit(tx => listPersonalWorks(tx), context)).items.length, 0);
  }
  f.phase = "attachment-only admission";
  const attachment = await f.upload("binary.bin", "application/octet-stream", f.binary);
  const submitted = await (await f.p.submit("", attachmentKey, [attachment])).wait(context);
  assert.ok(submitted.status === "done" && submitted.type === "input");
  const received = await f.p.media.message(attachmentKey); assert.ok(received);
  const original = received.artifacts[0]; assert.ok(original);
  assert.equal(received.body, ""); assert.equal(received.source.platform, "desktop");
  assert.deepEqual(loadPersonalArtifact(f.directory, original), f.binary);
  let processingKey: string = attachmentKey;
  if (order === "file first") {
    f.phase = "clarification without unsolicited work";
    const answer = await f.p.harness.commit(tx => tx.entry(AssistantEntry, submitted.answer), context);
    const text = answer?.model?.flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : []).join("\n") ?? "";
    const questions = await f.p.harness.commit(tx => personalQuestionList(tx), context);
    assert.match([text, ...questions.items.filter(question => question.status === "pending").map(question => question.question)].join("\n"), /[?？]|用途|如何|什么|希望|请.*(?:说明|指定)|\b(?:what|how|which)\b/i);
    assert.equal((await f.p.harness.commit(tx => listPersonalWorks(tx), context)).items.length, 0);
    assert.equal((await f.p.harness.snapshot(PersonalOutputsDoc, context))!.intents.length, 0);
    f.phase = "explicit use of the previously received original";
    const instruction = "请安排一项后台工作，把我上一条仅含附件的消息中的 binary.bin 原附件原样交付给我。不要修改它，也不要进行文件或网络写入。";
    const pending = questions.items.find(question => question.status === "pending");
    if (pending) {
      const receipt = await f.p.harness.commit(async tx => {
        const question = await personalQuestion(tx, pending.id);
        return answerPersonalQuestion(tx, { question: question.id, version: question.version, requestId: randomUUID(), answers: question.questions.map(() => ({ text: instruction })) }, { kind: "local" });
      }, context);
      assert.ok(receipt.taskId); processingKey = `personal-question:${receipt.taskId}`;
      f.p.harness.resume(); await f.p.harness.waitForTask(receipt.taskId, context);
    } else { processingKey = randomUUID(); await f.p.answer(instruction, processingKey); }
  }
  f.phase = "original binary publication and source proof";
  const returned = await f.publication("binary.bin");
  assert.deepEqual(f.outputBytes(returned), f.binary);
  assert.deepEqual(returned.intent.data.source, { kind: "artifact", artifact: original.id });
  assert.deepEqual(returned.intent.data.artifact, original);
  assert.ok(returned.intent.data.origin.work);
  const assigned = (await f.p.harness.snapshot(PersonalWorkDoc, returned.intent.data.origin.work!.ref.requestId, context))!;
  assert.ok(assigned.ref && assigned.ref.agentId !== ROOT_CONVERSATION_ID && assigned.attachments);
  const grant = await f.p.harness.commit(tx => personalAttachmentGrant(tx, assigned.attachments!), context);
  assert.deepEqual(grant.work, assigned.ref); assert.equal(grant.sourceRequestId, processingKey); assert.ok(grant.modelCall);
  assert.deepEqual(grant.attachments, [{ version: 1, artifact: original, name: "binary.bin", kind: "file", requestId: attachmentKey, source: received.source, received: received.accepted }]);
  assert.equal(await f.p.harness.commit(async tx => (await toolOperations(tx)).length, context), 0);
  assert.equal(fs.readFileSync(f.target, "utf8"), "UNCHANGED");
  await f.p.harness.waitForTask(returned.published.data.taskId, context);
  f.phase = "reopen the original attachment and delegated scope";
  await f.p.close(); await f.open();
  assert.deepEqual(await f.p.media.message(attachmentKey), received);
  assert.deepEqual(loadPersonalArtifact(f.directory, original), f.binary);
  assert.deepEqual(await f.p.harness.commit(tx => personalAttachmentGrant(tx, assigned.attachments!), context), grant);
  assert.deepEqual(f.outputBytes(returned), f.binary);
  f.phase = "passed";
});
