import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseRule, RuleError, type ScheduleRule } from "@ruukoto/channels/scheduler/time.ts";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { personalControl } from "./personal-control.ts";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_SCHEDULE_PENDING_FILE } from "./personal-profile.ts";
import type { personalScheduler } from "./personal-scheduler.ts";
import { parsePersonalScheduleCreate, personalScheduleDescription, personalScheduleRunDescription, personalScheduleRuleDescription, type PersonalScheduleCreateBody } from "./personal-scheduler-controls.ts";

type Scheduler = ReturnType<typeof personalScheduler>;
const pendingName = (input: PersonalScheduleCreateBody) => `pending-schedule-${input.requestId}.json`;

export function pendingPersonalSchedules(directory: string): PersonalScheduleCreateBody[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => PERSONAL_SCHEDULE_PENDING_FILE.test(name)).sort().map(name => {
    const filename = path.join(directory, name);
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new PersonalError("schedule_pending_invalid", "待核实计划不是普通文件，请保留原文件并检查档案。");
    let saved: unknown;
    try { saved = JSON.parse(fs.readFileSync(filename, "utf8")); } catch (error) { throw new PersonalError("schedule_pending_invalid", "待核实计划无法读取，请保留原文件并检查档案；未重新创建。", { cause: error }); }
    const input = parsePersonalScheduleCreate(saved);
    if (name !== pendingName(input)) throw new PersonalError("schedule_pending_invalid", "待核实计划的原请求不一致，请保留文件并检查；未重新创建。");
    return input;
  });
}

async function checkCreated(directory: string, input: PersonalScheduleCreateBody) {
  const result = await personalControl<Awaited<ReturnType<Scheduler["createByRequest"]>>>(directory, "GET", `/schedule?requestId=${encodeURIComponent(input.requestId)}`);
  if (result) fs.rmSync(path.join(directory, pendingName(input)), { force: true });
  return result;
}

async function recoverSchedules(io: PersonalCliIO, directory: string) {
  for (const input of pendingPersonalSchedules(directory)) {
    io.write(`\n待核实计划：${input.label}；${personalScheduleRuleDescription(input.rule)}\n`);
    const found = await checkCreated(directory, input);
    if (found) { io.write("后台已受理原计划，可从计划列表查看运行。\n"); continue; }
    const selected = await choose(io, "后台尚未接纳这项计划", ["保留原请求，返回", "按原请求创建", "放弃尚未接纳的创建"]);
    if (selected === 0) return false;
    if (selected === 2) { fs.rmSync(path.join(directory, pendingName(input))); continue; }
    await personalControl(directory, "POST", "/schedules", input);
    if (!await checkCreated(directory, input)) throw new PersonalError("schedule_create_unverified", "计划创建尚未核实，已保留原请求；请回到定时管理核实，勿重复新建。");
    io.write("原计划已创建。\n");
  }
  return true;
}

async function createSchedule(io: PersonalCliIO, directory: string) {
  if (!await recoverSchedules(io, directory)) return;
  const rule = await choosePersonalScheduleRule(io);
  if (!rule) return;
  const label = (await io.question("计划名称（最多128字符；/back 返回）：")).trim();
  if (label === "/back") return;
  const instruction = await io.question("完整工作要求（子会话不读取主聊天；/back 返回）：");
  if (instruction === "/back") return;
  const input = parsePersonalScheduleCreate({ requestId: randomUUID(), label, instruction, rule });
  io.write(`\n${label}\n${personalScheduleRuleDescription(rule)}\n${instruction}\n创建时固定当前模式、工具与资料范围；此处创建的完整回报保存在本机。\n`);
  if (await choose(io, "创建定时计划", ["返回", "确认创建"]) === 0) return;
  await personalControl(directory, "GET", "/status");
  fs.writeFileSync(path.join(directory, pendingName(input)), JSON.stringify(input) + "\n", { flag: "wx", mode: 0o600 });
  await personalControl(directory, "POST", "/schedules", input);
  if (!await checkCreated(directory, input)) throw new PersonalError("schedule_create_unverified", "计划创建尚未核实，已保留原请求；请回到定时管理核实，勿重复新建。");
  io.write("计划已创建；后台独立执行，主聊天仍可继续。\n");
}

