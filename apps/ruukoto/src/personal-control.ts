import { personalQuestionList, personalQuestionDetail, personalQuestionReceipt, answerPersonalQuestion, cancelPersonalQuestion, type PersonalOwnerAnswer } from "./personal-questions.ts";
import { listPersonalServiceGrants, revokePersonalServiceGrant } from "./personal-service-operations.ts";
import { appDataList, appDataDetail, appDataDecide, appDataRecheck } from "./personal-app-data.ts";
import { parsePersonalMemoryControl, personalMemoryControl } from "./personal-memory-controls.ts";
import { readPersonalMemory, searchPersonalMemory } from "./personal-memory.ts";
import { readPersonalHistory, searchPersonalHistory, personalTimeline } from "./personal-history.ts";
import { personalDesktopEvents } from "./personal-desktop-events.ts";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { parsePersonalQq, readPersonalQq } from "./personal-qq-config.ts";
import { exportPersonalArtifact, type PersonalArtifact } from "./personal-artifacts.ts";
import { browserList, browserDetail, browserResolve } from "./personal-browser.ts";
import { readPersonalBrowser } from "./personal-browser-config.ts";
import { personalPermissionFor, PersonalPermissionsDoc } from "./personal-permissions.ts";
import { copyJson } from "@earendil-works/chord";
import { readPersonalTools } from "./personal-tools-config.ts";
import { PersonalToolsDoc, personalArtifactEntries, toolList, toolDetail, toolDecide, toolResolve, toolVerifyStop, toolGrant, toolRevoke } from "./personal-tools.ts";
import * as fs from "node:fs";
import { SkillLibraryError } from "@ruukoto/agent/skills.ts";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, type EntryRecord, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import { openPersonalHarness } from "./personal-harness.ts";
import { parsePersonalModel, personalProvider } from "./personal-model.ts";
import { lockPersonalProfile } from "./personal-profile.ts";
import { readPersonalConfig } from "./personal-config.ts";
import { PersonalError } from "./personal-error.ts";
import { parsePersonalTelegram, readPersonalTelegram } from "./personal-telegram-config.ts";
import { parsePersonalServices, readPersonalServices } from "./personal-service-config.ts";
import { parsePersonalCommands, readPersonalCommands } from "./personal-command-config.ts";
import { personalBootstrapConfigurations } from "./personal-settings-records.ts";
import { appendPersonalWork, PersonalWorkDoc, closePersonalWorkAgent, listPersonalWorks, personalWorkRef, personalWorkResult, personalWorkSummary, requestPersonalWorkCancel } from "./personal-work.ts";
import { cancelPersonalDelegation, listPersonalDelegations, personalDelegationProgress } from "./personal-delegation.ts";
import { personalReportResult } from "./personal-report.ts";
import { listPersonalInspections } from "./personal-inspection-controls.ts";
import { listPersonalServices, personalServiceDetail, personalServiceRef, parsePersonalServiceResolution, type PersonalServiceResolution } from "./personal-service-controls.ts";
import { resolvePersonalServiceOperation } from "./personal-service-operations.ts";
import { personalCommandRef, resolvePersonalCommand } from "./personal-command-work.ts";
import { mcpDecide, mcpDetail, mcpList, mcpResolve } from "./personal-mcp.ts";
import { parsePersonalMcp, readPersonalMcp } from "./personal-mcp-config.ts";
import { parsePersonalScheduleCreate, type PersonalScheduleCreateBody } from "./personal-scheduler-controls.ts";
import { dispatchPersonalSettings, personalSettingsIdentity, PERSONAL_SETTINGS_LIMITS, type PersonalSettingsRequest } from "./personal-settings.ts";
import type { PersonalImPairingRequest } from "./personal-im-pairing.ts";
import type { PersonalSettingsWriteRequest } from "./personal-settings-operations.ts";
import { PersonalTelegramDoc } from "./personal-telegram.ts";

import { LocalInputDoc, personalInputDigest } from "./personal-local-records.ts";
export { LocalInputDoc } from "./personal-local-records.ts";

const context = BACKGROUND_CONTEXT;
const MAX_REQUEST = 128 * 1024;
const MAX_RESPONSE = 256 * 1024;
export const PERSONAL_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type PersonalToolsControlBody = { mode: "auto-review" | "confirm" | "full_access"; scope?: "qq" } | { id: string; version: number } | { operation: TaskId; decision: "approved" | "rejected" } | { operation: TaskId; effect: "applied" | "not_applied"; evidence: string } | { operation: TaskId; evidence: string } | { path: string } | { id: string } | { artifact: string; destination: string };
export type PersonalInput = { requestId: string; input: string; work?: TaskId };
export type PersonalInputStatus = { status: "queued" | "placed" | "done" | "unanswered" | "missing"; answer?: string; truncated?: boolean };
export type PersonalStatus = { model: string; tasks: number; inputs: number; services: boolean; capabilities: { commands: boolean; mcp: boolean; tools: boolean; browser: boolean; telegram: boolean; qq: boolean } };
export type PersonalMessage = { role: "user" | "assistant"; text: string; partial: boolean; truncated: boolean };

function queryNumber(url: URL, key: string, fallback?: number) {
  const value = url.searchParams.get(key);
  if (value === null && fallback !== undefined) return fallback;
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new PersonalError("work_input_invalid", "工作查询参数无效，请重新选择原工作。");
  return Number(value);
}

async function readControlJSON(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST) throw new PersonalError("control_request_large", "消息请求过大，请缩短消息后再提交。");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (error) {
    throw new PersonalError("control_request_invalid", "消息请求格式无效，请重新打开向导。", { cause: error });
  }
}

