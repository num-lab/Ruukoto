import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, defineTask, defineExtension, ROOT_CONVERSATION_ID, type TaskId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { recordedModels, personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalToolDoc, PersonalToolsDoc, ToolAdmission, toolOperation, toolUnresolved } from "../apps/ruukoto/src/personal-tools.ts";
import { personalToolControl, verifyToolControls } from "../apps/ruukoto/src/personal-tools-controls.ts";
import { PersonalOwnerClaim, verifyPersonalOwnerClaim, recordPersonalImOwnerClaim } from "../apps/ruukoto/src/personal-recovery-claims.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramControlInput, type TelegramResult } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMcpDoc, McpAdmission, mcpOperation } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { personalMcpControl, verifyMcpControls } from "../apps/ruukoto/src/personal-mcp-controls.ts";
import { PersonalBrowserOperationDoc, BrowserAdmission, browserOperation } from "../apps/ruukoto/src/personal-browser.ts";
import { personalBrowserControl, verifyBrowserControls } from "../apps/ruukoto/src/personal-browser-controls.ts";
import type { TelegramSelection } from "../apps/ruukoto/src/personal-telegram-records.ts";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { PersonalCommandDoc, CommandAdmission, personalCommand, personalCommandWork } from "../apps/ruukoto/src/personal-command-work.ts";
import { personalOwnerControl, verifyOwnerControls } from "../apps/ruukoto/src/personal-owner-controls.ts";

const context = BACKGROUND_CONTEXT;
async function fixture(t: TestContext) {
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "IM_CLAIM_UNUSED_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => assert.fail("An owner claim never calls a model"));
  const task = defineTask<{ requestId: string }, { phase: "run" }, TelegramResult>({ name: "ruukoto.telegram-input", version: 1, initial: () => ({ phase: "run" }), phases: { async run(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { delivery: "sent" } } }), callContext); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
  const registry = createRegistry(); registry.install(defineExtension({ name: "test-im-controls", tasks: [task] }));
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context); await harness.root(context); t.after(() => harness.close(context));
  const source = { botId: "123", ownerId: "456", generation: "original-generation" }, operation = 100 as TaskId;
  const admission = await harness.commit(async tx => {
    (await tx.doc(PersonalTelegramDoc)).config = { version: 1, enabled: true, ...source, apiBase: "http://127.0.0.1:1", tokenEnv: "UNUSED", tokenDigest: "0".repeat(64), boundary: 0 };
    const original = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: "Original write", timestamp: 1 }] })).id;
    const origin = { conversationId: ROOT_CONVERSATION_ID, generation: 99 as TaskId, inputs: [], sources: [], source: { entryId: original, requestId: "original", submissionId: 1 as SubmissionId }, permission: { mode: "confirm" as const, version: 1 }, telegram: { ...source, mode: "confirm" as const, version: 1 } };
    const admitted = { operation, origin, kind: "http_request" as const, params: { method: "POST", url: "http://127.0.0.1:1/original", body: "original" }, prepared: { kind: "http" as const, request: { method: "POST", url: "http://127.0.0.1:1/original", body: "original", headers: {}, pinnedAddress: "127.0.0.1", pinnedFamily: 4 } }, grantVersion: 1, approval: "approved" as const };
    const entry = await tx.appendEntry(ToolAdmission, ROOT_CONVERSATION_ID, { data: admitted });
    (await tx.doc(PersonalToolsDoc)).operations.push(operation); (await tx.doc(PersonalToolDoc, String(operation), null)).operation = { ...admitted, admission: entry.id, started: true, stopped: false, effect: "effect_unknown", code: "http_timeout" }; return entry.id;
  }, context);
  let next = 10;
  const input = (content: string, replyTo?: number): TelegramControlInput => { const messageId = ++next; return { ...source, requestId: `telegram:123:456:${messageId}`, messageId, updateId: messageId, content, direct: true, delivery: "waiting", ...(replyTo === undefined ? {} : { replyTo, replyBotId: source.botId }) }; };
  const save = async (tx: Tx, value: TelegramControlInput, platformMessageId?: string) => {
    value.accepted = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.telegram-received", data: { requestId: value.requestId, generation: value.generation } })).id;
    const taskId = await tx.createTask(task, { requestId: value.requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
    (await tx.doc(PersonalTelegramReceiptDoc, value.requestId, null)).receipt = { ...value, taskId, delivery: "sent", platformMessageId: platformMessageId ?? String(1000 + value.messageId) }; return 1000 + value.messageId;
  };
  const list = input("/工具"); list.control = true; list.selection = { kind: "tool-list", operations: [operation] }; list.reply = "Tools";
  const listMessage = await harness.commit(tx => save(tx, list), context);
  const menu = input("工具1", listMessage); menu.control = true; menu.selection = { kind: "tool", operation }; menu.reply = "Original operation";
  const menuMessage = await harness.commit(tx => save(tx, menu), context);
  return { registry, harness, operation, admission, source, input, save, menuMessage, menu, list };
}

test("Telegram explicit effect claims need no evidence and preserve unknown stopping", async t => {
  const f = await fixture(t), value = f.input("工具确认已生效", f.menuMessage);
  await f.harness.commit(async tx => { assert.equal(await personalToolControl(tx, value, "/tmp/unused-claim-profile"), true); value.control = true; await f.save(tx, value); }, context);
  assert.deepEqual(value.toolResolution, { operation: f.operation, effect: "applied" });
  const op = await f.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperation(tx, f.operation))) as Awaited<ReturnType<typeof toolOperation>>, context); assert.equal(op.effect, "effect_unknown"); assert.equal(op.stopped, false); assert.equal(toolUnresolved(op), true); assert.equal(op.resolution!.evidence, undefined);
  const claim = await f.harness.commit(async tx => JSON.parse(JSON.stringify(await verifyPersonalOwnerClaim(tx, op.resolution!.claim!, { family: "tools", operation: f.operation, admission: f.admission, effect: "applied" }))) as Awaited<ReturnType<typeof verifyPersonalOwnerClaim>>, context);
  assert.equal(claim.actor.kind, "im"); assert.equal(claim.requestId, value.requestId); assert.equal(claim.occurrence, f.menuMessage); assert.ok(claim.at > 0);
  await f.harness.commit(tx => verifyToolControls(tx, [f.list.requestId, f.menu.requestId, value.requestId], true), context);
  const stale = f.input("工具确认未生效", f.menuMessage);
  await f.harness.commit(tx => personalToolControl(tx, stale, "/tmp/unused-claim-profile"), context); assert.equal(stale.toolResolution, undefined);
  const entries = await f.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256), context); assert.equal(entries.items.filter(PersonalOwnerClaim.is).length, 1);
});

