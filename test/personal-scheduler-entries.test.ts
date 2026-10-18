import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalTelegramReceiptDoc, type TelegramReceipt } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import type { PersonalSchedule } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { PersonalQqConfig } from "../apps/ruukoto/src/personal-qq-config.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { startMockOneBot, MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET } from "./helpers/mock-onebot.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const OWNER = "880001";
const futureRule = { kind: "once", at: "2099-10-20T09:00:00+09:00", timeZone: "Asia/Tokyo", disambiguation: "compatible" } as const;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待定时入口操作超时"); await delay(10); }
}

async function modelFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-schedule-entry-")));
  const report = "整项报告：" + "甲".repeat(4500) + "🦉末页";
  const model = new MockModelServer(() => ({ kind: "text", text: report }));
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "PERSONAL_SCHEDULE_ENTRY_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const close = async () => { await model.close(); fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; };
  return { root, directory: path.join(root, "profile"), model, config, report, close };
}

test("定时HTTP入口：真实后台认证、创建去重/异参拒绝、独立运行完整报告及取消后重启", async t => {
  const f = await modelFixture(); await savePersonalConfig(f.directory, f.config);
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => { await server?.stop(); await f.close(); }); server = await startPersonalServer(f.directory);
  const denied = await new Promise<string>((resolve, reject) => {
    const request = http.request({ socketPath: path.join(f.directory, "control.sock"), path: "/schedules", method: "GET" }, response => { let body = ""; response.on("data", chunk => { body += String(chunk); }); response.on("end", () => resolve(body)); }); request.on("error", reject); request.end();
  });
  assert.equal(JSON.parse(denied).code, "control_unauthorized");
  const input = { requestId: randomUUID(), label: "独立测试", instruction: "执行本次独立观察后总结", rule: { ...futureRule, at: new Date(Date.now() - 1000).toISOString() } };
  const plan = await personalControl<PersonalSchedule>(f.directory, "POST", "/schedules", input);
  const duplicate = await personalControl<PersonalSchedule>(f.directory, "POST", "/schedules", input); assert.equal(duplicate.id, plan.id);
  await assert.rejects(personalControl(f.directory, "POST", "/schedules", { ...input, instruction: "异参" }), code("schedule_request_conflict"));
  const byRequest = await personalControl<PersonalSchedule>(f.directory, "GET", `/schedule?requestId=${input.requestId}`); assert.equal(byRequest.id, plan.id);
  type Runs = Awaited<ReturnType<PersonalHarness["scheduler"]["runs"]>>;
  let runs!: Runs;
  await until(async () => { runs = await personalControl<Runs>(f.directory, "GET", `/schedule/runs?schedule=${plan.id}`); return runs.items[0]?.state === "completed" && runs.items[0].delivery === "local"; });
  assert.equal(runs.items.length, 1);
  const runId = runs.items[0].id;
  let report = "", offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<PersonalHarness["scheduler"]["result"]>>>(f.directory, "GET", `/schedule/run/result?run=${runId}&offset=${offset}`);
    report += page.text; if (page.nextOffset === undefined) break; offset = page.nextOffset;
  }
  assert.equal(report, f.report); assert.ok(f.model.calls.length >= 2);
  assert.deepEqual(await personalControl(f.directory, "GET", "/messages"), []);
  await personalControl(f.directory, "POST", `/schedule/cancel?schedule=${plan.id}`);
  await server.stop(); server = await startPersonalServer(f.directory);
  const reopened = await personalControl<PersonalSchedule>(f.directory, "GET", `/schedule?schedule=${plan.id}`); assert.equal(reopened.canceled, true);
  assert.equal((await personalControl<{ items: PersonalSchedule[] }>(f.directory, "GET", "/schedules")).items.length, 1);
});

