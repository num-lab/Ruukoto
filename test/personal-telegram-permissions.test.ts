import { PersonalSchedulesDoc, PersonalScheduleRunDoc } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, SessionFailed, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalDelegationDoc, listPersonalDelegations } from "../apps/ruukoto/src/personal-delegation.ts";
import { PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalPermissionFor, PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram.ts";
import { listPersonalServiceGrants, revokePersonalServiceGrant, PersonalServiceGrantsDoc, PersonalServiceOperationDoc, ServiceOperationEvidence, type PersonalServiceOperationRef } from "../apps/ruukoto/src/personal-service-operations.ts";
import { personalServiceControls, listPersonalServices } from "../apps/ruukoto/src/personal-service-controls.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const UNIT = "approval-test.service";
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待审批事实超时"); await delay(10); }
}

async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "收到" })) {
  const root = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-tg-perm-"));
  const helper = path.join(root, "helper"); fs.mkdirSync(path.join(helper, "units"), { recursive: true }); fs.mkdirSync(path.join(helper, "ops"));
  const helperPath = path.join(helper, "helper.mjs"); fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), helperPath);
  const policyPath = path.join(helper, "services.json"); fs.writeFileSync(policyPath, JSON.stringify({ machineId: "test-machine", inspectUid: 1, inspectGid: 1, services: { [UNIT]: { actions: ["restart"] } } }));
  fs.writeFileSync(path.join(helper, "units", UNIT), "[Service]\nExecStart=/usr/bin/true\n");
  fs.writeFileSync(path.join(helper, "state.json"), JSON.stringify({ [UNIT]: { loadState: "loaded", activeState: "active", subState: "running", mainPid: 123, invocationId: "before", result: "success", activeEnterTimestamp: "2026-10-17T00:00:00Z", starts: 0 } }));
  const sends: { text: string; messageId: number }[] = []; let failure = false;
  const bot = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { text: string; chat_id: string };
    assert.match(req.url!, /\/sendMessage$/);
    sends.push({ text: body.text, messageId: 1000 + sends.length + 1 });
    if (failure) { failure = false; res.destroy(); return; }
    res.end(JSON.stringify({ ok: true, result: { message_id: sends.at(-1)!.messageId, chat: { id: Number(body.chat_id), type: "private" } } }));
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const model = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_PERMISSIONS_MODEL_KEY", contextWindow: 128000, maxTokens: 1024 };
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "RUUKOTO_PERMISSIONS_BOT_KEY", tokenDigest: createHash("sha256").update("123:test-token").digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  const oldModel = process.env[config.apiKeyEnv]; const oldBot = process.env[telegram.tokenEnv]; process.env[config.apiKeyEnv] = "test-only"; process.env[telegram.tokenEnv] = "123:test-token";
  const options = { directory: path.join(root, "profile"), provider: personalProvider(config), modelId: config.modelId, telegram, service: { helperPath, policyPath, useSudo: false, sudoPath: "/usr/bin/sudo", timeouts: { inspectMs: 1000, restartMs: 2000, stopMs: 1000 } }, serviceOperations: true };
  let p: PersonalHarness; let id = 0;
  t.after(async () => { await p?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); fs.rmSync(root, { recursive: true, force: true }); for (const [key, previous] of [[config.apiKeyEnv, oldModel], [telegram.tokenEnv, oldBot]]) { if (previous === undefined) delete process.env[key!]; else process.env[key!] = previous; } });
  const receive = async (text: string, replyTo?: number, extra: Record<string, unknown> = {}) => {
    const messageId = ++id;
    const update: TelegramUpdate = { update_id: id, message: { message_id: messageId, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }), ...extra } };
    await p.telegram.receive(update);
    const key = `telegram:123:456:${messageId}`; const value = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p.harness.waitForTask(value.taskId, context);
    return { key, update, value: (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt! };
  };
  const request = async () => { const source = await receive("重启测试服务"); const ref = await p.service!.request({ requestId: randomUUID(), sourceRequestId: source.key, unit: UNIT }); await until(async () => !!(await p.service!.status(ref)).operation.snapshot); return ref; };
  return { options, telegram, root, model, sends, helper, receive, request,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ ...options, ...overrides }),
    starts: () => (JSON.parse(fs.readFileSync(path.join(helper, "state.json"), "utf8")) as Record<string, { starts: number }>)[UNIT].starts,
    touch: (name: string) => fs.writeFileSync(path.join(helper, name), ""),
    loseSend: () => { failure = true; },
  };
}
async function menu(f: Awaited<ReturnType<typeof fixture>>, command = "/审批") { return Number((await f.receive(command)).value.platformMessageId); }
async function done(p: PersonalHarness, ref: PersonalServiceOperationRef) { return p.harness.waitForTask(ref.taskId, context); }

