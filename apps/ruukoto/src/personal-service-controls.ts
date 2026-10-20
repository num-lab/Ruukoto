import { isDeepStrictEqual } from "node:util";
import { defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalPendingInspectionsDoc } from "./personal-service-inspection.ts";
import { personalServiceOperation, personalServiceOperationsIn, resolvePersonalServiceOperation, type personalServiceOperations, type PersonalServiceOperationRef } from "./personal-service-operations.ts";
import { telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import { samePersonalEntry, type PersonalEntryIdentity, PersonalTelegramReceiptDoc, type TelegramControlInput } from "./personal-telegram-records.ts";

const NAME = "personal-service-recovery-controls";
const TASK = "ruukoto.service-stop";
const PAGE = 1200;
const ACTIONS = ["/服务核实", "更多服务", "刷新服务", "核实操作停止", "确认已生效", "确认未生效", "更多核实说明"];
type Entrance = PersonalEntryIdentity;
type StopInput = { ref: PersonalServiceOperationRef; hostOpId: string; machineId: string; telegramRequestId?: string };
export type PersonalServiceResolution = { effect: "applied" | "not_applied"; evidence: string };
type ServiceAPI = ReturnType<ReturnType<typeof personalServiceOperations>["api"]>;

export function parsePersonalServiceResolution(value: unknown): PersonalServiceResolution {
  if (!value || typeof value !== "object" || !("effect" in value) || (value.effect !== "applied" && value.effect !== "not_applied") || !("evidence" in value) || typeof value.evidence !== "string" || !value.evidence.trim() || value.evidence.length > 8192) throw new PersonalError("service_resolution_invalid", "请选择已生效或未生效，并提供最多 8192 字符的非空证据说明。");
  return { effect: value.effect, evidence: value.evidence };
}

async function originalService(tx: Tx, ref: PersonalServiceOperationRef, actor?: Entrance, active = true) {
  const op = await personalServiceOperation(tx, ref);
  if (actor && (!op.telegram || !samePersonalEntry(op.telegram, actor) || (active && !await telegramSourceActive(tx, op.telegram)))) throw new PersonalError("service_original_entry_required", "服务操作不属于当前原入口，请从原私聊或本机向导管理。");
  return op;
}

async function mayStop(tx: Tx, ref: PersonalServiceOperationRef, actor?: Entrance) {
  const op = await originalService(tx, ref, actor);
  if (!op.consumed || op.result?.effect !== "effect_unknown" || op.result.code === "started" || !op.snapshot || (await tx.doc(PersonalPendingInspectionsDoc)).tasks.includes(ref.taskId)) throw new PersonalError("service_resolution_invalid", "原写操作尚不处于停止待核实状态；请刷新服务状态。审批前检查请从检查菜单管理。");
  return op;
}

export async function personalServiceRef(tx: Tx, id: TaskId): Promise<PersonalServiceOperationRef> {
  const task = await tx.task(id);
  const key = task?.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId;
  if (task?.kind !== "ruukoto.service-operation" || typeof key !== "string") throw new PersonalError("service_operation_missing", "找不到原服务操作，请刷新服务列表。");
  return { ...(await personalServiceOperation(tx, { requestId: key, taskId: id })).ref };
}

export type PersonalServiceSummary = { ref: PersonalServiceOperationRef; unit: string; status: string; canResolve: boolean; canRecheck: boolean; canDecide: boolean; stop?: string };
export type PersonalServicePage = { items: PersonalServiceSummary[]; nextOffset?: number };
export type PersonalServiceDetail = { summary: PersonalServiceSummary; evidence: string; nextOffset?: number };

async function summary(tx: Tx, ref: PersonalServiceOperationRef): Promise<PersonalServiceSummary> {
  const op = await personalServiceOperation(tx, ref);
  const pending = (await tx.doc(PersonalPendingInspectionsDoc)).tasks.includes(ref.taskId);
  const unknown = op.consumed && op.result?.effect === "effect_unknown" && op.result.code !== "started";
  const task = await tx.task(ref.taskId);
  const canDecide = !op.telegram && op.mode !== "full_access" && !!op.snapshot && !op.consumed && !op.cancelRequested && op.decision === "pending" && task?.state.status !== "terminal" && !task?.abortRequested;
  const verification = op.result?.effect === "effect_unknown" ? `；${op.resolution ? `效果已核实：${op.resolution.effect === "applied" ? "已生效" : "未生效"}` : "未保存人工效果核实"}；${op.launcherStopped ? "原写操作停止已核实" : "原写操作停止未核实"}` : op.result ? "；写操作无需人工效果核实或停止重核" : "";
  const status = `${op.result?.code === "started" ? "已开始，结果尚未核实" : op.result?.effect === "effect_unknown" ? "效果未知" : op.result?.effect === "executed" ? "重启命令已结束，不代表业务健康" : op.result?.effect === "not_executed" ? "已知未执行" : "尚未得到执行结果"}（${op.result?.code ?? "pending"}）${verification}${pending ? "；审批前检查停止未核实，请从检查菜单管理" : ""}`;
  let stop: string | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: TASK, order: "descending" }, 256, cursor);
    const task = page.items.find(task => task.input && typeof task.input === "object" && !Array.isArray(task.input) && isDeepStrictEqual(task.input.ref, ref));
    if (task) {
      const result = task.state.status === "terminal" && task.state.outcome.result;
      stop = task.state.status === "terminal" ? result && typeof result === "object" && !Array.isArray(result) && typeof result.code === "string" ? result.code : task.state.outcome.status : "重核进行中";
      break;
    }
    cursor = page.next;
  } while (cursor);
  return { ref: { ...ref }, unit: op.unit, status: canDecide ? `等待批准：在机器 ${op.snapshot!.machineId} 重启 ${op.unit}；仅本次固定策略和单元修订` : status, canDecide, canResolve: !!unknown && !op.resolution, canRecheck: !!unknown && !pending && !op.launcherStopped, ...(stop ? { stop } : {}) };
}

