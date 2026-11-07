import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";
import type { PersonalDesktopAttachment } from "@ruukoto/view/personal-protocol.ts";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import type { RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { loadPersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { nativeMetadata, personalAttachmentGrant, personalAttachmentReference } from "../apps/ruukoto/src/personal-media.ts";
import { PersonalWorkDoc, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { personalArtifactEntries } from "../apps/ruukoto/src/personal-tools.ts";
import { answerPersonalQuestion, personalQuestionList } from "../apps/ruukoto/src/personal-questions.ts";
import { personalTimeline, readPersonalHistory, searchPersonalHistory } from "../apps/ruukoto/src/personal-history.ts";
import { personalOutputIntent, PersonalOutputsDoc, personalOutputChunk } from "../apps/ruukoto/src/personal-outputs.ts";
import { parsePersonalInput } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import { personalAttachments } from "../apps/ruukoto/src/personal-media.ts";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionFailed } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const binary = fs.readFileSync(new URL("./fixtures/personal-attachments/binary.bin", import.meta.url));
const png = fs.readFileSync(new URL("./fixtures/personal-attachments/image.png", import.meta.url));
function text(request: RecordedRequest) { const content = request.messages.findLast(message => message.role === "user")?.content; return typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : ""; }
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent") === true;
const call = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ id: randomUUID(), name, arguments: args }] });
async function until(check: () => Promise<boolean>) { const end = Date.now() + 15_000; while (!await check()) { assert.ok(Date.now() < end, "Attachment fixture did not reach the required state"); await delay(10); } }

async function fixture(t: TestContext, options: { imageInput?: boolean; openStorage?: Parameters<typeof openPersonalHarness>[0]["openStorage"]; beforePayload?: (input: Parameters<ReturnType<typeof personalProvider>["streamSimple"]>[1]) => Promise<void>; handler?: Responder } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-attachments-")), directory = path.join(root, "profile"), env = "RK_ATTACHMENT_TEST_KEY", previous = process.env[env];
  process.env[env] = "test-only";
  const model = new PersonalMockModelServer(options.handler ?? (() => ({ kind: "text", text: "附件已接纳，请说明用途。" })));
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: env, contextWindow: 128000, maxTokens: 4096, imageInput: options.imageInput ?? false };
  isolateSkillHome(t);
  const base = personalProvider(config);
  const provider = options.beforePayload ? { ...base, streamSimple: (model: Parameters<typeof base.streamSimple>[0], input: Parameters<typeof base.streamSimple>[1], selected?: Parameters<typeof base.streamSimple>[2]) => base.streamSimple(model, input, { ...selected, onPayload: async (payload, model) => { await options.beforePayload!(input); return await selected?.onPayload?.(payload, model) ?? payload; } }) } : base;
  let p = await openPersonalHarness({ directory, provider, modelId: config.modelId, openStorage: options.openStorage });
  t.after(async () => { await p.close(); await model.close(); if (previous === undefined) delete process.env[env]; else process.env[env] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const upload = async (bytes: Buffer, name = "input.bin", mime = "application/octet-stream"): Promise<PersonalDesktopAttachment> => {
    const ref = { id: randomUUID(), name, size: bytes.length, mime, sha256: hash(bytes) };
    let offset = 0;
    do { const chunk = bytes.subarray(offset, offset + 65536), result = await p.media.upload({ v: 1, attachmentId: ref.id, name, mime, totalBytes: ref.size, sha256: ref.sha256, offset, base64: chunk.toString("base64") }); assert.equal(result.nextOffset, offset + chunk.length); offset = result.nextOffset; } while (offset < bytes.length);
    return ref;
  };
  return { directory, model, upload, get p() { return p; }, async reopen() { await p.close(); p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId }); } };
}

test("Native files: complete binary and empty file, attachment-only display, original request replay and restart retain bytes", async t => {
  const f = await fixture(t), refs = [await f.upload(binary, "original.bin"), await f.upload(Buffer.alloc(0), "empty.bin")], requestId = randomUUID();
  const submitted = await f.p.submit("", requestId, refs); await submitted.wait(context);
  const message = await f.p.media.message(requestId); assert.ok(message); assert.equal(message.state, "bound"); assert.deepEqual(nativeMetadata(message), refs);
  assert.deepEqual(loadPersonalArtifact(f.directory, message.artifacts[0]), binary); assert.equal(message.artifacts[1].bytes, 0);
  const shown = (await f.p.harness.commit(tx => personalTimeline(tx, {}), context)).items.find(entry => entry.input?.requestId === requestId);
  assert.equal(shown?.text, ""); assert.deepEqual(shown?.attachments, refs); assert.equal(f.model.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.model.calls[0].raw), /image_url/); assert.match(JSON.stringify(f.model.calls[0].raw), /没有明确用途时询问拥有者/);
  assert.equal((await f.p.submit("", requestId, refs)).id, submitted.id); assert.equal(f.model.calls.length, 1);
  await assert.rejects(f.p.submit("changed", requestId, refs), error => error instanceof PersonalError && error.code === "media_input_conflict");
  await f.reopen(); assert.equal(f.model.calls.length, 1); assert.deepEqual(await f.p.media.message(requestId), message);
  await assert.rejects(f.p.submit("another input", randomUUID(), refs), error => error instanceof PersonalError && error.code === "attachment_bound");
});

