/**
 * 调度时间规则（issue 03）：一次性 / 每日 / 每周，IANA 时区，ISO 日历。
 *
 * - 一次性时间必须带 Z 或显式偏移；不用服务器本地时区补全；
 * - 每日/每周按当地日期 + 原定钟点重新构造（不做固定 24h/7d 相加）；
 * - DST 策略固定 compatible：不存在的当地时间按缺口向后移，重复时间取较早一次；
 * - 计算只看当前当地日期及相邻候选日，不逐分钟扫描，也不枚举停机期间的全部周期。
 *
 * IANA 偏移与 DST 算法全部交给 Temporal（@js-temporal/polyfill），本模块只做规则。
 */

import { Temporal } from "@js-temporal/polyfill";

export type ScheduleRule =
  | { kind: "once"; at: string; timeZone: string; disambiguation: "compatible" }
  | { kind: "daily"; time: string; timeZone: string; disambiguation: "compatible" }
  | { kind: "weekly"; time: string; weekdays: number[]; timeZone: string; disambiguation: "compatible" };

export class RuleError extends Error {}

const OFFSET_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 相邻候选日窗口：覆盖每周规则（7 天）+ 前后各一天的时区/DST 余量。 */
const SEARCH_DAYS = 9;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function canonicalZone(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || /^[+-]/.test(raw)) {
    throw new RuleError("time_zone 必须是 IANA 时区名（如 Asia/Shanghai），不接受裸偏移");
  }
  try {
    return new Temporal.ZonedDateTime(0n, raw).timeZoneId;
  } catch {
    throw new RuleError(`未知时区：${raw.slice(0, 64)}`);
  }
}

/** 校验并规范化规则输入（工具/控制面参数）；非法一律拒绝。 */
export function parseRule(raw: unknown): ScheduleRule {
  const r = (raw ?? {}) as Record<string, unknown>;
  const timeZone = canonicalZone(r.time_zone ?? r.timeZone);
  const base = { timeZone, disambiguation: "compatible" as const };
  if (r.kind === "once") {
    if (typeof r.at !== "string" || !OFFSET_INSTANT_RE.test(r.at)) {
      throw new RuleError("一次性时间必须是带 Z 或显式偏移的 ISO 时间（如 2026-10-01T09:00:00+08:00）");
    }
    let ms: number;
    try {
      ms = Temporal.Instant.from(r.at).epochMilliseconds;
    } catch {
      throw new RuleError(`一次性时间越界或非法：${r.at}`);
    }
    return { kind: "once", at: iso(ms), ...base };
  }
  if (r.kind !== "daily" && r.kind !== "weekly") throw new RuleError("kind 只能是 once / daily / weekly");
  if (typeof r.time !== "string" || !HHMM_RE.test(r.time)) throw new RuleError("time 必须是 HH:mm（00:00–23:59）");
  if (r.kind === "daily") return { kind: "daily", time: r.time, ...base };
  const days = r.weekdays;
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new RuleError("weekdays 必须是 1–7 的 ISO 星期列表（1=周一）");
  }
  if (new Set(days).size !== days.length) throw new RuleError("weekdays 不能重复");
  return { kind: "weekly", time: r.time, weekdays: [...days].sort((a, b) => a - b), ...base };
}

function localDate(ms: number, tz: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz).toPlainDate();
}

/** 某当地日期的发生时刻（不符合每周规则的日期返回 null）。 */
function occurrenceOn(rule: Exclude<ScheduleRule, { kind: "once" }>, date: Temporal.PlainDate): number | null {
  if (rule.kind === "weekly" && !rule.weekdays.includes(date.dayOfWeek)) return null;
  return date
    .toPlainDateTime(Temporal.PlainTime.from(rule.time))
    .toZonedDateTime(rule.timeZone, { disambiguation: rule.disambiguation })
    .epochMilliseconds;
}

/** 严格晚于 afterMs 的下一次发生时刻（一次性已过去则 null）。 */
export function nextAfter(rule: ScheduleRule, afterMs: number): string | null {
  if (rule.kind === "once") return Date.parse(rule.at) > afterMs ? rule.at : null;
  const start = localDate(afterMs, rule.timeZone).subtract({ days: 1 });
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const occ = occurrenceOn(rule, start.add({ days: i }));
    if (occ !== null && occ > afterMs) return iso(occ);
  }
  return null; // 规则合法时不可达
}

/** 不晚于 atMs 的最近一次发生时刻（合并补发选择的"最近一次"）。 */
export function latestAtOrBefore(rule: ScheduleRule, atMs: number): string | null {
  if (rule.kind === "once") return Date.parse(rule.at) <= atMs ? rule.at : null;
  const start = localDate(atMs, rule.timeZone).add({ days: 1 });
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const occ = occurrenceOn(rule, start.subtract({ days: i }));
    if (occ !== null && occ <= atMs) return iso(occ);
  }
  return null;
}

/** 新建计划的首次到期：一次性取原定时刻（已过去则登记后产生一次延迟触发）；周期取登记后首个时刻。 */
export function firstDue(rule: ScheduleRule, nowMs: number): string {
  return rule.kind === "once" ? rule.at : nextAfter(rule, nowMs)!;
}

/** 展示用当地时间（带偏移与时区名）。 */
export function localTimeOf(instantIso: string, tz: string): string {
  return Temporal.Instant.from(instantIso).toZonedDateTimeISO(tz).toString({ smallestUnit: "minute" });
}

/** 计算采用的时区数据版本（记录在计划上；只重算尚未登记的未来时间）。 */
export function tzDataVersion(): string {
  return `node ${process.version} icu ${process.versions.icu ?? "?"} tz ${process.versions.tz ?? "?"}`;
}

export function describeRule(rule: ScheduleRule): string {
  const tail = `（${rule.timeZone}，DST ${rule.disambiguation}）`;
  if (rule.kind === "once") return `一次性 ${localTimeOf(rule.at, rule.timeZone)}${tail}`;
  if (rule.kind === "daily") return `每日 ${rule.time}${tail}，持续至取消`;
  return `每周 ${rule.weekdays.join(",")} ${rule.time}${tail}，持续至取消`;
}