export async function listPersonalServices(tx: Tx, offset = 0, actor?: Entrance): Promise<PersonalServicePage> {
  const ops = (await personalServiceOperationsIn(tx)).reverse();
  const available = ops.filter(op => !actor || samePersonalEntry(op.telegram, actor));
  const items: PersonalServiceSummary[] = [];
  for (const op of available.slice(offset, offset + 8)) { await originalService(tx, op.ref, actor); items.push(await summary(tx, op.ref)); }
  return { items, ...(available.length > offset + 8 ? { nextOffset: offset + 8 } : {}) };
}

export async function personalServiceDetail(tx: Tx, ref: PersonalServiceOperationRef, offset = 0, actor?: Entrance): Promise<PersonalServiceDetail> {
  const op = await originalService(tx, ref, actor);
  const evidence = op.resolution?.evidence ?? "尚无人工核实说明；请独立检查服务实际效果后保存证据。";
  return { summary: await summary(tx, ref), evidence: evidence.slice(offset, offset + PAGE), ...(evidence.length > offset + PAGE ? { nextOffset: offset + PAGE } : {}) };
}

export function personalServiceDescription(item: PersonalServiceSummary) { return `${item.unit}；${item.status}${item.stop ? `；最近停止重核：${item.stop}` : ""}`; }

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-service-recovery-controls.md
export function personalServiceControls(getHarness: () => Harness, getService: () => ServiceAPI | undefined) {
  const task = defineTask<StopInput, { phase: "run" }, { stopped: boolean; code: string }>({
    name: TASK, version: 1, initial: () => ({ phase: "run" }),
    phases: { async run(current, runtime, ctx) {
      let result = { stopped: false, code: "stop_unverified" };
      async function checkStop() {
        await getHarness().commit(async tx => {
          const receipt = current.input.telegramRequestId ? (await tx.doc(PersonalTelegramReceiptDoc, current.input.telegramRequestId, null)).receipt : undefined;
          if (current.input.telegramRequestId && (!receipt || receipt.serviceStop?.taskId !== current.id || !isDeepStrictEqual(receipt.serviceStop.ref, current.input.ref))) throw new PersonalError("service_control_invalid", "原停止重核收件缺失，已保留占用。");
          const op = await mayStop(tx, current.input.ref, receipt);
          if (op.hostOpId !== current.input.hostOpId || op.snapshot?.machineId !== current.input.machineId) throw new PersonalError("service_control_invalid", "原操作执行身份不符，已保留占用。");
        }, ctx);
        const api = getService();
        if (!api) throw new PersonalError("service_config_missing", "服务操作未装配，请恢复原服务配置。");
        await api.recheckStop(current.input.ref, { hostOpId: current.input.hostOpId, machineId: current.input.machineId });
        const stopped = (await api.status(current.input.ref)).operation.launcherStopped;
        return { stopped, code: stopped ? "stopped" : "stop_unverified" };
      }
      try { result = await checkStop(); } catch (error) { if (!(error instanceof PersonalError)) throw error; result.code = error.code; }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), ctx);
    } },
    async abort(_current, runtime, ctx) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: { stopped: false, code: "canceled" } } }), ctx); },
  });
  async function request(tx: Tx, ref: PersonalServiceOperationRef, actor?: TelegramControlInput) {
    if (!getService()) throw new PersonalError("service_config_missing", "服务操作未装配，请核实服务配置。");
    const op = await mayStop(tx, ref, actor);
    return tx.createTask(task, { ref: { ...ref }, hostOpId: op.hostOpId, machineId: op.snapshot!.machineId, ...(actor ? { telegramRequestId: actor.requestId } : {}) }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
  }
  return { extension: defineExtension({ name: NAME, tasks: [task] }), request,
    async control(tx: Tx, value: TelegramControlInput): Promise<boolean> {
      const choice = /^服务([1-8])$/.exec(value.content);
      const evidence = value.content.startsWith("核实说明 ") ? value.content.slice(5) : undefined;
      if (!choice && evidence === undefined && !ACTIONS.includes(value.content)) return false;
      if (!value.direct) { value.reply = "请直接发送 /服务核实，再回复已送达宿主菜单；转发和引用摘录不能核实操作。"; return true; }
      async function applyControl() {
        const actor = value;
        const menu = value.content === "/服务核实" ? undefined : (await telegramSelection(tx, value))?.selection;
        if (value.content === "/服务核实" || value.content === "更多服务" && menu?.kind === "service-list" && menu.nextOffset !== undefined) {
          const page = await listPersonalServices(tx, value.content === "/服务核实" ? 0 : menu?.kind === "service-list" ? menu.nextOffset! : 0, actor);
          value.selection = { kind: "service-list", refs: page.items.map(item => item.ref), ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) };
          value.reply = page.items.length ? `原入口服务操作：\n${page.items.map((item, i) => `服务${i + 1}：${item.unit}`).join("\n")}\n回复本消息选择服务1至服务${page.items.length}${page.nextOffset === undefined ? "。" : "，或选择「更多服务」。"}` : "当前入口暂无服务操作；本机或旧代次操作请从本机向导管理。";
          return;
        }
        const ref = choice && menu?.kind === "service-list" ? menu.refs[Number(choice[1]) - 1] : menu?.kind === "service-recovery" || menu?.kind === "service-resolution" ? menu.ref : undefined;
        if (!ref) throw new PersonalError("service_menu_stale", "没有核实任何操作，请从 /服务核实 选择原服务。");
        await originalService(tx, ref, actor);
        value.selection = { kind: "service-recovery", ref: { ...ref } };
        if (evidence !== undefined && menu?.kind === "service-resolution") {
          await resolvePersonalServiceOperation(tx, ref, menu.effect, evidence, value.requestId);
          value.serviceResolution = { ref: { ...ref }, effect: menu.effect };
          value.reply = "原服务效果核实及证据已保存，不覆盖原未知结论。停止未核实仍保留占用；回复「刷新服务」查询。";
        } else if (value.content === "确认已生效" || value.content === "确认未生效") {
          if (!(await summary(tx, ref)).canResolve) throw new PersonalError("service_resolution_invalid", "原操作尚不可核实或已经保存效果，请刷新服务。");
          value.selection = { kind: "service-resolution", ref: { ...ref }, effect: value.content === "确认已生效" ? "applied" : "not_applied" };
          value.reply = `选择${value.content}。请独立核实实际效果后，回复本消息「核实说明 你的证据」，最多 8192 字符；不填凭据。证据提交后不可覆盖，单凭效果说明不能释放停止未核实的占用。`;
        } else if (value.content === "核实操作停止") {
          if (menu?.kind !== "service-recovery") throw new PersonalError("service_menu_stale", "停止重核须回复原服务详情菜单，未请求停止。");
          value.serviceStop = { ref: { ...ref }, taskId: await request(tx, ref, value) };
          value.reply = "已登记原写操作停止重核；登记不表示已停止，也不确认写入效果。回复「刷新服务」查询；未核实则检查 helper 后主动重核。";
        } else {
          if (evidence !== undefined) throw new PersonalError("service_menu_stale", "证据须回复原效果确认菜单，未保存核实。");
          const detail = await personalServiceDetail(tx, ref, value.content === "更多核实说明" && menu?.kind === "service-recovery" ? menu.nextOffset ?? 0 : 0, actor);
          value.selection = { kind: "service-recovery", ref: { ...ref }, ...(detail.nextOffset === undefined ? {} : { nextOffset: detail.nextOffset }) };
          value.reply = `${personalServiceDescription(detail.summary)}。\n核实说明：${detail.evidence}\n回复本消息选择：刷新服务${detail.summary.canResolve ? "、确认已生效、确认未生效" : ""}${detail.summary.canRecheck ? "、核实操作停止" : ""}${detail.nextOffset === undefined ? "" : "、更多核实说明"}。未知效果须效果及停止均核实后才解除占用；不会重新执行 restart。`;
        }
      }
      try { await applyControl(); } catch (error) { if (!(error instanceof PersonalError)) throw error; delete value.selection; value.reply = `${error.message} 请发送 /服务核实 查询。`; }
      return true;
    },
  };
}