test("Native admission: one incomplete member fences text, four and 8 MiB boundaries are exact, and legacy route rejects attachments", async t => {
  const f = await fixture(t), full = await f.upload(binary), absent = { ...full, id: randomUUID() }, key = randomUUID();
  await assert.rejects(f.p.submit("DO_NOT_EXECUTE", key, [full, absent]), error => error instanceof PersonalError && error.code === "attachment_incomplete");
  assert.equal(f.model.calls.length, 0); assert.equal(await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context), undefined);
  assert.throws(() => parsePersonalInput({ requestId: key, input: "DO_NOT_EXECUTE", attachments: [full] }), error => error instanceof PersonalError && error.code === "input_invalid");
  assert.deepEqual(parsePersonalInput({ requestId: key, input: "", attachments: [full] }, true).attachments, [full]);
  const limit = await f.upload(Buffer.alloc(8 * 1024 * 1024, 0xa5), "limit.bin"), refs = [full, limit, await f.upload(Buffer.alloc(0), "third.bin"), await f.upload(Buffer.from("fourth"), "fourth.txt", "text/plain")];
  await (await f.p.submit("Boundaries", key, refs)).wait(context); assert.equal(f.model.calls.length, 1);
  const saved = (await f.p.media.message(key))!; assert.equal(saved.artifacts[1].bytes, 8 * 1024 * 1024); assert.equal(saved.artifacts[1].partial, false);
  await assert.rejects(f.p.media.stageNative(randomUUID(), "DO_NOT_EXECUTE", [...refs, absent]));
  await assert.rejects(f.p.media.upload({ v: 1, attachmentId: randomUUID(), name: "large.bin", mime: "application/octet-stream", totalBytes: 8 * 1024 * 1024 + 1, sha256: hash(binary), offset: 0, base64: "" }));
});

test("Native uploads: interrupted chunk and finalized response loss recover exact original reference, conflicts and corrupt bytes reject", async t => {
  const f = await fixture(t), bytes = Buffer.alloc(130000, 0x91), ref = { id: randomUUID(), name: "resume.bin", size: bytes.length, mime: "application/octet-stream", sha256: hash(bytes) };
  const input = { v: 1 as const, attachmentId: ref.id, name: ref.name, mime: ref.mime, totalBytes: ref.size, sha256: ref.sha256, offset: 0, base64: bytes.subarray(0, 65536).toString("base64") };
  const first = await f.p.media.upload(input); assert.equal(first.complete, false);
  await f.reopen(); assert.deepEqual(await f.p.media.upload(input), first);
  await assert.rejects(f.p.media.upload({ ...input, name: "substitution.bin" }), error => error instanceof PersonalError && error.code === "attachment_conflict");
  await assert.rejects(f.p.media.upload({ ...input, base64: Buffer.alloc(65536, 0x90).toString("base64") }), error => error instanceof PersonalError && error.code === "attachment_conflict");
  const last = { ...input, offset: 65536, base64: bytes.subarray(65536).toString("base64") };
  const result = await f.p.media.upload(last); assert.equal(result.complete, true);
  await f.reopen(); assert.deepEqual(await f.p.media.upload(last), result);
  const key = randomUUID(); await (await f.p.submit("return this", key, [ref])).wait(context);
  assert.deepEqual(loadPersonalArtifact(f.directory, (await f.p.media.message(key))!.artifacts[0]), bytes);
  const corrupt = { ...input, attachmentId: randomUUID(), totalBytes: 3, sha256: "0".repeat(64), base64: Buffer.from("bad").toString("base64") };
  await assert.rejects(f.p.media.upload(corrupt), error => error instanceof PersonalError && error.code === "attachment_hash");
});

test("Download reception: incomplete file or image and a failed member never admit text, ordinary files need no vision", async t => {
  const f = await fixture(t), source = { platform: "telegram" as const, accountId: "bot", ownerId: "owner", generation: "generation" };
  const stage = (key: string, media: Parameters<typeof f.p.media.stage>[0]["media"]) => f.p.media.stage({ key, source, body: "DO_NOT_EXECUTE", media });
  const file = { identity: "file", kind: "file" as const, name: "input.csv", declaredMime: "text/csv", sizeBytes: binary.length, download: async () => new Response(binary) };
  assert.equal((await stage("file-ready", [file])).state, "ready");
  assert.equal((await stage("file-incomplete", [{ ...file, sizeBytes: binary.length + 1 }])).reason, "download_incomplete");
  assert.equal((await stage("header-incomplete", [{ ...file, sizeBytes: undefined, download: async () => new Response(binary, { headers: { "content-length": String(binary.length + 1) } }) }])).reason, "download_incomplete");
  assert.equal((await stage("failed-member", [file, { ...file, identity: "failed", download: async () => new Response("failed", { status: 404 }) }])).state, "rejected");
  assert.equal((await f.p.media.message("failed-member"))!.artifacts.length, 1); assert.equal(f.model.calls.length, 0);
  assert.equal((await stage("wrong-name", [{ ...file, name: "../secret" }])).reason, "attachment_invalid");
  assert.equal((await stage("five", Array.from({ length: 5 }, (_, index) => ({ ...file, identity: String(index) })))).reason, "too_many_files");
  const image = { identity: "image", kind: "image" as const, name: "image.png", declaredMime: "image/png", sizeBytes: png.length, download: async () => new Response(png) };
  assert.equal((await stage("mixed-no-vision", [file, image])).reason, "image_input_unsupported");
});

