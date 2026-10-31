import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { CodeScheduleConfig, CodeSchedulePlan, CodeScheduleReceipt, CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { CodeScheduleRequestGuard } from "@ruukoto/control/code-schedule-requests.ts";
import type { OpParams } from "@ruukoto/control/ops.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { configForSchedule, draftForSchedule, newScheduleDraft } from "../apps/desktop/src/renderer/scheduled-state.ts";
import { DesktopNotifications, type DesktopNotice } from "../apps/desktop/src/main/notifications.ts";
import { FakeTransport, fakeSnapshot } from "./helpers/fake-control.ts";

const selection = { provider: "mock", modelId: "model", thinkingLevel: "high" as const };
const at = "2026-10-26T00:00:00.000Z";
const config: CodeScheduleConfig = { title: "检查工作区", instructions: "检查并记录结果", workspaceId: "workspace", permission: "confirm", modelSelection: selection, rule: { kind: "daily", time: "09:00", timeZone: "Asia/Tokyo", disambiguation: "compatible" } };
const workspace = { cwd: "/work", cwdReal: "/work", dev: 1, ino: 2 };
const plan: CodeSchedulePlan = { id: "plan", config, workspace, version: 1, status: "active", nextDueAt: at, reason: null, createdAt: at, updatedAt: at };
const receipt: CodeScheduleReceipt = { requestId: "save-one", operation: "create", digest: "digest", plan };
const run: CodeScheduleRun = { id: "run", scheduleId: plan.id, planVersion: 1, snapshot: config, workspace, sessionId: "session", rootTaskId: "root", scheduledAt: at, coalescedFrom: at, coalescedThrough: at, status: "active", cancelRequested: false, reason: null, version: 1, createdAt: at, closedAt: null };

test("Scheduled 表单固定保存时区，处理 DST 并保留模型、权限与星期", () => {
  const draft = { ...newScheduleDraft(selection), title: config.title, instructions: config.instructions, workspaceId: "workspace", repeat: "once" as const, date: "2027-03-14", time: "02:30", timeZone: "America/New_York" };
  const result = configForSchedule(draft, Date.parse(at));
  assert.ok("config" in result);
  assert.deepEqual(result.config.rule, { kind: "once", at: "2027-03-14T07:30:00.000Z", timeZone: "America/New_York", disambiguation: "compatible" });
  assert.equal(result.config.permission, "confirm"); assert.deepEqual(result.config.modelSelection, selection);
  const spaced = configForSchedule({ ...draft, instructions: "  保留缩进\n  第二行\n" }, Date.parse(at));
  assert.ok("config" in spaced); assert.equal(spaced.config.instructions, "  保留缩进\n  第二行\n");
  assert.equal(draftForSchedule(result.config).time, "03:30");
  assert.deepEqual(configForSchedule({ ...draft, repeat: "weekly", weekdays: [5, 1] }, Date.parse(at)), { config: { ...config, rule: { kind: "weekly", time: "02:30", weekdays: [1, 5], timeZone: "America/New_York", disambiguation: "compatible" } } });
  assert.ok("error" in configForSchedule({ ...draft, repeat: "weekly", weekdays: [] }));
  assert.ok("error" in configForSchedule({ ...draft, date: "2020-01-01" }));
  assert.ok("error" in configForSchedule({ ...draft, instructions: "汉".repeat(22_000) }));
});

test("计划写入先落盘，丢答后查询原回执并按原参数核实；换实例不重放", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-schedule-request-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PendingRequestStore(dir), sent: unknown[] = [];
  let lost = true;
  const transport = new FakeTransport({ handlers: {
    code_schedule_save: params => { assert.equal(store.read(params.request_id).kind, "record"); sent.push(structuredClone(params)); if (lost) throw new ControlClientError("timeout", "测试丢答", "unknown"); return receipt; },
    code_schedule_receipt: params => { assert.equal(params.request_id, receipt.requestId); return { receipt }; },
  } });
  const guard = new CodeScheduleRequestGuard(store, { instanceId: "instance", request: transport.request.bind(transport) });
  const params: OpParams<"code_schedule_save"> = { request_id: receipt.requestId, config };
  assert.equal((await guard.write("code_schedule_save", params)).kind, "pending_verification");
  const pending = store.list().records[0];
  const foreign = new CodeScheduleRequestGuard(store, { instanceId: "different", request: transport.request.bind(transport) });
  assert.equal((await foreign.reconcile(pending)).kind, "foreign_instance"); assert.equal(sent.length, 1);
  lost = false; assert.equal((await guard.reconcile(pending)).kind, "linked");
  assert.deepEqual(sent, [params, params]); assert.equal(store.list().records.length, 0);
  assert.deepEqual(transport.requests.map(item => item.op), ["code_schedule_save", "code_schedule_receipt", "code_schedule_save"]);
});