export async function verifyServiceControls(tx: Tx, keys: string[], enabled: boolean) {
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!;
    const menu = value.selection;
    if (menu?.kind !== "service-list" && menu?.kind !== "service-recovery" && menu?.kind !== "service-resolution" && !value.serviceStop && !value.serviceResolution) continue;
    if (!enabled || !value.control || !value.direct) throw new PersonalError("service_control_invalid", "服务控制扩展或原收件不符，已停止恢复。");
    const actor = value;
    const refs = menu?.kind === "service-list" ? menu.refs : menu?.kind === "service-recovery" || menu?.kind === "service-resolution" ? [menu.ref] : [];
    if (!Array.isArray(refs) || refs.length > 8 || (menu && "nextOffset" in menu && menu.nextOffset !== undefined && (!Number.isSafeInteger(menu.nextOffset) || menu.nextOffset < 0))) throw new PersonalError("service_control_invalid", "服务菜单分页无法核实，已停止恢复。");
    for (const ref of refs) await originalService(tx, ref, actor, false);
    const selected = (await telegramSelection(tx, value))?.selection;
    if (value.serviceResolution) {
      const op = await originalService(tx, value.serviceResolution.ref, actor, false);
      if (selected?.kind !== "service-resolution" || !isDeepStrictEqual(selected.ref, op.ref) || selected.effect !== value.serviceResolution.effect || !["applied", "not_applied"].includes(selected.effect) || op.resolution?.controlRequestId !== key || op.resolution.effect !== selected.effect || value.content !== `核实说明 ${op.resolution.evidence}`) throw new PersonalError("service_control_invalid", "服务效果核实缺少原菜单、证据或决定回链，已停止恢复。");
    }
    if (value.serviceStop) {
      const task = await tx.task(value.serviceStop.taskId);
      if (value.content !== "核实操作停止" || selected?.kind !== "service-recovery" || !isDeepStrictEqual(selected.ref, value.serviceStop.ref) || task?.kind !== TASK || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || task.input.telegramRequestId !== key || !isDeepStrictEqual(task.input.ref, value.serviceStop.ref)) throw new PersonalError("service_control_invalid", "服务停止控制缺少原菜单或重核任务，已停止恢复。");
    }
  }
  for (const op of await personalServiceOperationsIn(tx)) {
    if (!op.resolution?.controlRequestId) continue;
    const receipt = (await tx.doc(PersonalTelegramReceiptDoc, op.resolution.controlRequestId, null)).receipt;
    if (!enabled || !receipt?.serviceResolution || !isDeepStrictEqual(receipt.serviceResolution.ref, op.ref)) throw new PersonalError("service_control_invalid", "服务效果核实的原控制收件缺失，已停止恢复。");
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: TASK }, 256, cursor);
    for (const task of page.items) {
      const input = task.input;
      if (!enabled || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !input || typeof input !== "object" || Array.isArray(input) || !input.ref || typeof input.ref !== "object" || Array.isArray(input.ref) || typeof input.ref.requestId !== "string" || typeof input.ref.taskId !== "number") throw new PersonalError("service_control_invalid", "服务重核任务的版本或归属无法核实，已停止恢复。");
      const op = await personalServiceOperation(tx, input.ref as PersonalServiceOperationRef);
      if (!op.consumed || op.result?.effect !== "effect_unknown" || input.hostOpId !== op.hostOpId || input.machineId !== op.snapshot?.machineId) throw new PersonalError("service_control_invalid", "服务重核任务的原写操作不符，已停止恢复。");
      if (input.telegramRequestId !== undefined) {
        if (typeof input.telegramRequestId !== "string") throw new PersonalError("service_control_invalid", "服务重核收件引用无效，已停止恢复。");
        const receipt = (await tx.doc(PersonalTelegramReceiptDoc, input.telegramRequestId, null)).receipt;
        if (receipt?.serviceStop?.taskId !== task.id || !isDeepStrictEqual(receipt.serviceStop.ref, op.ref)) throw new PersonalError("service_control_invalid", "服务重核任务缺少原控制收件，已停止恢复。");
      }
    }
    cursor = page.next;
  } while (cursor);
}
