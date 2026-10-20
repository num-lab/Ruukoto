import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, defineTask, type EntryId } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { choosePersonalScheduleRule, managePersonalSchedules, pendingPersonalSchedules } from "../apps/ruukoto/src/personal-scheduler-cli.ts";
import { pendingPersonalInputs } from "../apps/ruukoto/src/personal-cli.ts";
import { parsePersonalScheduleCreate, personalScheduleControl, verifyScheduleControls, type PersonalScheduleCreateBody } from "../apps/ruukoto/src/personal-scheduler-controls.ts";
import { PERSONAL_SCHEDULE_PENDING_FILE, lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalTelegramReceiptDoc, samePersonalEntry, type TelegramControlInput, type TelegramReceipt, type TelegramResult } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalScheduleRunDoc, type PersonalSchedule, type PersonalScheduleActor, type PersonalScheduleRun } from "../apps/ruukoto/src/personal-scheduler-records.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
type Scheduler = Parameters<typeof personalScheduleControl>[2];
const rule = { kind: "daily", time: "09:30", timeZone: "Asia/Tokyo", disambiguation: "compatible" } as const;
const body = () => ({ requestId: randomUUID(), label: "晨间汇总", instruction: "检查天气并汇总", rule });
function scripted(answers: string[]) {
  let output = ""; const prompts: string[] = [];
  return { io: { question: async (prompt: string) => { prompts.push(prompt); assert.ok(answers.length, prompt); return answers.shift()!; }, write: (text: string) => { output += text; } }, output: () => output, prompts, remaining: answers };
}

async function socketFixture(t: TestContext, loseCreate = false) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "personal-schedule-ui-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const token = "a".repeat(64); fs.writeFileSync(path.join(directory, "control.token"), token);
  let created: PersonalScheduleCreateBody | undefined, creates = 0, canceled = false;
  const report = "甲".repeat(4500) + "🦉末页";
  const routes: string[] = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const url = new URL(req.url!, "http://localhost"); routes.push(`${req.method} ${url.pathname}`);
    let result: unknown;
    if (req.method === "GET" && url.pathname === "/status") result = {};
    else if (req.method === "POST" && url.pathname === "/schedules") {
      let text = ""; for await (const chunk of req) text += String(chunk);
      created = parsePersonalScheduleCreate(JSON.parse(text)); creates++;
      if (loseCreate) { req.socket.destroy(); return; }
      result = { id: "saved-plan" };
    } else if (req.method === "GET" && url.pathname === "/schedules") result = { items: created ? [{ ...created, id: "saved-plan", canceled, nextDueAt: null }] : [] };
    else if (req.method === "GET" && url.pathname === "/schedule") result = url.searchParams.has("requestId") ? created?.requestId === url.searchParams.get("requestId") ? { id: "saved-plan" } : null : { ...created, id: "saved-plan", canceled, nextDueAt: null };
    else if (req.method === "GET" && url.pathname === "/schedule/runs") result = { items: [{ id: "saved-run", planId: "saved-plan", scheduledFor: "2026-10-18T00:00:00Z", mergedFrom: "2026-10-18T00:00:00Z", mergedThrough: "2026-10-18T00:00:00Z", state: "completed", delivery: "local" }] };
    else if (req.method === "GET" && url.pathname === "/schedule/run/result") { const offset = Number(url.searchParams.get("offset")); result = { runId: "saved-run", state: "completed", text: report.slice(offset, offset + 4096), delivery: "local", ...(offset + 4096 < report.length ? { nextOffset: offset + 4096 } : {}) }; }
    else if (req.method === "POST" && url.pathname === "/schedule/cancel") { canceled = true; result = { cancelRequested: true }; }
    else { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ v: 1, ok: true, result }));
  });
  server.listen(path.join(directory, "control.sock")); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { directory, routes, created: () => created, creates: () => creates, report, seed: () => { created = body(); } };
}