test("Empty download reception: null bodies still require valid MIME and exact HTTP length", async t => {
  const f = await fixture(t), source = { platform: "telegram" as const, accountId: "bot", ownerId: "owner", generation: "generation" };
  for (const { length, mime, reason } of [{ length: undefined, mime: "application/octet-stream", reason: undefined }, { length: "0", mime: "application/octet-stream", reason: undefined }, { length: "1", mime: "application/octet-stream", reason: "download_incomplete" }, { length: "bad", mime: "application/octet-stream", reason: "download_incomplete" }, { length: "0", mime: "invalid", reason: "mime_unsupported" }]) {
    const key = randomUUID(), headers = { "content-type": mime, ...(length === undefined ? {} : { "content-length": length }) };
    const message = await f.p.media.stage({ key, source, body: "DO_NOT_EXECUTE", media: [{ identity: key, kind: "file", name: "empty.bin", sizeBytes: 0, download: async () => new Response(null, { status: 204, headers }) }] });
    assert.equal(message.state, reason ? "rejected" : "ready"); assert.equal(message.reason, reason);
    if (reason) assert.deepEqual(message.artifacts, []); else assert.deepEqual(loadPersonalArtifact(f.directory, message.artifacts[0]), Buffer.alloc(0));
    assert.equal(await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context), undefined);
  }
  assert.equal(f.model.calls.length, 0);
});

test("Granted images: current work sees verified vision bytes and a reused child receives no earlier unassigned image", { timeout: 60000 }, async t => {
  let artifact = "", reused: PersonalWorkRef | undefined;
  const f = await fixture(t, { imageInput: true, handler: request => {
    if (child(request)) return { kind: "text", text: "Image inspected." };
    if (text(request).startsWith("宿主委托汇总参考")) return { kind: "text", text: "The work is complete." };
    if (text(request).includes("FIRST_VISION")) return call("background_work", { action: "delegate", content: "Inspect selected original", attachments: [artifact] });
    if (text(request).includes("SECOND_NO_IMAGE")) return call("background_work", { action: "delegate", content: "New work without images", agent: reused!.agentId });
    return { kind: "text", text: "Please specify the image task." };
  } });
  const upload = await f.upload(png, "original.png", "image/png"), owner = randomUUID(); await (await f.p.submit("", owner, [upload])).wait(context);
  artifact = (await f.p.media.message(owner))!.artifacts[0].id;
  await f.p.answer("FIRST_VISION", "first-vision");
  await until(async () => f.model.calls.some(request => child(request)));
  const works = await f.p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 64), context);
  const input = works.items[0].input; assert.ok(input && typeof input === "object" && !Array.isArray(input) && typeof input.requestId === "string");
  reused = (await f.p.harness.snapshot(PersonalWorkDoc, input.requestId, context))!.ref!; await f.p.harness.waitForTask(reused.taskId, context);
  assert.match(JSON.stringify(f.model.calls.find(child)!.raw), new RegExp(png.toString("base64")));
  await f.p.answer("SECOND_NO_IMAGE", "second-no-image");
  await until(async () => f.model.calls.filter(child).length === 2);
  assert.doesNotMatch(JSON.stringify(f.model.calls.filter(child)[1].raw), new RegExp(png.toString("base64")));
  assert.match(JSON.stringify(f.model.calls.filter(child)[1].raw), /未分配给当前工作/);
});

test("Attachment format marker: the previous executable refuses the profile before any provider request", async t => {
  const f = await fixture(t), ref = await f.upload(binary), key = randomUUID(); await (await f.p.submit("", key, [ref])).wait(context); await f.p.close();
  const baseline = fs.readFileSync(new URL("../apps/ruukoto/src/personal-harness.ts", import.meta.url), "utf8").replace("registry.install(personalAttachments);", "");
  const filename = path.join(path.dirname(new URL("../apps/ruukoto/src/personal-harness.ts", import.meta.url).pathname), `.attachment-marker-${randomUUID()}.ts`);
  fs.writeFileSync(filename, baseline, { mode: 0o600 });
  try {
    const script = `import {openPersonalHarness} from ${JSON.stringify(filename)};import {PersonalMockModelServer} from ${JSON.stringify(new URL("./helpers/mock-provider.ts", import.meta.url).pathname)};import {personalProvider} from ${JSON.stringify(new URL("../apps/ruukoto/src/personal-model.ts", import.meta.url).pathname)};const server=new PersonalMockModelServer(()=>({kind:"text",text:"unexpected"}));const url=await server.start();try{await openPersonalHarness({directory:${JSON.stringify(f.directory)},provider:personalProvider({api:"openai-completions",baseUrl:url,modelId:"mock-model",apiKeyEnv:"RK_ATTACHMENT_TEST_KEY",contextWindow:128000,maxTokens:4096}),modelId:"mock-model"});process.exitCode=2;}catch(error){process.stdout.write(error.code+"\\n");}finally{await server.close();}`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 60000, env: { ...process.env } });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /extension_missing/);
  } finally { fs.unlinkSync(filename); }
  assert.equal(f.model.calls.length, 1); assert.equal(personalAttachments.name, "personal-attachments");
});