test("原计划请求损坏或落盘失败时不发送；未知字段和未绑定的运行确认不能恢复", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-schedule-invalid-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PendingRequestStore(dir), transport = new FakeTransport({ handlers: { code_schedule_save: () => receipt } });
  const pending = { requestId: "invalid", op: "code_schedule_control" as const, params: { request_id: "invalid", plan_id: "plan", expected_version: 1, control: "resume", acknowledge_run_id: "run" }, instanceId: "instance", createdAt: at };
  store.save(pending); assert.equal(store.read("invalid").kind, "corrupt");
  const corruptGuard = new CodeScheduleRequestGuard(store, { instanceId: "instance", request: transport.request.bind(transport) });
  await assert.rejects(corruptGuard.write("code_schedule_save", { request_id: "invalid", config }), { code: "request_conflict" });
  assert.equal(transport.requests.length, 0);
  store.remove("invalid");
  const forged = { request_id: "forged", config, credential: "不得落盘" };
  await assert.rejects(corruptGuard.write("code_schedule_save", forged), { code: "invalid_params" });
  assert.equal(store.read("forged").kind, "absent");
  assert.equal(transport.requests.length, 0);
  fs.renameSync(dir, `${dir}-moved`); t.after(() => fs.rmSync(`${dir}-moved`, { recursive: true, force: true }));
  const guard = new CodeScheduleRequestGuard(store, { instanceId: "instance", request: transport.request.bind(transport) });
  await assert.rejects(guard.write("code_schedule_save", { request_id: "unsaved", config }));
  assert.equal(transport.requests.length, 0);
});

test("Scheduled 重复保存只发送一次，草稿与未决请求按实例保留", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), writes: unknown[] = [];
  const model = new CodeState({ request: async (_target, op, params) => {
    if (op === "code_schedule_save") { writes.push(params); await wait; return { ok: true, value: { kind: "pending_verification", requestId: params.request_id, reason: "待核实" } }; }
    return { ok: true, value: op === "code_schedules" ? { plans: [], nextOffset: null } : { plan, runs: [], activeRun: null, nextRunOffset: null } };
  } }, () => {});
  model.update({ type: "snapshot", result: { snapshot: fakeSnapshot(), replay: [], seq: 0 }, instanceChanged: false }); model.update({ type: "state", state: "online" });
  model.scheduled.create(); model.scheduled.draft = draftForSchedule(config);
  const currentDraftTitle = () => model.scheduled.draft?.title;
  const first = model.scheduled.save(); await model.scheduled.save(); assert.equal(writes.length, 1);
  release(); await first; assert.equal(model.scheduled.draft?.title, config.title);
  model.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ instanceId: "another" }), replay: [], seq: 0 }, instanceChanged: true });
  assert.equal(model.scheduled.draft, null); assert.equal(writes.length, 1);
  model.update({ type: "snapshot", result: { snapshot: fakeSnapshot(), replay: [], seq: 0 }, instanceChanged: true });
  assert.equal(currentDraftTitle(), config.title); assert.equal(writes.length, 1);
});