test("Telegram effect claims reject copied, foreign and ambiguous contexts", async t => {
  const f = await fixture(t);
  for (const change of [{ direct: false }, { replyTo: f.menuMessage + 1 }, { ownerId: "789" }, { botId: "789" }, { generation: "new-generation" }, { content: "好的" }, { content: "工具确认已生效。" }, { platform: "qq" as const }]) {
    const value = { ...f.input("工具确认已生效", f.menuMessage), ...change };
    await assert.rejects(f.harness.commit(tx => recordPersonalImOwnerClaim(tx, value, { family: "tools", operation: f.operation, admission: f.admission }, "applied"), context), { code: "recovery_claim_invalid" });
  }
  assert.equal(await f.harness.commit(async tx => (await toolOperation(tx, f.operation)).resolution === undefined, context), true);
  const entries = await f.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256), context); assert.equal(entries.items.filter(PersonalOwnerClaim.is).length, 0);
});

test("Telegram claim verification requires the original committed source and card", async t => {
  const f = await fixture(t), value = f.input("工具确认已生效", f.menuMessage);
  await f.harness.commit(async tx => { await personalToolControl(tx, value, "/tmp/unused-claim-profile"); value.control = true; await f.save(tx, value); }, context);
  const claim = await f.harness.commit(async tx => (await toolOperation(tx, f.operation)).resolution!.claim!, context), expected = { family: "tools" as const, operation: f.operation, admission: f.admission, effect: "applied" as const };
  const verify = () => f.harness.commit(tx => verifyPersonalOwnerClaim(tx, claim, expected).then(() => undefined), context); await verify();
  await f.harness.commit(async tx => { (await tx.doc(PersonalTelegramReceiptDoc, value.requestId, null)).receipt!.replyTo = f.menuMessage + 1; }, context);
  await assert.rejects(verify(), { code: "recovery_claim_invalid" });
  await f.harness.commit(async tx => { const receipt = (await tx.doc(PersonalTelegramReceiptDoc, value.requestId, null)).receipt!; receipt.replyTo = f.menuMessage; delete receipt.accepted; }, context);
  await assert.rejects(verify(), { code: "recovery_claim_invalid" });
});