async function dualFixture(t: TestContext) {
  const f = await modelFixture(), bot = await startMockOneBot({});
  const telegramSends: { text: string; chat_id: string; reply_parameters: { message_id: number } }[] = [];
  const token = `${MOCK_QQ_ACCOUNT}:schedule-test-secret`;
  const telegramServer = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    const value = JSON.parse(body) as { text: string; chat_id: string; reply_parameters: { message_id: number } }; telegramSends.push(value);
    assert.ok(Array.from(value.text).length <= 4096, "Telegram发送必须保留平台长度上限");
    assert.equal(request.url, `/bot${token}/sendMessage`);
    response.end(JSON.stringify({ ok: true, result: { message_id: 1900000 + telegramSends.length, chat: { id: Number(value.chat_id), type: "private" } } }));
  });
  telegramServer.listen(0, "127.0.0.1"); await once(telegramServer, "listening"); const address = telegramServer.address(); assert.ok(address && typeof address !== "string");
  const generation = randomUUID();
  const qq: PersonalQqConfig = { version: 1, enabled: true, generation, endpoint: bot.url, tokenEnv: "SCHEDULE_ONEBOT_KEY", tokenDigest: createHash("sha256").update(MOCK_QQ_SECRET).digest("hex"), botId: MOCK_QQ_ACCOUNT, ownerId: OWNER, boundary: 10, boundaryMessageId: "0" };
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation, apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "SCHEDULE_TELEGRAM_KEY", tokenDigest: createHash("sha256").update(token).digest("hex"), botId: MOCK_QQ_ACCOUNT, ownerId: OWNER, boundary: 0 };
  const previous = new Map([qq.tokenEnv, telegram.tokenEnv].map(name => [name, process.env[name]])); process.env[qq.tokenEnv] = MOCK_QQ_SECRET; process.env[telegram.tokenEnv] = token;
  let p: PersonalHarness | undefined, aborter: AbortController | undefined, poll: Promise<void> | undefined, serial = 100;
  const stop = async () => { aborter?.abort(); await poll; poll = undefined; await p?.close(); p = undefined; };
  t.after(async () => { await stop(); await bot.close(); telegramServer.closeAllConnections(); await new Promise<void>(resolve => telegramServer.close(() => resolve())); for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } await f.close(); });
  const open = async () => { p = await openPersonalHarness({ directory: f.directory, provider: personalProvider(f.config), modelId: f.config.modelId, telegram, qq }); aborter = new AbortController(); poll = p.qq.poll(aborter.signal); await until(async () => (await p!.qq.status()).online); return p; };
  const receive = async (content: string, reply?: TelegramReceipt, platform: "telegram" | "qq" = "telegram") => {
    const id = ++serial, replyTo = reply?.platformMessageId;
    if (platform === "qq") await p!.qq.receive({ post_type: "message", message_type: "private", sub_type: "friend", self_id: Number(MOCK_QQ_ACCOUNT), user_id: Number(OWNER), message_id: id, time: 20, message: [...(replyTo ? [{ type: "reply", data: { id: replyTo } }] : []), { type: "text", data: { text: content } }] });
    else await p!.telegram.receive({ update_id: id, message: { message_id: id, chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER), is_bot: false }, text: content, ...(replyTo ? { reply_to_message: { message_id: Number(replyTo), from: { id: Number(MOCK_QQ_ACCOUNT), is_bot: true } } } : {}) } });
    const key = `${platform}:${MOCK_QQ_ACCOUNT}:${OWNER}:${id}`, saved = (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p!.harness.waitForTask(saved.taskId, context); return (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
  };
  return { ...f, bot, telegramSends, open, stop, receive };
}

