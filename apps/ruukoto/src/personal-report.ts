import { AppDataAdmission, PersonalAppDataOperationDoc } from "./personal-app-data.ts";
import { PersonalImApiError } from "./personal-im-api.ts";
import type { PersonalQqApi } from "./personal-qq-api.ts";
import { PersonalToolDoc, ToolAdmission } from "./personal-tools.ts";
import { PersonalBrowserOperationDoc, BrowserAdmission } from "./personal-browser.ts";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, defineEntry, defineExtension, defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, type Cursor, type DocumentObserver, type EntryId, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalDelegationDoc, personalDelegation, personalDelegationBlocker, personalDelegationSources, requirePersonalDelegationInput, requirePersonalDelegationReady, type PersonalDelegationRef, type PersonalWorkSource } from "./personal-delegation.ts";
import { personalWorkNoteSource, personalWorkStatus } from "./personal-work.ts";
import { PersonalInspectionDoc, ServiceInspectionAdmission } from "./personal-service-inspection.ts";
import { PersonalServiceOperationDoc, type PersonalServiceBlocker } from "./personal-service-operations.ts";
import { McpAdmission, PersonalMcpDoc } from "./personal-mcp.ts";
import { CommandAdmission, PersonalCommandDoc } from "./personal-command-work.ts";
import { personalEntryConfig, PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { personalTelegramApi } from "./personal-telegram-api.ts";
import { telegramToken } from "./personal-telegram-config.ts";

type Delivery = "waiting" | "local" | "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled" | "blocked" | "unanswered";
export type PersonalReportFacts = { taskId: TaskId; admission: EntryId; source: PersonalWorkSource; modelCall: TaskId; content: string; attempt: number; pauses: EntryId[]; submissionId?: SubmissionId; answer?: EntryId; reply?: string; delivery: Delivery; platformMessageId?: string };
type ReportInput = { delegation: PersonalDelegationRef; source: PersonalWorkSource; modelCall: TaskId; content: string };
const ReportAdmission = defineEntry<ReportInput & { taskId: TaskId }>("ruukoto.report-admission");
const ReportPause = defineEntry<{ taskId: TaskId; attempt: number; submissionId: SubmissionId; blocker: PersonalServiceBlocker }>("ruukoto.report-pause");
const INPUT_KIND = "ruukoto.delegation-report";
const submissionKey = (taskId: TaskId, attempt: number) => `personal-report:${taskId}:${attempt}`;
const inputData = (ref: PersonalDelegationRef, report: PersonalReportFacts, attempt = report.attempt) => ({ delegation: ref.entryId, taskId: report.taskId, attempt });
const platformText = (text: string) => Array.from(text).length > 3900 ? Array.from(text).slice(0, 3900).join("") + "…（显示已截断，完整报告可从委托菜单读取）" : text || "本次报告没有文本内容，请查询原委托。";

async function reportFacts(tx: Tx, ref: PersonalDelegationRef, taskId?: TaskId) {
  const value = await personalDelegation(tx, ref);
  if (!value.report || (taskId !== undefined && value.report.taskId !== taskId)) throw new PersonalError("report_missing", "委托报告归属缺失，已停止；请查询原委托并保留档案。");
  return { value, report: value.report };
}

async function verifyInput(tx: Tx, ref: PersonalDelegationRef, report: PersonalReportFacts, attempt = report.attempt) {
  const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, submissionKey(report.taskId, attempt));
  if (!submission) return;
  if (submission.type !== "input") throw new PersonalError("report_input_invalid", "报告输入类型不符，已停止；请保留档案。");
  if (submission.entry) {
    const entry = await tx.entry(submission.entry);
    const message = entry?.model?.[0];
    if (entry?.kind !== INPUT_KIND || entry.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(entry.data, inputData(ref, report, attempt)) || message?.role !== "user" || message.content !== report.content) throw new PersonalError("report_input_invalid", "报告原输入或来源无法核实，已停止；请保留档案。");
  } else if (submission.status === "queued") {
    const queued = (await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items.find(item => item.id === submission.id);
    if (!queued || queued.mode !== "followUp" || queued.content !== report.content || !isDeepStrictEqual(queued.entry, { kind: INPUT_KIND, data: inputData(ref, report, attempt) })) throw new PersonalError("report_input_invalid", "报告排队原文或来源不符，已停止；请保留档案。");
  }
  return submission;
}

async function membersStopped(tx: Tx, ref: PersonalDelegationRef) {
  for (const member of (await personalDelegation(tx, ref)).members) if (!(await personalWorkStatus(tx, member)).stopVerified) throw new PersonalError("report_stop_unverified", "委托成员停止尚未核实，未生成报告；请查询原分析并核实停止。");
}

async function requireReportReady(tx: Tx, ref: PersonalDelegationRef) {
  await membersStopped(tx, ref);
  await requirePersonalDelegationReady(tx, ref);
}

function canceled(reader: DocumentObserver, ref: PersonalDelegationRef, context: Context) {
  return reader.watchDoc(PersonalDelegationDoc, String(ref.entryId), context).then(watch => {
    if (!watch) throw new PersonalError("report_missing", "报告委托记录缺失，已停止；请保留档案。");
    const promise = new Promise<void>(resolve => {
      const check = (value: typeof watch.value) => { if (!value?.delegation || value.delegation.cancelRequested) resolve(); };
      watch.start(async value => { check(value); });
      check(watch.value);
      // 关闭只结束观察；后续 commit 仍核实原记录及 invocation，不留下未消费的拒绝。
      void watch.closed.then(() => resolve());
    });
    return { watch, promise };
  });
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-delegation-reports.md
function personalReportTask(qqApi?: PersonalQqApi) { return defineTask<ReportInput, { phase: "wait" } | { phase: "summarize"; attempt: number } | { phase: "send"; retryAt?: number } | { phase: "verify" }, { delivery: Delivery }>({
  name: "ruukoto.delegation-report", version: 1, initial: () => ({ phase: "wait" }),
  phases: {
    async wait(current, runtime, context) {
      await runtime.commit(async tx => {
        const { value, report } = await reportFacts(tx, current.input.delegation, current.id);
        if (value.cancelRequested) { report.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; }
        return { status: "waiting", checkpoint: { phase: "summarize", attempt: report.attempt }, on: value.members.map(ref => ref.taskId), policy: "allSettled" };
      }, context);
    },
    async summarize(current, runtime, context) {
      const ref = current.input.delegation;
      const cancel = await canceled(runtime, ref, context);
      try {
        // 暂停等待留在后台 Task；provider 门禁拒绝该轮，主聊天仍能处理其他输入。
        while (true) {
          let blocker: PersonalServiceBlocker | undefined;
          let stop = false;
          await runtime.commit(async tx => {
            const { value, report } = await reportFacts(tx, ref, current.id);
            if (value.cancelRequested) { report.delivery = "canceled"; stop = true; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; }
            blocker = await personalDelegationBlocker(tx, value);
            if (!blocker) {
              try { await requireReportReady(tx, ref); } catch (error) {
                if (!(error instanceof PersonalError) || !["report_stop_unverified", "delegation_source_inactive", "delegation_canceled"].includes(error.code)) throw error;
                stop = true; report.delivery = error.code === "report_stop_unverified" ? "blocked" : "canceled";
                return { status: "terminal", outcome: { status: "failed", error: { message: error.message, detail: { code: error.code } }, result: { delivery: report.delivery } } };
              }
              await verifyInput(tx, ref, report);
            }
            return undefined;
          }, context);
          if (stop) return;
          if (!blocker) break;
          const watch = typeof blocker === "string" ? await runtime.watchDoc(PersonalServiceOperationDoc, blocker, context) : "appData" in blocker ? await runtime.watchDoc(PersonalAppDataOperationDoc, blocker.appData, context) : "browser" in blocker ? await runtime.watchDoc(PersonalBrowserOperationDoc, blocker.browser, context) : "tool" in blocker ? await runtime.watchDoc(PersonalToolDoc, blocker.tool, context) : "mcp" in blocker ? await runtime.watchDoc(PersonalMcpDoc, blocker.mcp, context) : "command" in blocker ? await runtime.watchDoc(PersonalCommandDoc, blocker.command, context) : await runtime.watchDoc(PersonalInspectionDoc, String(blocker.inspection), context);
          if (!watch) throw new PersonalError("service_operation_missing", "暂停报告的服务记录缺失，请保留档案。");
          try {
            const changed = new Promise<void>(resolve => { watch.start(async () => { resolve(); }); void watch.closed.then(() => resolve()); });
            let stillBlocked = false;
            await runtime.commit(async tx => { stillBlocked = isDeepStrictEqual(await personalDelegationBlocker(tx, await personalDelegation(tx, ref)), blocker); return undefined; }, context);
            if (stillBlocked) await Promise.race([changed, cancel.promise]);
          } finally { await watch.stop(); }
        }
        const saved = (await runtime.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
        const main = await runtime.conversation(ROOT_CONVERSATION_ID, context);
        if (!main) throw new PersonalError("report_main_missing", "报告主会话缺失，请保留档案。");
        const submission = await main.submit({ type: "input", requestId: submissionKey(current.id, saved.attempt), content: saved.content, entry: { kind: INPUT_KIND, data: inputData(ref, saved) }, whenBusy: "followUp" }, context);
        let cancelNow = false;
        await runtime.commit(async tx => { const { value, report } = await reportFacts(tx, ref, current.id); await verifyInput(tx, ref, report); report.submissionId = submission.id; cancelNow = value.cancelRequested; return undefined; }, context);
        if (cancelNow) await submission.abort(context);
        const settled = await Promise.race([submission.wait(context), cancel.promise.then(() => undefined)]);
        if (!settled) await submission.abort(context);
        await runtime.commit(async tx => {
          const { value, report } = await reportFacts(tx, ref, current.id);
          if (value.cancelRequested) { report.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; }
          if (settled?.status !== "done" || settled.type !== "input") {
            if (report.pauses[report.attempt]) { report.attempt++; delete report.submissionId; return { status: "running", checkpoint: { phase: "summarize", attempt: report.attempt } }; }
            report.delivery = "unanswered";
            return { status: "terminal", outcome: { status: "failed", error: { message: "主会话未完成本报告，未外发；请查询原委托。" }, result: { delivery: report.delivery } } };
          }
          const entry = await tx.entry(AssistantEntry, settled.answer);
          const message = entry?.model?.[0];
          if (message?.role !== "assistant") throw new PersonalError("report_answer_missing", "报告完整回答缺失，未外发；请保留档案。");
          report.answer = settled.answer;
          const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
          report.reply = platformText(text);
          report.delivery = "pending";
          return { status: "running", checkpoint: { phase: "send" } };
        }, context);
      } finally { await cancel.watch.stop(); }
    },
    async send(current, runtime, context) {
      if (current.state.checkpoint.retryAt) await runtime.sleep(current.state.checkpoint.retryAt, context);
      const ref = current.input.delegation;
      const source = (await runtime.snapshot(PersonalDelegationDoc, String(ref.entryId), context))?.delegation?.telegram;
      const state = await runtime.snapshot(PersonalTelegramDoc, context);
      const config = personalEntryConfig(state ?? {}, source ?? {});
      const api = source?.platform === "qq" ? qqApi : state?.config?.enabled ? personalTelegramApi(state.config.apiBase, telegramToken(state.config)) : undefined;
      let owner = "", message = 0, reply = "";
      await runtime.commit(async tx => {
        const { value, report } = await reportFacts(tx, ref, current.id);
        const currentConfig = personalEntryConfig(await tx.doc(PersonalTelegramDoc), source ?? {});
        if (value.cancelRequested || (value.telegram && (!isDeepStrictEqual(config, currentConfig) || !config?.enabled || config.generation !== value.telegram.generation || config.botId !== value.telegram.botId || config.ownerId !== value.telegram.ownerId))) { report.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "canceled" } } }; }
        if (await personalDelegationBlocker(tx, value)) return { status: "running", checkpoint: { phase: "summarize", attempt: report.attempt } };
        if (!value.telegram) { report.delivery = "local"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "local" } } }; }
        const receipt = (await tx.doc(PersonalTelegramReceiptDoc, value.source.requestId, null)).receipt;
        if (!receipt || !report.reply || report.delivery !== "pending" || !api) throw new PersonalError("report_send_invalid", "报告固定目标或正文缺失，已停止发送；请保留档案。");
        owner = value.telegram.ownerId; message = receipt.messageId; reply = report.reply;
        report.delivery = "sending";
        return { status: "running", checkpoint: { phase: "verify" } };
      }, context);
      if (!owner) return;
      let platformMessageId: string | undefined;
      let failure: PersonalImApiError | undefined;
      try { platformMessageId = await api!.send(owner, message, reply, runtime.signal); } catch (error) { if (!(error instanceof PersonalImApiError)) throw error; failure = error; }
      await runtime.commit(async tx => {
        const { report } = await reportFacts(tx, ref, current.id);
        if (failure?.retryAfterMs) { report.delivery = "pending"; return { status: "running", checkpoint: { phase: "send", retryAt: runtime.now() + failure.retryAfterMs } }; }
        report.delivery = platformMessageId ? "sent" : failure?.effect === "not_sent" ? "failed" : "effect_unknown";
        if (platformMessageId) report.platformMessageId = platformMessageId;
        return { status: "terminal", outcome: { status: "completed", result: { delivery: report.delivery } } };
      }, context);
    },
    async verify(current, runtime, context) {
      await runtime.commit(async tx => { const { report } = await reportFacts(tx, current.input.delegation, current.id); report.delivery = "effect_unknown"; return { status: "terminal", outcome: { status: "completed", result: { delivery: "effect_unknown" } } }; }, context);
    },
  },
  async abort(current, runtime, context) {
    const saved = (await runtime.snapshot(PersonalDelegationDoc, String(current.input.delegation.entryId), context))?.delegation?.report;
    const main = await runtime.conversation(ROOT_CONVERSATION_ID, context);
    let admitted = false;
    if (saved) await runtime.commit(async tx => { admitted = !!await verifyInput(tx, current.input.delegation, saved); return undefined; }, context);
    if (saved && main && admitted) { const submission = await main.submit({ type: "input", requestId: submissionKey(current.id, saved.attempt), content: saved.content, entry: { kind: INPUT_KIND, data: inputData(current.input.delegation, saved) }, whenBusy: "followUp" }, context); await submission.abort(context); }
    await runtime.commit(async tx => { const { report } = await reportFacts(tx, current.input.delegation, current.id); report.delivery = report.delivery === "sending" ? "effect_unknown" : "canceled"; return { status: "terminal", outcome: { status: "aborted", result: { delivery: report.delivery } } }; }, context);
  },
});

}
export const PersonalReportTask = personalReportTask();
export function personalReports(qqApi: PersonalQqApi) { return defineExtension({ name: "personal-delegation-reports", tasks: [personalReportTask(qqApi)] }); }
export const personalDelegationReports = defineExtension({ name: "personal-delegation-reports", tasks: [PersonalReportTask] });

