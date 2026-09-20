/**
 * GitHub REST 薄层客户端（issue 06 §1–§3）。
 *
 * 边界：
 * - 目标只允许两类：配置绑定的 API 主机（允许分页 Link 跨主机，github.com 的
 *   REST 分页会指向 api.github.com；任何情况下 Authorization 都不跨主机转发），
 *   以及经 302 从 jobs/logs 端点派生的签名下载地址（校验协议、拒绝回环/私网、
 *   不注入任何凭据，跳转次数有上限）；
 * - 请求头按白名单构造：Accept / API 版本头 / Authorization / Content-Type，
 *   不携带调用方任意头部；秘密值不进入返回值、事件或产物名；
 * - 每次调用重新从注入的回调读取凭据与授权版本（configVersion），撤销后
 *   后续分页/重试立即失败；
 * - 只读重试：429 与 5xx 按 Retry-After / 有界退避等待（可取消、有等待预算）；
 *   POST 不重试（已发送与否不可区分 → 由调用方按 effect_unknown 处理）；
 * - 响应体有界：JSON 走 4 MiB 上限；大正文（diff/日志）经 streamTo 回调
 *   直接落产物文件，256 MiB 封顶，超限保留已捕获部分并标 partial。
 */

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

export const GITHUB_API_VERSION = "2026-03-10";
const JSON_CAP_BYTES = 4 * 1024 * 1024;
export const STREAM_CAP_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class GitHubError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface GitHubClientDeps {
  /** 凭据注入：null = 未配置凭据（只读公开数据仍可访问，但绑定要求时调用方应先校验）。 */
  credential(): { header: string; secret: string } | null;
  /** 每次调用前重新读取授权版本；null = 绑定/范围已撤销。 */
  configVersion(): string | null;
  /** 取消信号（任务停止/超时预算）。 */
  signal?: AbortSignal;
  /** 时间注入（测试）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface GitHubResponseMeta {
  status: number;
  etag: string | null;
  /** x-ratelimit-remaining（展示与限流等待依据）。 */
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

export interface GitHubClientOptions {
  /** 配置绑定的 API 主机（小写 host，含端口，如 api.github.com 或模拟服务 127.0.0.1:PORT）。 */
  apiHost: string;
  /** 生产固定 https；测试模拟服务显式允许 http（仅本机回环）。 */
  scheme?: "https" | "http";
  /** 配置版本变化时抛错的码（调用方识别后终止采集/发布）。 */
  configChangedCode?: string;
}

export class GitHubClient {
  constructor(
    private readonly opts: GitHubClientOptions,
    private readonly deps: GitHubClientDeps,
  ) {
    if (opts.scheme === "http" && !isLoopbackHost(opts.apiHost)) {
      throw new GitHubError("invalid_config", "http 方案只允许指向本机回环的模拟服务（生产固定 https）");
    }
  }

  private baseUrl(): string {
    return `${this.opts.scheme ?? "https"}://${this.opts.apiHost}`;
  }

  /** 授权版本当前值；撤销/变化即抛（分页、重试、下载前都调用）。 */
  private assertConfig(expected: string): void {
    const current = this.deps.configVersion();
    if (current === null) {
      throw new GitHubError(this.opts.configChangedCode ?? "github_config_revoked", "仓库绑定或读取授权已撤销，停止后续请求");
    }
    if (current !== expected) {
      throw new GitHubError(this.opts.configChangedCode ?? "github_config_revoked", `仓库绑定/授权版本已变化（${expected} → ${current}），停止沿用旧授权的请求`);
    }
  }

  private buildHeaders(extra: Record<string, string> = {}, withAuth: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      ...extra,
    };
    if (withAuth) {
      const cred = this.deps.credential();
      if (cred) headers[cred.header.toLowerCase()] = cred.secret;
    }
    return headers;
  }

  /**
   * JSON GET（含分页由调用方处理）。预期配置版本须由调用方在采集开始时
   * 读取并贯穿本次操作；变化即抛。
   */
  async getJson(path: string, expectedConfig: string, opts: { accept?: string } = {}): Promise<{ data: unknown; meta: GitHubResponseMeta }> {
    const url = `${this.baseUrl()}${path}`;
    const { status, headers, body } = await this.requestWithRetry("GET", url, this.buildHeaders(opts.accept ? { accept: opts.accept } : {}, true), null, expectedConfig);
    if (status === 404) throw new GitHubError("not_found", `目标不存在或无权限：${path}`, 404);
    if (status === 401 || status === 403) {
      throw new GitHubError("auth_failed", `凭据缺失、过期或权限不足（HTTP ${status}）：${path}`, status);
    }
    if (status < 200 || status >= 300) {
      throw new GitHubError("http_error", `GitHub 返回 HTTP ${status}：${path}`, status);
    }
    let data: unknown;
    try {
      data = JSON.parse(body.toString("utf8"));
    } catch {
      throw new GitHubError("bad_response", `响应不是合法 JSON：${path}`, status);
    }
    return { data, meta: metaOf(status, headers) };
  }

  /** JSON POST（发布路径专用；不重试——超时/断线由调用方按 effect_unknown 处理）。 */
  async postJson(path: string, payload: unknown, expectedConfig: string): Promise<{ data: unknown; meta: GitHubResponseMeta }> {
    this.assertConfig(expectedConfig);
    const url = `${this.baseUrl()}${path}`;
    const headers = this.buildHeaders({ "content-type": "application/json" }, true);
    const { status, headers: resHeaders, body } = await this.rawRequest("POST", url, headers, Buffer.from(JSON.stringify(payload), "utf8"));
    if (status === 401 || status === 403) {
      throw new GitHubError("auth_failed", `发布凭据缺失或权限不足（HTTP ${status}）：${path}`, status);
    }
    if (status === 404) throw new GitHubError("not_found", `发布目标不存在：${path}`, 404);
    if (status === 422) throw new GitHubError("rejected_by_remote", `GitHub 拒绝该发布内容（HTTP 422）：${path}`, 422);
    if (status < 200 || status >= 300) {
      throw new GitHubError("http_error", `发布失败：GitHub 返回 HTTP ${status}：${path}`, status);
    }
    let data: unknown = null;
    try {
      data = JSON.parse(body.toString("utf8"));
    } catch {
      // 成功状态但正文不可解析：不影响事实（远端已接受），正文留空
    }
    return { data, meta: metaOf(status, resHeaders) };
  }

  /**
   * 流式 GET：原始字节经 streamTo 写产物；返回是否完整与字节数。
   * allowDownloadHost = true 时接受 302 到任意 https 下载地址（签名 URL），
   * 但不注入凭据且拒绝回环/私网目标。
   */
  async getStream(
    path: string,
    expectedConfig: string,
    streamTo: (chunk: Buffer) => void,
    opts: { accept?: string; allowDownloadHost?: boolean } = {},
  ): Promise<{ complete: boolean; bytes: number; meta: GitHubResponseMeta }> {
    const url = `${this.baseUrl()}${path}`;
    const headers = this.buildHeaders(opts.accept ? { accept: opts.accept } : {}, true);
    const { status, headers: resHeaders, res, redirected } = await this.rawRequestFollow("GET", url, headers, expectedConfig, {
      allowDownloadHost: opts.allowDownloadHost ?? false,
    });
    try {
      if (status === 404) throw new GitHubError("not_found", `目标不存在或无权限（不能未经核实归因为日志过期）：${path}`, 404);
      if (status === 401 || status === 403) {
        throw new GitHubError("auth_failed", `凭据缺失或权限不足（HTTP ${status}）：${path}`, status);
      }
      if (status < 200 || status >= 300) {
        throw new GitHubError("http_error", `GitHub 返回 HTTP ${status}：${path}`, status);
      }
      let bytes = 0;
      let truncated = false;
      await new Promise<void>((resolve, reject) => {
        res!.on("data", (chunk: Buffer) => {
          if (truncated) return;
          bytes += chunk.length;
          if (bytes > STREAM_CAP_BYTES) {
            truncated = true;
            res!.destroy(new GitHubError("too_large", `正文超过下载上限（${STREAM_CAP_BYTES} 字节），保留已捕获部分`));
            return;
          }
          try {
            streamTo(chunk);
          } catch (err) {
            res!.destroy(err as Error);
          }
        });
        res!.on("end", () => resolve());
        res!.on("error", (err) => {
          // 超限截断：保留已捕获部分，标 partial，不算失败（§3：部分结果如实标注）
          if (truncated && err instanceof GitHubError && err.code === "too_large") resolve();
          else reject(err);
        });
      });
      return { complete: !truncated, bytes, meta: metaOf(status, resHeaders, redirected) };
    } finally {
      res?.destroy();
    }
  }

  // ---------- 内部 ----------

  /** 只读重试：429/5xx 按 Retry-After 或有界退避；预算封顶，超出抛 rate_limited。 */
  private async requestWithRetry(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer | null,
    expectedConfig: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const sleep = this.deps.sleep ?? defaultSleep;
    let delayMs = 1000;
    let waitedMs = 0;
    const budgetMs = 120_000;
    for (let attempt = 0; ; attempt++) {
      this.assertConfig(expectedConfig);
      const out = await this.rawRequest(method, url, headers, body);
      if ((out.status === 429 || out.status >= 500) && attempt < 5) {
        const retryAfter = Number(out.headers["retry-after"] ?? "");
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delayMs;
        if (waitedMs + wait > budgetMs) {
          throw new GitHubError("rate_limited", `限流/服务端错误（HTTP ${out.status}）且等待超过本次预算，交付部分结果或明确暂停`, out.status);
        }
        waitedMs += wait;
        await sleep(wait, this.deps.signal);
        delayMs = Math.min(delayMs * 2, 30_000);
        continue;
      }
      return out;
    }
  }

  private rawRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer | null,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const transport = url.startsWith("https:") ? https : http;
      const req = transport.request(url, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total <= JSON_CAP_BYTES) chunks.push(c);
          else truncated = true;
        });
        res.on("end", () => {
          if (truncated) {
            reject(new GitHubError("too_large", `JSON 响应超过上限（${JSON_CAP_BYTES} 字节），不以截断内容充当完整结果`));
            return;
          }
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) flat[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks) });
        });
      });
      req.setTimeout(30_000, () => req.destroy(new GitHubError("timeout", "请求超时")));
      const onAbort = () => req.destroy(new GitHubError("canceled", "任务已停止，请求取消"));
      this.deps.signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => {
        this.deps.signal?.removeEventListener("abort", onAbort);
        if (err instanceof GitHubError) reject(err);
        else reject(new GitHubError("connection_failed", `请求失败：${err.message}`));
      });
      req.on("close", () => this.deps.signal?.removeEventListener("abort", onAbort));
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * 带受控重定向的流式请求。起始端点固定为配置 API 主机；302 目标经校验：
   * - https 强制；回环/私网拒绝（签名下载域名例外见下）；
   * - allowDownloadHost 时允许跳转任意 https 公网主机（不注入凭据、白名单重建头）；
   * - 否则只允许停留在配置 API 主机（不注入凭据）。
   */
  private async rawRequestFollow(
    method: string,
    startUrl: string,
    headers: Record<string, string>,
    expectedConfig: string,
    opts: { allowDownloadHost: boolean },
  ): Promise<{ status: number; headers: Record<string, string>; res: http.IncomingMessage | null; redirected: string | null }> {
    let url = startUrl;
    let currentHeaders = headers;
    let redirected: string | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.assertConfig(expectedConfig);
      const out = await this.rawStreamOnce(method, url, currentHeaders);
      if (out.status >= 300 && out.status < 400 && typeof out.headers["location"] === "string") {
        out.res?.resume();
        const next = new URL(out.headers["location"], url);
        this.assertRedirectTarget(next, opts.allowDownloadHost);
        // 跨主机：白名单重建头，不转发 Authorization 与其他头
        if (next.host.toLowerCase() !== this.opts.apiHost.toLowerCase()) {
          currentHeaders = { accept: currentHeaders["accept"] ?? "*/*" };
        }
        url = next.toString();
        redirected = next.host;
        continue;
      }
      return { ...out, redirected };
    }
    throw new GitHubError("redirect_loop", `重定向次数超过上限（${MAX_REDIRECTS}）`);
  }

  private assertRedirectTarget(url: URL, allowDownloadHost: boolean): void {
    const host = url.hostname.toLowerCase();
    // 同主机跳转：协议必须与起始一致（https 起点拒绝 http 降级，防止令牌明文外泄；
    // http 起点仅为测试模拟服务，同样拒绝跳到 https 之外的协议）
    if (url.host.toLowerCase() === this.opts.apiHost.toLowerCase()) {
      if (url.protocol !== `${this.opts.scheme ?? "https"}:`) {
        throw new GitHubError("redirect_rejected", `同主机重定向协议变化（${this.opts.scheme ?? "https"}: → ${url.protocol}），拒绝`);
      }
      return;
    }
    if (url.protocol !== "https:") {
      throw new GitHubError("redirect_rejected", `重定向目标协议拒绝：${url.protocol}（跨主机仅 https）`);
    }
    if (!allowDownloadHost) {
      throw new GitHubError("redirect_rejected", `分页/重定向不得跳出配置 API 主机：${url.host}`);
    }
    if (isLoopbackHost(host) || isPrivateHost(host)) {
      throw new GitHubError("redirect_rejected", `重定向目标为回环/私网地址，拒绝：${url.host}`);
    }
  }

  private rawStreamOnce(
    method: string,
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string>; res: http.IncomingMessage | null }> {
    return new Promise((resolve, reject) => {
      const transport = url.startsWith("https:") ? https : http;
      const req = transport.request(url, { method, headers }, (res) => {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) flat[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
        resolve({ status: res.statusCode ?? 0, headers: flat, res });
      });
      req.setTimeout(60_000, () => req.destroy(new GitHubError("timeout", "下载超时")));
      const onAbort = () => req.destroy(new GitHubError("canceled", "任务已停止，下载取消"));
      this.deps.signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => {
        this.deps.signal?.removeEventListener("abort", onAbort);
        if (err instanceof GitHubError) reject(err);
        else reject(new GitHubError("connection_failed", `请求失败：${err.message}`));
      });
      req.on("close", () => this.deps.signal?.removeEventListener("abort", onAbort));
      req.end();
    });
  }
}