test("Native response loss: committed submission and attachments recover under the original request without text-only replay", async t => {
  let armed = false;
  const cause = new Error("submission-response-lost"), f = await fixture(t, { openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, ctx) => { const result = await commit(writes, ctx); if (armed && writes.some(write => write.type === "submission")) { armed = false; throw cause; } return result; };
    return storage;
  } });
  const ref = await f.upload(binary), key = randomUUID(); armed = true;
  await assert.rejects(f.p.submit("Original request", key, [ref]), error => error === cause || error instanceof SessionFailed);
  try { await f.reopen(); } catch (error) { if (!(error instanceof SessionFailed)) throw error; await f.reopen(); }
  const recovered = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context); assert.ok(recovered);
  const submitted = await f.p.submit("Original request", key, [ref]); assert.equal(submitted.id, recovered.id); await submitted.wait(context);
  assert.equal(f.model.calls.length, 1); assert.equal((await f.p.media.message(key))!.submissionId, recovered.id);
  assert.deepEqual(loadPersonalArtifact(f.directory, (await f.p.media.message(key))!.artifacts[0]), binary);
});

test("Native source integrity: changing an admitted file descriptor or removing it rejects before another provider request", async t => {
  const f = await fixture(t), ref = await f.upload(binary), key = randomUUID(); await (await f.p.submit("Original body", key, [ref])).wait(context);
  const original = await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context); assert.ok(original?.entry);
  await f.p.close();
  const database = path.join(f.directory, "personal.sqlite"), baseline = fs.readFileSync(database), calls = f.model.calls.length;
  for (const mutation of ["drop", "replace"] as const) {
    fs.writeFileSync(database, baseline);
    const db = new DatabaseSync(database), row = db.prepare("SELECT record FROM entries WHERE id = ?").get(original.entry) as { record: string };
    const entry = JSON.parse(row.record) as { model: { content: { type: string; text?: string }[] }[] };
    if (mutation === "drop") entry.model[0].content.pop();
    else entry.model[0].content[2] = { type: "text", text: "Altered attachment descriptor" };
    db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(entry), original.entry); db.close();
    await assert.rejects(f.reopen(), error => error instanceof PersonalError && ["input_permission_invalid", "input_display_invalid", "image_reference_invalid"].includes(error.code)); assert.equal(f.model.calls.length, calls);
  }
  fs.writeFileSync(database, baseline); await f.reopen();
});

test("Native ready attachment recovery keeps the original retry valid before local admission", async t => {
  const f = await fixture(t), selected = await f.upload(binary), key = randomUUID(), body = "Original attachment body";
  const staged = await f.p.media.stageNative(key, body, [selected]); assert.equal(staged.state, "ready");
  await f.reopen(); await f.reopen(); assert.equal(f.model.calls.length, 0);
  assert.equal(await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context), undefined);
  const submitted = await f.p.submit(body, key, [selected]); await submitted.wait(context);
  assert.equal(f.model.calls.length, 1); assert.equal((await f.p.media.message(key))!.submissionId, submitted.id);
  assert.deepEqual(loadPersonalArtifact(f.directory, staged.artifacts[0]), binary);
  assert.equal((await f.p.submit(body, key, [selected])).id, submitted.id); assert.equal(f.model.calls.length, 1);
});

test("Ready attachment input verifies all original bytes immediately before admission", async t => {
  const f = await fixture(t), selected = [await f.upload(binary), await f.upload(Buffer.alloc(0), "empty.bin")], key = randomUUID(), body = "Do not admit incomplete originals";
  const staged = await f.p.media.stageNative(key, body, selected), filename = path.join(f.directory, "artifacts", `${staged.artifacts[0].id}.bin`), retained = `${filename}.retained`;
  for (const mutation of ["missing", "corrupt"] as const) {
    if (mutation === "missing") fs.renameSync(filename, retained); else fs.writeFileSync(filename, Buffer.alloc(binary.length));
    try {
      await assert.rejects(f.p.media.input(key), error => error instanceof PersonalError && error.code === "artifact_unavailable");
      assert.equal(f.model.calls.length, 0); assert.equal(await f.p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context), undefined);
    } finally { if (mutation === "missing") fs.renameSync(retained, filename); else fs.writeFileSync(filename, binary); }
  }
  const submitted = await f.p.submit(body, key, selected); await submitted.wait(context); assert.equal(f.model.calls.length, 1);
  assert.deepEqual(loadPersonalArtifact(f.directory, staged.artifacts[0]), binary);
});