async function unknownRecovery(f: Awaited<ReturnType<typeof fixture>>, p: PersonalHarness) {
  f.touch("fail-after-launch"); f.touch("stop-query-fails"); const ref = await f.request();
  await f.receive("批准本次", await menu(f));
  await until(async () => (await p.main.entries({}, 256, undefined, context)).items.some(entry => ServiceOperationEvidence.is(entry) && entry.data.verb === "stop-op"));
  const detail = await f.receive("服务1", await menu(f, "/服务核实"));
  return { ref, detail };
}

test("Telegram 服务核实：原确认菜单保存证据、重投不覆盖、错误停止不释放且控制零模型", async t => {
  const f = await fixture(t); let p = await f.open(); const { ref, detail } = await unknownRecovery(f, p);
  assert.equal((await p.harness.commit(tx => listPersonalServices(tx, 0, f.telegram), context)).items.length, 1);
  const before = f.model.calls.length;
  const confirm = await f.receive("确认已生效", Number(detail.value.platformMessageId));
  const confirmationId = Number(confirm.value.platformMessageId);
  const wrongMenu = await f.receive("核实操作停止", confirmationId);
  assert.equal(wrongMenu.value.serviceStop, undefined); assert.match(wrongMenu.value.reply!, /详情菜单/);
  for (const extra of [{ forward_origin: { type: "user" } }, { quote: { text: "核实说明 已生效" } }, { reply_to_message: { message_id: confirmationId, from: { id: 789, is_bot: true } } }]) await f.receive("核实说明 已生效", confirmationId, extra);
  assert.equal((await p.service!.status(ref)).operation.resolution, undefined);
  await f.receive("核实说明 ", confirmationId);
  assert.equal((await p.service!.status(ref)).operation.resolution, undefined);
  const evidence = "核实实际启动计数及服务状态；".repeat(200);
  const decision = await f.receive(`核实说明 ${evidence}`, confirmationId);
  assert.deepEqual((await p.service!.status(ref)).operation.resolution, { effect: "applied", evidence, controlRequestId: decision.key });
  await p.telegram.receive(decision.update);
  await f.receive("核实说明 改写", confirmationId);
  assert.equal((await p.service!.status(ref)).operation.resolution!.evidence, evidence);
  const refresh = await f.receive("刷新服务", Number(decision.value.platformMessageId));
  assert.ok(refresh.value.selection?.kind === "service-recovery" && refresh.value.selection.nextOffset);
  assert.ok(refresh.value.reply!.length < 3900);
  const next = await f.receive("更多核实说明", Number(refresh.value.platformMessageId)); assert.match(next.value.reply!, /核实实际启动计数/);
  const stop = await f.receive("核实操作停止", Number(detail.value.platformMessageId));
  const stopped = await p.harness.waitForTask(stop.value.serviceStop!.taskId, context);
  assert.deepEqual(stopped.state.outcome.result, { stopped: false, code: "stop_unverified" });
  await p.telegram.receive(stop.update);
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.service-stop" }, 8), context)).items.length, 1);
  assert.equal((await p.service!.status(ref)).operation.launcherStopped, false);
  assert.match((await f.receive("刷新服务", Number(stop.value.platformMessageId))).value.reply!, /stop_unverified/);
  assert.equal(f.model.calls.length, before);
  await p.close(); p = await f.open();
  fs.rmSync(path.join(f.helper, "stop-query-fails"));
  const success = await f.receive("核实操作停止", Number(detail.value.platformMessageId));
  await p.harness.waitForTask(success.value.serviceStop!.taskId, context); await done(p, ref);
  assert.equal(f.starts(), 1); assert.equal(f.model.calls.length, before);
  assert.equal((await p.service!.status(ref)).operation.result?.effect, "effect_unknown");
});

test("Telegram 服务核实：未送达确认与旧代次菜单不能核实，本机保留管理资格", async t => {
  const f = await fixture(t); let p = await f.open(); const { ref, detail } = await unknownRecovery(f, p);
  f.loseSend(); const confirmation = await f.receive("确认未生效", Number(detail.value.platformMessageId));
  assert.equal(confirmation.value.delivery, "effect_unknown");
  await f.receive("核实说明 未生效", f.sends.at(-1)!.messageId); assert.equal((await p.service!.status(ref)).operation.resolution, undefined);
  await p.close(); p = await f.open({ telegram: { ...f.telegram, generation: randomUUID() } });
  assert.match((await f.receive("/服务核实")).value.reply!, /暂无/);
  await f.receive("核实操作停止", Number(detail.value.platformMessageId));
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.service-stop" }, 8), context)).items.length, 0);
  assert.equal((await p.harness.commit(tx => listPersonalServices(tx), context)).items.length, 1);
  await p.service!.resolve(ref, "not_applied", "本机独立核实旧入口操作");
  assert.equal((await p.service!.status(ref)).operation.resolution!.effect, "not_applied");
});

