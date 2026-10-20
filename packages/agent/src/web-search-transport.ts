/** 无状态 Tavily Search 传输；凭据仅由宿主在执行时传入，不读取旧任务、项目或凭据库。 */

const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";

export const QUERY_CAP_CHARS = 500;
export const MAX_RESULTS_CAP = 5;
export const DEFAULT_TIMEOUT_MS = 15_000;
const RESPONSE_CAP_BYTES = 256 * 1024;
const TITLE_CAP_CHARS = 300;
const URL_CAP_CHARS = 2048;
const CONTENT_CAP_CHARS = 2000;
const DATE_CAP_CHARS = 100;
export const DOMAIN_LIST_CAP = 20;
const ERROR_DETAIL_CAP = 300;

export class WebSearchError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    readonly capture?: { body: Buffer; meta: Record<string, unknown>; partial: boolean },
  ) {
    super(message);
    this.code = code;
  }
}

/** Web Search 配置（生产缺省官方端点与 15s 超时；覆盖项仅拥有者配置/测试注入）。 */
export interface WebSearchConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

export interface SearchParams {
  query: string;
  topic: "general" | "news";
  timeRange?: string;
  includeDomains?: string[];
  maxResults: number;
  searchDepth: "basic" | "fast" | "ultra-fast";
}

/** 经过限额、URL 校验与凭据脱敏的搜索快照；不读取会话、记忆或项目资料。 */
export interface TavilySearchResult {
  queriedAt: string;
  requestId: string | null;
  items: Array<{ url: string; title: string; summary: string; publishedAt: string | null }>;
  params: SearchParams;
  dropped: number;
  fieldsTruncated: boolean;
  totalResults: number;
}

const ALLOWED_KEYS = new Set(["query", "topic", "time_range", "include_domains", "max_results", "search_depth"]);
const TIME_RANGES = new Set(["day", "week", "month", "year"]);
const SEARCH_DEPTHS = new Set(["basic", "fast", "ultra-fast"]);

export interface TavilyCredential {
  header: string;
  secret: string;
}

export interface TavilyTransportResult {
  result: TavilySearchResult;
  response: Buffer;
  partial: boolean;
}

/** 裸域名（不含协议/路径/端口），如 example.com、sub.example.co.uk。 */
function isDomain(value: string): boolean {
  if (value.length > 100 || !value.includes(".")) return false;
  return value.split(".").every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label));
}

/** 服务端强制参数校验（不依赖 SDK 的 schema 校验；超限/未知字段一律拒绝）。 */
export function validateParams(params: Record<string, unknown>): SearchParams {
  for (const key of Object.keys(params)) {
    if (!ALLOWED_KEYS.has(key)) throw new WebSearchError("invalid_params", `未知参数：${key}（仅开放 ${[...ALLOWED_KEYS].join("/")}）`);
  }
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) throw new WebSearchError("invalid_params", "query 不能为空");
  if (query.length > QUERY_CAP_CHARS) {
    throw new WebSearchError("invalid_params", `query 超长（${query.length} 字符 > 上限 ${QUERY_CAP_CHARS}）`);
  }
  const topic = params.topic === undefined ? "general" : String(params.topic);
  if (topic !== "general" && topic !== "news") {
    throw new WebSearchError("invalid_params", `topic 只支持 general/news：${topic}`);
  }
  let timeRange: string | undefined;
  if (params.time_range !== undefined) {
    timeRange = String(params.time_range);
    if (!TIME_RANGES.has(timeRange)) {
      throw new WebSearchError("invalid_params", `time_range 只支持 day/week/month/year：${timeRange}`);
    }
  }
  let includeDomains: string[] | undefined;
  if (params.include_domains !== undefined) {
    if (!Array.isArray(params.include_domains) || params.include_domains.some((d) => typeof d !== "string")) {
      throw new WebSearchError("invalid_params", "include_domains 必须是字符串数组");
    }
    const domains = params.include_domains.map((d) => d.trim().toLowerCase());
    if (domains.length > DOMAIN_LIST_CAP) {
      throw new WebSearchError("invalid_params", `include_domains 最多 ${DOMAIN_LIST_CAP} 个（收到 ${domains.length}）`);
    }
    const bad = domains.find((d) => !isDomain(d));
    if (bad !== undefined) {
      throw new WebSearchError("invalid_params", `include_domains 只接受裸域名（不含协议/路径/端口）：${bad}`);
    }
    includeDomains = domains;
  }
  let maxResults = MAX_RESULTS_CAP;
  if (params.max_results !== undefined) {
    const n = Number(params.max_results);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RESULTS_CAP) {
      throw new WebSearchError("invalid_params", `max_results 必须是 1-${MAX_RESULTS_CAP} 的整数：${String(params.max_results)}`);
    }
    maxResults = n;
  }
  const searchDepth = params.search_depth === undefined ? "basic" : String(params.search_depth);
  if (!SEARCH_DEPTHS.has(searchDepth)) {
    // advanced 每次 2 配额，首版不开放
    throw new WebSearchError("invalid_params", `search_depth 只支持 basic/fast/ultra-fast：${searchDepth}`);
  }
  return { query, topic, timeRange, includeDomains, maxResults, searchDepth: searchDepth as SearchParams["searchDepth"] };
}

