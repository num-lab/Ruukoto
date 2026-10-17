import * as fs from "node:fs";
import * as path from "node:path";
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { Socket, TcpNetConnectOpts } from "node:net";
import { createHash } from "node:crypto";
import { executeApprovedFileOp, isProtectedPath, restrictedResolve, sha256Hex, type FileOpRequest } from "@ruukoto/agent/execution/approved-ops.ts";
import { PersonalError } from "./personal-error.ts";

export const PERSONAL_TOOL_CAPTURE_BYTES = 8 * 1024 * 1024;
export const PERSONAL_HTTP_TIMEOUT_MS = 30_000;
export type PersonalToolCredential = { name: string; host: string; header: string; env: string };
export type PersonalFileRequest = FileOpRequest;
export type PersonalToolIoResult = { effect: "returned" | "not_executed" | "no_write" | "effect_unknown"; code: string; bytes: Buffer; partial: boolean };
export type PersonalHttpRequest = { method: string; url: string; headers: Record<string, string>; pinnedAddress: string; pinnedFamily: number; body?: string; credential?: PersonalToolCredential; credentialSha256?: string };
export type PersonalHttpResult = PersonalToolIoResult & { headers: Record<string, string>; stopped: boolean; status?: number };
const inputError = () => new PersonalError("tool_input_invalid", "操作参数无法核实，未执行；请修正参数后重新申请。");
const fileError = () => new PersonalError("file_target_invalid", "目标文件或保护范围无法核实，未执行；请检查原目标后重新申请。");
const validText = (value: string, cap: number) => !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= cap;

function readFileBytes(fd: number, capture: boolean) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), chunks: Buffer[] = [];
  let offset = 0, captured = 0;
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (!count) break;
    const chunk = buffer.subarray(0, count);
    hash.update(chunk);
    const available = capture ? Math.max(0, PERSONAL_TOOL_CAPTURE_BYTES - captured) : 0;
    if (available) { const copy = Buffer.from(chunk.subarray(0, available)); chunks.push(copy); captured += copy.length; }
    offset += count;
  }
  return { hash: hash.digest("hex"), bytes: Buffer.concat(chunks, captured), partial: offset > captured };
}

/** 只准备操作与对象身份，不授予权限；无保护根时按完全访问解析真实路径。 */
export function preparePersonalFile(input: { path: string; access: "read" | "read_write"; content?: string; protectedRoots: string[] }): PersonalFileRequest {
  if (!path.isAbsolute(input.path) || !validText(input.path, 4096) || !["read", "read_write"].includes(input.access) || (input.access === "read_write" && (typeof input.content !== "string" || Buffer.byteLength(input.content) > PERSONAL_TOOL_CAPTURE_BYTES)) || (input.access === "read" && input.content !== undefined)) throw inputError();
  try {
    const resolved = input.protectedRoots.length ? restrictedResolve(input.path, { allowMissingLast: input.access === "read_write" }) : fs.existsSync(input.path) ? fs.realpathSync(input.path) : path.join(fs.realpathSync(path.dirname(input.path)), path.basename(input.path));
    if (isProtectedPath(resolved, input.protectedRoots)) throw fileError();
    const existing = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw fileError();
    if (!existing && input.access === "read") throw fileError();
    const identity = existing ?? fs.lstatSync(path.dirname(resolved));
    let originalSha256: string | null = null;
    if (existing) {
      const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) throw fileError();
        originalSha256 = readFileBytes(fd, false).hash;
        const after = fs.fstatSync(fd);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw fileError();
      } finally { fs.closeSync(fd); }
    }
    return { path: resolved, access: input.access, ...(input.content !== undefined ? { content: input.content } : {}), targetDev: identity.dev, targetIno: identity.ino, originalSha256, protectedRoots: [...input.protectedRoots] };
  } catch (error) { if (error instanceof PersonalError) throw error; throw fileError(); }
}