test("Telegram 服务核实：效果、停止与原收件双向回链缺失或扩展缺失拒绝恢复", async t => {
  for (const mutation of ["resolution", "evidence", "stop", "marker"] as const) await t.test(mutation, async t => {
    const f = await fixture(t); const p = await f.open(); const { ref, detail } = await unknownRecovery(f, p);
    const confirm = await f.receive("确认已生效", Number(detail.value.platformMessageId));
    const decision = await f.receive("核实说明 独立核实已生效", Number(confirm.value.platformMessageId));
    const stop = await f.receive("核实操作停止", Number(detail.value.platformMessageId)); await p.harness.waitForTask(stop.value.serviceStop!.taskId, context);
    await p.harness.commit(async tx => {
      if (mutation === "resolution") delete (await tx.doc(PersonalTelegramReceiptDoc, decision.key, null)).receipt!.serviceResolution;
      if (mutation === "evidence") (await tx.doc(PersonalServiceOperationDoc, ref.requestId, null)).operation!.resolution!.evidence = "其他说明";
      if (mutation === "stop") delete (await tx.doc(PersonalTelegramReceiptDoc, stop.key, null)).receipt!.serviceStop;
      if (mutation === "marker") { const doc = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(doc.extensions)); doc.extensions = doc.extensions.filter(name => name !== "personal-service-recovery-controls"); }
    }, context);
    await p.close(); await assert.rejects(f.open(), code("service_control_invalid"));
  });
});

test("Telegram 服务核实：收件接纳失败零外调，同一重投只登记一次", async t => {
  const f = await fixture(t); let armed = false;
  let p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = (writes, ctx) => armed && JSON.stringify(writes).includes('"ruukoto.service-stop"') ? Promise.reject(new Error("service-stop-admission-failed")) : commit(writes, ctx);
    return storage;
  } });
  const { detail } = await unknownRecovery(f, p);
  const update: TelegramUpdate = { update_id: 50, message: { message_id: 50, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text: "核实操作停止", reply_to_message: { message_id: Number(detail.value.platformMessageId), from: { id: 123, is_bot: true } } } };
  const calls = fs.readFileSync(path.join(f.helper, "calls.log"), "utf8"); armed = true;
  await assert.rejects(p.telegram.receive(update)); await p.harness.closed; await p.close();
  assert.equal(fs.readFileSync(path.join(f.helper, "calls.log"), "utf8"), calls);
  p = await f.open(); assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.service-stop" }, 8), context)).items.length, 0);
  await p.telegram.receive(update); await p.telegram.receive(update);
  const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:50", context))!.receipt!;
  await p.harness.waitForTask(receipt.serviceStop!.taskId, context);
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.service-stop" }, 8), context)).items.length, 1);
});

test("Telegram 服务停止：接纳后换代在执行前拒绝，不调用原 helper", async t => {
  const f = await fixture(t); const p = await f.open(); const { ref, detail } = await unknownRecovery(f, p);
  const calls = fs.readFileSync(path.join(f.helper, "calls.log"), "utf8");
  const id = await p.harness.commit(async tx => {
    const receipt = (await tx.doc(PersonalTelegramReceiptDoc, detail.key, null)).receipt!;
    const id = await personalServiceControls(() => p.harness, () => p.service).request(tx, ref, receipt);
    receipt.serviceStop = { ref, taskId: id };
    (await tx.doc(PersonalTelegramDoc)).config!.generation = randomUUID();
    return id;
  }, context);
  const task = await p.harness.waitForTask(id, context);
  assert.deepEqual(task.state.outcome.result, { stopped: false, code: "service_original_entry_required" });
  assert.equal(fs.readFileSync(path.join(f.helper, "calls.log"), "utf8"), calls);
  assert.equal((await p.service!.status(ref)).operation.launcherStopped, false);
});

test("Telegram 权限：模式只作用新输入，API 不扩权，宿主控制零模型", async t => {
  const f = await fixture(t); const p = await f.open();
  const old = await f.receive("旧委托"); const before = f.model.calls.length;
  await f.receive("完全访问"); assert.equal((await p.harness.snapshot(PersonalPermissionsDoc, context))!.mode, "auto-review");
  await f.receive("完全访问", await menu(f, "/权限"));
  const source = await f.receive("新委托");
  assert.equal(f.model.calls.length, before + 1);
  const first = await p.service!.request({ requestId: "old", sourceRequestId: old.key, unit: UNIT });
  await until(async () => !!(await p.service!.status(first)).operation.snapshot);
  assert.equal((await p.service!.status(first)).operation.mode, "auto-review"); assert.equal(f.starts(), 0);
  await assert.rejects(p.service!.decide(first, "approved"), code("service_original_entry_required"));
  await f.receive("拒绝", await menu(f)); await done(p, first);
  await assert.rejects(p.service!.request({ requestId: "expand", sourceRequestId: old.key, unit: UNIT, mode: "full_access" }), code("service_mode_invalid"));
  const next = await p.service!.request({ requestId: "new", sourceRequestId: source.key, unit: UNIT }); await done(p, next); assert.equal(f.starts(), 1);
  assert.equal((await p.service!.status(next)).operation.mode, "full_access");
});

