/**
 * 已批准操作的受信执行器：结构化越界文件操作与单次 HTTP 请求。
 *
 * 执行参数完全来自审批保存的不可变请求（后台构造），工作进程/模型不能
 * 提交批准 ID 后自行替换参数。
 *
 * 文件操作（固定执行身份 = 后台进程）：
 * - 受限解析：逐段 lstat，拒绝符号链接组件；最终打开带 O_NOFOLLOW；
 * - 打开后 fstat 的 dev/ino 必须与批准时的对象身份一致（覆盖等待期间
 *   目标被替换）；写入前校验原文版本指纹，变化即失败并要求重新申请；
 * - 受限模式排除后台数据、服务凭据与控制面目录；完全访问传空保护列表，
 *   沿启动账户已有权限执行，仍核实目标身份与内容。
 *
 * HTTP 请求（单次、固定方法/目标/正文）：
 * - 默认不自动跟随重定向、不重试；连接固定到批准时解析出的地址
 *   （防 DNS 重绑定）；凭据只在目标主机与绑定一致时注入；
 * - 保留目标（控制面）即使被请求也不开放：控制面只有 unix socket，
 *   HTTP 到不了；保留地址清单留作未来 TCP 控制端点的强制点。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns";
import type { CredentialStore } from "./credentials.ts";

export const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
export const MAX_FILE_CONTENT_BYTES = 8 * 1024 * 1024;

export class ApprovedOpError extends Error {}

// ---------- 文件操作 ----------

export interface FileOpRequest {
  path: string;
  access: "read" | "read_write";
  /** write 时的完整待写内容。 */
  content?: string;
  /** 批准时对象身份（已存在文件的 dev/ino；新建文件为父目录 dev/ino）。 */
  targetDev: number | null;
  targetIno: number | null;
  /** 批准时原文件内容指纹（新建文件为 null）。 */
  originalSha256: string | null;
  /** 始终排除的保护根目录（后台数据、服务凭据、控制面）。 */
  protectedRoots: string[];
  writeProtectedRoots?: string[];
}

export interface FileOpOutcome {
  ok: boolean;
  message: string;
  /** 读操作返回的内容文本。 */
  content?: string;
  /** 写入已经开始而结果无法核实；调用方落盘效果未知且不重放。 */
  effectUnknown?: boolean;
}

function lstatNoFollow(p: string): fs.Stats {
  return fs.lstatSync(p);
}

function sameIdentity(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && (before.mode & 0o170000n) === (after.mode & 0o170000n);
}

function observeIdentity(observed: Map<string, fs.BigIntStats> | undefined, target: string, stat: fs.BigIntStats): void {
  if (!observed) return;
  const previous = observed.get(target);
  if (previous && !sameIdentity(previous, stat)) throw new ApprovedOpError("授权路径身份在保护核对期间变化；本次执行未启动，请报告拥有者核实路径");
  observed.set(target, stat);
}