/** 解析目标端点：固定 /search 路径；生产必须 https，http 仅允许 loopback（测试）。 */
export function resolveTavilyTarget(baseUrl: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(baseUrl ?? TAVILY_DEFAULT_BASE_URL);
  } catch {
    throw new WebSearchError("invalid_target", "Web Search 目标配置无法解析，请拥有者检查配置");
  }
  if (url.username || url.password) throw new WebSearchError("invalid_target", "Web Search 目标不接受 URL 内嵌凭据，请拥有者检查配置");
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new WebSearchError("invalid_target", `Web Search 目标必须是 https（http 仅限 loopback 测试）：${url.protocol}//${url.host}`);
  }
  return new URL("/search", url);
}

interface RawResponse {
  status: number;
  retryAfter: string | null;
  body: Buffer;
  /** 响应超过上限被截断（body 只含前 RESPONSE_CAP_BYTES 字节）。 */
  truncated: boolean;
}

/** 单次 POST（不重试、不跟随重定向）；超时与任务取消共用 AbortSignal。 */
async function postSearch(
  target: URL,
  cred: { header: string; secret: string },
  req: SearchParams,
  taskSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = taskSignal ? AbortSignal.any([taskSignal, timeoutSignal]) : timeoutSignal;
  const body = JSON.stringify({
    query: req.query,
    max_results: req.maxResults,
    search_depth: req.searchDepth,
    topic: req.topic,
    include_published_date: true,
    ...(req.timeRange ? { time_range: req.timeRange } : {}),
    ...(req.includeDomains ? { include_domains: req.includeDomains } : {}),
  });
  let res: Response;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", [cred.header.toLowerCase()]: `Bearer ${cred.secret}` },
      body,
      signal,
      redirect: "error",
    });
  } catch (err) {
    throw classifyFetchError(err, timeoutSignal, taskSignal, timeoutMs);
  }
  const retryAfter = res.headers.get("retry-after");
  if (!res.body) return { status: res.status, retryAfter, body: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (total + chunk.length > RESPONSE_CAP_BYTES) {
        chunks.push(chunk.subarray(0, RESPONSE_CAP_BYTES - total));
        truncated = true;
        await reader.cancel().catch(() => {
          // 已停止读取并保留上限内原文；取消流失败不覆盖响应超限。
        });
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch (err) {
    const error = classifyFetchError(err, timeoutSignal, taskSignal, timeoutMs);
    throw new WebSearchError(error.code, error.message, { body: Buffer.concat(chunks), meta: { status: res.status, reason: error.code }, partial: true });
  }
  return { status: res.status, retryAfter, body: Buffer.concat(chunks), truncated };
}

function classifyFetchError(
  err: unknown,
  timeoutSignal: AbortSignal,
  taskSignal: AbortSignal | undefined,
  timeoutMs: number,
): WebSearchError {
  // 先判任务取消：取消语义决定"不重复发送"的恢复叙述，超时只是其竞争形态
  if (taskSignal?.aborted) return new WebSearchError("canceled", "任务已停止，搜索请求已中止");
  if (timeoutSignal.aborted) return new WebSearchError("timeout", `请求超过 ${timeoutMs}ms 超时（未自动重试）`);
  return new WebSearchError("unavailable", `连接搜索服务失败：${(err as Error).message}（未自动重试）`);
}

/** 从错误响应提取有界说明（Tavily 错误体为 {detail:{error}} 或 {detail:[…]}）。 */
function extractDetail(bodyText: string, redact: (text: string) => string): string {
  try {
    const data = JSON.parse(bodyText) as any;
    const detail = data?.detail;
    const text = typeof detail?.error === "string" ? detail.error : detail ? JSON.stringify(detail) : "";
    const clean = cleanText(redact(text), ERROR_DETAIL_CAP);
    return clean ? `：${clean}` : "";
  } catch {
    return "";
  }
}

function httpError(res: RawResponse, redact: (text: string) => string): WebSearchError {
  const detail = extractDetail(res.body.toString("utf8"), redact);
  switch (res.status) {
    case 400:
    case 422:
      return new WebSearchError("invalid_params", `搜索服务拒绝请求参数（HTTP ${res.status}）${detail}`);
    case 401:
      return new WebSearchError("auth_failed", `搜索服务认证失败（HTTP 401）：凭据无效或已撤销，请拥有者检查 credentials 配置${detail}`);
    case 429:
      return new WebSearchError(
        "rate_limited",
        `搜索服务限流（HTTP 429${res.retryAfter ? `，服务建议 ${cleanText(redact(res.retryAfter), ERROR_DETAIL_CAP)}s 后重试` : ""}）；本工具不自动重试${detail}`,
      );
    case 432:
    case 433:
      return new WebSearchError("quota_exceeded", `搜索服务配额/套餐上限（HTTP ${res.status}）${detail}`);
    default:
      if (res.status >= 500) return new WebSearchError("service_error", `搜索服务内部错误（HTTP ${res.status}）${detail}`);
      return new WebSearchError("unexpected_status", `搜索服务返回非预期状态 HTTP ${res.status}${detail}`);
  }
}

/** 有界清理：去控制字符 + 限长。外部内容按不可信数据处理。 */
function cleanText(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, cap);
}