test("Attachment clarification: an actual Main question answer delegates the original file with its same authority", { timeout: 30000 }, async t => {
  let artifact = "";
  const f = await fixture(t, { handler: request => {
    const last = request.messages.at(-1);
    if (child(request)) return last?.role === "user" ? call("read_artifact", { artifact }) : { kind: "text", text: "The clarified original was read." };
    if (last?.role === "user" && text(request).includes("拥有者对原问题的回答")) return call("background_work", { action: "delegate", content: "Read the original after clarification", attachments: [artifact] });
    if (last?.role === "user" && text(request).includes("artifact=")) return call("ask_user", { questions: [{ question: "How should this original be used?" }] });
    return { kind: "text", text: "The task is recorded." };
  } });
  const selected = await f.upload(binary), key = randomUUID(); await (await f.p.submit("", key, [selected])).wait(context);
  artifact = (await f.p.media.message(key))!.artifacts[0].id;
  const question = (await f.p.harness.commit(tx => personalQuestionList(tx), context)).items[0]; assert.equal(question.status, "pending");
  const answer = await f.p.harness.commit(tx => answerPersonalQuestion(tx, { question: question.id, version: question.version, requestId: randomUUID(), answers: [{ text: "Read the complete original" }] }, { kind: "local" }), context);
  f.p.harness.resume(); await f.p.harness.waitForTask(answer.taskId!, context);
  const tasks = await f.p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 64), context), input = tasks.items[0]?.input;
  assert.ok(input && typeof input === "object" && !Array.isArray(input) && typeof input.requestId === "string");
  const work = (await f.p.harness.snapshot(PersonalWorkDoc, input.requestId, context))!; await f.p.harness.waitForTask(work.ref!.taskId, context);
  assert.equal(work.source!.requestId, `personal-question:${answer.taskId}`); assert.deepEqual(work.permission, { mode: "auto-review", version: 1 });
  const read = f.model.calls.filter(child).find(request => request.messages.at(-1)?.role === "tool")!;
  const result = JSON.parse(String(read.messages.at(-1)!.content)) as { base64: string; attachmentWork: PersonalWorkRef };
  assert.deepEqual(Buffer.from(result.base64, "base64"), binary); assert.deepEqual(result.attachmentWork, work.ref);
  const grant = await f.p.harness.commit(tx => personalAttachmentGrant(tx, work.attachments!), context); assert.equal(grant.attachments[0].requestId, key);
  await f.reopen(); assert.deepEqual((await f.p.harness.snapshot(PersonalWorkDoc, input.requestId, context))!.permission, work.permission);
});

test("Original file delivery: Main sees the direct publication route and a child returns unchanged bytes without reading", { timeout: 30000 }, async t => {
  let artifact = "";
  const f = await fixture(t, { handler: request => {
    const last = request.messages.at(-1);
    if (child(request)) return last?.role === "user" ? call("publish_output", { name: "returned.bin", artifact }) : { kind: "text", text: "The original file is registered for delivery." };
    if (last?.role === "user" && text(request) === "Return the original file as returned.bin") return call("background_work", { action: "delegate", content: "Deliver the unchanged assigned original as returned.bin using publish_output", attachments: [artifact] });
    return { kind: "text", text: "Please specify the intended use." };
  } });
  const selected = await f.upload(binary), key = randomUUID(); await (await f.p.submit("", key, [selected])).wait(context); artifact = (await f.p.media.message(key))!.artifacts[0].id;
  await f.p.answer("Return the original file as returned.bin", "return-original-file");
  await until(async () => (await f.p.harness.commit(tx => personalTimeline(tx, {}), context)).items.some(entry => entry.outputs?.length));
  const request = f.model.calls.find(call => !child(call) && call.messages.at(-1)?.role === "user" && text(call).includes("Return the original file as returned.bin")); assert.ok(request);
  const tool = request.tools!.find(tool => (tool.function as { name: string }).name === "background_work")!;
  const definition = tool.function as { parameters: { properties: { attachments: { description: string } } } };
  const output = await f.p.harness.commit(async tx => personalOutputIntent(tx, (await tx.doc(PersonalOutputsDoc)).intents[0]), context);
  assert.equal(output.data.artifact.id, artifact); assert.deepEqual(Buffer.from(personalOutputChunk(f.directory, output.id, output, 0).base64, "base64"), binary);
  assert.equal(f.model.calls.filter(child).some(call => call.messages.some(message => message.role === "tool" && String(message.content).includes('"base64"'))), false);
  const work = (await f.p.harness.snapshot(PersonalWorkDoc, output.data.origin.work!.ref.requestId, context))!;
  await f.p.harness.waitForTask(work.ref!.taskId, context); assert.deepEqual(work.permission, { mode: "auto-review", version: 1 });
  const evidence = await f.p.harness.commit(async tx => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256)).items.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence).find(value => JSON.stringify(value.payload) === JSON.stringify(request.raw)), context);
  assert.ok(evidence); assert.deepEqual(evidence.payload, request.raw);
  if (process.env.RUUKOTO_ATTACHMENT_GUIDANCE_EVIDENCE) fs.writeFileSync(process.env.RUUKOTO_ATTACHMENT_GUIDANCE_EVIDENCE, JSON.stringify({ request: request.raw, evidence, childRequests: f.model.calls.filter(child).map(call => call.raw), work, output }, null, 2) + "\n", { mode: 0o600 });
  assert.match(definition.parameters.properties.attachments.description, /publish_output/); assert.match(definition.parameters.properties.attachments.description, /原样交付/); assert.match(definition.parameters.properties.attachments.description, /base64/);
});

