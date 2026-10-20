import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { AgentDoc, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTool, LiveDoc, ROOT_CONVERSATION_ID, type Cursor, type DocumentObserver, type EntryId, type Harness, type TaskId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { APP_DATA_PARAMETERS, analyzeMigrate } from "@ruukoto/agent/app-data/contract.ts";
import { AppDataStore, AppDataError, AppDataConflictError, appDataReceiptFingerprint, LIMITS, validateReason, type AuditReceipt, type OpContext } from "@ruukoto/agent/app-data/store.ts";
import { AppDataQueryRunner, validateQueryRequest } from "@ruukoto/agent/app-data/query.ts";
import { PersonalError } from "./personal-error.ts";
import { personalToolOrigin, type PersonalToolOrigin } from "./personal-tool-source.ts";
import { activePersonalReferenceTool } from "./personal-history.ts";
import { activePersonalWorkInspection, personalWorkInspectionSource, PersonalWorkDoc } from "./personal-work.ts";
import { personalSource, personalSourceSubmission } from "./personal-source.ts";
import { scheduledConversation, requireScheduledSourceReady } from "./personal-scheduler-records.ts";
import { verifyPersonalScheduleScope } from "./personal-schedule-scope.ts";
import { samePersonalEntry, type PersonalEntryIdentity } from "./personal-telegram-records.ts";
import { telegramSourceActive } from "./personal-permissions.ts";

export const PERSONAL_APP_DATA = "personal-app-data";
export const PERSONAL_APP_DATA_TOOLS = ["app_data_define_table", "app_data_migrate", "app_data_query", "app_data_insert", "app_data_update", "app_data_delete"] as const;
type WriteName = Exclude<typeof PERSONAL_APP_DATA_TOOLS[number], "app_data_query">;
type Params = Record<string, JsonValue>;
type Result = { effect: "committed" | "not_committed" | "effect_unknown"; code: string; op_id: string; summary?: string; schema_version?: number; revision?: number };
type Operation = { operation: TaskId; opId: string; name: WriteName; params: Params; fingerprint: string; origin: PersonalToolOrigin; instanceId: string; admission: EntryId; versions: { schemaVersion: number; revision: number }; destructive: boolean; decision: "pending" | "approved" | "rejected" | "unneeded"; decisionEntry?: EntryId; actor?: string; started?: EntryId; result?: Result; observation?: EntryId };
export const PersonalAppDataDoc = defineDoc<{ instanceId?: string; binding?: EntryId; operations: TaskId[]; initializing?: boolean; unavailable?: string }>({ kind: "ruukoto.app-data", scope: "session", version: 1, initial: () => ({ operations: [] }) });
export const PersonalAppDataOperationDoc = defineDocFamily<{ operation?: Operation }, null>({ kind: "ruukoto.app-data-operation", scope: "session", version: 1, family: true, initial: () => ({}) });
const AppDataBinding = defineEntry<{ instanceId: string }>("ruukoto.app-data-binding");
export const AppDataAdmission = defineEntry<Omit<Operation, "admission" | "decision" | "decisionEntry" | "actor" | "started" | "result" | "observation">>("ruukoto.app-data-admission");
const AppDataDecision = defineEntry<{ operation: TaskId; decision: "approved" | "rejected"; actor?: string }>("ruukoto.app-data-decision");
const AppDataStart = defineEntry<{ operation: TaskId; admission: EntryId }>("ruukoto.app-data-start");
const AppDataObservation = defineEntry<{ operation: TaskId; result: Result }>("ruukoto.app-data-observation");
const context = BACKGROUND_CONTEXT;
const invalid = () => new PersonalError("app_data_record_invalid", "应用数据原记录无法核实，已停止恢复；请保留档案并检查存储。");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileFor = (directory: string) => path.join(directory, "agent-data", "main.db");

export async function appDataOperation(tx: Tx, operation: TaskId) {
  const value = (await tx.doc(PersonalAppDataOperationDoc, String(operation), null)).operation;
  if (!value || value.operation !== operation) throw invalid();
  return value;
}
export async function appDataOperations(tx: Tx) {
  const values: Operation[] = [];
  for (const operation of (await tx.doc(PersonalAppDataDoc)).operations) values.push(await appDataOperation(tx, operation));
  return values;
}
export function appDataUnresolved(value: Readonly<Operation>) { return !!value.started && (!value.result || value.result.effect === "effect_unknown"); }
export async function appDataSourceBlocker(tx: Tx, requestId: string) {
  const source = await personalSourceSubmission(tx, requestId);
  for (const value of await appDataOperations(tx)) if (source && value.origin.sources.includes(source.id) && appDataUnresolved(value)) return { appData: String(value.operation), admission: value.admission };
}
export async function requireWorkAppDataStopped(tx: Tx, taskId: TaskId) {
  if ((await appDataOperations(tx)).some(value => value.origin.work?.ref.taskId === taskId && appDataUnresolved(value))) throw new PersonalError("work_stop_unverified", "原应用数据操作尚未核实，占用保留；请恢复原库后从应用数据菜单重新核实。");
}
export async function waitWorkAppData(reader: DocumentObserver, ids: TaskId[], context: Context) {
  for (const id of ids) await waitOperation(reader, id, value => !appDataUnresolved(value), context);
}
async function waitOperation(reader: DocumentObserver, id: TaskId, ready: (value: Readonly<Operation>) => boolean, context: Context) {
  const watch = await reader.watchDoc(PersonalAppDataOperationDoc, String(id), context);
  if (!watch?.value?.operation) throw invalid();
  try { await new Promise<void>((resolve, reject) => { const check = (value: typeof watch.value | null) => { if (!value?.operation) reject(invalid()); else if (ready(value.operation)) resolve(); }; watch.start(async value => check(value)); check(watch.value); void watch.closed.then(() => reject(new PersonalError("app_data_wait_stopped", "应用数据等待已停止，占用保留；请查询原操作。"))); }); }
  finally { await watch.stop(); }
}

function openBound(directory: string, instanceId: string, readOnly = true) {
  try { return new AppDataStore(fileFor(directory), { readOnly, expectedInstanceId: instanceId }); }
  catch { throw new PersonalError("app_data_unavailable", "原应用库缺失、身份或结构不符，已停止应用数据；请保留档案并恢复原库后重新核实，勿新建库或换方式重试。"); }
}
function receiptResult(store: AppDataStore, value: Operation): Result {
  let receipt: AuditReceipt | null;
  try { receipt = store.getReceipt(value.opId); } catch { throw new PersonalError("app_data_receipt_invalid", "原应用数据回执损坏，保持效果未知；请保留原库并检查审计记录。"); }
  if (!receipt) {
    if (store.hasTaskReceipt(operationContext(value).taskId)) throw new PersonalError("app_data_receipt_invalid", "原工具回执的操作键不符，保持效果未知；请保留原库并检查审计记录。");
    return { effect: "not_committed", code: "not_committed", op_id: value.opId };
  }
  const expected = operationContext(value), versions = store.getVersions();
  if (receipt.opId !== value.opId || receipt.toolName !== value.name || receipt.taskId !== expected.taskId || receipt.sessionId !== expected.sessionId || receipt.agentId !== expected.agentId || receipt.reason !== String(value.params.reason).trim() || !receipt.operation || Array.isArray(receipt.operation) || receipt.operation.requestFingerprint !== value.fingerprint || receipt.operation.receiptFingerprint !== appDataReceiptFingerprint(receipt) || !Number.isSafeInteger(receipt.seq) || receipt.seq < 1 || !Number.isSafeInteger(receipt.schemaVersion) || receipt.schemaVersion < 0 || receipt.schemaVersion > versions.schemaVersion || !Number.isSafeInteger(receipt.revision) || receipt.revision <= value.versions.revision || receipt.revision > versions.revision || typeof receipt.resultSummary !== "string" || !receipt.resultSummary || typeof receipt.affected !== "string" || !receipt.affected || typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt)) || (receipt.definitions !== null && (typeof receipt.definitions !== "object" || !receipt.definitions.before || !receipt.definitions.after))) throw new PersonalError("app_data_receipt_invalid", "原应用数据回执与请求不符，保持效果未知；请保留原库并检查审计记录。");
  return { effect: "committed", code: "committed", op_id: value.opId, summary: receipt.resultSummary, schema_version: receipt.schemaVersion, revision: receipt.revision };
}
function operationContext(value: Operation): OpContext {
  return { taskId: `durable:${value.operation}`, sessionId: `durable:${value.origin.conversationId}`, agentId: value.origin.work ? `durable:${value.origin.conversationId}` : value.origin.conversationId === ROOT_CONVERSATION_ID ? "main" : `scheduled:${value.origin.conversationId}`, requestFingerprint: value.fingerprint, ...(value.destructive ? { expectedRevision: value.versions.revision } : {}) };
}
async function observe(tx: Tx, id: TaskId, result: Result) {
  const value = await appDataOperation(tx, id);
  if (isDeepStrictEqual(value.result, result)) return;
  value.result = result;
  value.observation = (await tx.appendEntry(AppDataObservation, value.origin.conversationId, { data: { operation: id, result } })).id;
}
async function childAllowed(tx: Tx, origin: PersonalToolOrigin) {
  if (origin.work && !(await tx.doc(PersonalWorkDoc, origin.work.ref.requestId, null)).appData) throw new PersonalError("app_data_forbidden", "本次子工作没有应用数据资格，请结束本轮并向主 Agent 说明所需资料或操作。");
}
async function active(tx: Tx, value: Operation) {
  if (value.instanceId !== (await tx.doc(PersonalAppDataDoc)).instanceId) throw invalid();
  const current = await personalToolOrigin(tx, { taskId: value.operation, conversationId: value.origin.conversationId }, value.origin.source.requestId);
  await childAllowed(tx, current);
  if (!isDeepStrictEqual(current, value.origin)) throw new PersonalError("app_data_source_changed", "原应用数据来源或权限已变化，批准失效且未执行；请查询原操作。");
}
export async function appDataOriginal(tx: Tx, id: TaskId, actor: PersonalEntryIdentity, active = true) {
  const value = await appDataOperation(tx, id);
  if (!samePersonalEntry(value.origin.telegram, actor) || active && !await telegramSourceActive(tx, actor)) throw new PersonalError("app_data_original_entry", "此应用数据操作须从原拥有者入口管理，请查询原入口菜单。");
}
export async function appDataDecide(tx: Tx, directory: string, id: TaskId, decision: "approved" | "rejected", actor?: PersonalEntryIdentity & { requestId: string }) {
  const value = await appDataOperation(tx, id);
  if (actor) await appDataOriginal(tx, id, actor);
  else if (value.origin.telegram) throw new PersonalError("app_data_original_entry", "请从原拥有者 IM 入口批准或拒绝此应用数据操作。");
  if (!['approved', 'rejected'].includes(decision) || value.decision !== "pending" || value.started || value.result) throw new PersonalError("app_data_decision_invalid", "原应用数据批准已决定或消费，请刷新原操作。");
  let invalidCode: string | undefined;
  if (decision === "approved") {
    try {
      await active(tx, value);
      const store = openBound(directory, value.instanceId);
      try { if (!isDeepStrictEqual(store.getVersions(), value.versions)) throw new PersonalError("app_data_version_changed", "应用数据版本已变化，原批准失效且未执行；请重新查询数据后决定下一步。"); } finally { store.close(); }
    } catch (error) {
      if (!(error instanceof PersonalError)) throw error;
      invalidCode = error.code;
    }
  }

  value.decision = decision; if (actor) value.actor = actor.requestId;
  value.decisionEntry = (await tx.appendEntry(AppDataDecision, value.origin.conversationId, { data: { operation: id, decision, ...(actor ? { actor: actor.requestId } : {}) } })).id;
  if (invalidCode) await observe(tx, id, { effect: "not_committed", code: invalidCode, op_id: value.opId });
}
export async function appDataList(tx: Tx, offset = 0, actor?: PersonalEntryIdentity) {
  const values = (await appDataOperations(tx)).reverse().filter(value => !actor || samePersonalEntry(value.origin.telegram, actor));
  const items = await Promise.all(values.slice(offset, offset + 8).map(async value => ({ operation: value.operation, name: value.name, table: value.params.table, decision: value.decision, effect: value.result?.effect ?? (value.started ? "effect_unknown" : "not_committed"), code: value.result?.code ?? "awaiting_approval", canDecide: value.decision === "pending" && !value.started && !value.result, canRecheck: appDataUnresolved(value) && (await tx.task(value.operation))?.state.status === "terminal" })));
  return { items, ...(offset + 8 < values.length ? { nextOffset: offset + 8 } : {}) };
}
export async function appDataDetail(tx: Tx, id: TaskId, offset = 0) {
  const value = await appDataOperation(tx, id), text = JSON.stringify({ tool: value.name, parameters: value.params, versions: value.versions, decision: value.decision, consumed: !!value.started, result: value.result, permission: value.origin.permission }, null, 2);
  return { text: text.slice(offset, offset + 3072), ...(offset + 3072 < text.length ? { nextOffset: offset + 3072 } : {}) };
}

