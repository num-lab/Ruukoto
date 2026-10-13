/** 工作流查询与版本化控制复用文本窗口；原键留在命令历史，断线后先核实。
 * Note: 见 .agents/notes/implemented/feature/2026-10-13-workflow-library-and-controls.md
 */
import type { OpResult } from "@ruukoto/control/ops.ts";
import { parseWorkflowControl, type WorkflowControl } from "@ruukoto/core/workflow.ts";
import { writeFailure, type CommandContext } from "./commands.ts";

const HELP = [
  "/workflow definitions [列表偏移]｜definition <名称> [字节偏移] [历史偏移]｜version <版本ID> [字节偏移]",
  "/workflow save <名称> <请求键> <当前摘要|null> <JSON脚本字符串>",
  "/workflow run <名称> <请求键> <JSON参数>｜find <原请求键>｜saved <原保存请求键>",
  "/workflow list [列表偏移]｜show <运行ID> [步骤偏移]｜logs <运行ID> [字节偏移]｜step <运行ID> <步骤键> [字节偏移]",
  "/workflow question <运行ID> <步骤键> [字节偏移]",
  "/workflow answer <运行ID> <步骤键> <问题运行代次> <问题版本> <请求键> <JSON回答>",
  "/workflow pause|cancel <运行ID> <当前版本> <请求键>",
  '/workflow resume <运行ID> <当前版本> <请求键> [JSON核实：{"clockConfirmed":true,"stopsConfirmed":true}]',
  "/workflow budget <运行ID> <当前版本> <请求键> <尝试上限> <运行毫秒>",
  "所有写操作使用稳定请求键，应答丢失后先 find/saved/show，不自动重发。",
].join("\n");

function json(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error("JSON 格式不正确，请核实参数原文"); }
}
function integer(text: string | undefined, fallback = 0, minimum = 0): number {
  const value = text === undefined ? fallback : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("版本、偏移与预算必须为允许范围内的整数");
  return value;
}
function requestKey(text: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(text)) throw new Error("请求键须为 1–128 位字母、数字或 ._:-，原请求核实前不要换键");
  return text;
}
function detail(value: OpResult<"workflow_get">): string {
  const run = value.run;
  return [
    "工作流 " + run.id + " · " + run.status + " · v" + run.version,
    "定义 " + run.definitionId + " · " + run.scriptDigest + "；参数摘要 " + run.inputDigest,
    "等待/暂停原因：" + (run.reason ?? "无") + "；尝试 " + run.attempts + "/" + run.maxAttempts + "，运行时间 " + Math.round(run.usedMs / 1000) + "/" + Math.round(run.durationMs / 1000) + " 秒",
    "计时" + (run.clockVerified ? "已核实" : "待核实") + "；脚本停止" + (run.scriptStopVerified === true ? "已核实" : run.scriptStopVerified === false ? "未核实" : "尚无结论") + "；最终回报 " + (run.delivery?.status ?? "尚未登记"),
    ...value.steps.map(step => step.key + " [" + step.kind + "] " + step.status + " · 尝试 " + step.attempts + (step.question ? " · 问题 " + step.question : "") + (step.outputArtifact ? " · 产物 " + step.outputArtifact.id : "")),
    ...value.executions.filter(execution => execution.stopVerified === false).map(execution => "执行 " + execution.taskId + " 停止未核实，保留占用与成果"),
    ...(value.nextStepOffset === null ? [] : ["/workflow show " + run.id + " " + value.nextStepOffset + " 查看下一页步骤"]),
    "/workflow logs " + run.id + " 查看阶段；/workflow step " + run.id + " <步骤键> 查看结果；/workflow question " + run.id + " <步骤键> 查看答复命令",
    "控制须使用当前版本和稳定请求键；未知效果或来源失效须先核实，恢复不会绕过安全限制。",
  ].join("\n");
}
function page(value: { text: string; offset: number; totalBytes: number }, command: string): string {
  const end = value.offset + Buffer.byteLength(value.text);
  return value.text + "\n（字节 " + value.offset + "–" + end + " / " + value.totalBytes + "）" + (end < value.totalBytes ? "\n续页：" + command + " " + end : "");
}

