import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { parsePersonalQuestionWrite, personalControl, type PersonalQuestionWrite } from "./personal-control.ts";
import { PERSONAL_QUESTION_PENDING_FILE } from "./personal-profile.ts";
import { PersonalError } from "./personal-error.ts";
import { personalQuestionState, questionOptionLabel } from "./personal-question-controls.ts";
import type { PersonalOwnerAnswer, PersonalQuestion, PersonalQuestionReceipt, personalQuestionList } from "./personal-questions.ts";

type Pending = { operation: "answer" | "cancel"; input: PersonalQuestionWrite };
const pendingName = (requestId: string) => `pending-question-${requestId}.json`;
function pendingQuestions(directory: string): Pending[] {
  return fs.readdirSync(directory).filter(name => PERSONAL_QUESTION_PENDING_FILE.test(name)).sort().map(name => {
    const filename = path.join(directory, name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new PersonalError("question_pending_invalid", "原问题待核实文件无法核实，请保留档案；未重复提交。");
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(filename, "utf8")); } catch (error) { throw new PersonalError("question_pending_invalid", "原问题请求无法读取，请保留文件；未重复提交。", { cause: error }); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("operation" in raw) || !["answer", "cancel"].includes(String(raw.operation)) || !("input" in raw)) throw new PersonalError("question_pending_invalid", "原问题请求格式不符，请保留文件；未重复提交。");
    const input = parsePersonalQuestionWrite(raw.input, raw.operation === "answer");
    if (name !== pendingName(input.requestId)) throw new PersonalError("question_pending_invalid", "原问题请求与文件不符，请保留文件；未重复提交。");
    return { operation: raw.operation as Pending["operation"], input };
  });
}
async function receipt(directory: string, pending: Pending) {
  const result = await personalControl<PersonalQuestionReceipt | null>(directory, "GET", `/question/receipt?requestId=${encodeURIComponent(pending.input.requestId)}`);
  if (result) {
    if (result.operation !== pending.operation || result.question !== pending.input.question || result.version !== pending.input.version || !isDeepStrictEqual(result.answers, pending.input.answers) || result.actor.kind !== "local") throw new PersonalError("question_request_conflict", "原问题回执与保存请求不同，请保留文件并检查档案；未重复提交。");
    fs.unlinkSync(path.join(directory, pendingName(pending.input.requestId)));
  }
  return result;
}
async function send(directory: string, pending: Pending) {
  await personalControl(directory, "POST", `/question/${pending.operation}`, pending.input);
  if (!await receipt(directory, pending)) throw new PersonalError("question_reply_unverified", "后台回执尚未核实，原请求已保留；请从问题菜单核实，不要重新回答。");
}
export async function recoverPersonalQuestions(io: PersonalCliIO, directory: string) {
  for (const pending of pendingQuestions(directory)) {
    if (await receipt(directory, pending)) { io.write("原问题请求已接纳，已找回原回执。\n"); continue; }
    const selected = await choose(io, "原问题请求尚未查到接纳回执", ["保留请求，返回", "按原请求核实并重送", "放弃尚未接纳的请求"]);
    if (selected === 0) return false;
    if (selected === 2) fs.unlinkSync(path.join(directory, pendingName(pending.input.requestId)));
    else await send(directory, pending);
  }
  return true;
}
async function answerQuestion(io: PersonalCliIO, value: PersonalQuestion): Promise<PersonalOwnerAnswer[] | undefined> {
  const answers: PersonalOwnerAnswer[] = [];
  for (const question of value.questions) {
    io.write(`\n${answers.length + 1}/${value.questions.length} ${question.question}\n`);
    const selectedOptions: number[] = [];
    while (true) {
      const labels = question.options?.map((option, index) => `${question.multiple ? `${selectedOptions.includes(index) ? "☑" : "☐"} ` : ""}${questionOptionLabel(option)}${typeof option === "object" && option.recommended ? "（推荐）" : ""}${typeof option === "object" && option.description ? `：${option.description}` : ""}`) ?? [];
      const actions = [...labels, ...(question.multiple ? ["完成选择"] : []), "自由输入", "跳过", "全部跳过", "返回问题列表"];
      const choice = await choose(io, "本题回答", actions), action = actions[choice];
      if (choice < labels.length) {
        if (question.multiple) { if (selectedOptions.includes(choice)) selectedOptions.splice(selectedOptions.indexOf(choice), 1); else { selectedOptions.push(choice); selectedOptions.sort((a, b) => a - b); } continue; }
        answers.push({ text: questionOptionLabel(question.options![choice]), option: choice }); break;
      }
      if (action === "完成选择") { if (!selectedOptions.length) { io.write("请至少选择一项，或选择跳过。\n"); continue; } answers.push({ text: selectedOptions.map(index => questionOptionLabel(question.options![index])).join("\n"), options: [...selectedOptions] }); break; }
      if (action === "自由输入") { const text = await io.question("答案（最多4096字符；/back 返回本题）："); if (text === "/back") continue; if (!text.trim() || text.length > 4096) { io.write("请输入最多4096字符的非空答案，或选择跳过。\n"); continue; } answers.push({ text }); break; }
      if (action === "跳过") { answers.push({ text: "" }); break; }
      if (action === "全部跳过") return value.questions.map(() => ({ text: "" }));
      return;
    }
  }
  return answers;
}
export async function managePersonalQuestions(io: PersonalCliIO, directory: string) {
  if (!await recoverPersonalQuestions(io, directory)) return;
  let offset = 0;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<typeof personalQuestionList>>>(directory, "GET", `/questions?offset=${offset}`);
    const options = [...page.items.map(item => `${({ pending: "待回答", answered: "已回答", canceled: "已取消", stale: "已失效" })[item.status]}：${item.question}`), ...(page.nextOffset === undefined ? [] : ["下一页问题"]), "核实上次回答或取消", "返回"];
    const choice = await choose(io, "问题与回答", options);
    if (choice === options.length - 1) return;
    if (choice === options.length - 2) { if (!await recoverPersonalQuestions(io, directory)) return; continue; }
    if (choice === page.items.length) { offset = page.nextOffset!; continue; }
    const value = await personalControl<PersonalQuestion>(directory, "GET", `/question?question=${encodeURIComponent(page.items[choice].id)}`);
    io.write(`${personalQuestionState(value)}\n${value.questions.map((question, index) => `${index + 1}. ${question.question}${value.answer ? `\n${value.answer.answers[index].text || "（跳过）"}` : ""}`).join("\n\n")}\n`);
    if (value.status !== "pending") continue;
    const actions = [...(!value.origin.telegram ? ["逐题回答"] : []), "取消问题", "返回"];
    const action = actions[await choose(io, value.origin.telegram ? "问题须回原私聊回答；本机可取消" : "原问题", actions)];
    if (action === "返回") continue;
    const answers = action === "逐题回答" ? await answerQuestion(io, value) : undefined;
    if (action === "逐题回答" && !answers) continue;
    if (answers) io.write(value.questions.map((question, index) => `${index + 1}. ${question.question}\n${answers[index].text || "（跳过）"}`).join("\n\n") + "\n业务回答不批准操作。\n");
    if (await choose(io, answers ? "核对全部答案" : "取消原问题", ["返回", answers ? "确认回答" : "确认取消"]) === 0) continue;
    const pending: Pending = { operation: answers ? "answer" : "cancel", input: { question: value.id, version: value.version, requestId: randomUUID(), ...(answers ? { answers } : {}) } };
    await personalControl(directory, "GET", "/status");
    fs.writeFileSync(path.join(directory, pendingName(pending.input.requestId)), JSON.stringify(pending) + "\n", { flag: "wx", mode: 0o600 });
    await send(directory, pending);
    io.write(answers ? "全部答案已接纳，后台正在续接；普通聊天可继续。\n" : "原问题已取消。\n"); offset = 0;
  }
}