test("Native attachment recovery retains queued and withdrawn files or images before user placement", { timeout: 60000 }, async t => {
  for (const image of [false, true]) for (const withdraw of [false, true]) await t.test(`${image ? "image" : "file"} ${withdraw ? "withdrawn" : "queued"}`, async t => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    const f = await fixture(t, { imageInput: image, handler: async request => { if (text(request) === "HOLD_MAIN") await held; return { kind: "text", text: "The original input completed." }; } });
    await f.p.submit("HOLD_MAIN", "held-main"); await until(async () => f.model.calls.length === 1);
    const bytes = image ? png : binary, selected = await f.upload(bytes, image ? "queued.png" : "queued.bin", image ? "image/png" : "application/octet-stream"), key = randomUUID();
    const pending = await f.p.submit("", key, [selected]), media = (await f.p.media.message(key))!;
    assert.equal((await pending.status(context)).status, "queued"); assert.equal((await pending.status(context)).entry, undefined); assert.equal(media.state, "bound");
    await assert.rejects(f.p.harness.commit(tx => personalAttachmentReference(tx, media.artifacts[0].id), context), error => error instanceof PersonalError && error.code === "source_invalid");
    assert.deepEqual(await f.p.harness.commit(tx => personalArtifactEntries(tx), context), []);
    if (withdraw) { await pending.abort(context); assert.equal((await pending.status(context)).status, "unanswered"); assert.equal((await pending.status(context)).entry, undefined); }
    await f.p.close(); release(); await f.reopen();
    const original = (await f.p.harness.submission(pending.id, context))!;
    const restored = await original.wait(context); assert.equal(restored.status, withdraw ? "unanswered" : "done");
    assert.equal((await f.p.media.message(key))!.submissionId, pending.id); assert.deepEqual(loadPersonalArtifact(f.directory, media.artifacts[0]), bytes);
    if (withdraw) {
      await assert.rejects(f.p.harness.commit(tx => personalAttachmentReference(tx, media.artifacts[0].id), context), error => error instanceof PersonalError && error.code === "source_invalid");
      assert.deepEqual(await f.p.harness.commit(tx => personalArtifactEntries(tx), context), []);
      assert.equal(f.model.calls.filter(request => text(request).includes(media.artifacts[0].id)).length, 0);
    } else {
      const ref = await f.p.harness.commit(tx => personalAttachmentReference(tx, media.artifacts[0].id), context); assert.equal(ref.requestId, key);
      assert.equal((await f.p.harness.commit(tx => personalArtifactEntries(tx), context))[0].artifact.id, ref.artifact.id);
      assert.equal((await f.p.submit("", key, [selected])).id, pending.id);
    }
  });
});

test("Indirect attachment history: copied read/search payloads retain work scope across reuse and fresh history queries", { timeout: 60000 }, async t => {
  let artifact = "", reused: PersonalWorkRef | undefined, reading = true;
  const f = await fixture(t, { handler: request => {
    const last = request.messages.at(-1);
    if (child(request)) {
      if (last?.role === "user" && reading) return call("read_artifact", { artifact });
      if (last?.role === "tool" && String(last.content).includes('"base64"')) {
        reading = false;
        return { kind: "text", text: "Original read for this work." };
      }
      return { kind: "text", text: "A new independent work completed." };
    }
    if (text(request).startsWith("宿主委托汇总参考")) return { kind: "text", text: "The work is complete." };
    if (text(request).includes("FIRST_HISTORY")) return call("background_work", { action: "delegate", content: "Read assigned original", attachments: [artifact] });
    if (text(request).includes("REUSE_HISTORY")) return call("background_work", { action: "delegate", content: "New work without the previous attachment", agent: reused!.agentId });
    return { kind: "text", text: "Please specify how to use the attachment." };
  } });
  const selected = await f.upload(binary), owner = randomUUID(); await (await f.p.submit("", owner, [selected])).wait(context); artifact = (await f.p.media.message(owner))!.artifacts[0].id;
  await f.p.answer("FIRST_HISTORY", "first-history");
  await until(async () => f.model.calls.filter(child).length >= 2);
  const tasks = await f.p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 64), context), input = tasks.items[0].input;
  assert.ok(input && typeof input === "object" && !Array.isArray(input) && typeof input.requestId === "string");
  reused = (await f.p.harness.snapshot(PersonalWorkDoc, input.requestId, context))!.ref!;
  await f.p.harness.waitForTask(reused.taskId, context);
  const bytes = binary.toString("base64"), indirect: EntryId[] = [];
  await f.p.harness.commit(async tx => {
    const payload = { text: bytes, attachmentWork: { ...reused! } };
    for (const toolName of ["history_read", "history_search"] as const) {
      const entry = await tx.appendEntry(reused!.agentId, { kind: "test.copied-attachment-history", model: [{ role: "toolResult", toolCallId: `old-${toolName}`, toolName, content: [{ type: "text", text: JSON.stringify(payload) }], isError: false, timestamp: 1 }] });
      indirect.push(entry.id);
    }
  }, context);
  await f.p.answer("REUSE_HISTORY", "reuse-history");
  await until(async () => f.model.calls.filter(child).some(request => text(request).includes("New work without")));
  const second = f.model.calls.filter(child).find(request => text(request).includes("New work without"))!;
  assert.equal(JSON.stringify(second.raw).includes(bytes), false); assert.match(JSON.stringify(second.raw), /另一项工作/);
  const evidence = await f.p.harness.commit(async tx => (await tx.scanEntries({ conversationId: reused!.agentId }, 256)).items.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence).find(value => JSON.stringify(value.payload).includes("New work without")), context);
  assert.ok(evidence); assert.equal(JSON.stringify(evidence.input).includes(bytes), false); assert.deepEqual(evidence.payload, second.raw);
  for (const entry of indirect) {
    const history: Awaited<ReturnType<typeof readPersonalHistory>> = await f.p.harness.commit(tx => readPersonalHistory(tx, reused!.agentId, { entry }), context); assert.equal(history.text.includes(bytes), false);
    const ownerHistory = await f.p.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry }), context); assert.equal(ownerHistory.text.includes(bytes), true);
  }
  const found = await f.p.harness.commit(tx => searchPersonalHistory(tx, reused!.agentId, { query: bytes.slice(0, 80) }), context); assert.equal(found.items.length, 0);
  const childConversation = (await f.p.harness.conversation(reused.agentId, context))!;
  const retained = await childConversation.entries({ order: "ascending" }, 256, undefined, context);
  assert.ok(indirect.every(id => retained.items.find(entry => entry.id === id)?.model?.some(message => message.role === "toolResult" && JSON.stringify(message.content).includes(bytes))));
});