export async function workflow(ctx: CommandContext, line: string): Promise<void> {
  const raw = line.replace(/^\/workflow(?:\s+|$)/, "");
  const tokens = raw.split(/\s+/), sub = tokens[0] || "list";
  let write = false, check = "/workflow list";
  try {
    if (sub === "definitions") {
      const value = await ctx.request("workflow_definitions", { offset: integer(tokens[1]) });
      ctx.showText(["工作流定义（共 " + value.total + " 个）", ...value.definitions.map(def => def.name + " · " + (def.error ?? def.id + " · " + def.digest)),
        ...(value.nextOffset === null ? [] : ["下一页：/workflow definitions " + value.nextOffset]), "详情：/workflow definition <名称>；编辑 workflows/<名称>.js 或使用 save"].join("\n"));
      return;
    }
    if ((sub === "definition" || sub === "version") && tokens[1]) {
      const value = await ctx.request("workflow_definition", { ...(sub === "definition" ? { name: tokens[1] } : { definition_id: tokens[1] }), offset: integer(tokens[2]), version_offset: integer(tokens[3]) });
      ctx.showText(["定义 " + (value.name ?? "历史版本") + " · " + value.id + " · " + value.digest, page(value, "/workflow " + sub + " " + tokens[1]),
        ...value.versions.map(version => "历史 " + version.id + " · " + version.digest),
        ...(value.nextVersionOffset === null ? [] : ["/workflow definition " + tokens[1] + " 0 " + value.nextVersionOffset + " 查看下一页历史"])].join("\n"));
      return;
    }
    if (sub === "list") {
      const value = await ctx.request("workflow_list", { session_id: ctx.view?.sessionId, offset: integer(tokens[1]) });
      ctx.showText(["工作流运行（共 " + value.total + " 项）", ...value.runs.map(run => run.id + " " + run.status + " v" + run.version + " · " + (run.reason ?? "无等待原因") + " · 尝试 " + run.attempts + "/" + run.maxAttempts),
        ...(value.nextOffset === null ? [] : ["下一页：/workflow list " + value.nextOffset]), "详情：/workflow show <完整运行ID>"].join("\n"));
      return;
    }
    if (sub === "show" && tokens[1]) { ctx.showText(detail(await ctx.request("workflow_get", { run_id: tokens[1], step_offset: integer(tokens[2]) }))); return; }
    if (sub === "logs" && tokens[1]) { ctx.showText(page(await ctx.request("workflow_logs", { run_id: tokens[1], offset: integer(tokens[2]) }), "/workflow logs " + tokens[1])); return; }
    if ((sub === "step" || sub === "question") && tokens[1] && tokens[2]) {
      if (sub === "step") ctx.showText(page(await ctx.request("workflow_step", { run_id: tokens[1], step_key: tokens[2], offset: integer(tokens[3]) }), "/workflow step " + tokens[1] + " " + tokens[2]));
      else {
        const value = await ctx.request("workflow_question", { run_id: tokens[1], step_key: tokens[2], offset: integer(tokens[3]) });
        ctx.showText(["问题 " + value.runId + "/" + value.stepKey + " · " + value.status + " · 运行代次 " + value.runVersion + "，问题版本 " + value.version,
          page(value, "/workflow question " + tokens[1] + " " + tokens[2]), "/workflow answer " + value.runId + " " + value.stepKey + " " + value.runVersion + " " + value.version + " <请求键> <JSON回答>；业务回答不批准工具"].join("\n"));
      }
      return;
    }
    if (sub === "run") {
      const match = /^run\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(raw);
      if (!match || !ctx.view) throw new Error("用法：在当前会话 /workflow run <名称> <请求键> <JSON参数>");
      const key = requestKey(match[2]), input = json(match[3]);
      check = "/workflow find " + key; write = true;
      const value = await ctx.request("workflow_start", { session_id: ctx.view.sessionId, name: match[1], request_id: key, input });
      ctx.result("已启动 " + value.run.id + "；请求键 " + key + "；/workflow show " + value.run.id + "，聊天可继续");
      return;
    }
    if (sub === "find" && tokens[1] && ctx.view) {
      const value = await ctx.request("workflow_find", { session_id: ctx.view.sessionId, request_id: requestKey(tokens[1]) });
      ctx.showText(value ? detail(value) : "原请求尚未登记；核实后台后可用原键重发原参数"); return;
    }
    if (sub === "save") {
      const match = /^save\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(raw);
      if (!match) throw new Error("用法：/workflow save <名称> <请求键> <当前摘要|null> <JSON脚本字符串>");
      const script = json(match[4]);
      if (typeof script !== "string") throw new Error("脚本须为 JSON 字符串，换行写为 \\n");
      const key = requestKey(match[2]); check = "/workflow saved " + key; write = true;
      const value = await ctx.request("workflow_save", { name: match[1], request_id: key, expected_digest: match[3] === "null" ? null : match[3], script });
      ctx.result("已保存 " + value.name + " · " + value.id + " · " + value.digest + "；请求键 " + key); return;
    }
    if (sub === "saved" && tokens[1]) { ctx.showText(JSON.stringify(await ctx.request("workflow_saved", { request_id: requestKey(tokens[1]) }), null, 2)); return; }
    if (sub === "answer") {
      const match = /^answer\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/.exec(raw);
      if (!match) throw new Error("用法：/workflow answer <运行ID> <步骤键> <问题运行代次> <问题版本> <请求键> <JSON回答>");
      const key = requestKey(match[5]), answer = json(match[6]), runVersion = integer(match[3], 0, 1), version = integer(match[4], 0, 1);
      check = "/workflow question " + match[1] + " " + match[2]; write = true;
      const value = await ctx.request("workflow_answer", { run_id: match[1], step_key: match[2], run_version: runVersion, question_version: version, request_id: key, answer });
      ctx.result("业务回答 " + value.status + "；请求键 " + key + "；工具审批未改变"); return;
    }
    if (["pause", "resume", "cancel", "budget"].includes(sub)) {
      const match = /^(pause|resume|cancel|budget)\s+(\S+)\s+(\d+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(raw);
      if (!match) throw new Error("控制须提供完整运行 ID、当前版本和稳定请求键；/workflow help 查看用法");
      let control: WorkflowControl;
      if (sub === "budget") {
        const values = match[5]?.split(/\s+/);
        if (!values || values.length !== 2) throw new Error("预算须提供尝试上限和运行毫秒");
        control = { action: "budget", maxAttempts: integer(values[0], 0, 1), durationMs: integer(values[1], 0, 1) };
      } else if (sub === "resume") {
        const extra = match[5] ? json(match[5]) : {};
        if (typeof extra !== "object" || extra === null || Array.isArray(extra)) throw new Error("恢复核实须为 JSON 对象");
        control = parseWorkflowControl({ ...extra, action: "resume" });
      } else { if (match[5]) throw new Error("暂停/取消不接受额外参数"); control = { action: sub === "pause" ? "pause" : "cancel" }; }
      const key = requestKey(match[4]), version = integer(match[3], 0, 1); check = "/workflow show " + match[2]; write = true;
      const value = await ctx.request("workflow_control", { run_id: match[2], expected_version: version, request_id: key, control });
      ctx.result(value.run.id + " " + value.run.status + " v" + value.run.version + "；请求键 " + key + "；成果保留"); ctx.showText(detail(value)); return;
    }
    ctx.showText(HELP);
  } catch (error) { ctx.result(write ? writeFailure("工作流操作", error, check) : "工作流请求失败：" + (error as Error).message + "；/workflow help 查看用法", true); }
}