function createPersonalFile(request: PersonalFileRequest): PersonalToolIoResult {
  const result = (effect: PersonalToolIoResult["effect"], code: string): PersonalToolIoResult => ({ effect, code, bytes: Buffer.alloc(0), partial: false });
  if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) return result("not_executed", "file_creation_unavailable");
  let created = false;
  try {
    if (request.content === undefined || Buffer.byteLength(request.content) > PERSONAL_TOOL_CAPTURE_BYTES) return result("not_executed", "tool_input_invalid");
    const target = restrictedResolve(request.path, { allowMissingLast: true });
    if (isProtectedPath(target, request.protectedRoots) || isProtectedPath(target, request.writeProtectedRoots ?? [])) throw fileError();
    const parent = fs.openSync(path.dirname(target), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const pinned = fs.fstatSync(parent);
      if (!pinned.isDirectory() || pinned.dev !== request.targetDev || pinned.ino !== request.targetIno) throw fileError();
      // 创建始终相对已核实的目录句柄，原路径祖先被替换也不能改指向。
      const fd = fs.openSync(`/proc/self/fd/${parent}/${path.basename(target)}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
      created = true;
      try {
        const bytes = Buffer.from(request.content);
        let offset = 0;
        while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset); if (count === 0) throw fileError(); offset += count; }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    } finally { fs.closeSync(parent); }
    return result("returned", "file_returned");
  } catch { return result(created ? "effect_unknown" : "not_executed", created ? "file_effect_unknown" : "file_target_changed"); }
}

/** 读取返回最多 8 MiB 原字节；新建仅使用 Linux 目录句柄，已存在文件沿共享执行器核实身份。 */
export function executePersonalFile(request: PersonalFileRequest): PersonalToolIoResult {
  if (request.access === "read_write") {
    if (request.originalSha256 === null) return createPersonalFile(request);
    const outcome = executeApprovedFileOp(request);
    return { effect: outcome.effectUnknown ? "effect_unknown" : outcome.ok ? "returned" : "not_executed", code: outcome.effectUnknown ? "file_effect_unknown" : outcome.ok ? "file_returned" : "file_target_changed", bytes: Buffer.alloc(0), partial: false };
  }
  let fd: number | undefined;
  try {
    const resolved = restrictedResolve(request.path);
    if (isProtectedPath(resolved, request.protectedRoots)) throw fileError();
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const identity = fs.fstatSync(fd);
    if (!identity.isFile() || identity.dev !== request.targetDev || identity.ino !== request.targetIno) throw fileError();
    const read = readFileBytes(fd, true);
    const after = fs.fstatSync(fd);
    if (after.size !== identity.size || after.mtimeMs !== identity.mtimeMs || after.ctimeMs !== identity.ctimeMs || read.hash !== request.originalSha256) throw fileError();
    return { effect: "returned", code: "file_returned", bytes: read.bytes, partial: read.partial };
  } catch { return { effect: "not_executed", code: "file_target_changed", bytes: Buffer.alloc(0), partial: false }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

const REQUEST_HEADERS = new Set(["accept", "content-type", "user-agent"]);
const RESPONSE_HEADERS = new Set(["content-type", "content-length", "content-encoding", "location", "etag", "last-modified", "cache-control", "expires", "date", "retry-after"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function validateCredential(value: PersonalToolCredential, url: URL) {
  if (!value.name || !validText(value.name, 128) || value.host.toLowerCase() !== url.host.toLowerCase() || !HEADER_NAME.test(value.header) || ["host", "content-length", "transfer-encoding", "connection", "upgrade", "trailer"].includes(value.header.toLowerCase()) || !/^[A-Z_][A-Z0-9_]*$/.test(value.env)) throw inputError();
}

/** 固定方法、URL 和解析地址；凭据仅保留宿主引用，准备失败不会发送请求。 */
export async function preparePersonalHttp(input: { method: string; url: string; headers?: Record<string, string>; body?: string; credential?: PersonalToolCredential }): Promise<PersonalHttpRequest> {
  if (!HEADER_NAME.test(input.method) || !validText(input.url, 8192) || (input.body !== undefined && Buffer.byteLength(input.body) > PERSONAL_TOOL_CAPTURE_BYTES)) throw inputError();
  let url: URL;
  try { url = new URL(input.url); } catch { throw inputError(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw inputError();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!REQUEST_HEADERS.has(name.toLowerCase()) || !validText(value, 8192)) throw inputError();
    if (Object.hasOwn(headers, name.toLowerCase())) throw inputError();
    headers[name.toLowerCase()] = value;
  }
  let credentialSha256: string | undefined;
  if (input.credential) {
    validateCredential(input.credential, url);
    const secret = process.env[input.credential.env];
    if (!secret || !validText(secret, 16384)) throw new PersonalError("http_credentials_unavailable", "原 HTTP 凭据不可用，未发送请求；请由拥有者检查原配置。");
    credentialSha256 = sha256Hex(secret);
  }
  let pinned;
  try { pinned = await dns.promises.lookup(url.hostname.replace(/^\[|\]$/g, "")); }
  catch { throw new PersonalError("http_target_unavailable", "目标地址无法核实，未发送请求；请检查目标后重新申请。"); }
  return { method: input.method.toUpperCase(), url: url.href, headers, pinnedAddress: pinned.address, pinnedFamily: pinned.family, ...(input.body !== undefined ? { body: input.body } : {}), ...(input.credential ? { credential: { ...input.credential }, credentialSha256: credentialSha256! } : {}) };
}

/** 单次连接不重试、不跟随跳转；本地 socket 关闭后才返回，关闭不证明远端写入结束。 */
export async function executePersonalHttp(input: PersonalHttpRequest, signal?: AbortSignal): Promise<PersonalHttpResult> {
  const empty = (code: string): PersonalHttpResult => ({ effect: "not_executed", code, bytes: Buffer.alloc(0), partial: false, headers: {}, stopped: true });
  if (signal?.aborted) return empty("http_canceled");
  const headers = { ...input.headers };
  if (input.body !== undefined) headers["content-length"] = String(Buffer.byteLength(input.body));
  let secret: string | undefined;
  let secretForms: string[] = [];
  let url: URL;
  try { url = new URL(input.url); } catch { return empty("http_target_invalid"); }
  if (input.credential) {
    try { validateCredential(input.credential, url); } catch { return empty("http_credentials_invalid"); }
    secret = process.env[input.credential.env];
    if (!secret || !validText(secret, 16384)) return empty("http_credentials_unavailable");
    if (sha256Hex(secret) !== input.credentialSha256) return empty("credentials_changed");
    secretForms = [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])];
    headers[input.credential.header.toLowerCase()] = secret;
  }
  return new Promise<PersonalHttpResult>(resolve => {
    let request: http.ClientRequest;
    let socket: Socket | undefined, closed = false, result: PersonalHttpResult | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    let count = 0;
    const responseHeaders: Record<string, string> = {};
    let status: number | undefined;
    const readonly = ["GET", "HEAD"].includes(input.method) && input.body === undefined;
    const finish = (complete: boolean, code: string) => {
      if (!result) {
        const bytes = Buffer.concat(chunks, count), unsafe = secretForms.some(value => {
          const needle = Buffer.from(value);
          if (bytes.includes(needle)) return true;
          if (!complete) for (let length = 1; length < needle.length && length <= bytes.length; length++) if (bytes.subarray(bytes.length - length).equals(needle.subarray(0, length))) return true;
          return false;
        });
        result = { effect: complete ? "returned" : readonly ? "no_write" : "effect_unknown", code: unsafe ? "credential_response_unsafe" : code, bytes: unsafe ? Buffer.alloc(0) : bytes, partial: unsafe || !complete, headers: responseHeaders, stopped: true, ...(status !== undefined ? { status } : {}) };
      }
      if (closed) { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(result); }
    };
    const abort = () => { finish(false, "http_canceled"); request.destroy(); };
    try {
      const options: http.RequestOptions & Pick<TcpNetConnectOpts, "autoSelectFamily"> = {
        method: input.method, headers, agent: false, autoSelectFamily: false,
        lookup: (_hostname, _options, callback) => callback(null, input.pinnedAddress, input.pinnedFamily),
      };
      request = (url.protocol === "https:" ? https : http).request(url, options, response => {
        status = response.statusCode;
        for (const [name, value] of Object.entries(response.headers)) if (RESPONSE_HEADERS.has(name) && value !== undefined) {
          const text = Array.isArray(value) ? value.join(", ") : value;
          if (!secretForms.some(value => text.includes(value))) responseHeaders[name] = text;
        }
        response.on("data", (chunk: Buffer) => {
          const available = PERSONAL_TOOL_CAPTURE_BYTES - count;
          if (available > 0) { const captured = chunk.subarray(0, available); chunks.push(captured); count += captured.length; }
          if (chunk.length > available) { finish(false, "http_response_limit"); request.destroy(); }
        });
        response.once("end", () => { finish(response.complete, response.complete ? "http_returned" : "http_response_interrupted"); socket?.destroy(); });
        response.once("error", () => finish(false, "http_response_interrupted"));
        response.once("aborted", () => finish(false, "http_response_interrupted"));
      });
    } catch { resolve(empty("http_request_invalid")); return; }
    request.once("socket", value => { socket = value; socket.once("close", () => { closed = true; finish(false, "http_connection_closed"); }); });
    request.once("close", () => { if (!socket) { closed = true; finish(false, "http_connection_closed"); } });
    request.once("error", () => finish(false, "http_transport_failed"));
    timer = setTimeout(() => { finish(false, "http_timeout"); request.destroy(); }, PERSONAL_HTTP_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else request.end(input.body);
  });
}