test("Telegram effect-action failure rolls back its claim and original resolution", async t => {
  const f = await fixture(t), value = f.input("工具确认已生效", f.menuMessage);
  await assert.rejects(f.harness.commit(async tx => {
    const append = tx.appendEntry.bind(tx);
    t.mock.method(tx, "appendEntry", (...args: Parameters<Tx["appendEntry"]>) => {
      if (typeof args[0] === "object" && args[0].kind === PersonalOwnerClaim.kind) throw new PersonalError("test_claim_failure", "Injected failure after effect-action admission");
      return append(...args);
    });
    await personalToolControl(tx, value, "/tmp/unused-claim-profile");
  }, context), { code: "test_claim_failure" });
  assert.equal(await f.harness.commit(async tx => (await toolOperation(tx, f.operation)).resolution === undefined, context), true);
  const entries = await f.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256), context);
  assert.equal(entries.items.filter(entry => entry.kind === "ruukoto.im-effect-action" || PersonalOwnerClaim.is(entry)).length, 0);
});

test("Telegram MCP and browser explicit claims retain their distinct original records", async t => {
  for (const family of ["mcp", "browser"] as const) await t.test(family, async t => {
    const f = await fixture(t), operation = 200 as TaskId;
    const admission = await f.harness.commit(async tx => {
      const origin = JSON.parse(JSON.stringify((await toolOperation(tx, f.operation)).origin)) as Awaited<ReturnType<typeof toolOperation>>["origin"];
      if (family === "mcp") {
        const config = parsePersonalMcp({ version: 4, generation: "claim-test", services: [{ id: "test", label: "Test", endpoint: "http://127.0.0.1:1", enabled: true, tools: [{ name: "act", inputSchema: { type: "object", properties: {} } }], toolEffects: { act: "unknown" } }] });
        const entry = (await tx.appendEntry(McpAdmission, ROOT_CONVERSATION_ID, { data: { operation, origin, config, service: "test", tool: "act", args: {}, recordVersion: 2, localEffect: "unknown" } })).id;
        (await tx.doc(PersonalMcpDoc, String(operation), null)).operation = { operation, origin, config, service: "test", tool: "act", args: {}, recordVersion: 2, localEffect: "unknown", admission: entry, decision: "approved", started: true, remoteEnded: false, effect: "effect_unknown", code: "disconnected", evidence: {} }; return entry;
      }
      const config = { version: 1 as const, generation: "claim-test", binaryPath: "/tmp/unused-browser", chromePath: "/tmp/unused-chrome", headed: false };
      const entry = (await tx.appendEntry(BrowserAdmission, ROOT_CONVERSATION_ID, { data: { operation, origin, config, params: { action: "open", url: "https://example.com" } } })).id;
      (await tx.doc(PersonalBrowserOperationDoc, String(operation), null)).operation = { operation, origin, config, params: { action: "open", url: "https://example.com" }, admission: entry, started: true, stopped: false, effect: "effect_unknown", code: "disconnected" }; return entry;
    }, context);
    const menu = f.input(family === "mcp" ? "MCP1" : "浏览器1"); menu.control = true; menu.selection = { kind: family, operation } as TelegramSelection; menu.reply = "Original operation";
    const messageId = await f.harness.commit(tx => f.save(tx, menu), context), value = f.input(family === "mcp" ? "MCP确认未生效" : "浏览器确认未生效", messageId);
    await f.harness.commit(async tx => {
      if (family === "mcp") await personalMcpControl(tx, value, true); else await personalBrowserControl(tx, value, async () => assert.fail("An effect claim does not stop the browser"));
      value.control = true; await f.save(tx, value);
    }, context);
    const claimId = await f.harness.commit(async tx => {
      const op = family === "mcp" ? await mcpOperation(tx, operation) : await browserOperation(tx, operation); assert.equal(op.effect, "effect_unknown"); assert.equal(op.resolution!.effect, "not_applied"); assert.equal(op.resolution!.evidence, undefined);
      if (family === "mcp") assert.equal((await mcpOperation(tx, operation)).remoteEnded, false); else assert.equal((await browserOperation(tx, operation)).stopped, false);
      return op.resolution!.claim!;
    }, context);
    await f.harness.commit(tx => verifyPersonalOwnerClaim(tx, claimId, { family, operation, admission, effect: "not_applied" }).then(() => undefined), context);
    await f.harness.commit(tx => family === "mcp" ? verifyMcpControls(tx, [value.requestId], true) : verifyBrowserControls(tx, [value.requestId], true), context);
  });
});