test("Telegram 审批：原菜单批准、重投及异回复冲突，普通聊天继续", async t => {
  const f = await fixture(t); const p = await f.open(); const ref = await f.request();
  const originalMenu = await menu(f); const before = f.model.calls.length;
  await f.receive("另一独立聊天"); assert.equal(f.model.calls.length, before + 1);
  for (const extra of [{ forward_origin: { type: "user" } }, { quote: { text: "批准本次" } }, { reply_to_message: { message_id: originalMenu, from: { id: 789, is_bot: true } } }]) await f.receive("批准本次", originalMenu, extra);
  assert.equal(f.starts(), 0);
  const decision = await f.receive("批准本次", originalMenu); await done(p, ref); assert.equal(f.starts(), 1);
  await p.telegram.receive(decision.update); assert.equal(f.starts(), 1);
  const calls = f.model.calls.length; const status = await f.receive("/服务状态"); assert.match(status.value.reply!, /重启命令已结束/); assert.equal(f.model.calls.length, calls);
  await assert.rejects(p.telegram.receive({ ...decision.update, message: { ...(decision.update.message as object), reply_to_message: { message_id: originalMenu + 1, from: { id: 123, is_bot: true } } } }), code("telegram_input_conflict"));
  await f.receive("批准并长期授权", originalMenu); assert.equal((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants.length, 0);
});

test("Telegram 长期授权：来源可追溯、独立再用、原入口撤销后恢复人工", async t => {
  const f = await fixture(t); let p = await f.open(); const first = await f.request();
  await f.receive("批准并长期授权", await menu(f)); await done(p, first);
  const grant = (await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[0]; assert.equal(grant.version, 1); assert.equal(grant.active, true);
  const next = await f.request(); await done(p, next); assert.equal(f.starts(), 2);
  assert.equal((await p.service!.status(next)).operation.grant?.id, grant.id); assert.notEqual(first.taskId, next.taskId);
  await p.close(); p = await f.open();
  const revoke = await f.receive("撤销授权", await menu(f, "/授权")); await p.telegram.receive(revoke.update);
  assert.equal((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[0].version, 2);
  const waiting = await f.request(); await delay(50); assert.equal((await p.service!.status(waiting)).operation.decision, "pending"); assert.equal(f.starts(), 2);
  await f.receive("批准本次", await menu(f)); await done(p, waiting); assert.equal(f.starts(), 3);
});

test("Telegram 审批：换代及旧无快照服务工作不能按本机批准消费", async t => {
  for (const kind of ["rebind", "legacy"] as const) await t.test(kind, async t => {
    const f = await fixture(t); let p = await f.open(); const ref = await f.request(); const originalMenu = await menu(f);
    if (kind === "legacy") await p.harness.commit(async tx => { const op = (await tx.doc(PersonalServiceOperationDoc, ref.requestId, null)).operation!; delete op.telegram; delete (await tx.doc(PersonalTelegramReceiptDoc, op.source.requestId, null)).receipt!.permission; }, context);
    await p.close(); p = await f.open(kind === "rebind" ? { telegram: { ...f.telegram, generation: randomUUID() } } : {});
    await done(p, ref); assert.equal(f.starts(), 0);
    await f.receive("批准本次", originalMenu); assert.equal(f.starts(), 0);
    await assert.rejects(p.service!.decide(ref, "approved"), code("service_original_entry_required"));
  });
});

test("Telegram 授权：未知效果撤销授权并保留目标占用，主聊天继续", async t => {
  const f = await fixture(t); const p = await f.open(); const first = await f.request(); await f.receive("批准并长期授权", await menu(f)); await done(p, first);
  f.touch("fail-after-launch"); const second = await f.request();
  await until(async () => (await p.service!.status(second)).operation.result?.code === "result_unverified");
  assert.equal((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[0].active, false);
  await f.receive("独立聊天继续"); const source = await f.receive("换键重试");
  await assert.rejects(p.service!.request({ requestId: "bypass", sourceRequestId: source.key, unit: UNIT }), code("service_operation_busy"));
  assert.equal(f.starts(), 2);
});

test("Telegram 控制：菜单未知发送不能批准，待审批重启后仍可按新菜单决定", async t => {
  const f = await fixture(t); let p = await f.open(); const ref = await f.request(); f.loseSend(); const query = await f.receive("/审批");
  assert.equal(query.value.delivery, "effect_unknown");
  await f.receive("批准本次", f.sends.at(-1)!.messageId); assert.equal(f.starts(), 0);
  await p.close(); p = await f.open(); await f.receive("批准本次", await menu(f)); await done(p, ref); assert.equal(f.starts(), 1);
});

test("Telegram 控制：决定提交后应答丢失，原消息恢复只有一个授权及执行", async t => {
  const f = await fixture(t); let armed = false;
  let p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = async (writes, context) => { const seq = await commit(writes, context); if (armed && JSON.stringify(writes).includes('"批准并长期授权"')) { armed = false; throw new Error("decision-answer-lost"); } return seq; };
    return storage;
  } });
  const ref = await f.request(); const target = await menu(f); armed = true;
  await assert.rejects(f.receive("批准并长期授权", target), error => error instanceof SessionFailed || error instanceof Error && error.message === "decision-answer-lost");
  await p.close(); p = await f.open(); await done(p, ref);
  assert.equal((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants.length, 1); assert.equal(f.starts(), 1);
});

test("Telegram 权限：原权限记录或授权来源缺失拒绝恢复，零额外副作用", async t => {
  for (const kind of ["permissions", "grant-source"] as const) await t.test(kind, async t => {
    const f = await fixture(t); const p = await f.open(); const ref = await f.request(); await f.receive("批准并长期授权", await menu(f)); await done(p, ref);
    await p.harness.commit(async tx => {
      if (kind === "permissions") await tx.retireDoc(PersonalPermissionsDoc);
      else (await tx.doc(PersonalServiceGrantsDoc)).grants[0].controlRequestId = "missing";
    }, context);
    await p.close(); await assert.rejects(f.open(), code(kind === "permissions" ? "permissions_version" : "service_grant_invalid")); assert.equal(f.starts(), 1);
  });
});

test("Telegram 授权：撤销与消费按事务先后决定，旧候选不得沿用", async t => {
  for (const order of ["revoke-first", "consume-first"] as const) await t.test(order, async t => {
    const f = await fixture(t); let armed = false; let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const p = await f.open({ openStorage: async filename => {
      const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
      storage.commit = async (writes, context) => {
        const seq = await commit(writes, context); const serialized = JSON.stringify(writes);
        const target = order === "revoke-first" ? serialized.includes('"approved"') && serialized.includes('"grant"') && !serialized.includes('"started"') : serialized.includes('"started"');
        if (armed && target) { armed = false; entered = true; await gate; }
        return seq;
      };
      return storage;
    } });
    t.after(release);
    const first = await f.request(); await f.receive("批准并长期授权", await menu(f)); await done(p, first);
    const revokeMenu = await menu(f, "/授权"); const source = await f.receive("第二次委托"); armed = true;
    const ref = await p.service!.request({ requestId: "race", sourceRequestId: source.key, unit: UNIT });
    await until(async () => entered);
    // 在原 commit 尚未返回时排入拥有者撤销，保证它先于下一次消费/外部派发。
    const revoked = f.receive("撤销授权", revokeMenu); await delay(0); release(); await revoked;
    if (order === "revoke-first") {
      await until(async () => (await p.service!.status(ref)).operation.decision === "pending"); assert.equal(f.starts(), 1);
      await f.receive("批准本次", await menu(f));
    }
    await done(p, ref); assert.equal(f.starts(), 2, JSON.stringify((await p.service!.status(ref)).operation));
    assert.equal((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[0].active, false);
  });
});

test("Telegram 授权：策略或单元修订变化失效，原单次批准独立", async t => {
  for (const kind of ["policy", "unit"] as const) await t.test(kind, async t => {
    const f = await fixture(t); const p = await f.open(); const first = await f.request(); await f.receive("批准并长期授权", await menu(f)); await done(p, first);
    fs.appendFileSync(kind === "policy" ? f.options.service.policyPath : path.join(f.helper, "units", UNIT), "\n");
    const next = await f.request(); await until(async () => !(await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[0].active);
    assert.equal((await p.service!.status(next)).operation.decision, "pending"); assert.equal(f.starts(), 1);
    await f.receive("批准本次", await menu(f)); await done(p, next); assert.equal(f.starts(), 2);
  });
});

test("Telegram 授权：服务结果写失败后恢复撤销授权且不重发", async t => {
  const f = await fixture(t); let armed = false;
  let p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = async (writes, context) => { if (armed && JSON.stringify(writes).includes('"command_completed"')) { armed = false; throw new Error("service-result-write-failed"); } return commit(writes, context); };
    return storage;
  } });
  const first = await f.request(); await f.receive("批准并长期授权", await menu(f)); await done(p, first);
  armed = true; const source = await f.receive("第二次重启"); const ref = await p.service!.request({ requestId: "lost-service-result", sourceRequestId: source.key, unit: UNIT });
  await p.harness.closed; assert.equal(f.starts(), 2); await p.close(); p = await f.open();
  await until(async () => (await p.service!.status(ref)).operation.result?.code === "interrupted");
  assert.equal((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[0].active, false); assert.equal(f.starts(), 2);
});

test("Telegram 授权：历史未知核实后新建的授权跨重启保持有效", async t => {
  const f = await fixture(t); let p = await f.open(); const first = await f.request(); await f.receive("批准并长期授权", await menu(f)); await done(p, first);
  f.touch("fail-after-launch"); const second = await f.request(); await until(async () => (await p.service!.status(second)).operation.result?.code === "result_unverified");
  await p.service!.resolve(second, "applied", "测试服务计数已增加一次"); await done(p, second); fs.rmSync(path.join(f.helper, "fail-after-launch"));
  const third = await f.request(); await f.receive("批准并长期授权", await menu(f)); await done(p, third);
  await p.close(); p = await f.open(); assert.equal((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[1].active, true);
  const fourth = await f.request(); await done(p, fourth); assert.equal(f.starts(), 4);
});

test("Telegram 恢复：篡改原模式或改指未接受的控制回执均拒绝", async t => {
  for (const kind of ["mode", "declined-receipt"] as const) await t.test(kind, async t => {
    const f = await fixture(t); const p = await f.open(); const ref = await f.request(); const target = await menu(f);
    if (kind === "mode") await p.harness.commit(async tx => { (await tx.doc(PersonalServiceOperationDoc, ref.requestId, null)).operation!.mode = "full_access"; }, context);
    else {
      await f.receive("批准并长期授权", target); await done(p, ref);
      const rejected = await f.receive("批准并长期授权", target); assert.equal(rejected.value.serviceDecision, undefined);
      await p.harness.commit(async tx => { (await tx.doc(PersonalServiceGrantsDoc)).grants[0].controlRequestId = rejected.key; }, context);
    }
    await p.close(); await assert.rejects(f.open(), code(kind === "mode" ? "service_operation_invalid" : "service_grant_invalid")); assert.equal(f.starts(), kind === "mode" ? 0 : 1);
  });
});


test("Telegram 单次批准：未知可核实，接受回执的决定损坏拒绝恢复", async t => {
  for (const kind of ["resolve", "decision"] as const) await t.test(kind, async t => {
    const f = await fixture(t); const p = await f.open(); const ref = await f.request();
    if (kind === "resolve") f.touch("fail-after-launch");
    const accepted = await f.receive("批准本次", await menu(f));
    if (kind === "resolve") {
      await until(async () => (await p.service!.status(ref)).operation.result?.code === "result_unverified");
      await p.service!.resolve(ref, "applied", "测试服务状态证明已执行一次"); await done(p, ref); assert.equal(f.starts(), 1);
    } else {
      await done(p, ref);
      await p.harness.commit(async tx => { (await tx.doc(PersonalTelegramReceiptDoc, accepted.key, null)).receipt!.serviceDecision!.decision = "rejected"; }, context);
      await p.close(); await assert.rejects(f.open(), code("service_approval_invalid")); assert.equal(f.starts(), 1);
    }
  });
});


test("Telegram 权限：主会话持有新扩展标记，旧程序不能按旧审批语义恢复", async t => {
  const f = await fixture(t); const p = await f.open();
  assert.ok((await p.main.agent(context)).extensions.some(extension => extension.name === "personal-telegram-permissions"));
  await p.harness.commit(async tx => { const agent = await tx.doc(AgentDoc, p.main.id); assert.ok(Array.isArray(agent.extensions)); agent.extensions = agent.extensions.filter(name => name !== "personal-telegram-permissions"); }, context);
  await p.close(); await assert.rejects(f.open(), code("permissions_version")); assert.equal(f.starts(), 0);
});


test("Telegram 工作：原收件冻结权限，转发拒绝委派，换代不扩大旧工作权限", async t => {
  const f = await fixture(t, request => {
    if (request.system?.includes("你是个人助手的子 Agent")) return { kind: "text", text: "子结果" };
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: String(request.messages.at(-1)?.content) };
    return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: "独立分析" } }] };
  });
  const p = await f.open();
  const source = await f.receive("分析工作");
  const tasks = await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 16), context);
  assert.equal(tasks.items.length, 1);
  const work = (await p.work.list())[0];
  const taskInput = tasks.items[0].input; assert.ok(taskInput && typeof taskInput === "object" && !Array.isArray(taskInput) && typeof taskInput.requestId === "string");
  const facts = (await p.harness.snapshot(PersonalWorkDoc, taskInput.requestId, context))!;
  assert.equal(facts.source!.requestId, source.key); assert.deepEqual(facts.permission, { mode: "auto-review", version: 1 });
  assert.equal(facts.telegram!.generation, f.telegram.generation);
  await p.harness.waitForTask(facts.ref!.taskId, context);
  await f.receive("完全访问", await menu(f, "/权限"));
  assert.deepEqual((await p.harness.snapshot(PersonalWorkDoc, taskInput.requestId, context))!.permission, { mode: "auto-review", version: 1 });
  const forwarded = await f.receive("转发的分析", undefined, { forward_origin: { type: "user" } });
  assert.match(forwarded.value.reply!, /work_source_invalid/);
  assert.equal((await p.work.list()).length, 1);
  await p.close(); const restored = await f.open(); assert.equal((await restored.work.list())[0].id, work.id);
});