/** URL 校验：仅 http/https，限长；返回原文（不规范化，保持来源可核对）。 */
function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > URL_CAP_CHARS) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return text;
  } catch {
    return null;
  }
}

/** 单次只读请求；完整脱敏响应在结果字段截断前返回，错误中的 capture 保留已接收字节。调用方持久化响应并约束调用额度。 */
export async function requestTavily(
  deps: WebSearchConfig & { credential: TavilyCredential },
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TavilyTransportResult> {
  const cred = deps.credential;
  // 同时处理明文、JSON 转义与 URL 编码的回显，先脱敏再截断，避免泄露凭据片段。
  const secretForms = new Set([cred.secret, JSON.stringify(cred.secret).slice(1, -1), encodeURIComponent(cred.secret)]);
  const redact = (text: string): string => {
    for (const secret of secretForms) if (secret) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  };
  const redactBody = (body: Buffer, partial = false): Buffer => {
    let secretSuffix = false;
    if (partial) for (const secret of secretForms) {
      const needle = Buffer.from(secret);
      for (let length = Math.min(body.length, needle.length - 1); length > 0; length--) {
        if (body.subarray(body.length - length).equals(needle.subarray(0, length))) {
          body = body.subarray(0, body.length - length);
          secretSuffix = true;
          break;
        }
      }
    }
    for (const secret of secretForms) {
      if (!secret) continue;
      const needle = Buffer.from(secret);
      const chunks: Buffer[] = [];
      let offset = 0;
      let match: number;
      while ((match = body.indexOf(needle, offset)) !== -1) {
        chunks.push(body.subarray(offset, match), Buffer.from("[REDACTED]"));
        offset = match + needle.length;
      }
      if (offset) body = Buffer.concat([...chunks, body.subarray(offset)]);
    }
    return secretSuffix ? Buffer.concat([body, Buffer.from("[REDACTED]")]) : body;
  };
  const queriedAt = new Date().toISOString();
  try {
    if (!cred.secret) throw new WebSearchError("not_configured", "Web Search 凭据为空，请拥有者检查配置");
    const req = validateParams(params);
    const target = resolveTavilyTarget(deps.baseUrl);
    const res = await postSearch(target, cred, req, signal, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const capture = (reason: string) => {
      const body = redactBody(res.body, res.truncated);
      return {
        body: body.subarray(0, RESPONSE_CAP_BYTES),
        meta: { target: redact(target.host), queriedAt, status: res.status, reason },
        partial: res.truncated || body.length > RESPONSE_CAP_BYTES,
      };
    };
    if (res.status !== 200) {
      const error = httpError(res, redact);
      throw new WebSearchError(error.code, error.message, capture(error.code));
    }
    if (res.truncated) {
      throw new WebSearchError("response_too_large", `搜索响应超过 ${RESPONSE_CAP_BYTES} 字节上限，已截断（未解析、未返回部分内容）`, capture("response_cap"));
    }

    let data: any;
    try {
      data = JSON.parse(res.body.toString("utf8"), (_key, value) => typeof value === "string" ? redact(value) : value);
    } catch {
      throw new WebSearchError("malformed_response", "搜索响应不是合法 JSON", capture("malformed_json"));
    }
    if (!data || !Array.isArray(data.results)) {
      throw new WebSearchError("malformed_response", "搜索响应缺少 results 数组", capture("missing_results"));
    }

    const items: TavilySearchResult["items"] = [];
    let dropped = 0;
    let fieldsTruncated = false;
    for (const raw of data.results.slice(0, req.maxResults)) {
      const url = cleanUrl(raw?.url);
      // 凭据回显不能成为来源链接；保持其余 URL 原文，供调用方去重与校验来源。
      if (!url || url.includes("[REDACTED]")) {
        dropped++;
        continue;
      }
      if (typeof raw?.title === "string" && raw.title.length > TITLE_CAP_CHARS) fieldsTruncated = true;
      if (typeof raw?.content === "string" && raw.content.length > CONTENT_CAP_CHARS) fieldsTruncated = true;
      items.push({
        url,
        title: cleanText(raw?.title, TITLE_CAP_CHARS) || "（无标题）",
        summary: cleanText(raw?.content, CONTENT_CAP_CHARS),
        publishedAt: cleanText(raw?.published_date, DATE_CAP_CHARS) || null,
      });
    }
    const captured = capture("complete");
    return {
      response: captured.body,
      partial: captured.partial,
      result: {
        queriedAt,
        requestId: cleanText(data.request_id, 100) || null,
        items,
        params: JSON.parse(JSON.stringify(req), (_key, value) => typeof value === "string" ? redact(value) : value) as SearchParams,
        dropped,
        fieldsTruncated,
        totalResults: data.results.length,
      },
    };
  } catch (err) {
    if (err instanceof WebSearchError) {
      const capture = err.capture ? { ...err.capture, body: redactBody(err.capture.body, err.capture.partial).subarray(0, RESPONSE_CAP_BYTES), meta: { ...err.capture.meta, queriedAt } } : undefined;
      throw new WebSearchError(err.code, redact(err.message), capture);
    }
    throw new WebSearchError("unavailable", `搜索失败：${redact((err as Error).message)}`);
  }
}