export function parsePersonalInput(value: unknown): PersonalInput {
  if (!value || typeof value !== "object" || !("requestId" in value) || typeof value.requestId !== "string" || !PERSONAL_REQUEST_ID.test(value.requestId)
    || !("input" in value) || typeof value.input !== "string" || !value.input.trim() || Buffer.byteLength(value.input) > 16384 || ("work" in value && (typeof value.work !== "number" || !Number.isSafeInteger(value.work) || value.work < 1))) {
    throw new PersonalError("input_invalid", "请输入非空消息，每条最多 16 KiB；请求标识由程序管理。");
  }
  return { requestId: value.requestId, input: value.input, ...("work" in value ? { work: value.work as TaskId } : {}) };
}

export type PersonalQuestionWrite = { question: string; version: number; requestId: string; answers?: PersonalOwnerAnswer[] };
export function parsePersonalQuestionWrite(value: unknown, answer: boolean): PersonalQuestionWrite {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["question", "version", "requestId", ...(answer ? ["answers"] : [])].includes(key)) || !("question" in value) || typeof value.question !== "string" || !/^[1-9][0-9]*$/.test(value.question) || !("version" in value) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !("requestId" in value) || typeof value.requestId !== "string" || !PERSONAL_REQUEST_ID.test(value.requestId) || answer && (!("answers" in value) || !Array.isArray(value.answers))) throw new PersonalError("question_input_invalid", "请从问题菜单逐题回答并核对；请求标识由程序管理。");
  return { question: value.question, version: Number(value.version), requestId: value.requestId, ...(answer && "answers" in value ? { answers: value.answers as PersonalOwnerAnswer[] } : {}) };
}