export async function requestPersonalReport(tx: Tx, ref: PersonalDelegationRef, sourceRequestId: string, modelCall: TaskId) {
  const value = await personalDelegation(tx, ref);
  await requirePersonalDelegationInput(tx, ref, sourceRequestId);
  if (value.report) return value.report.taskId;
  await requirePersonalDelegationReady(tx, ref);
  const source = await personalWorkNoteSource(tx, sourceRequestId);
  if (source.kind !== "input") throw new PersonalError("report_source_invalid", "汇总需要原入口的拥有者输入，请查询原委托。");
  const actor = { requestId: source.requestId, submissionId: source.submissionId, entryId: source.entryId };
  const entry = await tx.entry(value.source.entryId);
  const original = entry?.model?.[0];
  if (original?.role !== "user") throw new PersonalError("report_source_invalid", "委托原说明缺失，未安排汇总；请保留档案。");
  const content = `宿主委托汇总参考（不是拥有者的新指令）：分析安排已封组。请用 background_work progress 查询委托 ${ref.entryId} 的全部成员，并用 result 分页读取各项完整结果。主 Agent 汇总成功、失败和遗漏，给出可读结果与必要下一步；不能从本参考取得变更或外部操作授权。本轮回答由宿主固定回报原入口，无需自行发送。原委托说明：\n${typeof original.content === "string" ? original.content : original.content.filter(part => part.type === "text").map(part => part.text).join("")}`;
  const taskId = await tx.createTask(PersonalReportTask, { delegation: ref, source: actor, modelCall, content }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
  const admission = (await tx.appendEntry(ReportAdmission, ROOT_CONVERSATION_ID, { data: { delegation: ref, source: actor, modelCall, content, taskId } })).id;
  value.report = { taskId, admission, source: actor, modelCall, content, attempt: 0, pauses: [], delivery: "waiting" };
  return taskId;
}

export async function personalReportRequest(tx: Tx) {
  const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
  if (!live.run) return;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: PersonalReportTask.definition.name }, 64, cursor);
    for (const task of page.items) {
      const input = task.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || !input.delegation || typeof input.delegation !== "object" || Array.isArray(input.delegation) || typeof input.delegation.entryId !== "number") throw new PersonalError("report_missing", "报告任务来源缺失，已停止模型请求。");
      const ref = { entryId: input.delegation.entryId as EntryId };
      const { value, report } = await reportFacts(tx, ref, task.id);
      for (let attempt = 0; attempt <= report.attempt; attempt++) {
        const submission = await verifyInput(tx, ref, report, attempt);
        if (!submission || !live.run.inputs.includes(submission.id)) continue;
        if (attempt !== report.attempt || live.run.inputs.length !== 1 || value.cancelRequested || task.abortRequested || task.state.status === "terminal") return new PersonalError("report_inactive", "报告已停止，未继续请求；请查询原委托。");
        try { await requireReportReady(tx, ref); } catch (error) {
          if (!(error instanceof PersonalError)) throw error;
          if (error.code === "work_source_paused" && !report.pauses[attempt]) report.pauses[attempt] = (await tx.appendEntry(ReportPause, ROOT_CONVERSATION_ID, { data: { taskId: task.id, attempt, submissionId: submission.id, blocker: (await personalDelegationBlocker(tx, value))! } })).id;
          return error;
        }
      }
    }
    cursor = page.next;
  } while (cursor);
}

