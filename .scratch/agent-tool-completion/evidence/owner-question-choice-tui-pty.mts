import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { product } from "../../../apps/ruukoto-code/src/product.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, waitFor } from "../../../test/helpers/testkit.ts";
import type { OwnerQuestionItem } from "../../../packages/core/src/owner-questions.ts";
import { getOwnerQuestion } from "../../../packages/core/src/owner-questions.ts";

const driver = fs.readFileSync("test/15-tui-pty.test.ts", "utf8").split("const PTY_DRIVER = `")[1].split("`;\n")[0];
let questionItems: OwnerQuestionItem[] = [{ question: "选择多个目标", multiple: true, options: [{ label: "甲", description: "说明尾部", recommended: true }, "乙", "丙"] }, { question: "补充说明" }];
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
  await run([[4, "/questions\r"], [5, "\r"], [6, "\x1b[B"], [6.2, "\x1b[B"], [6.4, "\r"], [6.7, "\r"], [7, "\r"], [7.3, "\x1b[A"], [7.5, "\x1b[A"], [7.7, "\r"], [8, "\x1b[B"], [8.2, "\x1b[B"], [8.4, "\x1b[B"], [8.6, "\r"], [9, "\x1b[A"], [9.2, "\r"], [10, "\r"], [12, "\x1b"], [13, "/quit\r"]], ["拥有者问题", "Recommended", "说明尾部", "[x] 丙", "补充说明", "已跳过", "回答已接纳", "已退出 TUI"]);
  assert.deepEqual(getOwnerQuestion(t.runtime.store, first.id)!.answers, [{ text: "甲\n丙", options: [0, 2] }, { text: "" }]);
  questionItems = [{ question: "选择目标或自由回答", multiple: true, options: ["甲", "乙"] }];
  const second = await question();
  await run([[4, "/questions\r"], [5, "\r"], [6, "\r"], [6.2, "\x1b[B"], [6.4, "\x1b[B"], [6.6, "\x1b[B"], [6.8, "\r"], [7.2, "实际中文 q 回答\r"], [8, "\x1b"], [8.5, "\r"], [9, "\x1b[A"], [9.2, "\r"], [10, "\r"], [12, "\x1b"], [13, "/quit\r"]], ["拥有者问题", "实际中文 q 回答", "已跳过", "回答已接纳", "已退出 TUI"]);
  assert.deepEqual(getOwnerQuestion(t.runtime.store, second.id)!.answers, [{ text: "" }]);
  process.stdout.write("真实 Python PTY / Runtime / ControlServer：多选切换保留光标、推荐与说明、升序答案、自由输入切换及 Skip 空答案通过；模型使用 mock。\n");
} finally { await t.shutdown(); }