test("调度向导：选择每周与IANA时区并保存多星期，用户不提供内部键", async t => {
  const f = await socketFixture(t);
  const s = scripted(["1", "3", "4", "Europe/London", "09:30", "1", "7", "8", "周报", "汇总本周事项", "2", "4"]);
  await managePersonalSchedules(s.io, f.directory);
  assert.equal(s.remaining.length, 0); assert.equal(f.creates(), 1);
  assert.deepEqual(f.created()?.rule, { kind: "weekly", time: "09:30", weekdays: [1, 7], timeZone: "Europe/London", disambiguation: "compatible" });
  assert.equal(pendingPersonalSchedules(f.directory).length, 0);
  assert.doesNotMatch(s.prompts.join("\n"), /requestId|planId|UUID|内部键/);
  assert.match(s.output(), /计划已创建/);
});

test("调度向导：创建已接纳但应答丢失，恢复只查原程序键且不创建第二份", async t => {
  const f = await socketFixture(t, true);
  const s = scripted(["1", "2", "1", "09:30", "每日汇总", "汇总事项", "2"]);
  await assert.rejects(managePersonalSchedules(s.io, f.directory), code("control_response_lost"));
  const pending = pendingPersonalSchedules(f.directory); assert.equal(pending.length, 1); assert.equal(pending[0].requestId, f.created()?.requestId);
  const recovered = scripted(["3", "4"]); await managePersonalSchedules(recovered.io, f.directory);
  assert.equal(f.creates(), 1); assert.equal(pendingPersonalSchedules(f.directory).length, 0);
  assert.match(recovered.output(), /已受理原计划/);
});

test("调度向导：从计划选择原运行、分页完整报告与整项取消，始终通过认证后台", async t => {
  const f = await socketFixture(t); f.seed();
  const s = scripted(["2", "1", "2", "1", "2", "2", "2", "3", "3", "2", "4"]);
  await managePersonalSchedules(s.io, f.directory);
  assert.equal(s.remaining.length, 0); assert.ok(s.output().includes("甲".repeat(4096))); assert.match(s.output(), /🦉末页/);
  assert.match(s.output(), /取消已登记/); assert.equal(f.routes.filter(route => route === "POST /schedule/cancel").length, 1);
  assert.doesNotMatch(s.prompts.join("\n"), /requestId|planId|runId|UUID|内部键/);
});

