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
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { toolDecide, toolOperations, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalWorkDoc, personalWorkResult } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalDelegationDoc, listPersonalDelegations } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalTimeline } from "../apps/ruukoto/src/personal-history.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PERSONAL_MAIN_TOOL_ROUNDS } from "../apps/ruukoto/src/personal-coordination.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
type Catalog = { providers: Record<string, { api?: string; baseUrl: string; apiKey?: string; headers?: Record<string, string>; models: { id: string; api?: string; contextWindow?: number; maxTokens?: number; input?: string[] }[] }> };

test("Personal real model: status and redisplay preserve a held approval, amendment replaces it in the same child", {
  skip: process.env.RUN_MODEL_CHECK !== "1" ? "Requires explicit real-model opt-in" : false,
  timeout: 360_000,
}, async t => {
  const sourceFile = process.env.RUN_PERSONAL_AMENDMENT_MODELS_FILE;
  assert.ok(sourceFile && path.isAbsolute(sourceFile), "Set an explicit absolute RUN_PERSONAL_AMENDMENT_MODELS_FILE");
  let source: Buffer, catalog: Catalog;
  try { source = fs.readFileSync(sourceFile); catalog = JSON.parse(source.toString("utf8")) as Catalog; }
  catch { throw new Error("The selected models configuration could not be read or parsed; credentials are not printed."); }
  const requested = process.env.RUN_PERSONAL_AMENDMENT_MODEL;
  const candidates = Object.entries(catalog.providers).flatMap(([id, provider]) => provider.models.map(model => ({ id, provider, model })));
  const selected = requested ? candidates.find(value => `${value.id}/${value.model.id}` === requested) : candidates.length === 1 ? candidates[0] : undefined;
  assert.ok(selected, "Choose RUN_PERSONAL_AMENDMENT_MODEL when the explicit file contains several models");
  assert.ok(selected.provider.apiKey && !selected.provider.apiKey.startsWith("!"), "This check accepts a literal credential or an existing environment variable, without credential commands");
  assert.ok(!selected.provider.headers || Object.keys(selected.provider.headers).length === 0, "This check uses the existing API key authentication");
  const credentialName = "PERSONAL_AMENDMENT_ACCEPTANCE_KEY", credential = process.env[selected.provider.apiKey] ?? selected.provider.apiKey;
  const prior = process.env[credentialName]; process.env[credentialName] = credential;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-amend-model-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(outside, { mode: 0o700 });
  const target = path.join(outside, "original.txt"), replacement = path.join(outside, "current.txt");
  const originalContent = `ORIGINAL_${randomUUID()}`, currentContent = `CURRENT_${randomUUID()}`;
  fs.writeFileSync(target, "UNCHANGED", { mode: 0o600 }); fs.writeFileSync(replacement, "UNCHANGED", { mode: 0o600 });
  const identity = fs.statSync(workspace);
  const config = parsePersonalModel({ api: selected.model.api ?? selected.provider.api, baseUrl: selected.provider.baseUrl, modelId: selected.model.id, apiKeyEnv: credentialName, contextWindow: selected.model.contextWindow ?? 128000, maxTokens: Math.min(selected.model.maxTokens ?? 4096, 4096), imageInput: selected.model.input?.includes("image") ?? false });
  const base = personalProvider(config);
  let requests = 0, phase = "startup", p: PersonalHarness | undefined, lastRequest: string | undefined, lastAnswer: string | undefined;
  const provider = { ...base, streamSimple: (...args: Parameters<typeof base.streamSimple>) => { if (++requests > 32) throw new PersonalError("acceptance_request_limit", "Real-model acceptance exceeded its bounded request budget."); return base.streamSimple(...args); } };
  const deadline = Date.now() + 330_000;
  const wait = async (check: () => boolean | Promise<boolean>) => {
    while (!await check()) { assert.ok(Date.now() < deadline, `Real-model acceptance did not finish during ${phase}`); await delay(50); }
  };
  const operations = () => p!.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context);
  const answer = async (input: string, requestId: string) => { lastRequest = requestId; lastAnswer = undefined; return lastAnswer = await p!.answer(input, requestId); };
  const diagnostic = async () => {
    if (!p) return { requests };
    const inputs = await p.harness.commit(async tx => lastRequest ? tx.submissionByRequest(ROOT_CONVERSATION_ID, lastRequest) : undefined, context);
    const groups = await p.harness.commit(tx => listPersonalDelegations(tx), context);
    const work = groups.items[0]?.ref;
    const value = work && (await p.harness.snapshot(PersonalDelegationDoc, String(work.entryId), context))?.delegation;
    const members = [];
    for (const member of value?.members ?? []) {
      const task = await p.harness.getTask(member.taskId, context), result = await p.harness.commit(tx => personalWorkResult(tx, member), context);
      members.push({ work: member.taskId, state: task?.state.status, outcome: task?.state.status === "terminal" ? task.state.outcome.status : undefined, answerPresent: !!result.text, notes: result.notes });
    }
    const entries = await p.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 256), context);
    const calls = entries.items.flatMap(entry => entry.model?.flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [{ tool: part.name, arguments: part.arguments }] : []) : []) ?? []);
    const results = entries.items.flatMap(entry => entry.model?.flatMap(message => message.role === "toolResult" ? [{ tool: message.toolName, isError: message.isError, text: message.content.filter(part => part.type === "text").map(part => part.text).join("") }] : []) ?? []);
    return { requests, input: inputs?.status, answer: lastAnswer, members, calls, results, operations: (await operations()).map(value => ({ operation: value.operation, kind: value.kind, approval: value.approval, effect: value.effect, code: value.code, started: value.started })) };
  };
  const requestEvidence = async () => {
    const page = await p!.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 256), context);
    return page.items.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence);
  };
  const cjk = (code: number) => (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x20000 && code <= 0x2a6df);
  const estimate = (text: string) => Math.ceil(text.length / 4) + Math.ceil([...text].filter(character => cjk(character.codePointAt(0)!)).length * 3 / 4);
  const metrics = (value: RequestEvidence) => {
    const input = value.input as { messages: { role: string }[] };
    return { systemPrompt: estimate(getCurrentSystemPrompt(input.messages)), toolSchemas: estimate(JSON.stringify(getCurrentTools(input.messages).map(({ name, description, parameters }) => ({ name, description, parameters })))) };
  };
  t.after(async () => { await p?.close(); fs.rmSync(root, { recursive: true, force: true }); if (prior === undefined) delete process.env[credentialName]; else process.env[credentialName] = prior; });
  isolateSkillHome(t);
  try {
    p = await openPersonalHarness({ directory, provider, modelId: config.modelId, tools: parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] }) });
    await p.harness.commit(async tx => { const mode = await tx.doc(PersonalPermissionsDoc); mode.mode = "confirm"; mode.version++; }, context);
    phase = "initial delegation";
    await answer(`请在后台把完整文本 ${JSON.stringify(originalContent)} 写入已有文件 ${target}，只写这一个文件，不读取其他文件，也不使用网络、命令或其他能力。写完后报告结果。`, "model-initial");
    assert.ok((await p.harness.commit(tx => listPersonalDelegations(tx), context)).items.length, "The initial owner request must delegate file work");
    let original: PersonalToolOperation | undefined;
    await wait(async () => { original = (await operations()).find(value => value.kind === "write_file" && value.params.path === target); return original?.approval === "pending"; });
    assert.ok(original?.origin.work);
    assert.deepEqual(original.params, { path: target, content: originalContent });
    const ref = original.origin.work.ref;
    phase = "status query";
    const beforeQuery = await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context);
    const status = await answer("刚才那项写入现在进展如何，有没有待我决定的事项？这是状态查询，内容和目标都不变。", "model-status");
    assert.ok(status.trim());
    assert.deepEqual((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))?.notes, beforeQuery?.notes);
    assert.equal((await operations()).find(value => value.operation === original!.operation)?.superseded, undefined);
    phase = "decision redisplay";
    await answer("请重新显示刚才那项写文件的原批准请求，方便我决定；保持同一个决定和参数，不修改要求，不执行。", "model-redisplay");
    const displayed = (await operations()).find(value => value.operation === original!.operation)!;
    assert.ok(displayed.redisplay);
    assert.equal(displayed.approval, "pending"); assert.equal(displayed.started, false);
    phase = "amendment";
    await answer(`修改刚才那项工作的要求：不要写原文件，改把完整文本 ${JSON.stringify(currentContent)} 写入已有文件 ${replacement}。只执行更新后的这一次写入，完成后报告。`, "model-amendment");
    assert.ok((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))?.notes?.some(note => note.source.kind === "input" && note.source.requestId === "model-amendment"), "The model must append the amended requirements to the original work before waiting for a new operation");
    let current: PersonalToolOperation | undefined;
    await wait(async () => { current = (await operations()).find(value => value.operation !== original!.operation && value.kind === "write_file" && value.params.path === replacement); return current?.approval === "pending"; });
    assert.ok(current?.origin.work);
    const stale = (await operations()).find(value => value.operation === original!.operation)!;
    assert.equal(stale.effect, "not_executed"); assert.equal(stale.started, false); assert.equal(stale.code, "tool_requirements_changed");
    assert.equal(current.origin.work.ref.agentId, ref.agentId); assert.equal(current.origin.work.ref.taskId, ref.taskId);
    assert.deepEqual(current.params, { path: replacement, content: currentContent });
    assert.ok(current.instructions?.snapshot.notes.length);
    await assert.rejects(p.harness.commit(tx => toolDecide(tx, original!.operation, "approved", directory), context), error => error instanceof PersonalError && error.code === "tool_decision_invalid");
    phase = "one approved write and publication";
    await p.harness.commit(tx => toolDecide(tx, current!.operation, "approved", directory), context);
    await p.harness.waitForTask(ref.taskId, context);
    const group = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
    await wait(async () => { const report = (await p!.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))?.delegation?.report; return report?.version === 2 && report.publication !== undefined; });
    const timeline = await p.harness.commit(tx => personalTimeline(tx, {}), context);
    const published = timeline.items.filter(entry => entry.kind === "ruukoto.report-publication");
    assert.equal(published.length, 1); assert.ok(published[0].text.includes(currentContent) || published[0].text.includes("current.txt"));
    assert.equal(fs.readFileSync(target, "utf8"), "UNCHANGED"); assert.equal(fs.readFileSync(replacement, "utf8"), currentContent);
    assert.equal((await operations()).filter(value => value.kind === "write_file" && value.started).length, 1);
    const childEntries = await p.harness.commit(tx => tx.scanEntries({ conversationId: ref.agentId, order: "ascending" }, 256), context);
    const childEvidence = childEntries.items.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence);
    const freshRequest = childEvidence.find(value => value.references?.instructions?.notes.some(note => current!.instructions!.snapshot.notes.some(captured => captured.admission === note.admission)));
    assert.ok(freshRequest && JSON.stringify(freshRequest.input).includes(currentContent));
    phase = "four-round canonical query";
    const auditRequest = "model-four-round-audit", beforeAudit = await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context);
    const audit = await answer(`请审核刚才已完成的写入。按下面顺序分别执行四个工具批次，每批只调用一次 background_work，读取上一批结果后再进行下一批：1. delegations，找到刚才写入所属委托；2. progress，使用第1批返回的 delegation；3. result，使用第2批返回的 work；4. operation，使用第3批工具事实中的 operation。只查询已有记录，不调用 append、delegate、report、redisplay 或任何外部操作，不改要求。四批结束后根据第4批的原操作事实只返回 JSON 对象 {"path":实际目标路径,"content":完整写入文本,"started":是否开始执行,"effect":实际效果}，不要凭回忆回答。`, auditRequest);
    const auditInput = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, auditRequest), context);
    assert.ok(auditInput?.entry && auditInput.type === "input" && auditInput.status === "done");
    const auditEntries = (await p.main.entries({ minEntryId: auditInput.entry, maxEntryId: auditInput.answer, order: "ascending" }, 256, undefined, context)).items;
    const auditBatches = auditEntries.filter(entry => entry.kind === "pi.assistant" && entry.model?.some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall")));
    assert.equal(auditBatches.length, PERSONAL_MAIN_TOOL_ROUNDS);
    const auditCalls = auditBatches.flatMap(entry => entry.model!.flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part] : []) : []));
    assert.equal(auditCalls.length, PERSONAL_MAIN_TOOL_ROUNDS);
    assert.ok(auditCalls.every(call => call.name === "background_work"));
    assert.deepEqual(auditCalls.map(call => call.arguments.action), ["delegations", "progress", "result", "operation"]);
    assert.equal(auditCalls[1].arguments.delegation, group.entryId); assert.equal(auditCalls[2].arguments.work, ref.taskId); assert.equal(auditCalls[3].arguments.operation, current.operation);
    const auditEvidence = auditEntries.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence);
    const auditRequests = auditEvidence.filter(value => value.payload === undefined);
    assert.equal(auditRequests.length, PERSONAL_MAIN_TOOL_ROUNDS + 1);
    const finalRequest = auditRequests.at(-1)!, input = finalRequest.input as { messages: { role: string }[] };
    assert.deepEqual(getCurrentTools(input.messages), []);
    const finalPayload = auditEvidence.find(value => value.requestId === finalRequest.requestId && value.payload !== undefined)?.payload as { tools?: unknown[] } | undefined;
    assert.ok(finalPayload); assert.deepEqual(finalPayload.tools ?? [], []);
    assert.deepEqual(JSON.parse(audit.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")), { path: replacement, content: currentContent, started: true, effect: "returned" });
    assert.deepEqual((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))?.notes, beforeAudit?.notes);
    assert.equal((await operations()).filter(value => value.kind === "write_file" && value.started).length, 1);
    phase = "terminal continuation";
    const terminal = await p.harness.getTask(ref.taskId, context);
    await answer("追加一个新的要求，继续刚才那项工作：请交给刚才负责写入的后台助手，基于已完成的结果列出两点后续建议，再报告给我。不要由主助手直接回答，不再读写文件、不使用任何外部操作，只处理这项新要求。", "model-continuation");
    assert.ok((await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.members.some(member => member.taskId !== ref.taskId), "The new background requirement must explicitly continue the original work");
    let continued: typeof ref | undefined;
    await wait(async () => { const value = (await p!.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!; continued = value.members.find(member => member.taskId !== ref.taskId); return continued !== undefined; });
    assert.ok(continued); assert.equal(continued.agentId, ref.agentId);
    assert.deepEqual((await p.harness.snapshot(PersonalWorkDoc, continued.requestId, context))?.continuation?.predecessor, ref);
    await p.harness.waitForTask(continued.taskId, context);
    assert.deepEqual(await p.harness.getTask(ref.taskId, context), terminal);
    const currentReport = (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.report!;
    await p.harness.waitForTask(currentReport.taskId, context);
    assert.equal((await operations()).filter(value => value.kind === "write_file" && value.started).length, 1);
    phase = "mixed arrangement and query";
    const mixedRequest = "model-mixed-query", beforeMixed = await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context);
    const mixed = await answer(`请在同一个工具批次做两件事：用 background_work 的 delegate 新建一项独立后台工作，只为刚才的文字整理列出两点编辑建议，不读写文件或使用任何外部能力；同时用 background_work 的 operation 查询刚才实际执行的 current.txt 写入操作。只发这一批两次调用，成功后不再调用工具，主助手根据原操作查询事实只返回 JSON 对象 {"content":完整写入文本,"effect":实际效果}，不附带登记说明或其他文字。后台建议另外汇报，保持已有写入要求不变，不使用 append。`, mixedRequest);
    const mixedInput = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, mixedRequest), context);
    assert.ok(mixedInput?.entry && mixedInput.type === "input" && mixedInput.status === "done");
    const mixedEntries = (await p.main.entries({ minEntryId: mixedInput.entry, maxEntryId: mixedInput.answer, order: "ascending" }, 256, undefined, context)).items;
    const mixedBatches = mixedEntries.filter(entry => entry.kind === "pi.assistant" && entry.model?.some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall")));
    assert.equal(mixedBatches.length, 1);
    const mixedCalls = mixedBatches[0].model?.flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part] : []) : []) ?? [];
    assert.equal(mixedCalls.length, 2); assert.ok(mixedCalls.every(call => call.name === "background_work"));
    assert.deepEqual(mixedCalls.map(call => call.arguments.action).sort(), ["delegate", "operation"]);
    assert.equal(mixedCalls.find(call => call.arguments.action === "operation")!.arguments.operation, current.operation);
    const mixedResults = mixedEntries.flatMap(entry => entry.model?.filter(message => message.role === "toolResult") ?? []);
    for (const call of mixedCalls) assert.equal(mixedResults.find(result => result.toolCallId === call.id)?.isError, false, "Both original mixed calls must succeed");
    assert.deepEqual(JSON.parse(mixed.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")), { content: currentContent, effect: "returned" });
    assert.deepEqual((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))?.notes, beforeMixed?.notes);
    const mixedGroup = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items.find(item => item.ref.entryId === mixedInput.entry)!;
    assert.ok(mixedGroup);
    const mixedWork = (await p.harness.snapshot(PersonalDelegationDoc, String(mixedGroup.ref.entryId), context))!.delegation!.members[0];
    await p.harness.waitForTask(mixedWork.taskId, context);
    const mixedReport = (await p.harness.snapshot(PersonalDelegationDoc, String(mixedGroup.ref.entryId), context))!.delegation!.report!;
    await p.harness.waitForTask(mixedReport.taskId, context);
    assert.ok(!(await operations()).some(value => value.origin.work?.ref.taskId === mixedWork.taskId));
    assert.equal((await operations()).filter(value => value.kind === "write_file" && value.started).length, 1);
    const evidence = await requestEvidence();
    assert.ok(evidence.every(value => !JSON.stringify(value).includes(credential)));
    const firstOwner = evidence.find(value => value.references?.conversationId === ROOT_CONVERSATION_ID)!;
    const lastOwner = evidence.findLast(value => value.references?.conversationId === ROOT_CONVERSATION_ID)!;
    process.stdout.write(JSON.stringify({ status: "passed", node: process.version, platform: process.platform, model: `${selected.id}/${selected.model.id}`, sourceSha256: createHash("sha256").update(source).digest("hex"), requests, work: ref.taskId, operation: current.operation, publication: published[0].entry as EntryId, continuation: continued.taskId, fourRoundAudit: true, mixedQuery: true, estimates: { firstOwner: metrics(firstOwner), lastOwner: metrics(lastOwner), child: metrics(freshRequest) } }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: "failed", phase, reason: error instanceof Error ? error.message.replaceAll(credential, "[redacted]") : "Acceptance failed", diagnostics: await diagnostic() }) + "\n");
    throw new Error(`Personal real-model acceptance failed during ${phase}; private model configuration is not printed.`);
  } finally {
    if (p) try {
      const evidenceDirectory = fs.mkdtempSync(path.join(tmpdir(), "ruukoto-personal-model-evidence-")), file = path.join(evidenceDirectory, "entries.jsonl");
      fs.writeFileSync(file, "", { mode: 0o600 });
      let conversationCursor: Cursor | undefined;
      do {
        const conversations = await p.harness.commit(tx => tx.scanConversations({}, 256, conversationCursor), context);
        for (const conversation of conversations.items) {
          let cursor: Cursor | undefined;
          do {
            const page = await p.harness.commit(tx => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, cursor), context);
            if (page.items.length) fs.appendFileSync(file, page.items.map(entry => JSON.stringify(entry).replaceAll(credential, "[redacted]")).join("\n") + "\n");
            cursor = page.next;
          } while (cursor);
        }
        conversationCursor = conversations.next;
      } while (conversationCursor);
      process.stdout.write(JSON.stringify({ evidenceDirectory, phase, requests }) + "\n");
    } catch (error) {
      // Supplemental evidence must not replace the acceptance failure it is diagnosing.
      process.stderr.write(`[ruukoto:personal-model-evidence] Capture unavailable: ${error instanceof Error ? error.message.replaceAll(credential, "[redacted]") : "unknown capture failure"}.\n`);
    }
  }
});