/** 挂载别名与硬链接可有不同文本路径，保护范围仍按同一文件系统对象判定。 */
function identityOverlap(parent: string, targets: readonly string[], descendants = false, observed?: Map<string, fs.BigIntStats>): string | undefined {
  if (!fs.existsSync(parent)) return undefined;
  const pinned = fs.statSync(parent, { bigint: true });
  observeIdentity(observed, parent, pinned);
  const targetIdentities = new Map<string, string>();
  for (const target of targets) {
    let current = path.resolve(target);
    for (;;) {
      if (fs.existsSync(current)) {
        const stat = fs.statSync(current, { bigint: true });
        observeIdentity(observed, current, stat);
        if (stat.dev === pinned.dev && stat.ino === pinned.ino) return target;
        if (descendants) targetIdentities.set(`${stat.dev}:${stat.ino}`, target);
      }
      const ancestor = path.dirname(current);
      if (ancestor === current) break;
      current = ancestor;
    }
  }
  if (!descendants || !pinned.isDirectory()) return undefined;
  // 子对象的 bind 别名不含保护根的祖先身份；不跟随符号链接，遍历失败向调用方传播。
  const pending: Array<{ path: string; after?: fs.BigIntStats }> = [{ path: fs.realpathSync(parent) }], visited = new Set<string>();
  while (pending.length) {
    const entry = pending.pop()!;
    const stat = fs.lstatSync(entry.path, { bigint: true });
    if (entry.after) {
      if (!sameIdentity(entry.after, stat) || entry.after.mtimeNs !== stat.mtimeNs || entry.after.ctimeNs !== stat.ctimeNs) {
        throw new ApprovedOpError("保护目录在核对期间变化；本次执行未启动，请报告拥有者核实目录");
      }
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    const key = `${stat.dev}:${stat.ino}`, match = targetIdentities.get(key);
    if (match !== undefined) return match;
    if (!stat.isDirectory() || visited.has(key)) continue;
    visited.add(key);
    if (observed) pending.push({ path: entry.path, after: stat });
    pending.push(...fs.readdirSync(entry.path).map(name => ({ path: path.join(entry.path, name) })));
  }
  return undefined;
}

function identityCovers(parent: string, target: string, descendants = false): boolean {
  return identityOverlap(parent, [target], descendants) !== undefined;
}

export function isProtectedPath(resolved: string, protectedRoots: string[]): boolean {
  for (const root of protectedRoots) {
    const realRoot = path.resolve(root);
    if (resolved === realRoot || resolved.startsWith(realRoot + path.sep) || identityCovers(realRoot, resolved, true)) {
      return true;
    }
  }
  return false;
}

export function assertNotProtected(resolved: string, protectedRoots: string[]): void {
  if (isProtectedPath(resolved, protectedRoots)) {
    throw new ApprovedOpError("目标位于控制面/服务数据目录内，始终排除，不因批准而开放");
  }
}

/** 授权路径（目录）双向排除：既不能位于保护根内/下，也不能是保护根的祖先。 */
export function assertGrantNotProtected(resolved: string, protectedRoots: string[]): void {
  if (isProtectedPath(resolved, protectedRoots)) {
    throw new ApprovedOpError(`路径位于控制面/服务数据目录内，始终排除：${resolved}`);
  }
  // 根目录拼上分隔符会变成 "//"，需单独视为所有保护根的祖先
  const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  for (const root of protectedRoots) {
    const realRoot = path.resolve(root);
    if (realRoot === resolved || realRoot.startsWith(prefix) || identityCovers(resolved, realRoot)) {
      throw new ApprovedOpError(`路径是控制面/服务数据目录的父级，始终排除：${resolved}`);
    }
  }
}

// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-directory-protection-cost.md
export function assertDirectoryReadNotProtected(workspaceRoot: string, target: string, protectedRoots: string[]): void {
  const root = path.resolve(workspaceRoot), targets = [...new Set([root, path.resolve(target)])];
  const identities = new Set<string>();
  for (const directory of targets) {
    let current = directory;
    for (;;) {
      const stat = fs.statSync(current, { bigint: true });
      if (!stat.isDirectory()) throw new ApprovedOpError("目录保护检查的目标不是目录");
      identities.add(`${stat.dev}:${stat.ino}`);
      const ancestor = path.dirname(current);
      if (ancestor === current) break;
      current = ancestor;
    }
  }
  const visited = new Set<string>();
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  for (const protectedRoot of protectedRoots) {
    const protectedPath = path.resolve(protectedRoot);
    if (targets.some(directory => directory === protectedPath || directory.startsWith(protectedPath + path.sep)) || protectedPath === root || protectedPath.startsWith(prefix) || identityCovers(root, protectedPath)) throw new ApprovedOpError("目录与后台保护范围重叠");
    if (!fs.existsSync(protectedPath)) continue;
    const pending = [fs.realpathSync(protectedPath)];
    while (pending.length) {
      const directory = pending.pop()!;
      const before = fs.lstatSync(directory, { bigint: true });
      if (!before.isDirectory()) continue;
      const key = `${before.dev}:${before.ino}`;
      if (identities.has(key)) throw new ApprovedOpError("目录与后台保护范围重叠");
      if (visited.has(key)) continue;
      visited.add(key);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
      }
      // Dirent 分类只能用于枚举期间保持稳定的目录；文件被换成目录时不能按旧分类跳过。
      const after = fs.lstatSync(directory, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new ApprovedOpError("目录保护范围在检查期间发生变化");
    }
  }
}

/** 一次同步核对复用候选祖先集合；变化或读取失败均拒绝，不保留跨调用放行结果。 */
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-18-batch-native-protection-checks.md
export function assertGrantsNotProtected(paths: readonly string[], protectedRoots: readonly string[]): void {
  if (!paths.length || !protectedRoots.length) return;
  for (const resolved of paths) for (const root of protectedRoots) {
    const realRoot = path.resolve(root);
    if (resolved === realRoot || resolved.startsWith(realRoot + path.sep)) {
      throw new ApprovedOpError(`路径位于控制面/服务数据目录内，始终排除：${resolved}`);
    }
    const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
    if (realRoot === resolved || realRoot.startsWith(prefix)) {
      throw new ApprovedOpError(`路径是控制面/服务数据目录的父级，始终排除：${resolved}`);
    }
  }
  const observed = new Map<string, fs.BigIntStats>();
  for (const target of paths) observeIdentity(observed, target, fs.statSync(target, { bigint: true }));
  for (const root of protectedRoots) {
    const realRoot = path.resolve(root);
    let pinned: fs.BigIntStats | undefined;
    try { pinned = fs.statSync(realRoot, { bigint: true }); }
    catch (error) {
      // 忽略：ENOENT 表示保护根尚不存在，其路径仍受上面的文本范围限制。
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (pinned) observeIdentity(observed, realRoot, pinned);
    const match = identityOverlap(realRoot, paths, true, observed);
    if (match !== undefined) throw new ApprovedOpError(`路径位于控制面/服务数据目录内，始终排除：${match}`);
    for (const target of paths) if (identityOverlap(target, [realRoot], false, observed) !== undefined) {
      throw new ApprovedOpError(`路径是控制面/服务数据目录的父级，始终排除：${target}`);
    }
  }
  for (const [target, stat] of observed) if (!sameIdentity(stat, fs.statSync(target, { bigint: true }))) {
    throw new ApprovedOpError("授权路径身份在保护核对期间变化；本次执行未启动，请报告拥有者核实路径");
  }
}

/**
 * 受限解析：逐段检查并拒绝符号链接组件，返回受限解析路径。
 * - allowMissingLast：目标本身可以不存在（新建文件场景）；中间段缺失仍拒绝。
 * 解析结果仍需配合最终 O_NOFOLLOW 打开 + fstat 身份核对使用。
 */
export function restrictedResolve(target: string, opts: { allowMissingLast: boolean } = { allowMissingLast: false }): string {
  const resolved = path.resolve(target);
  const parts = resolved.split(path.sep).filter((p) => p.length > 0);
  let current = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    current = `${current}/${part}`;
    let st: fs.Stats;
    try {
      st = lstatNoFollow(current);
    } catch {
      const isLast = i === parts.length - 1;
      if (isLast && opts.allowMissingLast) break;
      throw new ApprovedOpError(`路径解析失败：${current} 不存在或不可达`);
    }
    if (st.isSymbolicLink()) {
      throw new ApprovedOpError(`路径包含符号链接组件，拒绝受限解析之外的操作：${current}`);
    }
  }
  return resolved;
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function executeApprovedFileOp(req: FileOpRequest): FileOpOutcome {
  let writing = false;
  try {
    const resolved = restrictedResolve(req.path, { allowMissingLast: true });
    assertNotProtected(resolved, req.protectedRoots);
    if (req.access === "read_write") assertNotProtected(resolved, req.writeProtectedRoots ?? []);
    let st: fs.Stats | null = null;
    try {
      st = lstatNoFollow(resolved);
    } catch {
      // 可能是新建文件
    }
    if (st?.isDirectory()) throw new ApprovedOpError("目标是目录，不支持目录级文件操作");
    if (req.access === "read_write" && req.writeProtectedRoots?.length && st && st.nlink > 1) throw new ApprovedOpError("来源保护任务不能写入多硬链接文件，请在独立工作目录新建检查产物");

    if (req.access === "read") {
      if (!st) throw new ApprovedOpError("目标文件不存在（读取）");
      if (st.isSymbolicLink()) throw new ApprovedOpError("目标是符号链接，拒绝");
      const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) throw new ApprovedOpError("目标不是普通文件，未执行");
        if (req.targetDev !== null && (opened.dev !== req.targetDev || opened.ino !== req.targetIno)) {
          throw new ApprovedOpError("目标文件在等待期间已被替换，批准失效，请重新申请");
        }
        const buf = fs.readFileSync(fd);
        return { ok: true, message: `已读取 ${resolved}（${buf.length} 字节）`, content: buf.toString("utf8") };
      } finally {
        fs.closeSync(fd);
      }
    }

    // 写操作
    if (req.content === undefined) throw new ApprovedOpError("写操作缺少待写内容");
    const contentBuf = Buffer.from(req.content, "utf8");
    if (contentBuf.length > MAX_FILE_CONTENT_BYTES) {
      throw new ApprovedOpError(`待写内容超过上限（${MAX_FILE_CONTENT_BYTES} 字节）`);
    }
    if (st) {
      if (st.isSymbolicLink()) throw new ApprovedOpError("目标已是符号链接，拒绝写入");
      const fd = fs.openSync(resolved, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) throw new ApprovedOpError("目标不是普通文件，未执行");
        if (req.writeProtectedRoots?.length && opened.nlink > 1) throw new ApprovedOpError("来源保护任务不能写入多硬链接文件，请在独立工作目录新建检查产物");
        if (opened.dev !== req.targetDev || opened.ino !== req.targetIno) {
          throw new ApprovedOpError("目标文件在等待期间已被替换，批准失效，请重新申请");
        }
        if (req.originalSha256 !== null) {
          const original = fs.readFileSync(fd);
          if (sha256Hex(original) !== req.originalSha256) {
            throw new ApprovedOpError("目标文件内容与批准时的原文版本不一致，批准失效，请重新申请");
          }
        }
        writing = true;
        fs.ftruncateSync(fd, 0);
        // 上面的原文校验把 fd 偏移推到末尾：写回必须显式定位到 0
        let offset = 0;
        while (offset < contentBuf.length) {
          const count = fs.writeSync(fd, contentBuf, offset, contentBuf.length - offset, offset);
          if (count === 0) throw new ApprovedOpError("文件写入未能继续");
          offset += count;
        }
        fs.fsyncSync(fd);
        return { ok: true, message: `已写入 ${resolved}（${contentBuf.length} 字节）` };
      } finally {
        fs.closeSync(fd);
      }
    }
    // 新建文件：父目录身份必须与批准一致（批准时 targetDev/Ino 为父目录身份）
    const parent = path.dirname(resolved);
    const parentSt = lstatNoFollow(parent);
    if (parentSt.dev !== req.targetDev || parentSt.ino !== req.targetIno) {
      throw new ApprovedOpError("父目录在等待期间已变化，批准失效，请重新申请");
    }
    const fd = fs.openSync(
      resolved,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o644,
    );
    writing = true;
    try {
      let offset = 0;
      while (offset < contentBuf.length) {
        const count = fs.writeSync(fd, contentBuf, offset, contentBuf.length - offset, offset);
        if (count === 0) throw new ApprovedOpError("文件写入未能继续");
        offset += count;
      }
      fs.fsyncSync(fd);
      return { ok: true, message: `已创建 ${resolved}（${contentBuf.length} 字节）` };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (writing) return { ok: false, message: "文件写入已开始但结果无法核实，未自动重写；请先核实目标内容", effectUnknown: true };
    if (err instanceof ApprovedOpError) return { ok: false, message: err.message };
    const code = (err as any)?.code;
    if (code === "EEXIST") return { ok: false, message: "目标文件已存在（等待期间被创建），批准失效，请重新申请" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, message: `执行身份无权限操作目标：${(err as Error).message}` };
    return { ok: false, message: `文件操作失败：${(err as Error).message}` };
  }
}

