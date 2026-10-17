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
import { AgentDoc, SessionFailed } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram.ts";
import { PersonalServiceGrantsDoc, PersonalServiceOperationDoc, type PersonalServiceOperationRef } from "../apps/ruukoto/src/personal-service-operations.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

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
