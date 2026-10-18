import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type ConversationId, type Harness, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { firstDue, latestAtOrBefore, nextAfter, parseRule, RuleError } from "@ruukoto/channels/scheduler/time.ts";
import { PersonalError } from "./personal-error.ts";
import { PersonalImApiError } from "./personal-im-api.ts";
import { telegramSourceActive } from "./personal-permissions.ts";
import { samePersonalEntry, type PersonalEntryIdentity } from "./personal-telegram-records.ts";
import { personalWorkResult, personalWorkStatus, requestPersonalWorkCancel } from "./personal-work.ts";
import { personalServiceSourceBlocker } from "./personal-service-operations.ts";
import { PERSONAL_SCHEDULER, PersonalSchedulesDoc, PersonalScheduledConversationDoc, PersonalScheduleDoc, PersonalScheduleRunDoc, ScheduleAdmission, ScheduleRunAdmission, ScheduleCancellation, ScheduleRunCancellation, ScheduleSummary, ScheduleResult, ScheduleSendAdmission, ScheduleSendClaim, ScheduleSendObservation, SCHEDULE_INPUT, SCHEDULE_SUMMARY_INPUT, SCHEDULE_RUN_TASK, SCHEDULE_SEND_TASK, SCHEDULE_SUPERVISOR_TASK, verifyScheduleSupervisor, scheduleAdmissionData, scheduleRunAdmissionData, scheduleRequestId, personalScheduleReportText, personalSchedule, personalScheduleRun, type PersonalSchedule, type PersonalScheduleActor, type PersonalScheduleAuthority, type PersonalScheduleRun, type PersonalScheduleScope } from "./personal-scheduler-records.ts";

