import { personalSourceImReceipt } from "./personal-source.ts";
import { PERSONAL_BACKGROUND_TOOL_NAMES } from "./personal-background-processes.ts";
import { PersonalAppDataOperationDoc, appDataOperations } from "./personal-app-data.ts";
import { isDeepStrictEqual } from "node:util";
import { AgentDoc, configure, ROOT_CONVERSATION_ID, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { PersonalError } from "./personal-error.ts";
import { personalServiceSourceBlocker, PersonalServiceOperationDoc, personalServiceOperationsIn } from "./personal-service-operations.ts";
import { PersonalInspectionDoc } from "./personal-service-inspection.ts";
import { PersonalCommandDoc, personalCommandsIn } from "./personal-command-work.ts";
import { PersonalMcpDoc, mcpOperations } from "./personal-mcp.ts";
import { PersonalToolDoc, toolOperations } from "./personal-tools.ts";
import { PersonalBrowserOperationDoc, PersonalBrowserSessionDoc, browserOperations, browserSessionStopped } from "./personal-browser.ts";
import { PERSONAL_SCHEDULED_WORK, PersonalScheduleRunDoc, type PersonalSchedule, type PersonalScheduleRun } from "./personal-scheduler-records.ts";
import type { PersonalScheduleRuntime } from "./personal-scheduler.ts";
import { PersonalImApiError, withPersonalImEntry, type PersonalImAccess } from "./personal-im-api.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, personalEntryConfig } from "./personal-telegram-records.ts";
import { personalTelegramApi } from "./personal-telegram-api.ts";
import { telegramToken } from "./personal-telegram-config.ts";

export async function configurePersonalScheduledConversation(tx: Tx, conversationId: ConversationId, plan: PersonalSchedule, options: { summary: boolean }) {
  const main = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
  if (!main.model) throw new PersonalError("model_unavailable", "当前定时模型无法核实，请查询配置。");
  const business = ["personal-app-data", "personal-media", "personal-browser", "personal-tools", "personal-file-search", "personal-mcp", "personal-service-inspect", "personal-service-executions", "personal-memory", "personal-history", "personal-skills"];
  const extensions = [PERSONAL_SCHEDULED_WORK, ...plan.scope.extensions.filter(name => business.includes(name))];
  const tools = ["background_work", ...plan.scope.tools.filter(name => !["ask_user", ...PERSONAL_BACKGROUND_TOOL_NAMES, "background_work", "schedule_create", "schedule_query", "schedule_cancel"].includes(name) && (!options.summary || ["app_data_query", "read_artifact", "read_mcp_result", "read_service_inspection", "memory", "history_search", "history_read", "skill"].includes(name)))];
  await configure(tx, conversationId, { model: main.model, thinkingLevel: "off", extensions: [], tools: [] });
  const agent = await tx.doc(AgentDoc, conversationId);
  agent.extensions = extensions; agent.tools = tools;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-18-personal-durable-scheduled-work.md
export async function settlePersonalScheduledRun(run: PersonalScheduleRun, runtime: PersonalScheduleRuntime, context: Context, cancel: boolean, stopBrowser?: (conversationId: ConversationId) => Promise<boolean>) {
  let started = false;
  await runtime.commit(async tx => { started = !!(await tx.submissionByRequest(run.conversationId, run.requestId))?.entry; return undefined; }, context);
  if (!started) {
    if (run.members.length) throw new PersonalError("schedule_record_invalid", "定时子工作缺少原执行输入，已保留占用；请保留档案。");
    return { failed: false, facts: "本次运行尚未进入模型，没有派生工作或外部操作。" };
  }
  const cancelWatch = await runtime.watchDoc(PersonalScheduleRunDoc, run.id, context);
  if (!cancelWatch?.value?.run) throw new PersonalError("schedule_run_missing", "定时运行的收尾归属缺失，已保留占用；请保留档案。");
  let stopping: Promise<boolean> | undefined;
  let cancellationObserved = cancel;
  let wakeCancel: () => void = () => undefined;
  const canceled = new Promise<void>(resolve => { wakeCancel = resolve; });
  const stop = () => stopping ??= stopBrowser?.(run.conversationId) ?? Promise.resolve(true);
  cancelWatch.start(async value => { if (value?.run?.cancelRequested) { wakeCancel(); await stop(); } });
  try {
    if (cancel || cancelWatch.value.run.cancelRequested) { cancellationObserved = true; await stop(); }
    let initial: Awaited<ReturnType<typeof personalServiceSourceBlocker>>;
    await runtime.commit(async tx => { initial = await personalServiceSourceBlocker(tx, run.requestId); return undefined; }, context);
    if (typeof initial === "string" || !initial || !("pause" in initial)) await stop();
    while (true) {
      let blocker: Awaited<ReturnType<typeof personalServiceSourceBlocker>>;
      await runtime.commit(async tx => { blocker = await personalServiceSourceBlocker(tx, run.requestId); return undefined; }, context);
      if (!blocker) break;
      const watch = typeof blocker === "string" ? await runtime.watchDoc(PersonalServiceOperationDoc, blocker, context) : "appData" in blocker ? await runtime.watchDoc(PersonalAppDataOperationDoc, blocker.appData, context) : "browser" in blocker ? blocker.session ? await runtime.watchDoc(PersonalBrowserSessionDoc, String(run.conversationId), context) : await runtime.watchDoc(PersonalBrowserOperationDoc, blocker.browser, context) : "tool" in blocker ? await runtime.watchDoc(PersonalToolDoc, blocker.tool, context) : "mcp" in blocker ? await runtime.watchDoc(PersonalMcpDoc, blocker.mcp, context) : "command" in blocker ? await runtime.watchDoc(PersonalCommandDoc, blocker.command, context) : await runtime.watchDoc(PersonalInspectionDoc, String(blocker.inspection), context);
      if (!watch) throw new PersonalError("schedule_effect_missing", "定时运行的待核实操作缺失，已保留占用；请保留档案。");
      try {
        const changed = new Promise<void>(resolve => { watch.start(async () => resolve()); void watch.closed.then(() => resolve()); });
        let waiting = false;
        await runtime.commit(async tx => { waiting = isDeepStrictEqual(await personalServiceSourceBlocker(tx, run.requestId), blocker); return undefined; }, context);
        if (waiting) {
          if (cancellationObserved) await changed;
          else await Promise.race([changed, canceled]);
          if (cancelWatch.value?.run?.cancelRequested && !cancellationObserved) { cancellationObserved = true; await stop(); }
        }
      } finally { await watch.stop(); }
    }
    await stop();
    await runtime.commit(async tx => { if (!await browserSessionStopped(tx, run.conversationId)) throw new PersonalError("schedule_stop_unverified", "原浏览器停止尚未核实，定时运行继续保留占用；请从原浏览器菜单核实停止。"); return undefined; }, context);
    let failed = false;
    const facts: string[] = [];
    await runtime.commit(async tx => {
      for (const operation of await appDataOperations(tx)) if (operation.origin.source.requestId === run.requestId) { failed ||= operation.result?.effect !== "committed"; facts.push(`应用数据：${operation.result?.code ?? "结果缺失"}；效果${operation.result?.effect ?? "待核实"}`); }
      for (const operation of await toolOperations(tx)) if (operation.origin.source.requestId === run.requestId) { failed ||= operation.effect !== "returned"; facts.push(`资料/网络操作：${operation.code}；原效果${operation.effect}；停止${operation.stopped ? "已核实" : "未核实"}${operation.resolution ? `；拥有者已核实${operation.resolution.effect === "applied" ? "已生效" : "未生效"}` : ""}`); }
      for (const operation of await mcpOperations(tx)) if (operation.origin.source.requestId === run.requestId) { failed ||= operation.effect !== "returned"; facts.push(`MCP操作：${operation.code}；原效果${operation.effect}；原请求结束${operation.remoteEnded ? "已核实" : "未核实"}${operation.cua?.recovery?.accepted ? "；拥有者已接受新观察，原结果保持" : ""}${operation.resolution ? `；拥有者已核实${operation.resolution.effect === "applied" ? "已生效" : "未生效"}` : ""}`); }
      for (const operation of await browserOperations(tx)) if (operation.origin.source.requestId === run.requestId) { failed ||= operation.effect !== "returned"; facts.push(`浏览器操作：${operation.code}；原效果${operation.effect}；停止${operation.stopped ? "已核实" : "未核实"}${operation.resolution ? `；拥有者已核实${operation.resolution.effect === "applied" ? "已生效" : "未生效"}` : ""}`); }
      for (const operation of await personalServiceOperationsIn(tx)) if (operation.source.requestId === run.requestId) { failed ||= operation.result?.effect !== "executed" || operation.result.exitCode !== 0; facts.push(`服务 ${operation.unit}：${operation.result?.code ?? "结果缺失"}；原效果${operation.result?.effect ?? "待核实"}；停止${operation.launcherStopped ? "已核实" : "未核实"}${operation.resolution ? `；拥有者已核实${operation.resolution.effect === "applied" ? "已生效" : "未生效"}` : ""}`); }
      for (const operation of await personalCommandsIn(tx)) if (run.submissionId !== undefined && operation.work.sources.includes(run.submissionId)) { failed ||= operation.result?.effect !== "returned" || operation.result.exitCode !== 0; facts.push(`命令操作：${operation.result?.code ?? "结果缺失"}；原效果${operation.result?.effect ?? "待核实"}；停止${operation.stopped ? "已核实" : "未核实"}${operation.resolution ? `；拥有者已核实${operation.resolution.effect === "applied" ? "已生效" : "未生效"}` : ""}`); }
      return undefined;
    }, context);
    return { failed, facts: facts.join("\n") };
  } finally { await cancelWatch.stop(); }
}

export async function preparePersonalScheduledReport(harness: Harness, plan: PersonalSchedule, text: string, signal: AbortSignal, im?: PersonalImAccess) {
  const source = plan.telegram;
  const target = await harness.commit(async tx => {
    const state = await tx.doc(PersonalTelegramDoc), config = personalEntryConfig(state, source ?? {});
    if (!source || !config?.enabled || config.botId !== source.botId || config.ownerId !== source.ownerId || config.generation !== source.generation) throw new PersonalImApiError("schedule_target_inactive", "定时原回报入口已失效，未发送；请查询原计划。", "not_sent");
    const creator = plan.createdBy;
    const requestId = creator.actor.kind === "im" ? creator.actor.input.requestId : creator.authority.source?.requestId;
    const receipt = requestId && await personalSourceImReceipt(tx, requestId);
    if (!receipt) throw new PersonalImApiError("schedule_target_missing", "定时原回报来源缺失，未发送；请保留档案。", "not_sent");
    return { messageId: receipt.messageId, telegram: state.config && { ...state.config } };
  }, BACKGROUND_CONTEXT);
  const api = im ? im.sender(source!) : source!.platform !== "qq" && target.telegram && personalTelegramApi(target.telegram.apiBase, telegramToken(target.telegram));
  if (!api) throw new PersonalImApiError("schedule_target_unavailable", "定时原回报平台不可用，未发送；请查询连接。", "not_sent");
  return () => api.send(source!.ownerId, target.messageId, text, signal);
}

export async function sendPersonalScheduledReport(harness: Harness, plan: PersonalSchedule, text: string, signal: AbortSignal, im?: PersonalImAccess) {
  const send = await withPersonalImEntry(im, plan.telegram ?? {}, () => preparePersonalScheduledReport(harness, plan, text, signal, im));
  return send();
}