test("Telegram 工作：HTTP 前停用原绑定拦截子请求，正常换代仍可启动主会话", async t => {
  const f = await fixture(t, request => request.messages.at(-1)?.role === "tool" ? { kind: "text", text: "已登记" } : { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: "独立分析" } }] });
  let p!: PersonalHarness; const base = f.options.provider;
  p = await f.open({ provider: { ...base, streamSimple: (model, input, options) => base.streamSimple(model, input, { ...options, onPayload: async payload => {
    if (JSON.stringify(input).includes("你是个人助手的子 Agent")) await p.harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config!.enabled = false; }, context);
    return await options?.onPayload?.(payload, model) ?? payload;
  } }) } });
  await f.receive("后台工作");
  const tasks = await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 16), context); assert.equal(tasks.items.length, 1);
  const settled = await p.harness.waitForTask(tasks.items[0].id, context); assert.equal(settled.state.outcome.status, "failed");
  assert.equal(f.model.calls.filter(request => request.system?.includes("你是个人助手的子 Agent")).length, 0);
  await p.close(); const restored = await f.open({ telegram: { ...f.telegram, enabled: false, generation: randomUUID() } });
  assert.equal((await restored.work.list()).length, 1); assert.ok(restored.main);
});

test("子服务权限：跨轮保持首次模式，原菜单授权/撤销且本机不能代决", async t => {
  let delegation = 0;
  const f = await fixture(t, request => {
    const last = request.messages.at(-1);
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (last?.role === "tool" || last?.content === "只分析") return { kind: "text", text: "子结果" };
      return { kind: "tool_calls", calls: [{ id: "restart", name: "service_restart", arguments: { unit: UNIT } }] };
    }
    if (last?.role === "tool") return { kind: "text", text: "后台已接纳" };
    if (last?.content === "创建委托" || last?.content === "续派") return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: last.content === "创建委托" ? "只分析" : "重启", ...(delegation ? { delegation } : {}) } }] };
    return { kind: "text", text: "继续聊天" };
  });
  let p = await f.open(); await f.receive("创建委托");
  const group = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const first = (await p.harness.snapshot(PersonalDelegationDoc, String(group.entryId), context))!.delegation!.members[0]; await p.harness.waitForTask(first.taskId, context);
  delegation = (await p.harness.snapshot(PersonalWorkDoc, first.requestId, context))!.delegation!.entryId;
  await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context);
  const nextOperation = async () => {
    const previous = (await p.service!.list()).items[0]?.operation.ref.taskId;
    await f.receive("续派"); let ref!: PersonalServiceOperationRef;
    await until(async () => { const op = (await p.service!.list()).items[0]?.operation; if (!op?.snapshot || op.ref.taskId === previous) return false; ref = op.ref; return true; });
    assert.equal((await p.service!.status(ref)).operation.mode, "auto-review"); return ref;
  };
  const op = await nextOperation(); assert.equal(f.starts(), 0);
  await assert.rejects(p.service!.decide(op, "approved"), code("service_original_entry_required"));
  await f.receive("批准并长期授权", await menu(f)); await done(p, op);
  const work = (await p.service!.status(op)).operation.work!.ref; await p.harness.waitForTask(work.taskId, context);
  assert.equal(f.starts(), 1);
  const granted = await nextOperation(); await done(p, granted); await p.harness.waitForTask((await p.service!.status(granted)).operation.work!.ref.taskId, context);
  assert.equal(f.starts(), 2);
  const results = f.model.calls.filter(call => call.system?.includes("你是个人助手的子 Agent")).map(call => call.messages.at(-1)).filter(message => message?.role === "tool").map(message => JSON.parse(String(message!.content)));
  assert.equal(results.find(result => result.operation === op.taskId).approval, "拥有者已在原入口批准");
  assert.equal(results.find(result => result.operation === granted.taskId).approval, "命中原入口长期授权");
  assert.equal(results.find(result => result.operation === granted.taskId).consumed, true);
  await f.receive("撤销授权", await menu(f, "/授权")); const revoked = await nextOperation();
  assert.equal((await p.service!.status(revoked)).operation.decision, "pending"); assert.equal(f.starts(), 2);
  await p.close(); p = await f.open({ telegram: { ...f.telegram, generation: randomUUID() } });
  await done(p, revoked); assert.equal((await p.service!.status(revoked)).operation.consumed, false); assert.equal(f.starts(), 2);
});