export type PersonalScheduleBody = { requestId: string; label: string; instruction: string; rule: unknown };
type RunInput = { runId: string };
export type PersonalScheduleRuntime = TaskRuntime<RunInput, { phase: "run" } | { phase: "summarize" }, object, object>;
export type PersonalSchedulerDeps = {
  authorize(tx: Tx, actor: PersonalScheduleActor): Promise<PersonalScheduleAuthority>;
  verifyCreator(tx: Tx, plan: PersonalSchedule): Promise<void>;
  captureScope(tx: Tx): Promise<PersonalScheduleScope>;
  verifyScope(tx: Tx, scope: PersonalScheduleScope): Promise<void>;
  configure(tx: Tx, conversationId: ConversationId, plan: PersonalSchedule, options: { summary: boolean }): Promise<void>;
  settle(run: PersonalScheduleRun, runtime: PersonalScheduleRuntime, context: Context, cancel: boolean): Promise<{ failed: boolean; facts: string }>;
  send(plan: PersonalSchedule, text: string, signal: AbortSignal): Promise<string>;
  now?: () => number;
};
const context = BACKGROUND_CONTEXT;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = <T>(value: T): T => copyJson(value) as T;
async function runState(tx: Tx, run: PersonalScheduleRun) {
  if (run.result) return run.result.status;
  if (run.cancelRequested) return "canceling";
  const source = await tx.submissionByRequest(run.conversationId, run.requestId);
  if (source?.entry && await personalServiceSourceBlocker(tx, run.requestId)) return "paused";
  return (await tx.task(run.taskId))?.state.status ?? "missing";
}
function pageText(text: string, offset: number, size = 4096) { let end = Math.min(text.length, offset + size); if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--; return { text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) }; }
function pageOffset(offset: number) { if (!Number.isSafeInteger(offset) || offset < 0) throw new PersonalError("schedule_input_invalid", "分页位置无效，请重新查询原计划。"); }
async function canceled(runtime: PersonalScheduleRuntime, id: string, context: Context) {
  const watch = await runtime.watchDoc(PersonalScheduleRunDoc, id, context);
  if (!watch) throw new PersonalError("schedule_run_missing", "定时运行记录缺失，已保留占用；请查询原计划。");
  const promise = new Promise<void>((resolve, reject) => { const check = (value: typeof watch.value) => { if (!value?.run) reject(new PersonalError("schedule_run_missing", "原定时运行记录缺失，请保留档案。")); else if (value.run.cancelRequested) resolve(); }; watch.start(async value => { check(value); }); check(watch.value); void watch.closed.then(() => resolve()); });
  return { watch, promise };
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-18-personal-durable-scheduled-work.md
export function personalScheduler(getHarness: () => Harness, deps: PersonalSchedulerDeps) {
  const now = deps.now ?? Date.now;
  const runTask = defineTask<RunInput, { phase: "run" } | { phase: "summarize" }, object>({
    name: SCHEDULE_RUN_TASK, version: 1, initial: () => ({ phase: "run" }),
    phases: {
      async run(current, runtime, taskContext) {
        let saved!: PersonalScheduleRun, plan!: PersonalSchedule;
        await runtime.commit(async tx => { const run = await personalScheduleRun(tx, current.input.runId); if (run.taskId !== current.id) throw new PersonalError("schedule_record_invalid", "定时执行与原运行不符，请保留档案。"); saved = copy(run); plan = copy(await personalSchedule(tx, run.planId)); return undefined; }, taskContext);
        if (saved.result) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), taskContext); return; }
        const conversation = await runtime.conversation(saved.conversationId, taskContext);
        if (!conversation) throw new PersonalError("schedule_run_missing", "原定时会话缺失，已保留占用；请查询原计划。");
        let failed = false;
        if (!saved.cancelRequested) {
          try {
            await runtime.commit(async tx => { const run = await personalScheduleRun(tx, saved.id); const live = await personalSchedule(tx, run.planId); if (run.cancelRequested || live.canceled) throw new PersonalError("schedule_run_inactive", "定时计划已取消，未执行。"); await deps.verifyScope(tx, live.scope); if (live.telegram && !await telegramSourceActive(tx, live.telegram)) throw new PersonalError("schedule_run_inactive", "原定时入口已失效，未执行。"); return undefined; }, taskContext);
          } catch (error) { if (!(error instanceof PersonalError)) throw error; await conversation.abort(taskContext, { background: true }); await drain(saved.id, runtime, taskContext, true); await runtime.commit(async tx => finish(tx, saved.id, "failed", "本次定时工作已停止：原配置、资料范围或拥有者入口无法核实。请查询原运行和外部操作，核实后重新创建计划。"), taskContext); return; }
          const submission = await conversation.submit({ type: "input", content: plan.instruction, requestId: saved.requestId, entry: { kind: SCHEDULE_INPUT, data: { runId: saved.id, admission: saved.admission } }, whenBusy: "reject" }, taskContext);
          await runtime.commit(async tx => { const run = await personalScheduleRun(tx, saved.id); const input = await tx.submissionByRequest(run.conversationId, run.requestId); if (input?.id !== submission.id) throw new PersonalError("schedule_record_invalid", "定时输入接纳无法核实，请保留档案。"); run.submissionId = submission.id; if (input.entry) run.entryId = input.entry; return undefined; }, taskContext);
          const cancel = await canceled(runtime, saved.id, taskContext);
          try {
            const settled = await Promise.race([submission.wait(taskContext), cancel.promise.then(() => undefined)]);
            failed = settled?.status !== "done";
            await conversation.abort(taskContext, { background: true });
            await runtime.commit(async tx => { const run = await personalScheduleRun(tx, saved.id); const input = await tx.submissionByRequest(run.conversationId, run.requestId); run.sealed = true; if (input?.entry) run.entryId = input.entry; if (settled?.status === "done" && settled.type === "input") run.initialAnswer = settled.answer; return undefined; }, taskContext);
          } finally { await cancel.watch.stop(); }
        } else await conversation.abort(taskContext, { background: true });
        const settlement = await drain(saved.id, runtime, taskContext);
        await runtime.commit(async tx => {
          const run = await personalScheduleRun(tx, saved.id);
          if (run.cancelRequested) return finish(tx, run.id, "canceled", `本次定时工作已取消；已登记工作均已停止。已经发生的外部效果仍以原操作记录为准。\n${settlement.facts}`);
          if (failed) return finish(tx, run.id, "failed", `本次定时执行未完成回答，已等待派生工作与外部操作核实收尾。请查询原运行和操作记录，不要自动重试未知操作。\n${settlement.facts}`);
          if (!run.summary) {
            let facts = `宿主定时整项汇总参考。原说明：\n${plan.instruction}\n本轮首次回答：\n`;
            const answer = run.initialAnswer && await tx.entry(AssistantEntry, run.initialAnswer), message = answer && answer.model?.[0];
            if (message?.role !== "assistant") throw new PersonalError("schedule_answer_missing", "定时首次完整回答缺失，未生成汇总；请保留档案。");
            facts += message.content.filter(part => part.type === "text").map(part => part.text).join("");
            for (const member of run.members) { const value = await personalWorkResult(tx, member, 0, 16384); facts += `\n子工作 ${member.taskId}：${value.state}\n${value.text ?? value.next ?? ""}${value.nextOffset ? "\n结果尚有后页，可用background_work result读取。" : ""}`; }
            facts += `\n宿主核实：${settlement.facts}\n部分工作未完成：${settlement.failed ? "是" : "否"}`;
            facts += "\n本轮已封组。只查询本轮结果，汇总成功、失败和未能完成之处；不能发起新的操作或委派。完成此回答后宿主固定回报原入口。";
            const admission = (await tx.appendEntry(ScheduleSummary, run.conversationId, { data: { runId: run.id, content: facts, failed: settlement.failed } })).id;
            run.summary = { content: facts, admission, failed: settlement.failed };
          }
          await deps.configure(tx, run.conversationId, await personalSchedule(tx, run.planId), { summary: true });
          return { status: "running", checkpoint: { phase: "summarize" } };
        }, taskContext);
      },
      async summarize(current, runtime, taskContext) {
        const saved = await runtime.snapshot(PersonalScheduleRunDoc, current.input.runId, taskContext), run = saved?.run;
        if (!run?.summary || run.taskId !== current.id) throw new PersonalError("schedule_record_invalid", "定时汇总缺少原接纳记录，请保留档案。");
        const conversation = await runtime.conversation(run.conversationId, taskContext);
        if (!conversation) throw new PersonalError("schedule_run_missing", "定时汇总会话缺失，未报告完成；请保留档案。");
        if (run.cancelRequested) { await drain(run.id, runtime, taskContext); await runtime.commit(async tx => finish(tx, run.id, "canceled", "本次定时工作已取消，完整执行事实可从原运行查询。"), taskContext); return; }
        const submission = await conversation.submit({ type: "input", requestId: `personal-schedule-summary:${run.id}`, content: run.summary.content, entry: { kind: SCHEDULE_SUMMARY_INPUT, data: { runId: run.id, admission: run.summary.admission } }, whenBusy: "reject" }, taskContext);
        await runtime.commit(async tx => { (await personalScheduleRun(tx, run.id)).summary!.submissionId = submission.id; return undefined; }, taskContext);
        const cancel = await canceled(runtime, run.id, taskContext);
        try {
          const settled = await Promise.race([submission.wait(taskContext), cancel.promise.then(() => undefined)]);
          await conversation.abort(taskContext, { background: true });
          await drain(run.id, runtime, taskContext);
          await runtime.commit(async tx => {
            const current = await personalScheduleRun(tx, run.id);
            if (current.cancelRequested) return finish(tx, run.id, "canceled", "本次定时工作已取消，完整执行事实可从原运行查询。");
            if (settled?.status !== "done" || settled.type !== "input") return finish(tx, run.id, "failed", "本次定时工作已收尾，但最终汇总没有完成；请查询原运行与子工作结果。");
            const answer = await tx.entry(AssistantEntry, settled.answer), message = answer?.model?.[0];
            if (message?.role !== "assistant") throw new PersonalError("schedule_answer_missing", "定时完整汇总缺失，未回报；请保留档案。");
            current.summary!.answer = answer!.id;
            return finish(tx, run.id, current.summary!.failed ? "failed" : "completed", message.content.filter(part => part.type === "text").map(part => part.text).join("") || "本次定时工作已收尾，但模型没有提供文字结果；请查询原运行。");
          }, taskContext);
        } finally { await cancel.watch.stop(); }
      },
    },
    async abort(current, runtime, taskContext) {
      await runtime.commit(async tx => { const run = await personalScheduleRun(tx, current.input.runId); for (const ref of run.members) await requestPersonalWorkCancel(tx, ref); if (!run.cancelRequested) mergeMissed(await personalSchedule(tx, run.planId), run); run.cancelRequested = true; if (!run.cancelEntry) run.cancelEntry = (await tx.appendEntry(ScheduleRunCancellation, run.conversationId, { data: { runId: run.id, reason: "task" } })).id; run.sealed = true; return undefined; }, taskContext);
      const run = (await runtime.snapshot(PersonalScheduleRunDoc, current.input.runId, taskContext))!.run!;
      const conversation = await runtime.conversation(run.conversationId, taskContext); if (!conversation) throw new PersonalError("schedule_run_missing", "取消时原定时会话缺失，占用仍保留；请保留档案。");
      await conversation.abort(taskContext, { background: true });
      await drain(run.id, runtime, taskContext);
      await runtime.commit(async tx => finish(tx, run.id, "canceled", "本次定时工作已取消，已发生的外部效果请查询原操作记录。"), taskContext);
    },
  });

  async function drain(id: string, runtime: PersonalScheduleRuntime, taskContext: Context, forceCancel = false) {
    const watch = await runtime.watchDoc(PersonalScheduleRunDoc, id, taskContext);
    if (!watch?.value?.run) throw new PersonalError("schedule_run_missing", "原定时运行记录缺失，已保留占用；请保留档案。");
    const run = copy(watch.value.run);
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      const conversation = await runtime.conversation(run.conversationId, taskContext);
      if (!conversation) throw new PersonalError("schedule_run_missing", "原定时会话缺失，占用保留；请保留档案。");
      await conversation.abort(taskContext, { background: true });
      for (const ref of run.members) { await runtime.commit(async tx => { await requestPersonalWorkCancel(tx, ref); return undefined; }, taskContext); await getHarness().abortTask(ref.taskId, taskContext); }
    })();
    watch.start(async value => { if (value?.run?.cancelRequested) await stop(); });
    try {
      if (forceCancel || run.cancelRequested) await stop();
      let failed = false; const facts: string[] = [];
      for (const ref of run.members) {
        await runtime.waitForTask(ref.taskId, taskContext);
        await runtime.commit(async tx => { const status = await personalWorkStatus(tx, ref); if (!status.stopVerified) throw new PersonalError("schedule_stop_unverified", "原子工作停止未核实，定时运行继续保留占用；请核实原工作。"); if (status.task.state.status === "terminal") { failed ||= status.task.state.outcome.status !== "completed"; facts.push(`子工作 ${ref.taskId}：${status.task.state.outcome.status}`); } return undefined; }, taskContext);
      }
      if (stopping) await stopping;
      const latest = (await runtime.snapshot(PersonalScheduleRunDoc, id, taskContext))!.run!;
      const direct = await deps.settle(copy(latest), runtime, taskContext, forceCancel || latest.cancelRequested);
      return { failed: failed || direct.failed, facts: facts.concat(direct.facts).join("\n") };
    } finally { await watch.stop(); }
  }
  function mergeMissed(plan: PersonalSchedule, run: PersonalScheduleRun) { const latest = latestAtOrBefore(plan.rule, now()); if (latest && Date.parse(latest) > Date.parse(run.mergedThrough)) run.mergedThrough = latest; }
  async function finish(tx: Tx, id: string, status: "completed" | "failed" | "canceled", text: string) {
    const run = await personalScheduleRun(tx, id), plan = await personalSchedule(tx, run.planId);
    if (!run.result) {
      run.sealed = true;
      if (!run.cancelRequested) mergeMissed(plan, run);
      const entry = (await tx.appendEntry(ScheduleResult, run.conversationId, { data: { runId: id, status, text } })).id;
      run.result = { status, text, entry, closedAt: new Date(now()).toISOString() };
      const taskId = await tx.createTask(sendTask, { runId: id }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      const reply = personalScheduleReportText(text);
      const admission = (await tx.appendEntry(ScheduleSendAdmission, run.conversationId, { data: { runId: id, taskId, text: reply } })).id;
      run.delivery = { taskId, admission, text: reply, claims: [], state: status === "canceled" ? "canceled" : "pending" };
      if (plan.activeRun !== id) throw new PersonalError("schedule_record_invalid", "原计划运行占用不符，未关闭；请保留档案。");
      delete plan.activeRun;
      if (plan.rule.kind === "once" || plan.canceled) plan.nextDueAt = null;
      else plan.nextDueAt = nextAfter(plan.rule, now());
    }
    return { status: "terminal" as const, outcome: { status: "completed" as const, result: {} } };
  }
  const sendTask = defineTask<RunInput, { phase: "send"; retryAt?: number }, object>({ name: SCHEDULE_SEND_TASK, version: 1, initial: () => ({ phase: "send" }), phases: { async send(current, runtime, taskContext) {
    if (current.state.checkpoint.retryAt) await runtime.sleep(current.state.checkpoint.retryAt, taskContext);
    let plan!: PersonalSchedule, text = "", shouldSend = false;
    await runtime.commit(async tx => {
      const run = await personalScheduleRun(tx, current.input.runId), delivery = run.delivery; plan = copy(await personalSchedule(tx, run.planId));
      if (!delivery || delivery.taskId !== current.id) throw new PersonalError("schedule_record_invalid", "定时回报的原认领记录不符，请保留档案。");
      if (delivery.state === "sending") { delivery.state = "effect_unknown"; delivery.code = "send_interrupted"; delivery.observation = (await tx.appendEntry(ScheduleSendObservation, run.conversationId, { data: { runId: run.id, state: delivery.state, code: delivery.code } })).id; }
      if (delivery.state !== "pending") return;
      if (plan.canceled || run.cancelRequested || plan.telegram && !await telegramSourceActive(tx, plan.telegram)) delivery.state = "canceled";
      else if (!plan.telegram) delivery.state = "local";
      else {
        if (run.submissionId) { try { await deps.verifyScope(tx, plan.scope); } catch (error) { if (!(error instanceof PersonalError)) throw error; delivery.state = "canceled"; delivery.code = "source_scope_changed"; } }
        if (delivery.state === "pending") { text = delivery.text; delivery.state = "sending"; delete delivery.observation; delivery.claims.push((await tx.appendEntry(ScheduleSendClaim, run.conversationId, { data: { runId: run.id, taskId: delivery.taskId, text, telegram: plan.telegram! } })).id); shouldSend = true; }
      }
      if (delivery.state !== "sending" && !delivery.observation) delivery.observation = (await tx.appendEntry(ScheduleSendObservation, run.conversationId, { data: { runId: run.id, state: delivery.state, ...(delivery.code ? { code: delivery.code } : {}) } })).id;
      return undefined;
    }, taskContext);
    if (!shouldSend) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), taskContext); return; }
    let state: "sent" | "failed" | "effect_unknown" = "effect_unknown", messageId: string | undefined, code = "send_unverified", retryAfterMs: number | undefined;
    try { messageId = await deps.send(plan, text, runtime.signal); state = "sent"; code = "sent"; } catch (error) { if (error instanceof PersonalImApiError) { code = error.code; if (error.effect === "not_sent") { state = "failed"; retryAfterMs = error.retryAfterMs; } } else if (error instanceof PersonalError) code = error.code; }
    await runtime.commit(async tx => {
      const run = await personalScheduleRun(tx, current.input.runId), delivery = run.delivery!;
      if (delivery.state !== "sending") throw new PersonalError("schedule_record_invalid", "定时回报认领已变化，迟到结果未改写其他发送。");
      if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && !run.cancelRequested && !(await personalSchedule(tx, run.planId)).canceled) { delivery.state = "pending"; delivery.code = code; delivery.observation = (await tx.appendEntry(ScheduleSendObservation, run.conversationId, { data: { runId: run.id, state: "pending", code } })).id; return { status: "running", checkpoint: { phase: "send", retryAt: now() + Math.max(retryAfterMs, 1) } }; }
      delivery.state = state; delivery.code = code; if (messageId) delivery.platformMessageId = messageId;
      delivery.observation = (await tx.appendEntry(ScheduleSendObservation, run.conversationId, { data: { runId: run.id, state, code, ...(messageId ? { platformMessageId: messageId } : {}) } })).id;
      return { status: "terminal", outcome: { status: "completed", result: {} } };
    }, taskContext);
  } }, async abort(current, runtime, taskContext) { await runtime.commit(async tx => { const run = await personalScheduleRun(tx, current.input.runId); if (run.delivery?.state === "sending") { run.delivery.state = "effect_unknown"; run.delivery.code = "send_interrupted"; } else if (run.delivery?.state === "pending") run.delivery.state = "canceled"; if (run.delivery && ["effect_unknown", "canceled"].includes(run.delivery.state)) run.delivery.observation = (await tx.appendEntry(ScheduleSendObservation, run.conversationId, { data: { runId: run.id, state: run.delivery.state, ...(run.delivery.code ? { code: run.delivery.code } : {}) } })).id; return { status: "terminal", outcome: { status: "aborted" } }; }, taskContext); } });

  async function hasFuture(tx: Tx) { for (const id of (await tx.doc(PersonalSchedulesDoc)).plans) { const plan = await personalSchedule(tx, id); if (!plan.canceled && plan.nextDueAt !== null) return true; } return false; }
  const supervisorTask = defineTask<object, { phase: "scan" }, object>({ name: SCHEDULE_SUPERVISOR_TASK, version: 1, initial: () => ({ phase: "scan" }), phases: { async scan(_current, runtime, taskContext) {
    let future = false;
    await runtime.commit(async tx => { await scan(tx, now()); future = await hasFuture(tx); if (!future) return { status: "terminal", outcome: { status: "completed", result: {} } }; return undefined; }, taskContext);
    if (!future) return;
    await runtime.sleep(Date.now() + 1000, taskContext);
    await runtime.commit(() => ({ status: "running", checkpoint: { phase: "scan" } }), taskContext);
  } }, async abort(_current, runtime, taskContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext); } });
  async function start(tx: Tx, observed?: { terminal: boolean } | null) { const index = await tx.doc(PersonalSchedulesDoc); if (!await hasFuture(tx)) return; const prior = observed === undefined ? await verifyScheduleSupervisor(tx) : observed; if (!prior || prior.terminal) index.supervisor = await tx.createTask(supervisorTask, {}, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }); return index.supervisor; }
  async function scan(tx: Tx, at: number) {
    const index = await tx.doc(PersonalSchedulesDoc); let admitted = 0;
    for (const id of index.plans) {
      const plan = await personalSchedule(tx, id); if (plan.canceled || plan.nextDueAt === null || Date.parse(plan.nextDueAt) > at) continue;
      const latest = latestAtOrBefore(plan.rule, at); if (!latest) continue;
      if (plan.activeRun) { const run = await personalScheduleRun(tx, plan.activeRun); run.mergedThrough = latest; plan.nextDueAt = nextAfter(plan.rule, at); continue; }
      if (admitted >= 50) break;
      const runId = hash([id, plan.version, latest]), prior = (await tx.doc(PersonalScheduleRunDoc, runId, null)).run;
      if (prior) { plan.nextDueAt = nextAfter(plan.rule, at); continue; }
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const taskId = await tx.createTask(runTask, { runId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      const run: PersonalScheduleRun = { id: runId, planId: id, planVersion: 1, scheduledFor: latest, mergedFrom: plan.nextDueAt, mergedThrough: latest, admission: 0 as typeof plan.admission, taskId, conversationId: conversation.id, requestId: scheduleRequestId(runId), cancelRequested: false, sealed: false, members: [] };
      run.admission = (await tx.appendEntry(ScheduleRunAdmission, run.conversationId, { data: scheduleRunAdmissionData(run) })).id;
      (await tx.doc(PersonalScheduledConversationDoc, String(conversation.id), null)).runId = runId;
      (await tx.doc(PersonalScheduleRunDoc, runId, null)).run = run; index.runs.push(runId); plan.activeRun = runId; plan.nextDueAt = nextAfter(plan.rule, at);
      await deps.configure(tx, conversation.id, plan, { summary: false }); admitted++;
    }
    return admitted;
  }
  async function createByRequest(tx: Tx, requestId: string) { const id = hash(["personal-schedule", requestId]); const plan = (await tx.doc(PersonalScheduleDoc, id, null)).plan; return plan ? copy(plan) : null; }
  async function create(tx: Tx, body: PersonalScheduleBody, actor: PersonalScheduleActor) {
    if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 256 || typeof body.label !== "string" || !body.label.trim() || body.label.length > 128 || typeof body.instruction !== "string" || !body.instruction.trim() || body.instruction.length > 16384 || Object.keys(body).some(key => !["requestId", "label", "instruction", "rule"].includes(key))) throw new PersonalError("schedule_input_invalid", "计划名称或自足任务说明无效，请使用最多128字符名称和16384字符说明。");
    let rule; try { rule = parseRule(body.rule); } catch (error) { if (!(error instanceof RuleError)) throw error; throw new PersonalError("schedule_rule_invalid", error.message); }
    const prior = await createByRequest(tx, body.requestId);
    if (prior) { const original = prior.createdBy.actor, sameActor = actor.kind === "im" && original.kind === "im" ? actor.menuRequestId === original.menuRequestId && samePersonalEntry(actor.input, original.input) : isDeepStrictEqual(actor, original); if (!sameActor || !isDeepStrictEqual([prior.label, prior.instruction, prior.rule], [body.label, body.instruction, rule])) throw new PersonalError("schedule_request_conflict", "原创建请求的内容不同，请查询原计划，不要换键自动重发。"); return copy(prior); }
    const index = await tx.doc(PersonalSchedulesDoc), previousSupervisor = await verifyScheduleSupervisor(tx);
    const authority = await deps.authorize(tx, actor), scope = await deps.captureScope(tx), id = hash(["personal-schedule", body.requestId]), createdAt = new Date(now()).toISOString(); if (index.plans.length >= 1000) throw new PersonalError("schedule_limit", "定时计划数量已达上限，请先查询并整理现有计划。");
    const plan: PersonalSchedule = { id, version: 1, requestId: body.requestId, label: body.label, instruction: body.instruction, rule, createdAt, createdBy: { actor: copy(actor), authority: copy(authority) }, permission: { ...authority.permission }, ...(authority.telegram ? { telegram: { ...authority.telegram } } : {}), scope: copy(scope), admission: 0 as PersonalSchedule["admission"], nextDueAt: firstDue(rule, now()), canceled: false };
    plan.admission = (await tx.appendEntry(ScheduleAdmission, ROOT_CONVERSATION_ID, { data: scheduleAdmissionData(plan) })).id;
    (await tx.doc(PersonalScheduleDoc, id, null)).plan = plan; index.plans.push(id); await start(tx, previousSupervisor); return copy(plan);
  }
  async function cancel(tx: Tx, id: string, actor: PersonalScheduleActor) {
    const plan = await personalSchedule(tx, id), activeRun = plan.activeRun && await personalScheduleRun(tx, plan.activeRun);
    if (activeRun) for (const ref of activeRun.members) await requestPersonalWorkCancel(tx, ref);
    const authority = await deps.authorize(tx, actor);
    if (actor.kind === "im" && !samePersonalEntry(authority.telegram, plan.telegram)) throw new PersonalError("schedule_original_entry", "此计划不属于当前拥有者原入口，请从原入口查询。");
    if (activeRun && !plan.canceled) mergeMissed(plan, activeRun);
    if (!plan.cancelEntry) plan.cancelEntry = (await tx.appendEntry(ScheduleCancellation, ROOT_CONVERSATION_ID, { data: { planId: id, actor: copy(actor), authority: copy(authority), ...(plan.activeRun ? { activeRun: plan.activeRun } : {}) } })).id;
    plan.canceled = true; plan.nextDueAt = null;
    if (plan.activeRun) { const run = await personalScheduleRun(tx, plan.activeRun); run.cancelRequested = true; run.cancelEntry = plan.cancelEntry; run.sealed = true; }
    for (const runId of (await tx.doc(PersonalSchedulesDoc)).runs) { const run = await personalScheduleRun(tx, runId); if (run.planId === id && run.delivery?.state === "pending") { run.delivery.state = "canceled"; delete run.delivery.observation; } }
    return copy(plan);
  }
  async function list(tx: Tx, offset = 0, actor?: PersonalEntryIdentity) { pageOffset(offset); const plans: PersonalSchedule[] = []; for (const id of (await tx.doc(PersonalSchedulesDoc)).plans.slice().reverse()) { const plan = await personalSchedule(tx, id); if (!actor || samePersonalEntry(actor, plan.telegram)) plans.push(plan); } return { items: plans.slice(offset, offset + 8).map(plan => copy(plan)), ...(offset + 8 < plans.length ? { nextOffset: offset + 8 } : {}) }; }
  async function runs(tx: Tx, id: string, offset = 0) { pageOffset(offset); await personalSchedule(tx, id); const items = []; for (const runId of (await tx.doc(PersonalSchedulesDoc)).runs.slice().reverse()) { const run = await personalScheduleRun(tx, runId); if (run.planId === id) items.push({ id: run.id, planId: id, scheduledFor: run.scheduledFor, mergedFrom: run.mergedFrom, mergedThrough: run.mergedThrough, state: await runState(tx, run), ...(run.delivery ? { delivery: run.delivery.state } : {}) }); } return { items: items.slice(offset, offset + 8), ...(offset + 8 < items.length ? { nextOffset: offset + 8 } : {}) }; }
  async function result(tx: Tx, id: string, offset = 0, size = 4096) { pageOffset(offset); if (!Number.isSafeInteger(size) || size < 1 || size > 16384) throw new PersonalError("schedule_input_invalid", "结果分页大小无效，请重新查询原运行。"); const run = await personalScheduleRun(tx, id); return { runId: id, state: await runState(tx, run), ...(run.result ? pageText(run.result.text, offset, size) : {}), ...(run.delivery ? { delivery: run.delivery.state } : {}) }; }
  return { extension: defineExtension({ name: PERSONAL_SCHEDULER, tasks: [supervisorTask, runTask, sendTask] }), runTask, sendTask, supervisorTask, create, createByRequest, list, get: async (tx: Tx, id: string) => copy(await personalSchedule(tx, id)), cancel, runs, result, scan,
    start,
    verifyCreator: deps.verifyCreator,
  };
}
export type PersonalScheduler = ReturnType<typeof personalScheduler>;
