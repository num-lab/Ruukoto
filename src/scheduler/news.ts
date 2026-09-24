/** 新闻采集只消费已批准的固定参数；不装配模型、历史、资料或记忆工具。 */
import { isIP } from "node:net";
import { validateParams, WebSearchError, type TavilySearchResult } from "../agent/web-search.ts";

export interface NewsSpec {
  keywords: string[];
  domains: string[];
  timeRange: "day" | "week";
}

export interface NewsResult {
  status: "pending" | "searching" | "completed" | "failed" | "unknown" | "canceled";
  windowStart: string;
  windowEnd: string;
  searches: Array<{ query: string; queriedAt: string; requestId: string | null }>;
  items: Array<{ url: string; title: string; summary: string; publishedAt: string; queriedAt: string; summarySource: "tavily_search.content" }>;
  dropped: number;
  duplicates: number;
  truncated: boolean;
  omitted: number;
  text: string;
  errorCode: string | null;
}

export type NewsSearch = (params: Record<string, unknown>, signal: AbortSignal) => Promise<TavilySearchResult>;

export function parseNewsSpec(raw: unknown): NewsSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("news 必须提供 keywords、domains 和可选 time_range");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["keywords", "domains", "time_range"].includes(key))) throw new Error("news 含未知参数");
  if (!Array.isArray(input.keywords) || input.keywords.length < 1 || input.keywords.length > 5 ||
    input.keywords.some((word) => typeof word !== "string" || !word.trim() || word.length > 200 || /[\x00-\x1f\x7f]/.test(word))) {
    throw new Error("news.keywords 需要 1–5 个非空关键词，每个不超过 200 字符且不含控制字符");
  }
  if (!Array.isArray(input.domains) || input.domains.length < 1) throw new Error("news.domains 需要明确的来源域名，新增来源须拥有者确认");
  const timeRange = input.time_range ?? "day";
  if (timeRange !== "day" && timeRange !== "week") throw new Error("news.time_range 只能是 day / week");
  const validated = validateParams({ query: input.keywords[0], topic: "news", time_range: timeRange, include_domains: input.domains });
  const domains = [...new Set(validated.includeDomains!)].sort();
  if (domains.some((domain) => !publicDomain(domain))) throw new Error("新闻来源仅支持公开域名，不支持 IP、本机或私有域名");
  return { keywords: [...new Set((input.keywords as string[]).map((word) => word.trim()))], domains, timeRange };
}

function publicDomain(domain: string): boolean {
  return domain.includes(".") && !isIP(domain) && !/(^|\.)(localhost|local|internal|lan|home|invalid|test)$/.test(domain);
}

function excerpt(text: string, cap: number): string {
  const chars = [...text];
  return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : text;
}

export function newsPolicyText(spec: NewsSpec): string {
  return `新闻推送：${spec.keywords.join("；")}\n来源域名（含子域）：${spec.domains.join("、")}\n` +
    `窗口：原定时刻前 ${spec.timeRange === "day" ? "24 小时" : "7 天"}；仅采用有发布时间的结果。\n` +
    "每个窗口合并一条有界通知，内容为 Tavily 返回的标题、摘要、发布时间与完整来源 URL；外部内容未经独立核实。\n" +
    "授权本计划按上述范围生成动态正文；搜索失败不编造或发送新闻。修改关键词、来源或时间须取消后重新确认。";
}

export function pendingNews(spec: NewsSpec, windowEnd: string): NewsResult {
  return {
    status: "pending", windowEnd,
    windowStart: new Date(Date.parse(windowEnd) - (spec.timeRange === "day" ? 1 : 7) * 86_400_000).toISOString(),
    searches: [], items: [], dropped: 0, duplicates: 0, truncated: false, omitted: 0, text: "", errorCode: null,
  };
}

/** URL 去重只移除片段与常见跟踪参数；保留可能决定文章身份的其它参数。 */
function sourceUrl(raw: string, domains: string[]): { url: string; key: string } | null {
  try {
    if (raw.length > 2048 || /\s|[\x00-\x1f\x7f]/.test(raw)) return null;
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || !publicDomain(url.hostname)) return null;
    if (!domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return { url: raw, key: url.href };
  } catch {
    return null;
  }
}

export function failedNews(result: NewsResult, code: string): NewsResult {
  return {
    ...result,
    status: ["timeout", "canceled", "unavailable", "backend_restart"].includes(code) ? "unknown" : "failed",
    errorCode: code,
    text: `新闻采集未完成（${code}），本窗口未发送新闻摘要；未自动重试。`,
  };
}

export async function collectNews(spec: NewsSpec, windowEnd: string, search: NewsSearch, signal: AbortSignal): Promise<NewsResult> {
  const result = pendingNews(spec, windowEnd);
  const seen = new Set<string>();
  try {
    for (const query of spec.keywords) {
      signal.throwIfAborted();
      const response = await search({ query, topic: "news", time_range: spec.timeRange, include_domains: spec.domains, max_results: 5, search_depth: "basic" }, signal);
      result.searches.push({ query, queriedAt: response.queriedAt, requestId: response.requestId });
      result.dropped += response.dropped;
      for (const item of response.items) {
        const source = sourceUrl(item.url, spec.domains);
        const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
        if (!source || !Number.isFinite(published) || published <= Date.parse(result.windowStart) || published > Date.parse(windowEnd)) {
          result.dropped++;
          continue;
        }
        if (seen.has(source.key)) { result.duplicates++; continue; }
        seen.add(source.key);
        const saved = { ...item, summary: excerpt(item.summary, 500), url: source.url, publishedAt: new Date(published).toISOString(), queriedAt: response.queriedAt, summarySource: "tavily_search.content" as const };
        // ponytail: 每次快照 ≤32 KiB（给后续查询元数据与正文预留 12 KiB）；更大资料需要分页产物。
        if (Buffer.byteLength(JSON.stringify({ ...result, items: [...result.items, saved] })) > 20 * 1024) {
          result.truncated = true;
          result.dropped++;
          continue;
        }
        result.items.push(saved);
      }
    }
    signal.throwIfAborted();
    result.status = "completed";
    result.text = digestText(result);
    return result;
  } catch (error) {
    return failedNews(result, signal.aborted ? "canceled" : error instanceof WebSearchError ? error.code : "search_failed");
  }
}

function digestText(result: NewsResult): string {
  const lines = [`新闻摘要｜${result.windowStart} – ${result.windowEnd}`, "来源：Tavily 搜索摘要，未经独立核实。"];
  const fits = (text: string) => [...text].length <= 1900 && Buffer.byteLength(text) <= 7600;
  let included = 0;
  for (const item of result.items) {
    const line = `${++included}. ${excerpt(item.title, 100)}\n${item.publishedAt}\n${excerpt(item.summary, 180)}\n${item.url}`;
    if (!fits([...lines, line].join("\n\n"))) { included--; continue; }
    lines.push(line);
  }
  result.omitted = result.items.length - included;
  if (!included) lines.push(result.items.length ? "来源链接超出单条通知上限，请在 schedule_query 查看本次采集记录。" : "该窗口没有符合已批准来源与发布时间的结果。");
  if (result.omitted) lines.push(`另有 ${result.omitted} 条因通知长度限制未展示（完整记录见 schedule_query）。`);
  if (result.truncated) lines.push("采集快照已达大小上限，部分结果未保存。");
  return lines.join("\n\n");
}