test("双平台真实收件：定时草稿中的权限名/补充前缀/工作命令只作正文，确认去重与原入口取消可恢复", async t => {
  const f = await dualFixture(t); let p = await f.open();
  for (const platform of ["telegram", "qq"] as const) {
    let menu = await f.receive("/定时", undefined, platform); menu = await f.receive("新建计划", menu, platform);
    for (const content of ["一次性", "东京", futureRule.at, "完全访问"]) menu = await f.receive(content, menu, platform);
    const slash = await f.receive("/工作", menu, platform); assert.ok(slash.selection?.kind === "schedule-draft" && slash.selection.draft.instruction === "/工作");
    menu = await f.receive("补充：/工作", menu, platform); assert.ok(menu.selection?.kind === "schedule-draft" && menu.selection.draft.step === "confirm");
    const created = await f.receive("确认创建计划", menu, platform), duplicate = await f.receive("确认创建计划", menu, platform);
    assert.equal(created.scheduleCreate?.id, duplicate.scheduleCreate?.id); assert.ok(created.scheduleCreate);
    assert.equal(created.control, true); assert.equal(created.permission, undefined); assert.equal(created.submissionId, undefined);
    const other = platform === "qq" ? "telegram" : "qq";
    const crossed = await f.receive("取消这项计划", created, other); assert.equal(crossed.scheduleCancel, undefined);
    const canceled = await f.receive("取消这项计划", created, platform); assert.equal(canceled.scheduleCancel?.id, created.scheduleCreate.id);
  }
  assert.equal(f.model.calls.length, 0);
  const permissions = await p.harness.snapshot(PersonalPermissionsDoc, context); assert.equal(permissions!.mode, "auto-review"); assert.equal(permissions!.qq!.mode, "auto-review");
  const plans = await p.harness.commit(tx => p.scheduler.list(tx), context); assert.equal(plans.items.length, 2); assert.ok(plans.items.every(plan => plan.canceled && plan.label === "完全访问" && plan.instruction === "补充：/工作" && plan.permission.mode === "auto-review"));
  await f.stop(); p = await f.open();
  assert.equal((await p.harness.commit(tx => p.scheduler.list(tx), context)).items.length, 2); assert.equal(f.model.calls.length, 0);
});

test("双平台定时回报：真实宿主发送固定原确认消息，长报告菜单保留全文且重启不重发", async t => {
  const f = await dualFixture(t); let p = await f.open();
  for (const platform of ["telegram", "qq"] as const) {
    let menu = await f.receive("/定时", undefined, platform); menu = await f.receive("新建计划", menu, platform);
    for (const content of ["一次性", "东京", new Date(Date.now() - 1000).toISOString(), `短周期${platform}`, "观察后完成整项报告"]) menu = await f.receive(content, menu, platform);
    const created = await f.receive("确认创建计划", menu, platform); assert.ok(created.scheduleCreate);
    let runId = "";
    await until(async () => { const runs = await p.harness.commit(tx => p.scheduler.runs(tx, created.scheduleCreate!.id), context); runId = runs.items[0]?.id ?? ""; return runs.items[0]?.delivery === "sent"; });
    const result = await p.harness.commit(tx => p.scheduler.result(tx, runId, 0, 16384), context); assert.equal(result.text, f.report);
    if (platform === "telegram") {
      const sent = f.telegramSends.filter(item => item.text.startsWith("整项报告：")); assert.equal(sent.length, 1); assert.equal(sent[0].chat_id, OWNER); assert.equal(sent[0].reply_parameters.message_id, created.messageId);
    } else {
      const sent = f.bot.actions.filter(item => item.action === "send_private_msg" && JSON.stringify(item.params.message).includes("整项报告：")); assert.equal(sent.length, 1); assert.equal(sent[0].params.user_id, Number(OWNER));
      assert.ok(Array.isArray(sent[0].params.message)); assert.deepEqual(sent[0].params.message[0], { type: "reply", data: { id: String(created.messageId) } });
    }
    const runsMenu = await f.receive("查看运行", created, platform), first = await f.receive("运行1", runsMenu, platform), second = await f.receive("下一页定时报告", first, platform);
    assert.match(second.reply!, /🦉末页/);
  }
  const telegramCount = f.telegramSends.length, qqCount = f.bot.actions.filter(item => item.action === "send_private_msg").length;
  await f.stop(); p = await f.open();
  assert.equal((await p.harness.commit(tx => p.scheduler.list(tx), context)).items.length, 2);
  assert.equal(f.telegramSends.length, telegramCount); assert.equal(f.bot.actions.filter(item => item.action === "send_private_msg").length, qqCount);
});