test("Attachment recovery: a reopened child without general tools reads a new explicit grant on reuse", { timeout: 60000 }, async t => {
  let artifact = "", previous: PersonalWorkRef | undefined;
  const f = await fixture(t, { handler: request => {
    const last = request.messages.at(-1);
    if (child(request)) {
      if (last?.role === "user" && text(request).includes("READ_AFTER_REOPEN")) return call("read_artifact", { artifact });
      return { kind: "text", text: "The assigned work completed." };
    }
    if (last?.role === "user" && text(request) === "REUSE_AFTER_REOPEN") return call("background_work", { action: "delegate", content: "READ_AFTER_REOPEN", agent: previous!.agentId, attachments: [artifact] });
    return { kind: "text", text: "Please specify how to use the attachment." };
  } });
  assert.equal(fs.existsSync(path.join(f.directory, "tools.json")), false);
  await f.p.answer("Prepare a child without a file", "prepare-reopen");
  previous = await f.p.work.delegate({ content: "Initial work without attachments", requestId: "before-reopen", sourceRequestId: "prepare-reopen" });
  await f.p.harness.waitForTask(previous.taskId, context);
  await f.reopen();
  const selected = await f.upload(binary, "after-reopen.bin"), owner = randomUUID();
  await (await f.p.submit("", owner, [selected])).wait(context); artifact = (await f.p.media.message(owner))!.artifacts[0].id;
  await f.p.answer("REUSE_AFTER_REOPEN", "reuse-after-reopen");
  const tasks = await f.p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 64), context);
  const input = tasks.items.find(task => task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.content === "READ_AFTER_REOPEN")?.input;
  assert.ok(input && typeof input === "object" && !Array.isArray(input) && typeof input.requestId === "string");
  const current = (await f.p.harness.snapshot(PersonalWorkDoc, input.requestId, context))!.ref!;
  await f.p.harness.waitForTask(current.taskId, context); assert.equal(current.agentId, previous.agentId);
  const read = f.model.calls.filter(child).findLast(request => request.messages.at(-1)?.role === "tool")!;
  const content = String(read.messages.at(-1)!.content); assert.match(content, /"base64"/);
  const result = JSON.parse(content) as { base64: string; attachmentWork: PersonalWorkRef };
  assert.deepEqual(Buffer.from(result.base64, "base64"), binary); assert.deepEqual(result.attachmentWork, current);
  assert.deepEqual(read.tools?.map(tool => (tool.function as { name: string }).name), ["memory", "history_search", "history_read", "skill", "publish_output", "read_artifact", "ask_user"]);
  const config = (await f.p.harness.snapshot(AgentDoc, current.agentId, context))!;
  assert.ok(Array.isArray(config.extensions) && config.extensions.includes(personalAttachments.name));
  const grant = await f.p.harness.commit(async tx => personalAttachmentGrant(tx, (await tx.doc(PersonalWorkDoc, current.requestId, null)).attachments!), context);
  assert.equal(grant.attachments[0].requestId, owner);
  await f.reopen();
  assert.deepEqual((await f.p.harness.snapshot(AgentDoc, current.agentId, context))!.tools, config.tools);
});

