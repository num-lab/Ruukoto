import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Cursor, type EntryId } from "@earendil-works/pi-durable";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalModel, personalProvider, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalOutputsDoc, personalOutputIntent, personalOutputChunk } from "../apps/ruukoto/src/personal-outputs.ts";
import { PersonalReportCoverageEntry, PersonalReportPublication, personalReportOutputs } from "../apps/ruukoto/src/personal-report.ts";
import { personalTimeline } from "../apps/ruukoto/src/personal-history.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
type Catalog = { providers: Record<string, { api?: string; baseUrl: string; apiKey?: string; headers?: Record<string, string>; models: { id: string; api?: string; contextWindow?: number; maxTokens?: number; input?: string[] }[] }> };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function estimates(evidence: RequestEvidence) {
  const messages = (evidence.input as { messages: { role: string }[] }).messages;
  const estimate = (text: string) => Math.ceil(text.length / 4) + Math.ceil([...text].filter(character => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)).length * 3 / 4);
  return { systemPrompt: estimate(getCurrentSystemPrompt(messages)), toolSchemas: estimate(JSON.stringify(getCurrentTools(messages).map(({ name, description, parameters }) => ({ name, description, parameters })))) };
}

test("Personal M4 real model: owner-requested final file is published from one original write and survives reopen", { skip: process.env.RUN_MODEL_CHECK !== "1" ? "Requires explicit real-model opt-in" : false, timeout: 360000 }, async t => {
  const sourceFile = process.env.RUN_PERSONAL_M4_MODELS_FILE;
  assert.ok(sourceFile && path.isAbsolute(sourceFile), "Set an absolute RUN_PERSONAL_M4_MODELS_FILE");
  let source: Buffer, catalog: Catalog;
  try { source = fs.readFileSync(sourceFile); catalog = JSON.parse(source.toString("utf8")) as Catalog; }
  catch { throw new Error("The selected models configuration could not be read or parsed."); }
  const candidates = Object.entries(catalog.providers).flatMap(([id, provider]) => provider.models.map(model => ({ id, provider, model })));
  const selected = process.env.RUN_PERSONAL_M4_MODEL ? candidates.find(value => `${value.id}/${value.model.id}` === process.env.RUN_PERSONAL_M4_MODEL) : candidates.length === 1 ? candidates[0] : undefined;
  assert.ok(selected, "Choose RUN_PERSONAL_M4_MODEL when the file contains several models");
  assert.ok(selected.provider.apiKey && !selected.provider.apiKey.startsWith("!") && !Object.keys(selected.provider.headers ?? {}).length, "Use existing API key authentication without credential commands");
  const credential = process.env[selected.provider.apiKey] ?? selected.provider.apiKey, credentialName = "PERSONAL_M4_ACCEPTANCE_KEY", previous = process.env[credentialName];
  process.env[credentialName] = credential;
  const config = parsePersonalModel({ api: selected.model.api ?? selected.provider.api, baseUrl: selected.provider.baseUrl, modelId: selected.model.id, apiKeyEnv: credentialName, contextWindow: selected.model.contextWindow ?? 128000, maxTokens: Math.min(selected.model.maxTokens ?? 4096, 4096), imageInput: selected.model.input?.includes("image") ?? false });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-m4-model-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), evidenceDirectory = fs.mkdtempSync(path.join(tmpdir(), "rk-m4-model-evidence-"));
  fs.mkdirSync(workspace, { mode: 0o700 });
  const name = "final-result.txt", target = path.join(workspace, name), content = `PERSONAL_M4_FINAL_${randomUUID()}\n这是拥有者要求交付的最终结果。\nUnicode remains intact: 🙂 café.\n`, expected = Buffer.from(content);
  fs.writeFileSync(target, "UNCHANGED", { mode: 0o600 });
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  const base = personalProvider(config);
  let p: PersonalHarness | undefined, phase = "startup", requests = 0, heldChild = false, childReady = false;
  let releaseChild!: () => void;
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
  const scopes: { request: number; child: boolean; tools: string[] }[] = [];
  const sanitize = (value: unknown) => JSON.stringify(value).replaceAll(credential, "[redacted]");
  const provider = { ...base, streamSimple: (model: Parameters<typeof base.streamSimple>[0], input: Parameters<typeof base.streamSimple>[1], options?: Parameters<typeof base.streamSimple>[2]) => {
    const request = ++requests;
    if (request > 20) throw new PersonalError("acceptance_request_limit", "M4 acceptance exceeded its request budget.");
    const child = getCurrentSystemPrompt(input.messages).includes("你是个人助手的子 Agent"), definitions = getCurrentTools(input.messages);
    scopes.push({ request, child, tools: definitions.map(tool => tool.name) });
    return base.streamSimple(model, input, { ...options, onPayload: async (payload, selectedModel) => {
      if (child && !heldChild) { heldChild = true; childReady = true; await childGate; }
      const sent = await options?.onPayload?.(payload, selectedModel) ?? payload;
      fs.appendFileSync(path.join(evidenceDirectory, "provider-requests.jsonl"), sanitize({ request, child, model: model.id, tools: definitions, payload: sent }) + "\n", { mode: 0o600 });
      return sent;
    } });
  } };
  const deadline = Date.now() + 330000;
  const wait = async (check: () => boolean | Promise<boolean>) => { while (!await check()) { assert.ok(Date.now() < deadline, `M4 acceptance did not finish during ${phase}`); await delay(50); } };
  const open = async () => p = await openPersonalHarness({ directory, provider, modelId: config.modelId, tools });
  t.after(async () => {
    releaseChild();
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
              for (const entry of entries.items) { fs.appendFileSync(file, sanitize(entry) + "\n"); if (entry.kind === "ruukoto.model-request") metrics.push({ conversation: conversation.id, entry: entry.id, ...estimates(entry.data as RequestEvidence) }); }
              cursor = entries.next;
            } while (cursor);
          }
          conversations = page.next;
        } while (conversations);
        fs.writeFileSync(path.join(evidenceDirectory, "metrics.json"), JSON.stringify(metrics) + "\n", { mode: 0o600 });
      }
      fs.writeFileSync(path.join(evidenceDirectory, "run.json"), sanitize({ phase, requests, scopes, model: `${selected.id}/${selected.model.id}`, sourceSha256: hash(source), expected: { name, bytes: expected.length, sha256: hash(expected) }, pause: "First child provider payload held until an ordinary main progress query completes" }) + "\n", { mode: 0o600 });
      process.stdout.write(JSON.stringify({ evidenceDirectory, phase, requests }) + "\n");
      assert.equal(hash(fs.readFileSync(sourceFile)), hash(source), "The opted-in configuration must remain unchanged");
    } finally { await p?.close(); fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous; }
  });
  isolateSkillHome(t);
  try {
    await open();
    phase = "natural background delegation";
    await p!.answer(`请安排一项独立后台工作：将以下 JSON 字符串所表示的完整 UTF-8 内容覆盖写入已有文件 ${target}，然后把最终文件 ${name} 交付给我。内容必须逐字一致，保留所有换行：${JSON.stringify(content)}。只写这一个文件，只交付这个最终文件，不交付中间产物。成功写入后复用原写入记录交付，不要为了交付再次读取或写入目标。`, "m4-final-file");
    await wait(() => childReady);
    phase = "main progress query while child is held";
    const progress = await p!.answer("刚才要求交付的后台文件工作进展如何？只查询原工作进展，不追加说明、不改变要求、不另建工作，也不重试原操作。", "m4-progress");
    assert.ok(progress.trim(), "Main must answer a progress query while child work waits");
    assert.equal(fs.readFileSync(target, "utf8"), "UNCHANGED");
    releaseChild();
    phase = "original write and final publication";
    await wait(async () => (await p!.harness.commit(tx => personalTimeline(tx, {}), context)).items.some(entry => entry.kind === PersonalReportPublication.kind && entry.outputs?.length));
    const saved = await p!.harness.commit(async tx => {
      const ids = (await tx.doc(PersonalOutputsDoc)).intents;
      assert.equal(ids.length, 1, "Only the requested final file may be registered");
      const intent = await personalOutputIntent(tx, ids[0]);
      const timeline = await personalTimeline(tx, {}), shown = timeline.items.find(entry => entry.outputs?.some(output => output.output === intent.id));
      assert.ok(shown);
      const publication = await tx.entry(PersonalReportPublication, shown.entry as EntryId);
      assert.ok(publication);
      const coverage = await tx.entry(PersonalReportCoverageEntry, publication.data.coverage);
      assert.ok(coverage);
      const metadata = await personalReportOutputs(tx, publication), writes = (await toolOperations(tx)).filter(operation => operation.kind === "write_file");
      const value = { intent, publication, coverage, metadata, writes };
      return JSON.parse(JSON.stringify(value)) as typeof value;
    }, context);
    assert.equal(saved.writes.length, 1); const write = saved.writes[0];
    assert.equal(write.started, true); assert.equal(write.stopped, true); assert.equal(write.effect, "returned"); assert.equal(write.code, "file_returned");
    assert.equal(write.params.path, target); assert.equal(write.params.content, content);
    assert.deepEqual(saved.intent.data.source, { kind: "write_file", operation: write.operation });
    assert.deepEqual(saved.intent.data.origin.work?.ref, write.origin.work?.ref);
    assert.equal(saved.intent.data.instructions.version, 1); assert.equal(saved.intent.model, undefined); assert.equal(saved.publication.model, undefined); assert.equal(saved.coverage.model, undefined);
    assert.deepEqual(saved.coverage.data.coverage.members.flatMap(member => member.outputs ?? []), [saved.intent.id]);
    assert.deepEqual(saved.publication.data.outputs, [saved.intent.id]);
    assert.deepEqual(saved.metadata, [{ v: 1, publication: saved.publication.id, output: saved.intent.id, name, mime: "text/plain; charset=utf-8", bytes: expected.length, sha256: hash(expected), partial: false }]);
    const chunks: Buffer[] = []; let offset: number | undefined = 0;
    do {
      const chunk = personalOutputChunk(directory, saved.publication.id, saved.intent, offset);
      const { offset: receivedOffset, base64, nextOffset, ...metadata } = chunk;
      assert.deepEqual(metadata, saved.metadata[0]); assert.equal(receivedOffset, offset); chunks.push(Buffer.from(base64, "base64")); offset = nextOffset;
    } while (offset !== undefined);
    assert.deepEqual(Buffer.concat(chunks), expected); assert.deepEqual(fs.readFileSync(target), expected);
    assert.ok(scopes.some(scope => scope.child && scope.tools.includes("publish_output")));
    assert.ok(scopes.some(scope => !scope.child)); assert.ok(scopes.filter(scope => !scope.child).every(scope => !scope.tools.includes("publish_output")), "Publication schema belongs only to child model requests");
    const tool = await p!.harness.commit(tx => tx.task(saved.intent.data.tool), context);
    assert.ok(tool?.state.status === "terminal" && tool.state.outcome.status === "completed");
    await p!.harness.waitForTask(saved.publication.data.taskId, context);
    phase = "reopen without business or publication replay";
    await p!.close(); p = undefined;
    const requestsBefore = requests; await open();
    const reopened = await p!.harness.commit(async tx => {
      const value = { intent: await personalOutputIntent(tx, saved.intent.id), publication: await tx.entry(PersonalReportPublication, saved.publication.id), coverage: await tx.entry(PersonalReportCoverageEntry, saved.coverage.id), metadata: await personalReportOutputs(tx, saved.publication), writes: (await toolOperations(tx)).filter(operation => operation.kind === "write_file"), inputs: await tx.submissionByRequest(ROOT_CONVERSATION_ID, "m4-final-file") };
      return JSON.parse(JSON.stringify(value)) as typeof value;
    }, context);
    assert.deepEqual(reopened.intent, saved.intent); assert.deepEqual(reopened.publication, saved.publication); assert.deepEqual(reopened.coverage, saved.coverage); assert.deepEqual(reopened.metadata, saved.metadata); assert.deepEqual(reopened.writes, saved.writes);
    assert.equal(reopened.inputs?.status, "done"); assert.equal(requests, requestsBefore); assert.deepEqual(fs.readFileSync(target), expected);
    phase = "passed";
    const result = { status: "passed", model: `${selected.id}/${selected.model.id}`, requests, writes: 1, intent: saved.intent.id, coverage: saved.coverage.id, ...saved.metadata[0], sourceSha256: hash(source), evidenceDirectory };
    fs.writeFileSync(path.join(evidenceDirectory, "summary.json"), sanitize(result) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) { throw new Error(`M4 model acceptance failed during ${phase}: ${error instanceof Error ? error.message.replaceAll(credential, "[redacted]") : "unknown failure"}`); }
});