test("子服务检查：追加本机来源保留全来源，Telegram 不能管理混合检查", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release()); let requested = false;
  const f = await fixture(t, async request => {
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: "结果" };
      requested = true; await gate; return { kind: "tool_calls", calls: [{ id: "restart", name: "service_restart", arguments: { unit: UNIT } }] };
    }
    return { kind: "text", text: "聊天继续" };
  });
  f.touch("inspection-stop-fails"); const p = await f.open(); const source = await f.receive("拥有者重启要求");
  const work = await p.work.delegate({ content: "重启", requestId: "mixed", sourceRequestId: source.key }); await until(async () => requested);
  await p.answer("本机补充资料", "local-note"); await p.work.append(work, { requestId: "note", content: "附加资料", sourceRequestId: "local-note" }); release();
  let ref!: PersonalServiceOperationRef;
  await until(async () => { const op = (await p.service!.list()).items[0]?.operation; if (!op?.result) return false; ref = op.ref; return true; });
  const inspection = (await p.inspections!.list())[0]; assert.ok(inspection); assert.equal(inspection.sources.length, 2);
  assert.deepEqual(inspection.sources, (await p.service!.status(ref)).operation.work!.sources);
  const menuResult = await f.receive("/检查"); assert.doesNotMatch(menuResult.value.reply!, /检查1|approval-test/);
  const cancel = p.work.cancel(work); await until(async () => (await p.work.status(work)).cancelRequested);
  assert.equal((await p.work.status(work)).stopVerified, false); fs.rmSync(path.join(f.helper, "inspection-stop-fails")); await p.inspections!.recheckStop(ref.taskId); await cancel;
  assert.equal(f.starts(), 0);
});