test("Attachment append: a held child receives selected originals on its same work and retains exact scope on restart", { timeout: 60000 }, async t => {
  let work: PersonalWorkRef | undefined, artifact = "", entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { beforePayload: async input => { if (input.messages[0]?.role === "system" && input.messages[0].sections?.subagent !== undefined && !entered) { entered = true; await gate; } }, handler: request => {
    if (child(request)) return { kind: "text", text: "The original work completed its updated instructions." };
    if (text(request).startsWith("宿主委托汇总参考")) return { kind: "text", text: "The original work is ready." };
    if (text(request).includes("BEGIN_HELD")) return call("background_work", { action: "delegate", content: "Wait for the requested attachment." });
    if (text(request).includes("APPEND_FILE")) return call("background_work", { action: "append", work: work!.taskId, content: "Use this exact assigned original", attachments: [artifact] });
    return { kind: "text", text: "Please specify attachment use." };
  } });
  await f.p.answer("BEGIN_HELD", "begin-held");
  await until(async () => entered);
  const tasks = await f.p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 64), context), taskInput = tasks.items[0].input;
  assert.ok(taskInput && typeof taskInput === "object" && !Array.isArray(taskInput) && typeof taskInput.requestId === "string");
  work = (await f.p.harness.snapshot(PersonalWorkDoc, taskInput.requestId, context))!.ref!;
  const ref = await f.upload(binary), owner = randomUUID(); await (await f.p.submit("", owner, [ref])).wait(context); artifact = (await f.p.media.message(owner))!.artifacts[0].id;
  const appended = await f.p.answer("APPEND_FILE", "append-file"); assert.match(appended, /已补充工作/);
  const saved = (await f.p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!; assert.equal(saved.notes!.length, 1); assert.ok(saved.notes![0].attachments);
  const grant = await f.p.harness.commit(tx => personalAttachmentGrant(tx, saved.notes![0].attachments!), context); assert.equal(grant.work.taskId, work.taskId); assert.equal(grant.attachments[0].requestId, owner);
  release(); await f.p.harness.waitForTask(work.taskId, context);
  const childConversation = (await f.p.harness.conversation(work.agentId, context))!, entries = (await childConversation.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.equal(entries.filter(entry => entry.kind === "pi.user").length, 2);
  assert.ok(entries.some(entry => entry.model?.some(message => message.role === "user" && Array.isArray(message.content) && message.content.some(part => part.type === "text" && part.text.includes(artifact)))));
  await f.reopen(); assert.equal((await f.p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.notes![0].attachments, saved.notes![0].attachments);
});

test("Delegated original: Main grants a prior attachment to one work, bytes publish unchanged, reuse cannot read or publish it", { timeout: 60000 }, async t => {
  let artifact: string | undefined, reused: PersonalWorkRef | undefined;
  const f = await fixture(t, { handler: request => {
    const last = request.messages.at(-1);
    if (child(request)) {
      if (last?.role === "user") return call("read_artifact", { artifact: artifact! });
      if (last?.role === "tool" && String(last.content).includes('"base64"')) return call("publish_output", { name: "returned.bin", artifact: artifact! });
      return { kind: "text", text: "Original returned or access refused." };
    }
    if (text(request).startsWith("宿主委托汇总参考")) return { kind: "text", text: "The assigned original is ready." };
    if (last?.role === "tool") return { kind: "text", text: String(last.content) };
    if (text(request).includes("USE_PRIOR")) return call("background_work", { action: "delegate", content: "Return assigned original", attachments: [artifact!] });
    if (text(request).includes("REUSE_NO_GRANT")) return call("background_work", { action: "delegate", content: "Try old original", agent: reused!.agentId });
    return { kind: "text", text: "Please tell me how to use the attachment." };
  } });
  const ref = await f.upload(binary), owner = randomUUID(); await (await f.p.submit("", owner, [ref])).wait(context); artifact = (await f.p.media.message(owner))!.artifacts[0].id;
  const delegated = await f.p.answer("USE_PRIOR", "use-prior");
  assert.doesNotMatch(delegated, /attachment_forbidden|image_reference_invalid|work_input_invalid/);
  await until(async () => (await f.p.harness.commit(tx => personalTimeline(tx, {}), context)).items.some(entry => entry.outputs?.length));
  const output = await f.p.harness.commit(async tx => { const id = (await tx.doc(PersonalOutputsDoc)).intents[0]; return personalOutputIntent(tx, id); }, context);
  assert.equal(output.data.artifact.id, artifact); assert.deepEqual(Buffer.from(personalOutputChunk(f.directory, output.id, output, 0).base64, "base64"), binary);
  reused = output.data.origin.work!.ref;
  await f.p.harness.waitForTask(reused.taskId, context);
  const grantId = (await f.p.harness.snapshot(PersonalWorkDoc, reused.requestId, context))!.attachments!;
  const grant = await f.p.harness.commit(tx => personalAttachmentGrant(tx, grantId), context); assert.equal(grant.attachments[0].requestId, owner);
  const reads = (await (await f.p.harness.conversation(reused.agentId, context))!.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.model?.some(message => message.role === "toolResult" && message.toolName === "read_artifact"));
  assert.equal(reads.length, 1); const readId = reads[0].id;
  await f.p.answer("REUSE_NO_GRANT", "reuse-no-grant");
  await until(async () => f.model.calls.some(request => child(request) && JSON.stringify(request.raw).includes("artifact_forbidden")));
  assert.equal((await f.p.harness.snapshot(PersonalOutputsDoc, context))!.intents.length, 1);
  const history = await f.p.harness.commit(tx => readPersonalHistory(tx, reused!.agentId, { entry: readId as EntryId }), context);
  assert.equal(history.text.includes(binary.toString("base64")), false); assert.match(history.text, /另一项工作/);
  const searched = await f.p.harness.commit(tx => searchPersonalHistory(tx, reused!.agentId, { query: binary.toString("base64").slice(0, 80) }), context); assert.equal(searched.items.length, 0);
  await f.reopen(); assert.deepEqual(loadPersonalArtifact(f.directory, output.data.artifact), binary);
  await f.p.close();
  const database = path.join(f.directory, "personal.sqlite"), baseline = fs.readFileSync(database), calls = f.model.calls.length;
  for (const mutation of ["work", "original-source", "instruction", "hash"] as const) {
    fs.writeFileSync(database, baseline);
    const db = new DatabaseSync(database), row = db.prepare("SELECT record FROM entries WHERE id = ?").get(grantId) as { record: string };
    const saved = JSON.parse(row.record) as { data: { work: { requestId: string; taskId: number }; sourceRequestId: string; attachments: { requestId: string; source: { generation: string }; artifact: { sha256: string } }[] } };
    if (mutation === "work") saved.data.work.taskId += 1;
    if (mutation === "original-source") saved.data.attachments[0].source.generation = "other-generation";
    if (mutation === "instruction") saved.data.sourceRequestId = "reuse-no-grant";
    if (mutation === "hash") saved.data.attachments[0].artifact.sha256 = "0".repeat(64);
    db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(saved), grantId); db.close();
    await assert.rejects(f.reopen(), error => error instanceof PersonalError && error.code === "image_reference_invalid"); assert.equal(f.model.calls.length, calls);
  }
  fs.writeFileSync(database, baseline); await f.reopen();
});