function text(entry: EntryRecord): PersonalMessage | undefined {
  const message = entry.model?.[0];
  if (message?.role !== "user" && message?.role !== "assistant") return;
  const content = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("");
  return { role: message.role, text: content.slice(0, 8192), truncated: content.length > 8192, partial: message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted") };
}

export function readPersonalToken(directory: string): string {
  let token: string;
  try {
    const filename = path.join(directory, "control.token");
    if (!fs.lstatSync(filename).isFile()) throw new PersonalError("control_token_invalid", "本机认证文件类型无效，请保留档案并检查权限。");
    token = fs.readFileSync(filename, "utf8").trim();
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("control_unavailable", "无法读取本机认证文件，请先启动隔离后台；仍有后台运行时请检查权限。", { cause: error });
  }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new PersonalError("control_token_invalid", "本机认证文件无效，请保留档案并检查；未自动覆盖。");
  return token;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-personal-token-atomic-publish.md
export async function startPersonalServer(directory: string, options: { development?: boolean } = {}) {
  const profile = lockPersonalProfile(directory);
  const socketPath = path.join(directory, "control.sock");
  const active = new Set<Promise<void>>();
  const server = http.createServer();
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = PERSONAL_SETTINGS_LIMITS.modelTestMs + 5000;
  let listenerClosed: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let personal: Awaited<ReturnType<typeof openPersonalHarness>> | undefined;
  let desktopEvents: ReturnType<typeof personalDesktopEvents> | undefined;
  const runId = randomUUID();
  const telegramStop = new AbortController();
  let qqLoop: Promise<void> | undefined;
  let telegramLoop: Promise<void> | undefined;
  const closeListener = () => listenerClosed ??= (async () => {
    telegramStop.abort();
    await desktopEvents?.close();
    await Promise.all([telegramLoop, qqLoop]);
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...active]);
  })();
  const stop = () => shutdown ??= (async () => { await closeListener(); await personal?.close(); })();
  try {
    if (options.development && (readPersonalTelegram(profile)?.enabled || readPersonalQq(profile)?.enabled)) throw new PersonalError("development_im_enabled", "开发实例不接入真实 IM。请先在开发配置菜单停用 QQ 与 Telegram；原配置与消息保持，请勿使用生产凭据配对。");
    const bootstrap = await personalBootstrapConfigurations(profile);
    const config = bootstrap.has("model") ? parsePersonalModel(bootstrap.get("model")) : readPersonalConfig(profile);
    const telegram = bootstrap.has("telegram") ? bootstrap.get("telegram") === null ? undefined : parsePersonalTelegram(bootstrap.get("telegram")) : readPersonalTelegram(profile);
    const qq = bootstrap.has("qq") ? bootstrap.get("qq") === null ? undefined : parsePersonalQq(bootstrap.get("qq")) : readPersonalQq(profile);
    if (options.development && (telegram?.enabled || qq?.enabled)) throw new PersonalError("development_im_enabled", "开发实例不接入真实 IM。请先在开发配置菜单停用 QQ 与 Telegram；原配置与消息保持，请勿使用生产凭据配对。");
    const services = bootstrap.has("services") ? bootstrap.get("services") === null ? undefined : parsePersonalServices(bootstrap.get("services")) : readPersonalServices(profile);
    const commands = bootstrap.has("commands") ? bootstrap.get("commands") === null ? undefined : parsePersonalCommands(bootstrap.get("commands")) : readPersonalCommands(profile);
    const mcp = bootstrap.has("mcp") ? bootstrap.get("mcp") === null ? undefined : parsePersonalMcp(bootstrap.get("mcp")) : readPersonalMcp(profile);
    const tools = readPersonalTools(profile);
    const browser = readPersonalBrowser(profile);
    if (fs.existsSync(path.join(directory, "control.token"))) readPersonalToken(directory);
    if (Buffer.byteLength(socketPath) > 100) throw new PersonalError("control_path_long", "隔离档案路径过长，请用较短的新目录启动。");
    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(path.join(directory, "control.token.tmp"), token + "\n", { mode: 0o600 });
    fs.renameSync(path.join(directory, "control.token.tmp"), path.join(directory, "control.token"));
    fs.rmSync(socketPath, { force: true });
    server.on("request", (_req, res) => res.writeHead(503, { connection: "close", "content-type": "application/json" }).end(JSON.stringify({ v: 1, ok: false, code: "control_starting", message: "隔离后台正在恢复，请稍后查询。" })));
    server.listen(socketPath);
    await once(server, "listening");
    fs.chmodSync(socketPath, 0o600);
    personal = await openPersonalHarness({ profile, provider: personalProvider(config), modelId: config.modelId, telegram, qq, ...(services ? { service: { ...services, useSudo: true }, serviceOperations: true } : {}), ...(commands ? { commands } : {}), ...(mcp ? { mcp } : {}), ...(tools ? { tools } : {}), ...(browser ? { browser } : {}), beforeUnlock: closeListener });
    const instance = personal;
    desktopEvents = personalDesktopEvents(server, instance.harness, token, runId);
    qqLoop = instance.qq.poll(telegramStop.signal).catch(() => { process.stderr.write("[ruukoto:personal] QQ 收件已停止，请查询状态并检查档案；未自动重启。\n"); });
    telegramLoop = instance.telegram.poll(telegramStop.signal).catch(() => { process.stderr.write("[ruukoto:personal] Telegram 收件已停止，请查询状态并检查档案；未自动重启。\n"); });
    const respond = (res: http.ServerResponse, status: number, result: unknown) => {
      if (res.destroyed) return;
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > MAX_RESPONSE) throw new PersonalError("control_response_large", "本次查询结果过大，请缩小查询范围。");
      res.writeHead(status, { "content-type": "application/json", "connection": "close" }).end(body);
    };
    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let requestedStop = false;
      try {
        const authorization = req.headers.authorization;
        const supplied = Buffer.from(authorization ?? "");
        const expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new PersonalError("control_unauthorized", "本机认证失败，请重新连接当前隔离实例。");
        if (listenerClosed) throw new PersonalError("control_stopping", "后台正在停止，请等待停止完成后再启动。");
        const url = new URL(req.url ?? "/", "http://localhost");
        let result: unknown;
        if (req.method === "GET" && url.pathname === "/desktop/identity") {
          result = { v: 1, product: "ruukoto", profile: personalSettingsIdentity(profile), runId };
        } else if (req.method === "GET" && url.pathname === "/timeline") {
          result = await instance.harness.commit(tx => personalTimeline(tx, { ...(url.searchParams.has("through") ? { through: queryNumber(url, "through") } : {}), ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}) }), context);
        } else if (req.method === "GET" && url.pathname === "/settings") {
          result = await dispatchPersonalSettings({ profile, instance, development: options.development }, { v: 1, op: "settings.read" });
        } else if (req.method === "POST" && url.pathname === "/settings") {
          result = await dispatchPersonalSettings({ profile, instance, development: options.development }, await readControlJSON(req));
        } else if (req.method === "GET" && url.pathname === "/status") {
          const live = await instance.harness.inspect(context);
          const selected = instance.configurationStatus(), im = await instance.harness.snapshot(PersonalTelegramDoc, context);
          result = { ...selected, tasks: live.tasks.length, inputs: live.submissions.length, capabilities: { ...selected.capabilities, telegram: !!im?.config?.enabled, qq: !!im?.qqConfig?.enabled } } satisfies PersonalStatus;
        } else if (req.method === "GET" && url.pathname === "/messages") {
          const entries = await instance.main.entries({}, 64, undefined, context);
          result = entries.items.map(text).filter(item => item !== undefined).slice(0, 16).reverse();
        } else if (req.method === "GET" && url.pathname === "/questions") {
          result = await instance.harness.commit(tx => personalQuestionList(tx, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "GET" && url.pathname === "/question") {
          const id = url.searchParams.get("question");
          if (!id || !/^[1-9][0-9]*$/.test(id)) throw new PersonalError("question_input_invalid", "请从问题列表选择原问题。");
          result = await instance.harness.commit(tx => personalQuestionDetail(tx, id), context);
        } else if (req.method === "GET" && url.pathname === "/question/receipt") {
          const requestId = url.searchParams.get("requestId");
          if (!requestId || !PERSONAL_REQUEST_ID.test(requestId)) throw new PersonalError("question_input_invalid", "请从问题菜单核实原回答。");
          result = await instance.harness.commit(async tx => await personalQuestionReceipt(tx, requestId) ?? null, context);
        } else if (req.method === "POST" && ["/question/answer", "/question/cancel"].includes(url.pathname)) {
          const input = parsePersonalQuestionWrite(await readControlJSON(req), url.pathname.endsWith("answer"));
          result = await instance.harness.commit(tx => input.answers ? answerPersonalQuestion(tx, { ...input, answers: input.answers }, { kind: "local" }) : cancelPersonalQuestion(tx, input, { kind: "local" }), context);
          instance.harness.resume();
        } else if (req.method === "GET" && url.pathname === "/memories") {
          result = await instance.harness.commit(tx => searchPersonalMemory(tx, directory, ROOT_CONVERSATION_ID, url.searchParams.get("query") ?? "", queryNumber(url, "offset", 0), true), context);
        } else if (req.method === "GET" && url.pathname === "/memory") {
          result = await instance.harness.commit(tx => readPersonalMemory(tx, directory, ROOT_CONVERSATION_ID, queryNumber(url, "memory") as EntryId, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "POST" && url.pathname === "/memory") {
          const input = parsePersonalMemoryControl(await readControlJSON(req));
          result = await instance.harness.commit(tx => personalMemoryControl(tx, directory, input), context);
        } else if (req.method === "GET" && url.pathname === "/history") {
          result = await instance.harness.commit(tx => searchPersonalHistory(tx, ROOT_CONVERSATION_ID, { query: url.searchParams.get("query") ?? "", cursor: url.searchParams.get("cursor") ?? undefined }), context);
        } else if (req.method === "GET" && url.pathname === "/history/entry") {
          result = await instance.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry: queryNumber(url, "entry") as EntryId, offset: queryNumber(url, "offset", 0) }), context);
        } else if (req.method === "GET" && url.pathname === "/qq") {
          result = await instance.qq.status();
        } else if (req.method === "GET" && url.pathname === "/telegram") {
          result = await instance.telegram.status();
        } else if (req.method === "POST" && url.pathname === "/schedules") {
          const input = parsePersonalScheduleCreate(await readControlJSON(req));
          result = await instance.harness.commit(tx => instance.scheduler.create(tx, input, { kind: "local", requestId: input.requestId }), context);
          instance.harness.resume();
        } else if (req.method === "GET" && url.pathname === "/schedules") {
          result = await instance.harness.commit(tx => instance.scheduler.list(tx, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "GET" && url.pathname === "/schedule/run/result") {
          const id = url.searchParams.get("run");
          if (!id || id.length > 256) throw new PersonalError("schedule_input_invalid", "请选择原计划列表中的运行。");
          result = await instance.harness.commit(tx => instance.scheduler.result(tx, id, queryNumber(url, "offset", 0)), context);
        } else if ((req.method === "GET" && ["/schedule", "/schedule/runs"].includes(url.pathname)) || (req.method === "POST" && url.pathname === "/schedule/cancel")) {
          const requestId = url.searchParams.get("requestId");
          if (url.pathname === "/schedule" && requestId !== null) {
            if (!PERSONAL_REQUEST_ID.test(requestId)) throw new PersonalError("schedule_input_invalid", "请求标识无效，请从向导选择待核实计划。");
            result = await instance.harness.commit(async tx => await instance.scheduler.createByRequest(tx, requestId) ?? null, context);
          } else {
            const id = url.searchParams.get("schedule");
            if (!id || id.length > 256) throw new PersonalError("schedule_input_invalid", "请选择原定时计划。");
            result = await instance.harness.commit(async tx => {
              if (url.pathname === "/schedule/cancel") { await instance.scheduler.cancel(tx, id, { kind: "local", requestId: randomUUID() }); return { cancelRequested: true }; }
              if (url.pathname === "/schedule/runs") return instance.scheduler.runs(tx, id, queryNumber(url, "offset", 0));
              return instance.scheduler.get(tx, id);
            }, context);
            if (url.pathname === "/schedule/cancel") instance.harness.resume();
          }
        } else if (req.method === "GET" && url.pathname === "/permissions") {
          result = await instance.harness.commit(async tx => {
            const permission = await tx.doc(PersonalPermissionsDoc);
            return { default: { mode: permission.mode }, qq: { mode: permission.qq?.mode ?? "auto-review" } };
          }, context);
        } else if (req.method === "GET" && url.pathname === "/service/grants") {
          result = instance.service ? await instance.harness.commit(tx => listPersonalServiceGrants(tx, queryNumber(url, "offset", 0)), context) : { items: [] };
        } else if (req.method === "POST" && url.pathname === "/service/grants/revoke") {
          if (!instance.service) throw new PersonalError("service_config_missing", "服务未装配，请停止后台后通过向导配置。");
          const value = await readControlJSON(req);
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !("id" in value) || typeof value.id !== "string" || !("version" in value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) throw new PersonalError("service_grant_invalid", "请选择原长期授权；版本由向导管理。");
          await instance.harness.commit(tx => revokePersonalServiceGrant(tx, value.id as string, value.version as number), context);
          result = { saved: true };
        } else if (req.method === "POST" && url.pathname === "/permissions") {
          const value = await readControlJSON(req);
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["mode", "scope"].includes(key)) || "scope" in value && value.scope !== "qq" || !("mode" in value) || value.mode !== "auto-review" && value.mode !== "confirm" && value.mode !== "full_access") throw new PersonalError("permissions_input_invalid", "请选择自动审查、请求确认或完全访问。");
          const mode = value.mode, scope = "scope" in value && value.scope === "qq" ? "qq" : undefined;
          await instance.harness.commit(async tx => {
            const permission = await personalPermissionFor(tx, scope ? { platform: scope } : undefined);
            if (permission.mode === mode) return;
            permission.mode = mode; permission.version++;
            await tx.appendEntry(instance.main.id, { kind: "ruukoto.permissions-change", data: { mode, version: permission.version, source: "local", ...(scope ? { scope } : {}) } });
          }, context);
          result = { saved: true };
        } else if (req.method === "GET" && url.pathname === "/browser") {
          result = { enabled: !!instance.browser, ...(instance.browser?.status() ?? {}) };
        } else if (req.method === "GET" && url.pathname === "/browser/operations") {
          result = await instance.harness.commit(tx => browserList(tx, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "GET" && url.pathname === "/browser/operation") {
          result = await instance.harness.commit(tx => browserDetail(tx, queryNumber(url, "operation") as TaskId, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "POST" && url.pathname === "/browser/stop") {
          if (!instance.browser) throw new PersonalError("browser_config_missing", "浏览器未装配，请停止后台后通过向导配置。");
          result = { stopped: url.searchParams.has("operation") ? await instance.browser.verifyStop(queryNumber(url, "operation") as TaskId) : await instance.browser.stop() };
        } else if (req.method === "POST" && url.pathname === "/browser/resolve") {
          const value = await readControlJSON(req);
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !("effect" in value) || value.effect !== "applied" && value.effect !== "not_applied" || !("evidence" in value) || typeof value.evidence !== "string") throw new PersonalError("browser_resolution_invalid", "请选择原网页效果并填写独立核实证据。");
          await instance.harness.commit(tx => browserResolve(tx, queryNumber(url, "operation") as TaskId, value.effect as "applied" | "not_applied", value.evidence as string), context);
          result = { saved: true };
        } else if (req.method === "GET" && url.pathname === "/works") {
          const offset = queryNumber(url, "offset", 0);
          result = await instance.harness.commit(tx => listPersonalWorks(tx, offset), context);
        } else if (req.method === "GET" && url.pathname === "/inspections") {
          result = await instance.harness.commit(tx => listPersonalInspections(tx, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "POST" && url.pathname === "/inspection/stop") {
          const ref = { taskId: queryNumber(url, "inspection") as TaskId, admission: queryNumber(url, "admission") as EntryId };
          await instance.requestInspectionStop(ref);
          result = { requested: true };
        } else if (req.method === "GET" && url.pathname === "/services") {
          result = await instance.harness.commit(tx => listPersonalServices(tx, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "GET" && ["/tools/operations", "/tools/operation", "/tools/grants", "/tools/artifacts"].includes(url.pathname)) {
          if (!instance.tools && url.pathname !== "/tools/artifacts") throw new PersonalError("tools_config_missing", "资料与网络工具未装配，请停止后台后通过向导配置。");
          const offset = queryNumber(url, "offset", 0);
          result = await instance.harness.commit(async tx => {
            if (url.pathname === "/tools/operations") return toolList(tx, offset);
            if (url.pathname === "/tools/operation") return toolDetail(tx, queryNumber(url, "operation") as TaskId, offset);
            if (url.pathname === "/tools/grants") { const all = (await tx.doc(PersonalToolsDoc)).grants; return { items: all.slice(offset, offset + 8).map(value => ({ id: value.id, path: value.path, revoked: value.revoked })), ...(offset + 8 < all.length ? { nextOffset: offset + 8 } : {}) }; }
            const all = await personalArtifactEntries(tx);
            return { items: all.slice(offset, offset + 8).map(value => ({ artifact: value.artifact!.id, kind: value.kind, target: value.target, bytes: value.artifact!.bytes, partial: value.artifact!.partial, mime: value.artifact!.mime })), ...(offset + 8 < all.length ? { nextOffset: offset + 8 } : {}) };
          }, context);
        } else if (req.method === "POST" && ["/tools/decide", "/tools/resolve", "/tools/stop", "/tools/grant", "/tools/revoke", "/tools/export"].includes(url.pathname)) {
          if (!instance.tools && url.pathname !== "/tools/export") throw new PersonalError("tools_config_missing", "资料与网络工具未装配，请停止后台后通过向导配置。");
          const value = await readControlJSON(req);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new PersonalError("tool_input_invalid", "请选择原工具操作并填写所需说明。");
          if (url.pathname === "/tools/export") {
            if (Object.keys(value).length !== 2 || !("artifact" in value) || typeof value.artifact !== "string" || !("destination" in value) || typeof value.destination !== "string") throw new PersonalError("tool_input_invalid", "请选择原产物及完整导出路径。");
            const id = value.artifact;
            const ref = await instance.harness.commit(async tx => { const ref = (await personalArtifactEntries(tx)).find(value => value.artifact.id === id)?.artifact; return ref && copyJson(ref) as PersonalArtifact; }, context);
            if (!ref) throw new PersonalError("artifact_missing", "原产物不存在，请刷新产物列表。");
            await exportPersonalArtifact(directory, ref, value.destination);
          } else await instance.harness.commit(async tx => {
            if (url.pathname === "/tools/grant") { if (Object.keys(value).length !== 1 || !("path" in value) || typeof value.path !== "string") throw new PersonalError("tool_input_invalid", "请选择要开放读取的绝对路径。"); await toolGrant(tx, directory, value.path); return; }
            if (url.pathname === "/tools/revoke") { if (Object.keys(value).length !== 1 || !("id" in value) || typeof value.id !== "string") throw new PersonalError("tool_input_invalid", "请选择原资料授权。"); await toolRevoke(tx, value.id); return; }
            if (!("operation" in value) || !Number.isSafeInteger(value.operation) || Number(value.operation) < 1) throw new PersonalError("tool_input_invalid", "请选择原工具操作。");
            const operation = Number(value.operation) as TaskId;
            if (url.pathname === "/tools/decide") { if (Object.keys(value).length !== 2 || !("decision" in value) || value.decision !== "approved" && value.decision !== "rejected") throw new PersonalError("tool_input_invalid", "请选择批准本次或拒绝。"); await toolDecide(tx, operation, value.decision, directory); }
            else { if (!("evidence" in value) || typeof value.evidence !== "string") throw new PersonalError("tool_input_invalid", "请提供独立核实证据。"); if (url.pathname === "/tools/stop") { if (Object.keys(value).length !== 2) throw new PersonalError("tool_input_invalid", "原请求结束核实只需原操作和证据。"); await toolVerifyStop(tx, operation, value.evidence); } else { if (Object.keys(value).length !== 3 || !("effect" in value) || value.effect !== "applied" && value.effect !== "not_applied") throw new PersonalError("tool_input_invalid", "请选择实际效果并提供独立证据。"); await toolResolve(tx, operation, value.effect, value.evidence); } }
          }, context);
          result = { recorded: true };
        } else if (req.method === "GET" && url.pathname === "/app-data/operations") {
          result = await instance.harness.commit(tx => appDataList(tx, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "GET" && url.pathname === "/app-data/operation") {
          result = await instance.harness.commit(tx => appDataDetail(tx, queryNumber(url, "operation") as TaskId, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "POST" && ["/app-data/decide", "/app-data/recheck"].includes(url.pathname)) {
          const id = queryNumber(url, "operation") as TaskId;
          const value = (req.headers["content-length"] === undefined || req.headers["content-length"] === "0") && req.headers["transfer-encoding"] === undefined ? {} : await readControlJSON(req);
          if (url.pathname === "/app-data/decide") {
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("decision" in value) || value.decision !== "approved" && value.decision !== "rejected") throw new PersonalError("app_data_decision_invalid", "请选择批准本次或拒绝原应用数据操作。");
            await instance.harness.commit(tx => appDataDecide(tx, directory, id, value.decision as "approved" | "rejected"), context);
          } else {
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw new PersonalError("app_data_input_invalid", "请从向导选择原操作后重新核实回执。");
            await instance.harness.commit(tx => appDataRecheck(tx, directory, id), context);
          }
          result = { saved: true };
        } else if (req.method === "POST" && url.pathname === "/mcp/recheck") {
          throw new PersonalError("mcp_recheck_retired", "原请求续流核实已退役，不会联网；请查询原调用，结果未知时可选择结束此工作。");
        } else if (req.method === "GET" && url.pathname === "/mcp/operations") {
          result = await instance.harness.commit(tx => mcpList(tx, queryNumber(url, "offset", 0)), context);
        } else if ((req.method === "GET" && url.pathname === "/mcp/operation") || (req.method === "POST" && ["/mcp/decide", "/mcp/resolve", "/mcp/end", "/mcp/cua-recover"].includes(url.pathname))) {
          const operation = queryNumber(url, "operation") as TaskId;
          if (operation < 1) throw new PersonalError("mcp_input_invalid", "请选择列表中的原 MCP 操作。");
          if (url.pathname === "/mcp/decide") {
            const value = await readControlJSON(req);
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("decision" in value) || (value.decision !== "approved" && value.decision !== "rejected")) throw new PersonalError("mcp_decision_invalid", "请选择批准本次或拒绝原 MCP 操作。");
            await instance.harness.commit(tx => mcpDecide(tx, operation, value.decision as "approved" | "rejected"), context);
            result = { saved: true };
          } else if (url.pathname === "/mcp/resolve") {
            const value = await readControlJSON(req);
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !("effect" in value) || (value.effect !== "applied" && value.effect !== "not_applied") || !("evidence" in value) || typeof value.evidence !== "string") throw new PersonalError("mcp_resolution_invalid", "请选择业务已生效或未生效，并填写原 MCP 操作的核实证据。");
            await instance.harness.commit(tx => mcpResolve(tx, operation, value.effect as "applied" | "not_applied", value.evidence as string), context);
            result = { saved: true };
          } else if (url.pathname === "/mcp/cua-recover") {
            const value = await readControlJSON(req);
            if (!instance.mcp || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["action", "observation"].includes(key)) || !("action" in value) || !["stop", "observe", "accept"].includes(String(value.action))) throw new PersonalError("cua_recovery_invalid", "请从原电脑操作依次选择停止核实、检查并恢复与接受新图。");
            await instance.mcp.recoverCua(operation, value.action as "stop" | "observe" | "accept", "observation" in value && Number.isSafeInteger(value.observation) ? value.observation as EntryId : undefined);
            result = { saved: true };
          } else if (url.pathname === "/mcp/end") {
            const value = await readControlJSON(req);
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw new PersonalError("mcp_end_invalid", "请从原调用选择结束此工作，不能修改原结果或来源。");
            if (!instance.mcp) throw new PersonalError("mcp_config_missing", "MCP 未装配，请停止后台后通过向导配置服务。");
            await instance.mcp.end(operation);
            result = { requested: true };
          } else result = await instance.harness.commit(tx => mcpDetail(tx, operation, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "GET" && url.pathname === "/background") {
          if (!instance.background) throw new PersonalError("background_unavailable", "会话后台需要 Linux 固定命令目录；请停止实例后配置。");
          result = await instance.background.status(url.searchParams.get("process") ?? undefined, url.searchParams.has("offset") ? queryNumber(url, "offset") : undefined);
        } else if (req.method === "GET" && url.pathname === "/background/output") {
          if (!instance.background) throw new PersonalError("background_unavailable", "会话后台未装配，请核实原配置。");
          const stream = url.searchParams.get("stream"), id = url.searchParams.get("process");
          if (!id || stream !== "stdout" && stream !== "stderr") throw new PersonalError("background_invalid_params", "请选择原后台及 stdout 或 stderr。");
          result = await instance.background.output(id, stream, queryNumber(url, "offset", 0));
        } else if (req.method === "POST" && url.pathname === "/background/stop") {
          if (!instance.background) throw new PersonalError("background_unavailable", "会话后台未装配，请核实原配置。");
          const id = url.searchParams.get("process"); if (!id) throw new PersonalError("background_invalid_params", "请选择原后台。");
          result = await instance.background.stop(id);
        } else if (["GET", "POST"].includes(req.method ?? "") && url.pathname === "/background/end") {
          if (!instance.background) throw new PersonalError("background_unavailable", "会话后台未装配，请核实原配置。");
          const requestId = url.searchParams.get("request"); if (!requestId || !PERSONAL_REQUEST_ID.test(requestId)) throw new PersonalError("background_invalid_params", "结束请求无效，请由本机菜单重新核实原回执。");
          result = req.method === "POST" ? await instance.background.end(requestId) : await instance.background.endStatus(requestId);
        } else if (req.method === "GET" && url.pathname === "/commands") {
          if (!instance.commands) throw new PersonalError("command_config_missing", "命令未装配，请停止后台后配置独立命令目录。");
          result = await instance.commands.list(queryNumber(url, "offset", 0));
        } else if ((req.method === "GET" && url.pathname === "/command") || (req.method === "POST" && ["/command/resolve", "/command/stop"].includes(url.pathname))) {
          if (!instance.commands) throw new PersonalError("command_config_missing", "命令未装配，请停止后台后配置独立命令目录。");
          const ref = await instance.harness.commit(tx => personalCommandRef(tx, queryNumber(url, "command") as TaskId), context);
          if (url.pathname === "/command/resolve") {
            const value = await readControlJSON(req);
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !("effect" in value) || !["applied", "not_applied"].includes(String(value.effect)) || !("evidence" in value) || typeof value.evidence !== "string") throw new PersonalError("command_resolution_invalid", "请选择原命令已生效或未生效，并填写核实证据。");
            await instance.harness.commit(tx => resolvePersonalCommand(tx, ref, value.effect as "applied" | "not_applied", value.evidence as string), context);
            result = { saved: true };
          } else if (url.pathname === "/command/stop") { await instance.commands.stop(ref); result = { requested: true }; }
          else {
            const stream = url.searchParams.get("stream") ?? "stdout";
            if (stream !== "stdout" && stream !== "stderr") throw new PersonalError("command_input_invalid", "请选择标准输出或标准错误。");
            result = await instance.commands.detail(ref, stream, queryNumber(url, "offset", 0));
          }
        } else if ((req.method === "GET" && url.pathname === "/service") || (req.method === "POST" && ["/service/resolve", "/service/stop", "/service/decide"].includes(url.pathname))) {
          const ref = await instance.harness.commit(tx => personalServiceRef(tx, queryNumber(url, "service") as TaskId), context);
          if (url.pathname === "/service/decide") {
            const value = await readControlJSON(req);
            if (!value || typeof value !== "object" || !("decision" in value) || (value.decision !== "approved" && value.decision !== "rejected") || Object.keys(value).length !== 1) throw new PersonalError("service_decision_invalid", "请选择批准本次或拒绝原服务操作。");
            if (!instance.service) throw new PersonalError("service_config_missing", "服务操作未装配，请核实配置。");
            await instance.service.decide(ref, value.decision);
            result = { saved: true };
          } else if (url.pathname === "/service/stop") { await instance.requestServiceStop(ref); result = { requested: true }; }
          else if (url.pathname === "/service/resolve") {
            const resolution = parsePersonalServiceResolution(await readControlJSON(req));
            await instance.harness.commit(tx => resolvePersonalServiceOperation(tx, ref, resolution.effect, resolution.evidence), context);
            result = { saved: true };
          } else result = await instance.harness.commit(tx => personalServiceDetail(tx, ref, queryNumber(url, "offset", 0)), context);
        } else if (req.method === "GET" && url.pathname === "/delegations") {
          result = await instance.harness.commit(tx => listPersonalDelegations(tx, queryNumber(url, "offset", 0)), context);
        } else if ((req.method === "GET" && ["/delegation", "/delegation/report"].includes(url.pathname)) || (req.method === "POST" && url.pathname === "/delegation/cancel")) {
          const ref = { entryId: queryNumber(url, "delegation") as EntryId };
          result = await instance.harness.commit(async tx => {
            if (url.pathname === "/delegation/cancel") { await cancelPersonalDelegation(tx, ref); return { cancelRequested: true }; }
            if (url.pathname === "/delegation/report") return personalReportResult(tx, ref, queryNumber(url, "offset", 0));
            return personalDelegationProgress(tx, ref, queryNumber(url, "offset", 0));
          }, context);
        } else if ((req.method === "GET" && url.pathname === "/work") || (req.method === "POST" && ["/work/cancel", "/work/close"].includes(url.pathname))) {
          const id = queryNumber(url, "work") as TaskId;
          const offset = queryNumber(url, "offset", 0);
          result = await instance.harness.commit(async tx => {
            const ref = await personalWorkRef(tx, id);
            if (url.pathname === "/work/cancel") { await requestPersonalWorkCancel(tx, ref); return { cancelRequested: true }; }
            if (url.pathname === "/work/close") { await closePersonalWorkAgent(tx, ref); return { closed: true }; }
            return { summary: await personalWorkSummary(tx, ref), result: await personalWorkResult(tx, ref, offset) };
          }, context);
        } else if (req.method === "GET" && ["/input", "/work/notes"].includes(url.pathname)) {
          const requestId = url.searchParams.get("requestId") ?? "";
          if (!PERSONAL_REQUEST_ID.test(requestId)) throw new PersonalError("input_invalid", "请求标识无效，请从向导选择待核实消息。");
          const workId = url.searchParams.has("work") ? queryNumber(url, "work") as TaskId : undefined;
          if ((url.pathname === "/work/notes") !== (workId !== undefined)) throw new PersonalError("input_invalid", "追加说明须通过原工作入口查询，请重新打开向导。");
          result = await instance.main.commit(async tx => {
            if (workId !== undefined) {
              const ref = await personalWorkRef(tx, workId);
              const note = (await tx.doc(PersonalWorkDoc, ref.requestId, null)).notes?.find(note => note.requestId === requestId);
              return { status: note ? "done" : "missing", ...(note ? { answer: "原分析已接纳说明，将在当前回答结束后处理；请从后台分析查询状态和最终结果。" } : {}) } satisfies PersonalInputStatus;
            }
            const record = await tx.submissionByRequest(instance.main.id, requestId);
            if (!record) return { status: "missing" } satisfies PersonalInputStatus;
            if (record.type !== "input") throw new PersonalError("input_conflict", "原请求对应其他操作，请保留记录并检查。");
            if (record.status !== "done") return { status: record.status } satisfies PersonalInputStatus;
            const entry = await tx.entry(AssistantEntry, record.answer);
            const message = entry && text(entry);
            if (!message) throw new PersonalError("answer_missing", "完整回答记录缺失，请保留档案并检查存储。");
            return { status: record.status, answer: message.text, truncated: message.truncated } satisfies PersonalInputStatus;
          }, context);
        } else if (req.method === "POST" && ["/inputs", "/work/notes"].includes(url.pathname)) {
          const input = parsePersonalInput(await readControlJSON(req));
          if ((url.pathname === "/work/notes") !== (input.work !== undefined)) throw new PersonalError("input_invalid", "追加说明须通过原工作入口提交，请重新打开向导。");
          // JSON 字符串编码保留孤立 UTF-16 代理的区别，直接 UTF-8 哈希会统一替换它们。
          const digest = personalInputDigest(input.input, input.work);
          await instance.harness.commit(async tx => {
            const intent = await tx.doc(LocalInputDoc, input.requestId, digest);
            if (intent.digest !== digest || (intent.work !== undefined && intent.work !== input.work)) throw new PersonalError("input_conflict", "同一请求的正文不一致，已拒绝；请核实原消息。");
            if (input.work !== undefined) {
              intent.work = input.work;
              await appendPersonalWork(tx, await personalWorkRef(tx, input.work), { requestId: input.requestId, content: input.input, source: { kind: "local" } });
            }
          }, context);
          if (input.work === undefined) {
            const submission = await instance.submit(input.input, input.requestId);
            result = { status: (await submission.status(context)).status } satisfies PersonalInputStatus;
          } else result = { status: "done", answer: "原分析已接纳说明，将在当前回答结束后处理。" } satisfies PersonalInputStatus;
        } else if (req.method === "POST" && url.pathname === "/stop") {
          requestedStop = true;
          result = { stopping: true };
        } else throw new PersonalError("control_route_missing", "此管理操作不可用，请更新向导与后台到相同版本。");
        respond(res, 200, { v: 1, ok: true, result });
      } catch (error) {
        const known = error instanceof PersonalError || error instanceof SkillLibraryError;
        if (!known) process.stderr.write("[ruukoto:personal] 本机管理操作失败，请保留档案并查询原请求；未自动重试。\n");
        respond(res, known ? 400 : 500, { v: 1, ok: false, code: known ? error.code : "control_internal", message: known ? error.message : "后台未能确认操作结果，请保留原请求并重新查询。" });
      }
      if (requestedStop) setImmediate(() => void stop().catch(() => process.stderr.write("[ruukoto:personal] 后台停止未核实，请保留档案并检查进程。\n")));
    };
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      const running = handle(req, res);
      active.add(running);
      void running.catch(() => res.destroy()).finally(() => active.delete(running));
    });
    server.on("error", () => { process.stderr.write("[ruukoto:personal] 本机管理接口异常，正在停止隔离后台。\n"); void stop().catch(() => process.stderr.write("[ruukoto:personal] 停止未核实，请检查后台进程。\n")); });
    return { stop, closed: instance.harness.closed };
  } catch (error) {
    if (personal) await personal.close();
    else { await closeListener(); profile.release(); }
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("control_start_failed", "隔离后台未能启动，请检查档案权限、路径和诊断日志。", { cause: error });
  }
}

export async function personalControl<T>(directory: string, method: "GET" | "POST", route: string, value?: ReturnType<typeof parsePersonalMemoryControl> | PersonalInput | PersonalServiceResolution | Record<string, never> | { decision: "approved" | "rejected" } | PersonalToolsControlBody | { action: "stop" | "observe" | "accept"; observation?: EntryId } | PersonalScheduleCreateBody | PersonalQuestionWrite | PersonalSettingsRequest | PersonalSettingsWriteRequest | PersonalImPairingRequest, timeoutMs?: number): Promise<T> {
  const token = readPersonalToken(directory);
  return new Promise<T>((resolve, reject) => {
    const req = http.request({ socketPath: path.join(directory, "control.sock"), method, path: route, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" } });
    const fail = (cause?: unknown) => reject(new PersonalError("control_response_lost", method === "POST" ? "未取得后台应答；请核实原消息或后台状态，不要重复提交新消息。" : "无法查询隔离后台；连接失败不表示后台已停止，请检查状态与日志。", { cause }));
    const timeout = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs ?? (route === "/settings" ? PERSONAL_SETTINGS_LIMITS.modelTestMs + 5000 : 5000));
    req.once("close", () => clearTimeout(timeout));
    req.on("error", fail);
    req.on("response", res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE) { fail(); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("end", () => {
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (error) { fail(error); return; }
        if (!body || typeof body !== "object" || !("v" in body) || body.v !== 1 || !("ok" in body)) { fail(); return; }
        if (body.ok === false && "code" in body && typeof body.code === "string" && "message" in body && typeof body.message === "string") {
          reject(new PersonalError(body.code, body.message)); return;
        }
        if (body.ok !== true || !("result" in body) || res.statusCode !== 200) { fail(); return; }
        resolve(body.result as T);
      });
    });
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
