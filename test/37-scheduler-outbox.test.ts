import assert from "node:assert/strict";
import { test } from "node:test";
import { firstDue, latestAtOrBefore, nextAfter, parseRule, RuleError } from "@ruukoto/channels/scheduler/time.ts";

// ---------- 时间规则 ----------

const ms = (s: string) => Date.parse(s);

test("时间：一次性必须带偏移；非法时区/越界日期/无效钟点拒绝", () => {
  assert.throws(() => parseRule({ kind: "once", at: "2026-10-01T09:00:00", time_zone: "Asia/Shanghai" }), RuleError);
  assert.throws(() => parseRule({ kind: "once", at: "2026-02-30T09:00:00Z", time_zone: "UTC" }), RuleError);
  assert.throws(() => parseRule({ kind: "daily", time: "24:00", time_zone: "UTC" }), RuleError);
  assert.throws(() => parseRule({ kind: "daily", time: "09:00", time_zone: "Mars/Olympus" }), RuleError);
  assert.throws(() => parseRule({ kind: "daily", time: "09:00", time_zone: "+08:00" }), RuleError);
  assert.throws(() => parseRule({ kind: "weekly", time: "09:00", weekdays: [1, 1], time_zone: "UTC" }), RuleError);
  assert.throws(() => parseRule({ kind: "weekly", time: "09:00", weekdays: [0], time_zone: "UTC" }), RuleError);
  const once = parseRule({ kind: "once", at: "2026-10-01T09:00:00+08:00", time_zone: "Asia/Shanghai" });
  assert.equal(once.kind === "once" && once.at, "2026-10-01T01:00:00.000Z");
  // 已过去的一次性时间：首次到期仍是原定时刻（登记后产生一次延迟触发）
  assert.equal(firstDue(once, ms("2027-01-01T00:00:00Z")), "2026-10-01T01:00:00.000Z");
});

test("时间：纽约 DST gap 向后移、次日回到原钟点；fold 只取第一次", () => {
  const daily = parseRule({ kind: "daily", time: "02:30", time_zone: "America/New_York" });
  // 2026-03-08 春季跳时：02:30 不存在 → 03:30 EDT（07:30Z）
  assert.equal(nextAfter(daily, ms("2026-03-08T05:00:00Z")), "2026-03-08T07:30:00.000Z");
  // 次日回到 02:30 EDT（06:30Z），不是 +24h 的 07:30Z
  assert.equal(nextAfter(daily, ms("2026-03-08T07:30:00Z")), "2026-03-09T06:30:00.000Z");
  const fold = parseRule({ kind: "daily", time: "01:30", time_zone: "America/New_York" });
  // 2026-11-01 秋季重复 01:30：只取较早的 EDT（05:30Z），下一次是次日 EST（06:30Z）
  assert.equal(nextAfter(fold, ms("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z");
  assert.equal(nextAfter(fold, ms("2026-11-01T05:30:00Z")), "2026-11-02T06:30:00.000Z");
  // 钟点跨 DST 不漂移：DST 前后都在当地 09:00
  const nine = parseRule({ kind: "daily", time: "09:00", time_zone: "America/New_York" });
  assert.equal(nextAfter(nine, ms("2026-03-07T15:00:00Z")), "2026-03-08T13:00:00.000Z");
  assert.equal(nextAfter(nine, ms("2026-03-06T15:00:00Z")), "2026-03-07T14:00:00.000Z");
});

test("时间：Lord_Howe 半小时 DST、Kathmandu +05:45、每周与跨年闰日", () => {
  // Lord Howe 2026-10-04 02:00 → 02:30（半小时缺口）：02:15 不存在 → 02:45 +11:00
  const lh = parseRule({ kind: "daily", time: "02:15", time_zone: "Australia/Lord_Howe" });
  assert.equal(nextAfter(lh, ms("2026-10-03T14:00:00Z")), "2026-10-03T15:45:00.000Z");
  const ktm = parseRule({ kind: "daily", time: "00:10", time_zone: "Asia/Kathmandu" });
  assert.equal(nextAfter(ktm, ms("2026-12-31T12:00:00Z")), "2026-12-31T18:25:00.000Z"); // 次日 00:10 +05:45
  // 每周一、四 08:00 上海：周四（2026-09-24）之后是下周一
  const weekly = parseRule({ kind: "weekly", time: "08:00", weekdays: [4, 1], time_zone: "Asia/Shanghai" });
  assert.equal(nextAfter(weekly, ms("2026-09-24T00:00:00Z")), "2026-09-28T00:00:00.000Z");
  assert.equal(latestAtOrBefore(weekly, ms("2026-09-27T00:00:00Z")), "2026-09-24T00:00:00.000Z");
  // 跨年 + 闰日：2028-02-28 之后下一天是 02-29
  const utc = parseRule({ kind: "daily", time: "23:59", time_zone: "UTC" });
  assert.equal(nextAfter(utc, ms("2028-02-28T23:59:00Z")), "2028-02-29T23:59:00.000Z");
  assert.equal(nextAfter(utc, ms("2026-12-31T23:59:00Z")), "2027-01-01T23:59:00.000Z");
  // 多年停机：最近一次直接定位，不枚举全部周期
  assert.equal(latestAtOrBefore(utc, ms("2031-06-15T12:00:00Z")), "2031-06-14T23:59:00.000Z");
});