test("调度向导：坏规则不保存，返回不创建，独立待核实文件可由原档案保护", async t => {
  const s = scripted(["1", "1", "2026-10-20T09:00:00"]);
  await assert.rejects(choosePersonalScheduleRule(s.io), code("schedule_rule_invalid"));
  assert.equal(await choosePersonalScheduleRule(scripted(["4"]).io), undefined);
  const once = await choosePersonalScheduleRule(scripted(["1", "1", "2026-10-20T09:00:00+09:00"]).io); assert.equal(once?.kind, "once");
  assert.throws(() => parsePersonalScheduleCreate({ ...body(), permission: { mode: "full_access" } }), code("schedule_input_invalid"));
  const directory = fs.mkdtempSync(path.join(tmpdir(), "personal-schedule-pending-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  lockPersonalProfile(directory).release();
  const input = body(), filename = `pending-schedule-${input.requestId}.json`;
  assert.ok(PERSONAL_SCHEDULE_PENDING_FILE.test(filename)); fs.writeFileSync(path.join(directory, filename), JSON.stringify(input));
  lockPersonalProfile(directory).release(); assert.equal(pendingPersonalSchedules(directory)[0].requestId, input.requestId); assert.deepEqual(pendingPersonalInputs(directory), []);
  fs.writeFileSync(path.join(directory, filename), JSON.stringify({ ...input, requestId: randomUUID() }));
  assert.throws(() => pendingPersonalSchedules(directory), code("schedule_pending_invalid"));
});

async function controlsFixture(t: TestContext) {
  const task = defineTask<{ requestId: string }, { phase: "done" }, TelegramResult>({ name: "ruukoto.telegram-input", version: 1, initial: () => ({ phase: "done" }), phases: { async done() { assert.fail("菜单测试不运行收件任务"); } }, abort: async () => {} });
  const registry = createRegistry(); registry.install(defineExtension({ name: "test-scheduler-menu", tasks: [task] }));
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "SCHEDULER_UI_UNUSED_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => { assert.fail("宿主调度菜单不能调用模型"); });
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  const p = { harness, main: await harness.root(context) }; t.after(() => harness.close(context));
  let serial = 0, creates = 0, cancels = 0; const plans = new Map<string, PersonalSchedule>(), keys: string[] = [], runs = new Map<string, PersonalScheduleRun>();
  const scheduler: Scheduler = {
    async create(_tx, input, actor) {
      const prior = [...plans.values()].find(plan => plan.requestId === input.requestId); if (prior) return prior;
      assert.equal(actor.kind, "im"); creates++;
      const origin = actor.kind === "im" ? actor.input : undefined;
      const permission = { mode: "auto-review" as const, version: 1 };
      const plan: PersonalSchedule = { id: `plan-${creates}`, version: 1, requestId: input.requestId, label: input.label, instruction: input.instruction, rule, createdAt: "2026-10-18T00:00:00Z", createdBy: { actor, authority: { permission, proof: {} } }, permission, scope: { tools: [], extensions: [], snapshot: {} }, admission: 1 as EntryId, nextDueAt: null, canceled: false, ...(origin ? { telegram: { botId: origin.botId, ownerId: origin.ownerId, generation: origin.generation, ...(origin.platform ? { platform: origin.platform } : {}), ...permission } } : {}) };
      plans.set(plan.id, plan); return plan;
    },
    async createByRequest(_tx, requestId) { return [...plans.values()].find(plan => plan.requestId === requestId) ?? null; },
    async list(_tx, _offset, actor) { return { items: [...plans.values()].filter(plan => !actor || samePersonalEntry(plan.telegram, actor)) }; },
    async get(_tx, id) { const plan = plans.get(id); assert.ok(plan); return plan; },
    async cancel(_tx, id, actor: PersonalScheduleActor) { assert.equal(actor.kind, "im"); plans.get(id)!.canceled = true; cancels++; return plans.get(id)!; },
    async runs(_tx, id) { return { items: [...runs.values()].filter(run => run.planId === id).map(run => ({ id: run.id, planId: id, scheduledFor: run.scheduledFor, mergedFrom: run.mergedFrom, mergedThrough: run.mergedThrough, state: "completed", delivery: "sent" as const })) }; },
    async result(_tx, runId, offset = 0, size = 4096) { assert.equal(size, 2400); return { runId, state: "completed", text: offset ? "🦉原报告末页" : "甲".repeat(2399), ...(offset ? {} : { nextOffset: 2399 }), delivery: "sent" }; },
  };
  async function receive(content: string, reply?: TelegramReceipt, platform?: "qq", direct = true, sent = true) {
    const requestId = `schedule-menu-${++serial}`, input: TelegramControlInput = { ...(platform ? { platform } : {}), requestId, generation: "generation", botId: "123", ownerId: "456", messageId: serial, updateId: serial, content, direct, delivery: "waiting", ...(reply ? { replyTo: Number(reply.platformMessageId), replyBotId: "123" } : {}) };
    let receipt!: TelegramReceipt;
    await p.harness.commit(async tx => {
      const handled = await personalScheduleControl(tx, input, scheduler); assert.equal(handled, true);
      const taskId = await tx.createTask(task, { requestId }, { conversationId: p.main.id, ownership: { kind: "conversation" }, background: true });
      receipt = { ...input, control: true, taskId, delivery: sent ? "sent" : "effect_unknown", platformMessageId: String(serial + 1000) };
      (await tx.doc(PersonalTelegramReceiptDoc, requestId, null)).receipt = receipt; keys.push(requestId);
    }, context);
    return receipt;
  }
  async function addRun(planId: string, receipt: TelegramReceipt) {
    const run: PersonalScheduleRun = { id: `run-${planId}`, planId, planVersion: 1, scheduledFor: "2026-10-18T00:00:00Z", mergedFrom: "2026-10-18T00:00:00Z", mergedThrough: "2026-10-18T00:00:00Z", admission: 1 as EntryId, taskId: receipt.taskId, conversationId: p.main.id, requestId: `run-source-${planId}`, cancelRequested: false, sealed: true, members: [] };
    runs.set(run.id, run); await p.harness.commit(async tx => { (await tx.doc(PersonalScheduleRunDoc, run.id, null)).run = run; }, context); return run;
  }
  return { p, scheduler, keys, plans, receive, addRun, creates: () => creates, cancels: () => cancels };
}

test("双平台定时菜单：逐步草稿与确认回链零模型，同草稿重复确认只创建一项", async t => {
  const f = await controlsFixture(t);
  for (const platform of [undefined, "qq"] as const) {
    let menu = await f.receive("/定时", undefined, platform);
    menu = await f.receive("新建计划", menu, platform);
    for (const content of ["每日", "东京", "09:30", "晨间计划", "汇总事项"]) menu = await f.receive(content, menu, platform);
    assert.equal(menu.selection?.kind, "schedule-draft"); assert.match(menu.reply!, /确认创建计划/);
    const created = await f.receive("确认创建计划", menu, platform);
    const duplicate = await f.receive("确认创建计划", menu, platform);
    assert.equal(created.scheduleCreate?.id, duplicate.scheduleCreate?.id);
    await f.addRun(created.scheduleCreate!.id, created);
    const runs = await f.receive("查看运行", created, platform);
    const first = await f.receive("运行1", runs, platform), next = await f.receive("下一页定时报告", first, platform);
    assert.match(next.reply!, /🦉原报告末页/); assert.ok(Array.from(first.reply!).length < 3900);
    await f.receive("取消这项计划", created, platform);
  }
  assert.equal(f.creates(), 2); assert.equal(f.cancels(), 2); assert.ok((await f.p.harness.inspect(context)).tasks.every(task => task.record.kind === "ruukoto.telegram-input"));
  await f.p.harness.commit(tx => verifyScheduleControls(tx, f.keys, true, f.scheduler), context);
});

test("定时菜单：跨平台、摘录、未送达及无原菜单不能创建或取消，坏草稿恢复拒绝", async t => {
  const f = await controlsFixture(t);
  const menu = await f.receive("/定时"), unknown = await f.receive("/定时", undefined, undefined, true, false);
  const cross = await f.receive("新建计划", menu, "qq"); assert.equal(cross.selection, undefined);
  const missing = await f.receive("新建计划"); assert.equal(missing.selection, undefined);
  const forwarded = await f.receive("新建计划", menu, undefined, false); assert.equal(forwarded.selection, undefined);
  const lost = await f.receive("新建计划", unknown); assert.equal(lost.selection, undefined);
  const draft = await f.receive("新建计划", menu);
  await f.p.harness.commit(async tx => { const value = (await tx.doc(PersonalTelegramReceiptDoc, draft.requestId, null)).receipt!; assert.ok(value.selection?.kind === "schedule-draft"); value.selection.draft.step = "confirm"; }, context);
  await assert.rejects(f.p.harness.commit(tx => verifyScheduleControls(tx, f.keys, true, f.scheduler), context), code("schedule_menu_invalid"));
  assert.equal(f.creates(), 0); assert.equal(f.cancels(), 0); assert.ok((await f.p.harness.inspect(context)).tasks.every(task => task.record.kind === "ruukoto.telegram-input"));
});