test("拥有者权限：QQ 默认模式独立于 Telegram 与本机，旧输入快照保持原形", async t => {
  const f = await fixture(t), p = await f.open();
  await p.harness.commit(async tx => {
    const telegram = await personalPermissionFor(tx);
    telegram.mode = "full_access"; telegram.version++;
    const qq = await personalPermissionFor(tx, { platform: "qq" });
    assert.deepEqual(qq, { mode: "auto-review", version: 1 });
    qq.mode = "confirm"; qq.version++;
  }, context);
  const receipt = await f.receive("各入口模式独立");
  assert.deepEqual(receipt.value.permission, { mode: "full_access", version: 2 });
  assert.equal("platform" in receipt.value, false);
  assert.deepEqual((await p.harness.snapshot(PersonalPermissionsDoc, context))!.qq, { mode: "confirm", version: 2 });
});


test("定时子服务权限：已有长期授权不继承，原菜单只能批准本次且整项等待", async t => {
  const f = await fixture(t, request => {
    const last = request.messages.at(-1);
    if (request.system?.includes("你是个人助手的子 Agent")) return last?.role === "tool" ? { kind: "text", text: "定时子服务已返回" } : { kind: "tool_calls", calls: [{ id: "restart-scheduled", name: "service_restart", arguments: { unit: UNIT } }] };
    if (last?.role === "user" && last.content === "创建定时重启") return { kind: "tool_calls", calls: [{ id: "create-scheduled", name: "schedule_create", arguments: { label: "定时服务", instruction: "请委派定时重启", rule: { kind: "once", at: new Date(Date.now() - 1000).toISOString(), time_zone: "UTC" } } }] };
    if (last?.role === "user" && last.content === "请委派定时重启") return { kind: "tool_calls", calls: [{ id: "delegate-scheduled", name: "background_work", arguments: { action: "delegate", content: "定时服务重启" } }] };
    return { kind: "text", text: "工作已收尾" };
  });
  const p = await f.open(); const first = await f.request(); await f.receive("批准并长期授权", await menu(f)); await done(p, first); assert.equal(f.starts(), 1);
  const originalGrant = (await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[0];
  await f.receive("创建定时重启");
  let operation!: PersonalServiceOperationRef;
  await until(async () => { const value = (await p.service!.list()).items[0]?.operation; if (!value || value.ref.taskId === first.taskId || !value.snapshot) return false; operation = value.ref; return true; });
  const op = (await p.service!.status(operation)).operation; assert.equal(op.decision, "pending"); assert.equal(op.grant, undefined); assert.equal(f.starts(), 1);
  const index = await p.harness.snapshot(PersonalSchedulesDoc, context); assert.equal(index!.runs.length, 1); const runId = index!.runs[0]; assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!.result, undefined);
  const approvalMenu = await f.receive("/审批"); assert.doesNotMatch(approvalMenu.value.reply!, /批准并长期授权/);
  const declined = await f.receive("批准并长期授权", Number(approvalMenu.value.platformMessageId)); assert.match(declined.value.reply!, /不能创建长期授权/); assert.equal(f.starts(), 1);
  assert.deepEqual((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants, [originalGrant]);
  await f.receive("批准本次", Number(approvalMenu.value.platformMessageId)); await done(p, operation); assert.equal(f.starts(), 2);
  await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!.result);
  assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!.result!.status, "completed");
});