export async function initializeAppData(tx: Tx) {
  const doc = await tx.doc(PersonalAppDataDoc);
  if (doc.instanceId) return;
  if (doc.operations.length) throw invalid();
  doc.instanceId = `appdb_${randomUUID()}`; doc.initializing = true;
  doc.binding = (await tx.appendEntry(AppDataBinding, ROOT_CONVERSATION_ID, { data: { instanceId: doc.instanceId } })).id;
}

export async function appDataRecheck(tx: Tx, directory: string, id: TaskId) {
  if ((await tx.task(id))?.state.status !== "terminal") throw new PersonalError("app_data_recheck_active", "原应用数据调用仍在运行，尚不可重新核实；请刷新原记录并等待本轮结束。");
  await reconcileAppData(tx, directory, id);
}
async function reconcileAppData(tx: Tx, directory: string, id: TaskId) {
  const value = await appDataOperation(tx, id);
  if (!value.started || value.result && value.result.effect !== "effect_unknown") return;
  let result: Result;
  try { const store = openBound(directory, value.instanceId); try { result = receiptResult(store, value); } finally { store.close(); } }
  catch (error) { if (!(error instanceof PersonalError)) throw error; result = { effect: "effect_unknown", code: error.code, op_id: value.opId }; }
  await observe(tx, id, result);
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-18-personal-durable-app-data.md
export function personalAppData(directory: string, getHarness: () => Harness) {
  const runner = new AppDataQueryRunner();
  async function reconcile(id: TaskId) { await getHarness().commit(tx => reconcileAppData(tx, directory, id), context); }
  async function recover() {
    const harness = getHarness(), binding = await harness.snapshot(PersonalAppDataDoc, context);
    if (!binding?.instanceId) throw invalid();
    if (binding.initializing) {
      if (binding.operations.length) throw invalid();
      const store = new AppDataStore(fileFor(directory), { initialInstanceId: binding.instanceId }); store.close();
      await harness.commit(async tx => { delete (await tx.doc(PersonalAppDataDoc)).initializing; }, context);
    }
    const saved = (await harness.snapshot(PersonalAppDataDoc, context))!;
    let unavailable: string | undefined;
    try { const store = openBound(directory, saved.instanceId!); store.close(); } catch (error) { if (!(error instanceof PersonalError)) throw error; unavailable = error.code; }
    await harness.commit(async tx => { const doc = await tx.doc(PersonalAppDataDoc); if (unavailable) doc.unavailable = unavailable; else delete doc.unavailable; }, context);
    for (const id of saved.operations) await reconcile(id);
  }
  const descriptions = {
    app_data_define_table: "声明业务表，保存待办、提醒、习惯等结构化数据；偏好、约定、决策、经验用memory。先query mode=schema获取expected_schema_version；表存在报冲突。字段和索引名称遵守表名格式，表最多32字段/8索引，每索引最多4字段；关系引用已声明表的_id，删除受RESTRICT约束。",
    app_data_migrate: "单事务迁移，最多16步。steps每项为{op,table,...}：add_field用field:{name,type,nullable:true}；add_index用name/fields/unique；drop_index用name；drop_field用field名称；drop_table无需其他项；rewrite_rows用rows:[{id,expected_version,set}]。先query获取expected_schema_version。删除表/字段/唯一索引和任何rewrite_rows在请求确认/自动审查等待原入口人工批准，完全访问免逐次批准。批准后schema/revision变化拒绝。",
    app_data_insert: "按已声明schema原子插入1至100行，字段必须已声明；非法行整批拒绝。结果summary提供行id，新行_version为1。单字段最多16KiB、合并后整行最多32KiB、整次参数最多64KiB、每表最多10000行。",
    app_data_update: "按明确id和expected_version更新字段，必须提供每行set；先query读取行版本。单行直接执行，多行在请求确认/自动审查等待原入口人工批准，完全访问免逐次批准；批准后revision变化拒绝。禁止无条件全表写；每次最多100行。",
    app_data_delete: "按明确id和expected_version删除行，先query读取行版本；省略set。单行直接执行，多行在请求确认/自动审查等待原入口人工批准，完全访问免逐次批准；批准后revision变化拒绝。关系RESTRICT不级联，每次最多100行。",
  };
  const writeTools = (["app_data_define_table", "app_data_migrate", "app_data_insert", "app_data_update", "app_data_delete"] as const).map(name => defineTool({ name, description: descriptions[name] + " 所有写入须给非空reason（最多1KiB）。同一逻辑调用恢复只读原回执，不再次写入。缺库、换库或回执损坏会暂停所属工作和报告；此时结束本轮并报告拥有者，从/应用数据或本机应用数据管理恢复原库后重新核实，仍可查询/取消工作，勿换键、工具或子Agent重试。", parameters: { ...(name === "app_data_define_table" ? APP_DATA_PARAMETERS.define_table : name === "app_data_migrate" ? APP_DATA_PARAMETERS.migrate : name === "app_data_insert" ? APP_DATA_PARAMETERS.insert : APP_DATA_PARAMETERS.row_write(name === "app_data_update" ? "update" : "delete")), additionalProperties: false }, replay: "safe", executionMode: "sequential", async execute(input, api, callContext) {
    const params = input as Params;
    const harness = getHarness();
    try {
      const live = await api.snapshot(LiveDoc, api.conversationId, callContext), candidate = live?.run?.inputs.length === 1 ? await harness.submission(live.run.inputs[0], callContext) : undefined, requestId = (await candidate?.status(callContext))?.requestId;
      const saved = await api.commit(async tx => {
        const doc = await tx.doc(PersonalAppDataDoc), previous = (await tx.doc(PersonalAppDataOperationDoc, String(api.taskId), null)).operation;
        if (previous) { if (previous.name !== name || !isDeepStrictEqual(previous.params, params) || previous.origin.conversationId !== api.conversationId) throw new PersonalError("app_data_request_conflict", "原应用数据参数不同，未执行；请查询原操作，不换键重试。"); return copyJson(previous) as Operation; }
        const origin = await personalToolOrigin(tx, api, requestId); await childAllowed(tx, origin);
        if (!doc.instanceId || doc.initializing) throw invalid();
        validateReason(params.reason);
        if (Buffer.byteLength(JSON.stringify(params)) > LIMITS.maxWriteBytes) throw new AppDataError("payload_too_large", "应用数据参数超过64KiB，请缩小本次操作。");
        const store = openBound(directory, doc.instanceId);
        let destructive: boolean, versions: Operation["versions"];
        try { versions = store.getVersions(); destructive = name === "app_data_migrate" ? analyzeMigrate(store, params).destructive : (name === "app_data_update" || name === "app_data_delete") && Array.isArray(params.rows) && params.rows.length > 1; } finally { store.close(); }
        const admitted = { operation: api.taskId, opId: `durable:${api.taskId}`, name, params, fingerprint: digest([name, params, origin, doc.instanceId]), origin, instanceId: doc.instanceId, versions, destructive };
        const admission = await tx.appendEntry(AppDataAdmission, api.conversationId, { data: admitted });
        const value: Operation = { ...admitted, admission: admission.id, decision: destructive && origin.permission.mode !== "full_access" ? "pending" : "unneeded" };
        (await tx.doc(PersonalAppDataOperationDoc, String(api.taskId), null)).operation = value; doc.operations.push(api.taskId);
        return copyJson(value) as Operation;
      }, callContext);
      if (saved.started) await reconcile(api.taskId);
      else if (!saved.result) {
        await waitOperation(api, api.taskId, value => value.decision !== "pending" || !!value.result, callContext);
        const executable = await api.commit(async tx => {
          const value = await appDataOperation(tx, api.taskId);
          if (value.started || value.result) return undefined;
          if (value.decision === "rejected") { await observe(tx, api.taskId, { effect: "not_committed", code: "rejected", op_id: value.opId }); return undefined; }
          await active(tx, value);
          if (value.decision !== "approved" && value.decision !== "unneeded") throw invalid();
          value.started = (await tx.appendEntry(AppDataStart, value.origin.conversationId, { data: { operation: api.taskId, admission: value.admission } })).id;
          return copyJson(value) as Operation;
        }, callContext);
        if (executable) {
          let store: AppDataStore | undefined;
          try {
            store = openBound(directory, executable.instanceId, false);
            const input = { ...executable.params, opId: executable.opId, ctx: operationContext(executable) };
            if (name === "app_data_define_table") store.defineTable(input);
            else if (name === "app_data_migrate") store.migrate(input);
            else if (name === "app_data_insert") store.insert(input);
            else if (name === "app_data_update") store.updateRows(input);
            else store.deleteRows(input);
          } catch (error) {
            const code = error instanceof AppDataError || error instanceof PersonalError ? error.code : "app_data_write_failed";
            // 已开始操作只从原回执分类，写失败不作为重发依据。
            await reconcile(api.taskId);
            await harness.commit(async tx => { const value = await appDataOperation(tx, api.taskId); if (value.result?.effect === "not_committed") await observe(tx, api.taskId, { ...value.result, code }); }, context);
          } finally { store?.close(); }
          await reconcile(api.taskId);
        }
      }
      const result = (await harness.snapshot(PersonalAppDataOperationDoc, String(api.taskId), context))!.operation!.result!;
      return { ...(result.effect !== "committed" ? { isError: true } : {}), output: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      if (!(error instanceof PersonalError) && !(error instanceof AppDataError) && !callContext.abortSignal?.aborted) throw error;
      const value = (await harness.snapshot(PersonalAppDataOperationDoc, String(api.taskId), context))?.operation;
      if (value?.started) await reconcile(api.taskId);
      else if (value && !value.result) await harness.commit(tx => observe(tx, api.taskId, { effect: "not_committed", code: error instanceof PersonalError || error instanceof AppDataError ? error.code : "canceled", op_id: value.opId }), context);
      return { isError: true, output: [{ type: "text", text: error instanceof PersonalError || error instanceof AppDataError ? `${error.code}：${error instanceof AppDataConflictError ? `${error.message}；当前版本${JSON.stringify(error.current)}` : error.message}` : "app_data_canceled：操作已停止，请查询原操作。" }] };
    }
  } }));
  const query = defineTool({ name: "app_data_query", description: "查询应用数据。mode=schema发现表结构与schema_version；rows按_id分页，字段条件为AND，in用values（1至100项），其余比较用value，空值判断省略值；changes分页读审计或传op_id核实原操作。默认50行、硬上限100行/64KiB，最多扫描1000候选，总时限2秒；complete=false须用next_cursor与原参数继续，即使本页为空。游标冲突重新查询，单条过大缩小fields。查询不提供新操作授权，汇总仅可查询。缺库或身份不符时停止并报告拥有者恢复原库，勿建立空库。", parameters: { ...APP_DATA_PARAMETERS.query, additionalProperties: false }, outputLimits: { maxBytes: 128 * 1024, maxLines: 1000 }, replay: "safe", async execute(params, api, callContext) {
    try {
      const instanceId = await api.commit(async tx => {
        await activePersonalReferenceTool(tx, api, "app_data_query");
        const live = await tx.doc(LiveDoc, api.conversationId), scheduled = await scheduledConversation(tx, api.conversationId);
        if (scheduled) {
          const submission = scheduled.run.sealed ? scheduled.run.summary?.submissionId : scheduled.run.submissionId;
          if (!submission || !isDeepStrictEqual(live.run?.inputs, [submission])) throw new PersonalError("app_data_forbidden", "查询缺少本次定时执行或汇总来源，请结束本轮并报告拥有者。");
          await requireScheduledSourceReady(tx, scheduled.run.requestId); await verifyPersonalScheduleScope(tx, scheduled.plan.scope);
        } else if (api.conversationId !== ROOT_CONVERSATION_ID) { const work = await activePersonalWorkInspection(tx, api.conversationId, live.run!.inputs); if (!(await tx.doc(PersonalWorkDoc, work.work.ref.requestId, null)).appData) throw new PersonalError("app_data_forbidden", "本次子工作未获应用数据资格，请向主 Agent 请求所需资料。"); }
        const id = (await tx.doc(PersonalAppDataDoc)).instanceId; if (!id) throw invalid(); return id;
      }, callContext);
      const store = openBound(directory, instanceId); store.close();
      const raw = { ...params, ...(params.op_id === undefined ? {} : { opId: params.op_id }) }; delete raw.op_id;
      const result = await runner.run(fileFor(directory), validateQueryRequest(raw), { expectedInstanceId: instanceId });
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) { if (!(error instanceof PersonalError) && !(error instanceof AppDataError)) throw error; return { isError: true, output: [{ type: "text", text: `${error.code}：${error.message}` }] }; }
  } });
  return { extension: defineExtension({ name: PERSONAL_APP_DATA, tools: [...writeTools.slice(0, 2), query, ...writeTools.slice(2)] }), recover, reconcile, close() { const active = runner.inFlight > 0, closing = runner.dispose(); return active ? closing : undefined; } };
}

export async function verifyAppData(tx: Tx, keys: string[], tools: readonly ToolRegistration[] | undefined) {
  const doc = await tx.doc(PersonalAppDataDoc), values = await appDataOperations(tx);
  if (!doc.instanceId) { if (keys.length || values.length || doc.binding) throw invalid(); return; }
  const binding = doc.binding && await tx.entry(AppDataBinding, doc.binding);
  if (!binding || binding.conversationId !== ROOT_CONVERSATION_ID || binding.data.instanceId !== doc.instanceId || values.length !== keys.length || new Set(doc.operations).size !== values.length || values.some(value => !keys.includes(String(value.operation)))) throw invalid();
  for (const value of values) {
    const { admission: admissionId, decision, decisionEntry, actor, started, result, observation, ...admitted } = value;
    const admission = await tx.entry(AppDataAdmission, admissionId), task = await tx.task(value.operation), input = task?.input;
    const assistant = input && typeof input === "object" && !Array.isArray(input) && typeof input.assistant === "number" ? await tx.entry(input.assistant as EntryId) : undefined;
    const call = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === (input && typeof input === "object" && !Array.isArray(input) ? input.callId : undefined));
    let normalized: Params | undefined;
    const definition = tools?.find(tool => tool.name === value.name);
    if (call?.type === "toolCall" && definition) { try { normalized = validateToolArguments(definition, { ...call, arguments: copyJson(call.arguments) as Params }) as Params; } catch { throw invalid(); } }
    if (!admission || admission.conversationId !== value.origin.conversationId || !isDeepStrictEqual(admission.data, admitted) || value.instanceId !== doc.instanceId || value.opId !== `durable:${value.operation}` || value.fingerprint !== digest([value.name, value.params, value.origin, value.instanceId]) || task?.kind !== "pi.tool" || task.conversationId !== value.origin.conversationId || task.owner !== value.origin.generation || assistant?.byTaskId !== value.origin.generation || assistant!.id >= admissionId || call?.type !== "toolCall" || call.name !== value.name || !isDeepStrictEqual(normalized, value.params) || !["pending", "approved", "rejected", "unneeded"].includes(decision) || (["approved", "rejected"].includes(decision) !== !!decisionEntry) || !!result !== !!observation || (started && decision !== "approved" && decision !== "unneeded")) throw invalid();
    const original = await personalSource(tx, value.origin.source.requestId);
    if (!isDeepStrictEqual(original.source, value.origin.source)) throw invalid();
    if (value.origin.work) { const current = await personalWorkInspectionSource(tx, value.origin.work.ref, value.origin.inputs, admissionId); if (!isDeepStrictEqual(current, { work: value.origin.work, sources: value.origin.sources }) || !(await tx.doc(PersonalWorkDoc, value.origin.work.ref.requestId, null)).appData) throw invalid(); }
    else if (value.origin.conversationId !== original.submission.conversationId || !isDeepStrictEqual(value.origin.inputs, [original.submission.id]) || !isDeepStrictEqual(value.origin.sources, [original.submission.id])) throw invalid();
    if (!isDeepStrictEqual(original.telegram, value.origin.telegram) || !isDeepStrictEqual(original.permission, value.origin.permission)) throw invalid();
    if (decisionEntry && !isDeepStrictEqual((await tx.entry(AppDataDecision, decisionEntry))?.data, { operation: value.operation, decision, ...(actor ? { actor } : {}) })) throw invalid();
    if (started && !isDeepStrictEqual((await tx.entry(AppDataStart, started))?.data, { operation: value.operation, admission: admissionId })) throw invalid();
    if (observation && !isDeepStrictEqual((await tx.entry(AppDataObservation, observation))?.data, { operation: value.operation, result })) throw invalid();
    if (result && (!["committed", "not_committed", "effect_unknown"].includes(result.effect) || result.op_id !== value.opId || result.effect !== "not_committed" && !started)) throw invalid();
  }
  let cursor: Cursor | undefined;
  const seen = new Set<TaskId>(), starts = new Set<TaskId>(), decisions = new Set<TaskId>(), observations = new Map<TaskId, EntryId>();
  do { const page = await tx.scanConversations({}, 256, cursor); for (const conversation of page.items) { let next: Cursor | undefined; do { const entries = await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, next); for (const entry of entries.items) {
    if (AppDataBinding.is(entry) && entry.id !== doc.binding) throw invalid();
    if (AppDataAdmission.is(entry)) { if (!values.some(value => value.admission === entry.id) || seen.has(entry.data.operation)) throw invalid(); seen.add(entry.data.operation); }
    if (AppDataStart.is(entry)) { if (!values.some(value => value.started === entry.id) || starts.has(entry.data.operation)) throw invalid(); starts.add(entry.data.operation); }
    if (AppDataDecision.is(entry)) { if (!values.some(value => value.decisionEntry === entry.id) || decisions.has(entry.data.operation)) throw invalid(); decisions.add(entry.data.operation); }
    if (AppDataObservation.is(entry)) { if (!values.some(value => value.operation === entry.data.operation && value.origin.conversationId === entry.conversationId && value.admission < entry.id)) throw invalid(); observations.set(entry.data.operation, entry.id); }
  } next = entries.next; } while (next); } cursor = page.next; } while (cursor);
  if (seen.size !== values.length || values.some(value => value.observation !== observations.get(value.operation))) throw invalid();
}

export async function configureAppDataChild(tx: Tx, id: import("@earendil-works/pi-durable").ConversationId, enabled: boolean) {
  const agent = await tx.doc(AgentDoc, id);
  if (!Array.isArray(agent.extensions) || !Array.isArray(agent.tools)) throw invalid();
  agent.extensions = agent.extensions.filter(name => name !== PERSONAL_APP_DATA);
  agent.tools = agent.tools.filter(name => !PERSONAL_APP_DATA_TOOLS.some(tool => tool === name));
  if (enabled) { agent.extensions.push(PERSONAL_APP_DATA); agent.tools.push(...PERSONAL_APP_DATA_TOOLS); }
}