test("定时通知等待整项关闭，首次任务结束与重连补发不提前或重复通知", () => {
  const notices: DesktopNotice[] = [];
  const notifications = new DesktopNotifications(() => false, notice => notices.push(notice), () => {}, async () => { throw new Error("本例不需任务查询"); });
  notifications.update("code", { type: "snapshot", instanceChanged: false, result: { snapshot: fakeSnapshot({ codeScheduleRuns: [run] }), replay: [], seq: 0 } });
  const event = (seq: number, body: PersistentEvent["body"], kind: "live" | "replay" = "live") => notifications.update("code", { type: "event", kind, event: { seq, body, taskId: "taskId" in body ? body.taskId : "root", sessionId: "sessionId" in body ? body.sessionId : "session", createdAt: at } });
  event(1, { type: "task.queued", inputPurpose: "user", taskId: "child", sessionId: "child-session", requestId: "delegated", accessMode: "confirm", planMode: false, modelSelection: selection, queueOrder: 1 });
  event(2, { type: "code_schedule.task_bound", taskId: "child", sessionId: "child-session", runId: run.id });
  event(3, { type: "task.completed", taskId: "child", sessionId: "child-session" }); assert.equal(notices.length, 0);
  // 没有完整任务快照时，运行账本也必须压住根任务级通知。
  event(4, { type: "task.completed", taskId: "root", sessionId: "session" }); assert.equal(notices.length, 0);
  const closed: CodeScheduleRun = { ...run, status: "completed", closedAt: at, version: 2 };
  event(5, { type: "code_schedule.run_changed", run: closed }); event(5, { type: "code_schedule.run_changed", run: closed }, "replay");
  notifications.update("code", { type: "snapshot", instanceChanged: false, result: { snapshot: fakeSnapshot({ codeScheduleRuns: [closed] }), replay: [], seq: 5 } });
  assert.equal(notices.length, 1); assert.equal(notices[0].taskId, "root"); assert.match(notices[0].title, /定时运行/);
});

