import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { product } from "../../../apps/ruukoto-code/src/product.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, waitFor } from "../../../test/helpers/testkit.ts";
import { getOwnerQuestion } from "@ruukoto/core/owner-questions.ts";

const driver = fs.readFileSync("test/15-tui-pty.test.ts", "utf8").split("const PTY_DRIVER = `")[1].split("`;\n")[0];
let questionItems = [{ question: "选择做法", options: ["甲", "乙"] }, { question: "补充说明" }];
const t = await startTestRuntime("questions-pty", request => lastUserText(request) === "ASK" && !afterTool(request)
  ? { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: questionItems } }] }
  : { kind: "text", text: "已记录" }, { config: { ...realTools(), product: product.runtime, socketPath: undefined } });
async function question() {
  const task = await t.runtime.submit({ sessionId: session.id, requestId: crypto.randomUUID(), input: "ASK", modelSelection: t.runtime.defaultSelection });
  await waitFor("问题登记", () => t.runtime.store.getTask(task.id)?.status === "completed");
  const question = t.runtime.listOwnerQuestions(session.id).questions.find(item => item.status === "pending");
  assert.ok(question); return question;
}
async function run(inputs: Array<[number, string]>, expect: string[]) {
  const payload = { cmd: ["npx", "tsx", "apps/ruukoto-code/src/main.ts", "tui", "--session", session.id],
    env: { RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CODE_CONTROL_DIR: t.runtime.controlDir(), RUUKOTO_CODE_PENDING_DIR: path.join(t.dirs.root, "pending"), RUUKOTO_OWNER_TOKEN: "", RUUKOTO_OWNER_TOKEN_FILE: "" },
    inputs, expect, size: { columns: 90, rows: 28 }, timeout: 25 };
  const result = await new Promise<{ exitCode: number; expectSeen: number; expectTotal: number; all: string; tail: string; segments: string[]; cleanupError: string | null }>((resolve, reject) => {
    const child = spawn("python3", ["-c", driver, JSON.stringify(payload)], { cwd: process.cwd() });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject); child.on("close", () => { try { resolve(JSON.parse(out.trim())); } catch (error) { reject(new Error(`PTY 无可解析结果：${(error as Error).message} ${err}`)); } });
  });
  assert.equal(result.exitCode, 0, result.tail); assert.equal(result.cleanupError, null, result.tail);
  assert.equal(result.expectSeen, result.expectTotal, result.tail); assert.ok(result.all.includes("\x1b[?1049l"));
  return result;
}
const session = await t.runtime.createSession({ projectName: "questions", cwd: t.work[0], mode: "full_access" });
try {
  const first = await question();
  await run([[4, "/questions\r"], [5, "\r"], [6, "\x1b[B"], [6.2, "\x1b[B"], [6.4, "\r"], [7, "custom q 问题\r"], [8, "\r"], [9, "第二题\r"], [10, "\r"], [12, "\x1b"], [13, "/quit\r"]], ["拥有者问题待回答", "拥有者问题", "自由输入", "补充说明", "回答已接纳", "已退出 TUI"]);
  assert.deepEqual(getOwnerQuestion(t.runtime.store, first.id)!.answers, [{ text: "custom q 问题" }, { text: "第二题" }]);
  const second = await question();
  await run([[4, "/questions\r"], [5, "\r"], [6, "\x1b[B"], [6.2, "\x1b[B"], [6.4, "\x1b[B"], [6.6, "\r"], [7, "\r"], [9, "\x1b"], [10, "/quit\r"]], ["拥有者问题", "确认取消", "已取消", "已退出 TUI"]);
  assert.equal(getOwnerQuestion(t.runtime.store, second.id)!.status, "canceled");
  assert.equal(getOwnerQuestion(t.runtime.store, second.id)!.continuationTaskId, undefined);
  const third = await question();
  await run([[4, "/questions\r"], [5, "\r"], [6, "\x1b[B"], [6.2, "\r"], [7, "\r"], [8, "选项补充\r"], [9, "\r"], [11, "\x1b"], [12, "/quit\r"]], ["拥有者问题", "补充说明", "回答已接纳", "已退出 TUI"]);
  assert.deepEqual(getOwnerQuestion(t.runtime.store, third.id)!.answers, [{ text: "乙", option: 1 }, { text: "选项补充" }]);
  const options = Array.from({ length: 5 }, (_, index) => "共同前缀".repeat(45) + `选项${index + 1}尾部`);
  questionItems = [{ question: "长选项完整续读", options }];
  const fourth = await question();
  const paged = await run([[4, "/questions\r"], [5, "\r"], [6, "\x1b[6~"], [6.3, "\x1b[6~"], [6.6, "\x1b[6~"], [6.9, "\x1b[6~"], [7.2, "\x1b[6~"], [8, "\x1b[B"], [8.3, "\r"], [9, "\r"], [11, "\x1b"], [12, "/quit\r"]], ["长选项完整续读", "选项5尾部", "回答已接纳", "已退出 TUI"]);
  assert.ok(!paged.segments.slice(0, 3).join("").includes("选项5尾部"));
  assert.ok(paged.segments.slice(3, 8).join("").includes("选项5尾部"), "翻页时就能读到尾部，不能等核对页才补全文");
  assert.deepEqual(getOwnerQuestion(t.runtime.store, fourth.id)!.answers, [{ text: options[1], option: 1 }]);
  process.stdout.write("真实 Python PTY / Runtime / ControlServer：逐题选择、含 q 中文自由文本、唯一续接、显式取消、长选项翻页与终端退出恢复通过；模型使用 mock。\n");
} finally { await t.shutdown(); }
