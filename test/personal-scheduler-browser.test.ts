import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { BrowserManager, type BrowserBinding } from "@ruukoto/agent/browser-manager.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalBrowser } from "../apps/ruukoto/src/personal-browser-config.ts";
import { PersonalBrowserDoc, PersonalBrowserSessionDoc, browserOperations } from "../apps/ruukoto/src/personal-browser.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalScheduleDoc, PersonalScheduleRunDoc, PersonalSchedulesDoc } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, "等待定时浏览器收尾超时"); await delay(5); } }
async function fixture(t: TestContext, action: "pause" | "open") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-scheduled-browser-"))), directory = path.join(root, "profile");
  let p: PersonalHarness | undefined, stopVerified = true;
  const states = new Map<string, BrowserBinding>(), stops: string[] = [];
  const binding = (sessionId: string) => {
    if (!states.has(sessionId)) {
      const id = createHash("sha256").update(`${directory}\0${sessionId}`).digest("hex").slice(0, 24);
      states.set(sessionId, { sessionId, generation: randomUUID(), kind: "owned", state: "closed", profileDir: null, socketDir: `/tmp/ruukoto-browser-${process.getuid?.() ?? "unknown"}-${id}`, cliSession: `rk-${id}`, cdpUrl: null, targetId: null, chrome: null, daemon: null, dashboard: null, chromePending: false, daemonPending: false, dashboardPending: false, lockDir: null, pauseTaskId: null, pauseAfterSeq: null, outcomeUnknown: false, failureCode: null, dashboardUrl: null, headed: false });
    }
    return states.get(sessionId)!;
  };
  const persist = async (sessionId: string) => {
    if (!p) return;
    await p.harness.commit(async tx => {
      const value = binding(sessionId), stateJson = JSON.stringify({ version: 1, bindings: [value] }), conversationId = Number(sessionId) as ConversationId;
      const doc = conversationId === ROOT_CONVERSATION_ID ? await tx.doc(PersonalBrowserDoc) : await tx.doc(PersonalBrowserSessionDoc, sessionId, null);
      doc.stateJson = stateJson; doc.bindingEntry = (await tx.appendEntry(conversationId, { kind: "ruukoto.browser-binding-changed", data: { stateJson, sessionId, generation: value.generation, state: value.state } })).id;
    }, context);
  };
  const previous = { start: BrowserManager.prototype.start, status: BrowserManager.prototype.status, command: BrowserManager.prototype.command, pause: BrowserManager.prototype.pause, close: BrowserManager.prototype.close };
  BrowserManager.prototype.status = session => structuredClone(binding(session));
  BrowserManager.prototype.start = async session => { const value = binding(session); value.state = "ready"; await persist(session); return structuredClone(value); };
  BrowserManager.prototype.command = async () => ({ data: { title: "隔离网页" } });
  BrowserManager.prototype.pause = async (session, taskId) => { const value = binding(session); value.state = "paused"; value.pauseTaskId = taskId; await persist(session); return structuredClone(value); };
  BrowserManager.prototype.close = async session => { stops.push(session); const verified = session === String(ROOT_CONVERSATION_ID) || stopVerified; binding(session).state = verified ? "closed" : "unavailable"; await persist(session); return verified; };
  const model = new MockModelServer(request => request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "本轮浏览器工作" ? { kind: "tool_calls", calls: [{ id: "start-browser", name: "browser", arguments: { action: "start" } }, { id: "use-browser", name: "browser", arguments: { action, ...(action === "open" ? { url: "https://example.com" } : {}) } }] } : { kind: "text", text: "完整定时结果" });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_SCHEDULE_BROWSER_TEST_KEY", contextWindow: 128000, maxTokens: 4096 }, previousKey = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  t.after(async () => { stopVerified = true; await p?.close(); await model.close(); Object.assign(BrowserManager.prototype, previous); if (previousKey === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previousKey; fs.rmSync(root, { recursive: true, force: true }); });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, browser: parsePersonalBrowser({ version: 1, generation: "scheduled-browser-probe", binaryPath: "/unused/browser", chromePath: "/unused/chrome", headed: false }) });
  await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  const requestId = randomUUID(), plan = await p.harness.commit(tx => p!.scheduler.create(tx, { requestId, label: "浏览器收尾", instruction: "本轮浏览器工作", rule: { kind: "once", at: new Date(Date.now() - 1000).toISOString(), timeZone: "UTC" } }, { kind: "local", requestId }), context);
  let runId = "";
  await until(async () => { for (const id of (await p!.harness.snapshot(PersonalSchedulesDoc, context))?.runs ?? []) if ((await p!.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.planId === plan.id) { runId = id; return true; } return false; });
  return { p, plan, runId, stops, model, setStopVerified(value: boolean) { stopVerified = value; }, run: async () => (await p!.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run! };
}

test("定时浏览器组合：人工暂停占用跨首次回答保留，取消关闭原会话后收尾", async t => {
  const f = await fixture(t, "pause");
  await until(async () => { const run = await f.run(); return run.sealed && !!(await f.p.harness.snapshot(PersonalBrowserSessionDoc, String(run.conversationId), context))?.pause; });
  const waiting = await f.run(); assert.equal(waiting.result, undefined); assert.equal((await f.p.harness.snapshot(PersonalScheduleDoc, f.plan.id, context))?.plan?.activeRun, f.runId);
  assert.equal(await f.p.answer("主聊天仍可继续", "independent-owner"), "完整定时结果");
  await f.p.harness.commit(tx => f.p.scheduler.cancel(tx, f.plan.id, { kind: "local", requestId: randomUUID() }), context);
  await until(async () => !!(await f.run()).result);
  const run = await f.run(); assert.equal(run.result?.status, "canceled"); assert.equal((await f.p.harness.snapshot(PersonalScheduleDoc, f.plan.id, context))?.plan?.activeRun, undefined); assert.ok(f.stops.includes(String(run.conversationId)));
});

test("定时浏览器组合：成功网页动作的停止核实失败不释放运行，原停止核实唤醒收尾", async t => {
  const f = await fixture(t, "open"); f.setStopVerified(false);
  await until(async () => { const run = await f.run(); return run.sealed && f.stops.includes(String(run.conversationId)); });
  const waiting = await f.run(); await delay(30); assert.equal((await f.run()).result, undefined); assert.equal((await f.p.harness.snapshot(PersonalScheduleDoc, f.plan.id, context))?.plan?.activeRun, f.runId);
  const operation = await f.p.harness.commit(async tx => (await browserOperations(tx)).filter(value => value.origin.source.requestId === waiting.requestId).at(-1)!.operation, context);
  f.setStopVerified(true); const taskId = await f.p.harness.commit(tx => f.p.browser!.requestStop(tx, operation), context); await f.p.harness.waitForTask(taskId, context);
  await until(async () => !!(await f.run()).result);
  assert.equal((await f.run()).result?.status, "completed"); assert.equal((await f.p.harness.snapshot(PersonalScheduleDoc, f.plan.id, context))?.plan?.activeRun, undefined);
});

test("定时浏览器组合：人工暂停的独立停止核实唤醒会话等待，不依赖操作再次变化", async t => {
  const f = await fixture(t, "pause");
  await until(async () => { const run = await f.run(); return run.sealed && !!(await f.p.harness.snapshot(PersonalBrowserSessionDoc, String(run.conversationId), context))?.pause; });
  const waiting = await f.run(), operation = await f.p.harness.commit(async tx => { const value = (await browserOperations(tx)).filter(value => value.origin.source.requestId === waiting.requestId).at(-1)!; return { operation: value.operation, stopped: value.stopped }; }, context);
  assert.equal(operation.stopped, true); assert.equal(await f.p.browser!.verifyStop(operation.operation), true);
  await until(async () => !!(await f.run()).result);
  assert.equal((await f.p.harness.snapshot(PersonalScheduleDoc, f.plan.id, context))?.plan?.activeRun, undefined);
});