test("长期授权：本机只能按原版本撤销，IM旧授权菜单不恢复权限", async t => {
  const f = await fixture(t), p = await f.open(), ref = await f.request();
  await f.receive("批准并长期授权", await menu(f)); await done(p, ref);
  const listed = await p.harness.commit(tx => listPersonalServiceGrants(tx), context), grant = listed.items[0];
  assert.equal(grant.active, true); assert.equal(grant.platform, "Telegram");
  const oldMenu = await menu(f, "/授权");
  await assert.rejects(p.harness.commit(tx => revokePersonalServiceGrant(tx, grant.id, grant.version + 1), context), code("service_grant_stale"));
  await p.harness.commit(tx => revokePersonalServiceGrant(tx, grant.id, grant.version), context);
  const current = (await p.harness.commit(tx => listPersonalServiceGrants(tx), context)).items[0];
  assert.equal(current.active, false); assert.equal(current.version, grant.version + 1);
  await f.receive("撤销授权", oldMenu);
  assert.equal((await p.harness.snapshot(PersonalServiceGrantsDoc, context))!.grants[0].version, current.version);
  const next = await f.request(); assert.equal((await p.service!.status(next)).operation.decision, "pending");
  await f.receive("拒绝", await menu(f)); await done(p, next); await p.close(); await f.open();
});