function metaOf(status: number, headers: Record<string, string>, redirected: string | null = null): GitHubResponseMeta {
  const remaining = headers["x-ratelimit-remaining"] === undefined || headers["x-ratelimit-remaining"] === "" ? NaN : Number(headers["x-ratelimit-remaining"]);
  const reset = headers["x-ratelimit-reset"] === undefined || headers["x-ratelimit-reset"] === "" ? NaN : Number(headers["x-ratelimit-reset"]);
  void redirected;
  return {
    status,
    etag: headers["etag"] ?? null,
    rateLimitRemaining: Number.isFinite(remaining) ? remaining : null,
    rateLimitResetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
  };
}

/** URL.hostname 对 IPv6 保留方括号；统一剥除以供 net.isIP 判定。 */
function bareHost(host: string): string {
  const h = host.toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

export function isLoopbackHost(host: string): boolean {
  const hostname = bareHost(host.split(":").length > 2 ? host : host.split(":")[0]!);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const ipType = net.isIP(hostname);
  if (ipType === 4) return hostname.startsWith("127.");
  if (ipType === 6) return hostname === "::1" || v4Mapped(hostname)?.startsWith("127.") === true;
  return false;
}

/** IPv4-mapped IPv6（::ffff:a.b.c.d）→ 取映射的 IPv4；否则 null。 */
function v4Mapped(hostname: string): string | null {
  if (!hostname.startsWith("::ffff:")) return null;
  const tail = hostname.slice(7);
  return net.isIP(tail) === 4 ? tail : null;
}

/** 私网/保留地址（下载跳转拒绝；API 主机由配置决定，不在此列）。 */
function isPrivateHost(host: string): boolean {
  const hostname = bareHost(host);
  const mapped = v4Mapped(hostname);
  const v4 = net.isIP(hostname) === 4 ? hostname : mapped;
  if (v4) {
    const parts = v4.split(".").map(Number);
    const [a, b] = parts as [number, number];
    return a === 10 || a === 0 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIP(hostname) === 6) {
    const h = hostname.toLowerCase();
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  }
  return false;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GitHubError("canceled", "等待已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
