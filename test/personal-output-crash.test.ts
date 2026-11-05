import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalOutputsDoc, personalOutputChunk } from "../apps/ruukoto/src/personal-outputs.ts";
import { personalPublishedOutput } from "../apps/ruukoto/src/personal-report.ts";
import { personalTimeline } from "../apps/ruukoto/src/personal-history.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
async function until(check: () => boolean | Promise<boolean>, detail: () => string) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, detail()); await delay(5); }
}

test("A SIGKILL after output-intent commit replays the original tool without another write or publication", { timeout: 45_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-output-crash-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const target = path.join(workspace, "final.txt"), content = "Original successful write, delivered once.\n", requestId = "owner-output-crash";
  fs.writeFileSync(target, "before", { mode: 0o600 });
  let writeCalls = 0, publishCalls = 0, personal: PersonalHarness | undefined;
  const model = new PersonalMockModelServer(request => {
    const last = request.messages.at(-1), text = String(last?.content);
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (last?.role === "user") { writeCalls++; return { kind: "tool_calls", calls: [{ id: "original-write", name: "write_file", arguments: { path: target, content } }] }; }
      const result = JSON.parse(text) as { operation?: number; output?: number; code?: string };
      if (result.operation) { assert.equal(result.code, "file_returned"); publishCalls++; return { kind: "tool_calls", calls: [{ id: "original-publish", name: "publish_output", arguments: { name: "final.txt", operation: result.operation } }] }; }
      assert.ok(result.output); return { kind: "text", text: "The final file is registered." };
    }
    if (String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考")) return { kind: "text", text: "The requested final file is ready." };
    return { kind: "tool_calls", calls: [{ id: "original-delegate", name: "background_work", arguments: { action: "delegate", content: "Write and deliver the requested final.txt file." } }] };
  });
  const apiKeyEnv = "PERSONAL_OUTPUT_CRASH_KEY", previous = process.env[apiKeyEnv]; process.env[apiKeyEnv] = "test-only";
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    await personal?.close(); await model.close();
    if (previous === undefined) delete process.env[apiKeyEnv]; else process.env[apiKeyEnv] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  isolateSkillHome(t);
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv, contextWindow: 128000, maxTokens: 2048 };
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  const script = `
import { openPersonalHarness } from "./apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "./apps/ruukoto/src/personal-model.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
const { directory, config, tools, requestId } = JSON.parse(process.env.RUUKOTO_OUTPUT_CRASH_TEST);
setInterval(() => {}, 1000);
const p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, openStorage: async filename => {
  const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
  storage.commit = async (writes, context) => {
    const result = await commit(writes, context);
    if (writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.output-intent")) {
      process.stdout.write("output-intent-committed\\n");
      await new Promise(() => {});
    }
    return result;
  };
  return storage;
} });
await p.answer("Write and deliver final.txt.", requestId);
`;
  child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_OUTPUT_CRASH_TEST: JSON.stringify({ directory, config, tools, requestId }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", diagnostics = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { diagnostics += data; });
  await until(() => { assert.equal(child!.exitCode, null, diagnostics); return output.includes("output-intent-committed"); }, () => diagnostics || "Output intent did not reach the crash boundary");
  const database = new DatabaseSync(path.join(directory, "personal.sqlite"), { readOnly: true });
  const entries = (database.prepare("SELECT record FROM entries ORDER BY id").all() as { record: string }[]).map(row => JSON.parse(row.record) as EntryRecord); database.close();
  const intents = entries.filter(entry => entry.kind === "ruukoto.output-intent"); assert.equal(intents.length, 1);
  assert.equal(entries.filter(entry => entry.model?.some(message => message.role === "toolResult" && message.toolName === "publish_output")).length, 0);
  assert.equal(entries.filter(entry => entry.kind === "ruukoto.report-publication").length, 0);
  assert.equal(fs.readFileSync(target, "utf8"), content); const afterWrite = fs.statSync(target);
  const exited = once(child, "exit"); child.kill("SIGKILL"); const [exitCode, signal] = await exited;
  assert.equal(exitCode, null, diagnostics); assert.equal(signal, "SIGKILL", diagnostics);
  personal = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools });
  await until(async () => (await personal!.harness.commit(tx => personalTimeline(tx, {}), context)).items.some(entry => entry.outputs?.length), () => diagnostics || "Original output did not publish after reopen");
  const timeline = await personal.harness.commit(tx => personalTimeline(tx, {}), context), publications = timeline.items.filter(entry => entry.outputs?.length);
  assert.equal(publications.length, 1); assert.equal(publications[0].outputs!.length, 1); assert.equal(publications[0].outputs![0].output, intents[0].id);
  assert.deepEqual((await personal.harness.snapshot(PersonalOutputsDoc, context))!.intents, [intents[0].id]);
  const operations = await personal.harness.commit(async tx => (await toolOperations(tx)).map(operation => ({ kind: operation.kind, effect: operation.effect, requestId: operation.origin.source.requestId })), context);
  assert.deepEqual(operations, [{ kind: "write_file", effect: "returned", requestId }]);
  assert.equal(writeCalls, 1); assert.equal(publishCalls, 1); assert.equal(fs.readFileSync(target, "utf8"), content); assert.equal(fs.statSync(target).mtimeMs, afterWrite.mtimeMs);
  const owner = await personal.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId), context); assert.equal(owner?.status, "done");
  const publication = publications[0].entry as EntryId;
  const published = await personal.harness.commit(async tx => personalOutputChunk(directory, publication, await personalPublishedOutput(tx, publication, intents[0].id), 0), context);
  assert.equal(Buffer.from(published.base64, "base64").toString("utf8"), content);
});
