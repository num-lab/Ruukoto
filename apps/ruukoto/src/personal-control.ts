import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, type EntryRecord, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import { openPersonalHarness } from "./personal-harness.ts";
import { personalProvider } from "./personal-model.ts";
import { lockPersonalProfile } from "./personal-profile.ts";
import { readPersonalConfig } from "./personal-config.ts";
import { PersonalError } from "./personal-error.ts";
import { readPersonalTelegram } from "./personal-telegram-config.ts";
import { readPersonalServices } from "./personal-service-config.ts";
import { appendPersonalWork, PersonalWorkDoc, closePersonalWorkAgent, listPersonalWorks, personalWorkRef, personalWorkResult, personalWorkSummary, requestPersonalWorkCancel } from "./personal-work.ts";
import { cancelPersonalDelegation, listPersonalDelegations, personalDelegationProgress } from "./personal-delegation.ts";
import { personalReportResult } from "./personal-report.ts";

import { LocalInputDoc, personalInputDigest } from "./personal-local-records.ts";
export { LocalInputDoc } from "./personal-local-records.ts";

const context = BACKGROUND_CONTEXT;
const MAX_REQUEST = 128 * 1024;
const MAX_RESPONSE = 256 * 1024;
export const PERSONAL_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type PersonalInput = { requestId: string; input: string; work?: TaskId };
export type PersonalInputStatus = { status: "queued" | "placed" | "done" | "unanswered" | "missing"; answer?: string; truncated?: boolean };
export type PersonalStatus = { model: string; tasks: number; inputs: number; services: boolean };
export type PersonalMessage = { role: "user" | "assistant"; text: string; partial: boolean; truncated: boolean };

function queryNumber(url: URL, key: string, fallback?: number) {
  const value = url.searchParams.get(key);
  if (value === null && fallback !== undefined) return fallback;
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new PersonalError("work_input_invalid", "工作查询参数无效，请重新选择原工作。");
  return Number(value);
}

export function parsePersonalInput(value: unknown): PersonalInput {
  if (!value || typeof value !== "object" || !("requestId" in value) || typeof value.requestId !== "string" || !PERSONAL_REQUEST_ID.test(value.requestId)
    || !("input" in value) || typeof value.input !== "string" || !value.input.trim() || Buffer.byteLength(value.input) > 16384 || ("work" in value && (typeof value.work !== "number" || !Number.isSafeInteger(value.work) || value.work < 1))) {
    throw new PersonalError("input_invalid", "请输入非空消息，每条最多 16 KiB；请求标识由程序管理。");
  }
  return { requestId: value.requestId, input: value.input, ...("work" in value ? { work: value.work as TaskId } : {}) };
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
export async function startPersonalServer(directory: string) {
  const profile = lockPersonalProfile(directory);
  const socketPath = path.join(directory, "control.sock");
  const active = new Set<Promise<void>>();
  const server = http.createServer();
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  let listenerClosed: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let personal: Awaited<ReturnType<typeof openPersonalHarness>> | undefined;
  const telegramStop = new AbortController();
  let telegramLoop: Promise<void> | undefined;
  const closeListener = () => listenerClosed ??= (async () => {
    telegramStop.abort();
    await telegramLoop;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...active]);
  })();
  const stop = () => shutdown ??= (async () => { await closeListener(); await personal?.close(); })();
  try {
    const config = readPersonalConfig(profile);
    const telegram = readPersonalTelegram(profile);
    const services = readPersonalServices(profile);
    if (!process.env[config.apiKeyEnv]) throw new PersonalError("model_credentials_missing", "模型凭据环境变量尚未设置，请设置后再启动隔离后台。");
    if (fs.existsSync(path.join(directory, "control.token"))) readPersonalToken(directory);
    if (Buffer.byteLength(socketPath) > 100) throw new PersonalError("control_path_long", "隔离档案路径过长，请用较短的新目录启动。");
    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(path.join(directory, "control.token"), token + "\n", { mode: 0o600 });
    fs.rmSync(socketPath, { force: true });
    server.on("request", (_req, res) => res.writeHead(503, { connection: "close", "content-type": "application/json" }).end(JSON.stringify({ v: 1, ok: false, code: "control_starting", message: "隔离后台正在恢复，请稍后查询。" })));
    server.listen(socketPath);
    await once(server, "listening");
    fs.chmodSync(socketPath, 0o600);
    personal = await openPersonalHarness({ profile, provider: personalProvider(config), modelId: config.modelId, telegram, ...(services ? { service: { ...services, useSudo: true }, serviceOperations: true } : {}), beforeUnlock: closeListener });
    const instance = personal;
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
        if (req.method === "GET" && url.pathname === "/status") {
          const live = await instance.harness.inspect(context);
          result = { model: config.modelId, tasks: live.tasks.length, inputs: live.submissions.length, services: !!services } satisfies PersonalStatus;
        } else if (req.method === "GET" && url.pathname === "/messages") {
          const entries = await instance.main.entries({}, 64, undefined, context);
          result = entries.items.map(text).filter(item => item !== undefined).slice(0, 16).reverse();
        } else if (req.method === "GET" && url.pathname === "/telegram") {
          result = await instance.telegram.status();
        } else if (req.method === "GET" && url.pathname === "/works") {
          const offset = queryNumber(url, "offset", 0);
          result = await instance.harness.commit(tx => listPersonalWorks(tx, offset), context);
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
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > MAX_REQUEST) throw new PersonalError("control_request_large", "消息请求过大，请缩短消息后再提交。");
            chunks.push(Buffer.from(chunk));
          }
          let value: unknown;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (error) {
            throw new PersonalError("control_request_invalid", "消息请求格式无效，请重新打开向导。", { cause: error });
          }
          const input = parsePersonalInput(value);
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
        const known = error instanceof PersonalError;
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

export async function personalControl<T>(directory: string, method: "GET" | "POST", route: string, value?: PersonalInput): Promise<T> {
  const token = readPersonalToken(directory);
  return new Promise<T>((resolve, reject) => {
    const req = http.request({ socketPath: path.join(directory, "control.sock"), method, path: route, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" } });
    const fail = (cause?: unknown) => reject(new PersonalError("control_response_lost", method === "POST" ? "未取得后台应答；请核实原消息或后台状态，不要重复提交新消息。" : "无法查询隔离后台；连接失败不表示后台已停止，请检查状态与日志。", { cause }));
    const timeout = setTimeout(() => req.destroy(new Error("timeout")), 5000);
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