async function viewRuns(io: PersonalCliIO, directory: string, id: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<Scheduler["runs"]>>>(directory, "GET", `/schedule/runs?schedule=${encodeURIComponent(id)}&offset=${offset}`);
    const options = [...page.items.map(personalScheduleRunDescription), ...(page.nextOffset === undefined ? [] : ["下一页运行"]), "返回计划"];
    const selected = await choose(io, "计划运行", options);
    if (selected === options.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const run = page.items[selected];
    let resultOffset = 0;
    while (true) {
      const result = await personalControl<Awaited<ReturnType<Scheduler["result"]>>>(directory, "GET", `/schedule/run/result?run=${encodeURIComponent(run.id)}&offset=${resultOffset}`);
      io.write(`${personalScheduleRunDescription({ ...run, ...result })}\n${result.text ?? "原运行暂无完整报告，请刷新查询。"}\n`);
      const actions = ["刷新运行", ...(result.nextOffset === undefined ? [] : ["下一页报告"]), "返回运行列表"];
      const action = actions[await choose(io, "原定时运行", actions)];
      if (action === "返回运行列表") break;
      resultOffset = action === "下一页报告" ? result.nextOffset! : 0;
    }
  }
}

async function listSchedules(io: PersonalCliIO, directory: string) {
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<Scheduler["list"]>>>(directory, "GET", `/schedules?offset=${offset}`);
    const options = [...page.items.map(personalScheduleDescription), ...(page.nextOffset === undefined ? [] : ["下一页计划"]), "返回"];
    const selected = await choose(io, "定时计划", options);
    if (selected === options.length - 1) return;
    if (selected === page.items.length) { offset = page.nextOffset!; continue; }
    const id = page.items[selected].id;
    while (true) {
      const value = await personalControl<Awaited<ReturnType<Scheduler["get"]>>>(directory, "GET", `/schedule?schedule=${encodeURIComponent(id)}`);
      io.write(`${personalScheduleDescription(value)}\n${value.instruction}\n`);
      const actions = ["刷新计划", "查看运行与完整报告", ...(!value.canceled ? ["取消计划及未结束运行"] : []), "返回计划列表"];
      const action = actions[await choose(io, "原定时计划", actions)];
      if (action === "返回计划列表") break;
      if (action === "查看运行与完整报告") await viewRuns(io, directory, id);
      if (action === "取消计划及未结束运行") { await personalControl(directory, "POST", `/schedule/cancel?schedule=${encodeURIComponent(id)}`); io.write("取消已登记；原运行的外部效果与停止仍须核实，历史和完整报告保留。\n"); }
    }
  }
}

export async function managePersonalSchedules(io: PersonalCliIO, directory: string) {
  while (true) {
    const selected = await choose(io, "定时工作", ["创建定时计划", "查看计划与运行", "核实上次创建", "返回"]);
    if (selected === 3) return;
    if (selected === 0) await createSchedule(io, directory);
    else if (selected === 1) await listSchedules(io, directory);
    else if (await recoverSchedules(io, directory)) io.write("没有尚待核实的计划创建。\n");
  }
}

export async function choosePersonalScheduleRule(io: PersonalCliIO): Promise<ScheduleRule | undefined> {
  const kind = await choose(io, "执行频率", ["一次性", "每日", "每周", "返回"]);
  if (kind === 3) return;
  const zone = await choose(io, "执行时区", ["东京（Asia/Tokyo）", "上海（Asia/Shanghai）", "UTC", "其他 IANA 时区", "返回"]);
  if (zone === 4) return;
  const timeZone = zone === 3 ? (await io.question("IANA 时区（例如 Europe/London；/back 返回）：")).trim() : ["Asia/Tokyo", "Asia/Shanghai", "UTC"][zone];
  if (timeZone === "/back") return;
  if (kind === 0) {
    const at = (await io.question("一次性时间（例如 2026-10-20T09:00:00+09:00，须带时区偏移；/back 返回）：")).trim();
    return at === "/back" ? undefined : scheduleRule({ kind: "once", at, timeZone });
  }
  const time = (await io.question("当地执行时间（HH:mm，例如 09:00；/back 返回）：")).trim();
  if (time === "/back") return;
  if (kind === 1) return scheduleRule({ kind: "daily", time, timeZone });
  const weekdays: number[] = [];
  while (true) {
    const days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((day, index) => `${weekdays.includes(index + 1) ? "已选：" : ""}${day}`);
    const selected = await choose(io, "选择执行星期（可多选）", [...days, "完成星期选择", "返回"]);
    if (selected === 8) return;
    if (selected === 7) return scheduleRule({ kind: "weekly", time, timeZone, weekdays });
    if (weekdays.includes(selected + 1)) weekdays.splice(weekdays.indexOf(selected + 1), 1);
    else weekdays.push(selected + 1);
  }
}

function scheduleRule(value: unknown) {
  try { return parseRule(value); } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    throw new PersonalError("schedule_rule_invalid", error.message, { cause: error });
  }
}