export async function personalReportResult(tx: Tx, ref: PersonalDelegationRef, offset = 0, size = 4096): Promise<{ delivery: string; state?: string; text?: string; nextOffset?: number }> {
  const value = await personalDelegation(tx, ref);
  if (!value.report) return { delivery: "not_requested" };
  const { report } = await reportFacts(tx, ref);
  const task = await tx.task(report.taskId);
  if (!task) throw new PersonalError("report_missing", "报告执行缺失，请保留档案。");
  const state = task.state.status === "terminal" ? task.state.outcome.status : task.state.status;
  if (!report.answer) return { delivery: report.delivery, state };
  const entry = await tx.entry(AssistantEntry, report.answer);
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") throw new PersonalError("report_answer_missing", "报告原回答缺失，请保留档案。");
  const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
  let end = Math.min(offset + size, text.length);
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--;
  return { delivery: report.delivery, state, text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
}

export async function verifyPersonalReports(tx: Tx, keys: string[], enabled: boolean) {
  for (const key of keys) {
    const value = (await tx.doc(PersonalDelegationDoc, key, null)).delegation!;
    const report = value.report;
    if (!report) continue;
    const task = await tx.task(report.taskId);
    const admission = await tx.entry(ReportAdmission, report.admission);
    const expected = { delegation: value.ref, source: report.source, modelCall: report.modelCall, content: report.content };
    if (!enabled || task?.kind !== PersonalReportTask.definition.name || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !isDeepStrictEqual(task.input, expected) || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, { ...expected, taskId: report.taskId }) || !Number.isSafeInteger(report.attempt) || report.attempt < 0 || !Array.isArray(report.pauses) || report.pauses.length < report.attempt || report.pauses.length > report.attempt + 1 || typeof report.content !== "string" || !["waiting", "local", "pending", "sending", "sent", "failed", "effect_unknown", "canceled", "blocked", "unanswered"].includes(report.delivery)) throw new PersonalError("report_record_invalid", "报告版本、接纳或执行归属不符，已停止恢复；请保留档案。");
    await requirePersonalDelegationInput(tx, value.ref, report.source.requestId);
    const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, report.source.requestId);
    if (source?.type !== "input" || source.id !== report.source.submissionId || source.entry !== report.source.entryId || (await tx.entry(report.source.entryId))?.kind !== "pi.user") throw new PersonalError("report_record_invalid", "报告原说明不符，已停止恢复。");
    const call = await tx.task(report.modelCall);
    const input = call?.input;
    const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
    const part = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
    if (call?.kind !== "pi.tool" || call.conversationId !== ROOT_CONVERSATION_ID || assistant?.byTaskId !== call.owner || assistant!.id <= report.source.entryId || admission.id <= assistant!.id || part?.type !== "toolCall" || part.name !== "background_work" || !isDeepStrictEqual(part.arguments, { action: "report", delegation: value.ref.entryId })) throw new PersonalError("report_record_invalid", "报告缺少原模型封组动作，已停止恢复。");
    for (let attempt = 0; attempt <= report.attempt; attempt++) {
      const submission = await verifyInput(tx, value.ref, report, attempt);
      const pauseId = report.pauses[attempt];
      if (attempt < report.attempt && (submission?.status !== "unanswered" || !pauseId)) throw new PersonalError("report_record_invalid", "报告重做缺少未回答的原尝试或暂停证明，已停止恢复。");
      if (attempt < report.pauses.length) {
        const pause = pauseId && await tx.entry(ReportPause, pauseId);
        let sourceValid = false;
        if (pause) {
          const sources = await personalDelegationSources(tx, value);
          const blocker = pause.data.blocker;
          if (typeof blocker === "string") {
            const operation = (await tx.doc(PersonalServiceOperationDoc, blocker, null)).operation;
            sourceValid = !!operation && sources.has(operation.source.requestId);
          } else if ("appData" in blocker) {
            const admission = await tx.entry(AppDataAdmission, blocker.admission);
            if (admission && admission.id < pause.id && String(admission.data.operation) === blocker.appData) sourceValid = sources.has(admission.data.origin.source.requestId);
          } else if ("browser" in blocker) {
            const admission = await tx.entry(BrowserAdmission, blocker.admission);
            if (admission && admission.id < pause.id && String(admission.data.operation) === blocker.browser) sourceValid = sources.has(admission.data.origin.source.requestId);
          } else if ("tool" in blocker) {
            const admission = await tx.entry(ToolAdmission, blocker.admission);
            if (admission && admission.id < pause.id && String(admission.data.operation) === blocker.tool) sourceValid = sources.has(admission.data.origin.source.requestId);
          } else if ("mcp" in blocker) {
            const admission = await tx.entry(McpAdmission, blocker.admission);
            if (admission && admission.id < pause.id && String(admission.data.operation) === blocker.mcp) {
              for (const requestId of sources) { const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId); if (source && admission.data.origin.sources.includes(source.id)) sourceValid = true; }
            }
          } else if ("command" in blocker) {
            const admission = await tx.entry(CommandAdmission, blocker.admission);
            if (admission && admission.id < pause.id && admission.data.ref.requestId === blocker.command) {
              for (const requestId of sources) { const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId); if (source && admission.data.work.sources.includes(source.id)) sourceValid = true; }
            }
          } else {
            const inspection = await tx.entry(ServiceInspectionAdmission, blocker.admission);
            if (inspection?.conversationId === ROOT_CONVERSATION_ID && inspection.data.taskId === blocker.inspection && inspection.id < pause.id) {
              for (const requestId of sources) { const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId); if (source && inspection.data.sources.includes(source.id)) sourceValid = true; }
            }
          }
        }
        if (!pause || pause.conversationId !== ROOT_CONVERSATION_ID || pause.data.taskId !== report.taskId || pause.data.attempt !== attempt || pause.data.submissionId !== submission?.id || !submission?.entry || pause.id <= submission.entry || !sourceValid) throw new PersonalError("report_record_invalid", "报告暂停证明缺失或不符，已停止恢复。");
      }
      if (attempt === report.attempt && ((report.submissionId !== undefined && report.submissionId !== submission?.id) || (report.answer !== undefined && (submission?.status !== "done" || submission.type !== "input" || submission.answer !== report.answer)))) throw new PersonalError("report_record_invalid", "报告回答与原尝试不符，已停止恢复。");
    }
    if (report.answer !== undefined) {
      const entry = await tx.entry(AssistantEntry, report.answer);
      const message = entry?.model?.[0];
      if (entry?.conversationId !== ROOT_CONVERSATION_ID || message?.role !== "assistant" || report.reply !== platformText(message.content.filter(part => part.type === "text").map(part => part.text).join(""))) throw new PersonalError("report_record_invalid", "报告外发正文与完整回答不符，已停止恢复。");
    } else if (report.reply !== undefined || ["local", "pending", "sending", "sent", "failed", "effect_unknown"].includes(report.delivery)) throw new PersonalError("report_record_invalid", "报告发送缺少完整回答，已停止恢复。");
    if (task.state.status !== "terminal") {
      const checkpoint = task.state.status !== "completing" && task.state.checkpoint;
      if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || !["wait", "summarize", "send", "verify"].includes(String(checkpoint.phase)) || (checkpoint.phase === "summarize" && checkpoint.attempt !== report.attempt) || (checkpoint.phase === "send" && report.delivery !== "pending") || (checkpoint.phase === "verify" && report.delivery !== "sending")) throw new PersonalError("report_record_invalid", "报告发送检查点与效果记录不符，已停止恢复。");
    }
    if (report.delivery === "sending" && task.state.status === "terminal") report.delivery = "effect_unknown";
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: PersonalReportTask.definition.name }, 64, cursor);
    for (const task of page.items) {
      const input = task.input;
      const ref = input && typeof input === "object" && !Array.isArray(input) && input.delegation;
      if (!ref || typeof ref !== "object" || Array.isArray(ref) || typeof ref.entryId !== "number" || !keys.includes(String(ref.entryId)) || (await personalDelegation(tx, { entryId: ref.entryId as EntryId })).report?.taskId !== task.id) throw new PersonalError("report_record_invalid", "报告执行缺少原委托，已停止恢复。");
    }
    cursor = page.next;
  } while (cursor);
}