// ---------- 单次 HTTP 请求 ----------

export interface HttpOpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** 凭据绑定名；审批展示只含名称与用途。 */
  credentialName?: string;
  /** 批准时解析出的固定连接地址（防 DNS 重绑定）；执行不得重新解析。 */
  pinnedAddress?: string;
  pinnedFamily?: number;
  timeoutMs?: number;
}

export interface HttpOpOutcome {
  ok: boolean;
  status: number | null;
  message: string;
  body: string;
  responseHeaders: Record<string, string>;
  /** 请求头与正文已交给操作系统发送（`finish`）；之后的失败远端可能已收到。 */
  sent: boolean;
}

/**
 * 保留地址清单：控制面等即使被批准的请求也不开放的目标。
 * 当前控制面只有 unix socket（HTTP 到不了）；未来若增加 TCP 控制端点，
 * 必须把其地址加入此清单。
 */
export function isReservedTarget(url: URL): boolean {
  return url.protocol !== "http:" && url.protocol !== "https:";
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

export async function executeApprovedHttpRequest(
  req: HttpOpRequest,
  credentials: CredentialStore,
  signal?: AbortSignal,
): Promise<HttpOpOutcome> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { ok: false, status: null, message: "无法解析目标 URL", body: "", responseHeaders: {}, sent: false };
  }
  if (isReservedTarget(url)) {
    return { ok: false, status: null, message: `不支持的目标协议：${url.protocol}（仅 http/https）`, body: "", responseHeaders: {}, sent: false };
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  if (req.credentialName) {
    const binding = credentials.get(req.credentialName);
    if (!binding) {
      return { ok: false, status: null, message: `凭据绑定不存在：${req.credentialName}`, body: "", responseHeaders: {}, sent: false };
    }
    if (binding.scope) {
      // 带使用范围的凭据（如 MCP 服务凭据）不得被通用 http_request 借用（issue 06/16）
      return {
        ok: false,
        status: null,
        message: `凭据 ${binding.name} 限定了使用范围（${binding.purpose}），通用 HTTP 请求不得使用`,
        body: "",
        responseHeaders: {},
        sent: false,
      };
    }
    if (url.host.toLowerCase() !== binding.host.toLowerCase()) {
      return {
        ok: false,
        status: null,
        message: `凭据 ${binding.name} 绑定到 ${binding.host}，不能用于 ${url.host}（凭据不得转发到其他地址）`,
        body: "",
        responseHeaders: {},
        sent: false,
      };
    }
    headers[binding.header.toLowerCase()] = binding.secret;
  }

  // 解析并固定连接地址：实际连接范围 = 批准时解析结果（防 DNS 重绑定）
  let pinnedAddress: string | null = req.pinnedAddress ?? null;
  let pinnedFamily: number = req.pinnedFamily ?? 4;
  if (!pinnedAddress) {
    // 兼容路径：未经审批侧解析的请求（生产路径必须已在审批侧固定）
    try {
      const resolved = await dns.promises.lookup(url.hostname, { all: true });
      if (resolved.length === 0) throw new Error("无解析结果");
      pinnedAddress = resolved[0]!.address;
      pinnedFamily = resolved[0]!.family;
    } catch (err) {
      return { ok: false, status: null, message: `目标主机解析失败：${(err as Error).message}`, body: "", responseHeaders: {}, sent: false };
    }
  }
  const pinned: string = pinnedAddress;
  const pinLookup = (_hostname: string, _options: any, cb: LookupCallback): void => {
    cb(null, pinned, pinnedFamily);
  };

  const transport = url.protocol === "https:" ? https : http;
  const method = req.method.toUpperCase();
  return new Promise<HttpOpOutcome>((resolve) => {
    let settled = false;
    // ponytail: 正文只发出前半截即断开按未发出处理（远端不会处理不完整的请求）
    let sent = false;
    const finish = (outcome: Omit<HttpOpOutcome, "sent">) => {
      if (!settled) {
        settled = true;
        resolve({ ...outcome, sent });
      }
    };
    const request = transport.request(
      url,
      {
        method,
        headers,
        lookup: pinLookup as any,
        // 任务停止即中止，不等超时
        signal,
        // 默认不自动跟随重定向
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total <= MAX_HTTP_RESPONSE_BYTES) chunks.push(c);
          else truncated = true;
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const responseHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            responseHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          }
          finish({
            ok: res.statusCode !== undefined && res.statusCode < 400,
            status: res.statusCode ?? null,
            message: truncated
              ? `响应已按上限截断（>${MAX_HTTP_RESPONSE_BYTES} 字节）`
              : `HTTP ${res.statusCode}`,
            body,
            responseHeaders,
          });
        });
        res.on("error", (err) => finish({ ok: false, status: null, message: `响应读取失败：${err.message}`, body: "", responseHeaders: {} }));
      },
    );
    request.setTimeout(req.timeoutMs ?? 30_000, () => {
      request.destroy(new Error("请求超时"));
    });
    request.on("finish", () => {
      sent = true;
    });
    request.on("error", (err) => {
      finish({ ok: false, status: null, message: `请求失败：${err.message}`, body: "", responseHeaders: {} });
    });
    if (req.body !== undefined && req.body.length > 0) {
      request.write(req.body);
    }
    request.end();
  });
}