test("Code 计划控制面真实接纳与回读，原键幂等且拒绝越权字段和过期版本", async t => {
  const { Runtime } = await import("@ruukoto/runtime/runtime.ts");
  const { ControlServer } = await import("@ruukoto/control/server.ts");
  const { createMockTools } = await import("@ruukoto/agent/mock-tools.ts");
  const { product } = await import("../apps/ruukoto-code/src/product.ts");
  const { MockModelServer } = await import("./helpers/mock-provider.ts");
  const { cleanupDirs, connectAuthedClient, makeTestDirs, writeModelsJson } = await import("./helpers/testkit.ts");
  const { dirs, work } = await makeTestDirs("code-schedule-control", 1), server = new MockModelServer(() => ({ kind: "text", text: "不应执行" }));
  let runtime: Awaited<ReturnType<typeof Runtime.start>> | undefined, client: Awaited<ReturnType<typeof connectAuthedClient>> | undefined;
  t.after(async () => { client?.close(); await runtime?.stop("test_end"); await server.close(); await cleanupDirs(dirs); });
  await writeModelsJson(dirs, await server.start());
  runtime = await Runtime.start({ product: product.runtime, dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "control.sock"), modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", toolFactory: context => createMockTools(context) });
  await ControlServer.start(runtime); client = await connectAuthedClient(runtime);
  const { session: workspaceSession } = await runtime.openWorkspace({ cwd: work[0] });
  const savedConfig: CodeScheduleConfig = { ...config, workspaceId: workspaceSession.projectId, modelSelection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, rule: { kind: "once", at: new Date(Date.now() + 3_600_000).toISOString(), timeZone: "Asia/Tokyo", disambiguation: "compatible" } };
  const params = { request_id: "control-create", config: savedConfig };
  const saved = await client.request<CodeScheduleReceipt>("code_schedule_save", params);
  assert.deepEqual(await client.request("code_schedule_save", params), saved);
  assert.deepEqual((await client.request<{ plan: CodeSchedulePlan }>("code_schedule", { plan_id: saved.plan.id })).plan.config, savedConfig);
  assert.equal((await client.request<{ plans: CodeSchedulePlan[] }>("code_schedules", { limit: 1 })).plans[0].id, saved.plan.id);
  await assert.rejects(client.request("code_schedule_save", { ...params, config: { ...savedConfig, instructions: "另一份正文" } }), { code: "request_conflict" });
  await assert.rejects(client.request("code_schedule_save", { request_id: "forged", config: { ...savedConfig, source: { kind: "coding-owner" } } }), { code: "invalid_params" });
  await assert.rejects(client.request("code_schedule_save", { request_id: "no-version", plan_id: saved.plan.id, config: savedConfig }), { code: "invalid_params" });
  await assert.rejects(client.request("code_schedules", { limit: 101 }), { code: "invalid_params" });
  await assert.rejects(client.request("code_schedule_control", { request_id: "unbound-ack", plan_id: saved.plan.id, expected_version: saved.plan.version, control: "resume", acknowledge_run_id: "run" }), { code: "invalid_params" });
  const pause = { request_id: "control-pause", plan_id: saved.plan.id, expected_version: saved.plan.version, control: "pause" };
  const paused = await client.request<CodeScheduleReceipt>("code_schedule_control", pause);
  assert.equal(paused.plan.status, "paused"); assert.deepEqual(await client.request("code_schedule_control", pause), paused);
  await assert.rejects(client.request("code_schedule_control", { ...pause, request_id: "stale-pause" }), { code: "schedule_version_conflict" });
  const resumed = await client.request<CodeScheduleReceipt>("code_schedule_control", { request_id: "control-resume", plan_id: saved.plan.id, expected_version: paused.plan.version, control: "resume" });
  assert.equal(resumed.plan.status, "active");
  const canceled = await client.request<CodeScheduleReceipt>("code_schedule_control", { request_id: "control-cancel", plan_id: saved.plan.id, expected_version: resumed.plan.version, control: "cancel" });
  assert.equal(canceled.plan.status, "canceled"); assert.equal(server.calls.length, 0);
});

test("编辑草稿固定原版本；并发更新后保留草稿，核对当前配置才允许再次保存", async () => {
  const current = { ...plan, version: 2, config: { ...config, title: "其他客户端修改" } }, writes: OpParams<"code_schedule_save">[] = [];
  const model = new CodeState({ request: async (_target, op, params) => {
    if (op === "code_schedule_save") {
      const input = params as OpParams<"code_schedule_save">; writes.push(input);
      return input.expected_version === 1 ? { ok: true, value: { kind: "rejected", requestId: input.request_id, code: "schedule_version_conflict", reason: "过期版本" } }
        : { ok: true, value: { kind: "accepted", requestId: input.request_id, receipt: { ...receipt, requestId: input.request_id, plan: { ...current, config: input.config } } } };
    }
    return { ok: true, value: op === "code_schedules" ? { plans: [current], latestRuns: [], nextOffset: null } : { plan: current, runs: [], activeRun: null, nextRunOffset: null } };
  } }, () => {});
  model.update({ type: "snapshot", result: { snapshot: fakeSnapshot(), replay: [], seq: 0 }, instanceChanged: false }); model.update({ type: "state", state: "online" });
  model.scheduled.selectedId = plan.id; model.scheduled.detail = { plan, runs: [], activeRun: null, nextRunOffset: null }; model.scheduled.edit();
  model.scheduled.draft!.instructions = "我的草稿";
  await model.scheduled.open(plan.id, true);
  assert.equal(model.scheduled.detail.plan.version, 2);
  await model.scheduled.save(); assert.equal(writes[0].expected_version, 1); assert.equal(model.scheduled.needsReview, true); assert.equal(model.scheduled.draft!.instructions, "我的草稿");
  await model.scheduled.save(); assert.equal(writes.length, 1);
  await model.scheduled.open(plan.id, true); model.scheduled.reviewed(); await model.scheduled.save();
  assert.equal(writes[1].expected_version, 2); assert.equal(writes[1].config.instructions, "我的草稿");
});