test("Telegram command claims use the original command and do not verify stopping", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-im-command-claim-"))), workspace = path.join(root, "work"), profile = path.join(root, "profile"); fs.mkdirSync(workspace); fs.mkdirSync(profile);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!, machineId = "a".repeat(32), read = fs.readFileSync;
  Object.defineProperty(process, "platform", { value: "linux" }); t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => file === "/etc/machine-id" ? machineId + "\n" : read(file, options)); syncBuiltinESMExports();
  try {
    const f = await fixture(t), identity = fs.statSync(workspace), config = { version: 1 as const, workspace, identity: { dev: identity.dev, ino: identity.ino }, machineId, tmpdir: fs.realpathSync(os.tmpdir()) }, commands = personalCommandWork(profile, config);
    type Result = NonNullable<Awaited<ReturnType<typeof personalCommand>>["result"]>;
    const task = defineTask<{ requestId: string }, { phase: "run" }, Result>({ name: "ruukoto.command", version: 1, initial: () => ({ phase: "run" }), phases: { async run() { assert.fail("An effect claim does not run commands"); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } }); f.registry.install(defineExtension({ name: "test-command", tasks: [task] }));
    const ref = await f.harness.commit(async tx => ({ requestId: "original-command", taskId: await tx.createTask(task, { requestId: "original-command" }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }) }), context);
    const admission = await f.harness.commit(async tx => {
      const work = { ref: { requestId: "original-work", taskId: 200 as import("../apps/ruukoto/src/personal-work.ts").PersonalWorkRef["taskId"], agentId: ROOT_CONVERSATION_ID }, inputs: [], sources: [], tool: ref.taskId, generation: ref.taskId, permission: { mode: "full_access" as const, version: 1 }, telegram: { ...f.source, mode: "full_access" as const, version: 1 } }, execution = { executionId: "original-execution", machineId };
      const admission = (await tx.appendEntry(CommandAdmission, ROOT_CONVERSATION_ID, { data: { ref, command: "original-command", execution, work } })).id;
      (await tx.doc(PersonalCommandDoc, ref.requestId, null)).command = { ref, command: "original-command", execution, work, admission, started: true, stopped: false, cancelRequested: false, result: { effect: "effect_unknown", code: "interrupted" } }; return admission;
    }, context);
    const menu = f.input("命令1"); menu.control = true; menu.selection = { kind: "command", ref, view: "record" }; menu.reply = "Original command";
    const messageId = await f.harness.commit(tx => f.save(tx, menu), context), value = f.input("命令确认已生效", messageId);
    await f.harness.commit(async tx => { await personalOwnerControl(tx, value, commands); value.control = true; await f.save(tx, value); }, context);
    const resolution = (await f.harness.snapshot(PersonalTelegramReceiptDoc, value.requestId, context))!.receipt!.commandResolution;
    assert.deepEqual(resolution, { ref, effect: "applied" });
    const claim = await f.harness.commit(async tx => { const op = await personalCommand(tx, ref); assert.equal(op.result!.effect, "effect_unknown"); assert.equal(op.stopped, false); assert.equal(op.resolution!.evidence, undefined); return op.resolution!.claim!; }, context);
    await f.harness.commit(tx => verifyPersonalOwnerClaim(tx, claim, { family: "commands", operation: ref.taskId, admission, effect: "applied" }).then(() => undefined), context);
    await f.harness.commit(tx => verifyOwnerControls(tx, [value.requestId], true), context);
  } finally { Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});
