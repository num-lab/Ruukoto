import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ModelOption } from "@ruukoto/agent/model-selection.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { listAgentReports } from "@ruukoto/core/agent-wait.ts";
import { requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { waitFor } from "./helpers/testkit.ts";

interface AcceptanceModels {
  providers: Record<string, { models: Array<{ id: string }>; [key: string]: unknown }>;
}

test("Coding real model: one Task waits, answers two batches and receives guidance cancellation", {
  skip: process.env.RUN_MODEL_CHECK !== "1" ? "真实模型仅在 RUN_MODEL_CHECK=1 时运行" : false,
  timeout: 360_000,
}, async () => {
  const file = process.env.RUN_OWNER_QUESTION_MODELS_FILE;
  assert.ok(file && path.isAbsolute(file), "须显式指定 RUN_OWNER_QUESTION_MODELS_FILE 绝对路径，不能使用默认凭据目录");
  let raw: AcceptanceModels;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) as AcceptanceModels; }
  catch {
    // 配置解析异常可能含凭据正文，只报告显式配置失败。
    throw new Error("显式模型配置无法读取或解析，请核对 RUN_OWNER_QUESTION_MODELS_FILE 的 JSON 内容");
  }
  const selected = Object.entries(raw.providers).flatMap(([provider, value]) => value.models
    .filter(model => model.id.toLowerCase().includes("deepseek")).map(model => ({ provider, model, value })))[0];
  assert.ok(selected, "显式配置须含可独立调用的 DeepSeek 模型");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-owner-question-model-"));
  const agentDir = path.join(root, "agent"), workspace = path.join(root, "work");
  fs.mkdirSync(agentDir); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [selected.provider]: { ...selected.value, models: [selected.model] } } }), { mode: 0o600 });
  const options = ["集中目录", "按模块分目录"];
  const questions = [
    { question: "哪些目录布局可接受？", options: [{ label: options[0], description: "文件放在共同目录", recommended: true }, { label: options[1], description: "文件跟随各自模块" }], multiple: true },
    { question: "可选备注。" },
    { question: "请给出验收口令。" },
  ];
  const answerMarker = `OWNER_ANSWER_${randomBytes(8).toString("hex")}`;
  const reportMarker = `REPORT_${randomBytes(8).toString("hex")}`;
  let rt: Runtime | null = null, passed = false;
  try {
    rt = await Runtime.start({ product: product.runtime, agentDir, dataDir: path.join(root, "data"), socketPath: path.join(root, "c.sock"),
      modelProvider: selected.provider, modelId: selected.model.id, thinkingLevel: "off", qqDisabled: true });
    let option: ModelOption | undefined;
    for (let offset = 0; ;) {
      const page = await rt.models.current.modelCatalog.list({ provider: selected.provider, offset });
      option = page.models.find(model => model.modelId === selected.model.id);
      if (option || page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    assert.ok(option?.available && option.thinkingLevels.length, "显式模型配置缺少可用认证或思考模式，不能记作验收通过");
    const selection = { ...rt.defaultSelection, thinkingLevel: option.thinkingLevels.includes("off") ? "off" as const : option.thinkingLevels[0] };
    const session = await rt.createSession({ projectName: "real-owner-questions", cwd: workspace });
    await rt.setSessionDefaultMode({ sessionId: session.id, expectedVersion: session.defaultAccessModeVersion, mode: "full_access" });
    const secondQuestions = [{ question: "请再次确认验收口令。" }];
    const source = await rt.submit({ sessionId: session.id, requestId: "ask", modelSelection: selection,
      input: `先调用 ask_user，questions 参数原样使用 ${JSON.stringify(questions)}，等待实际回答。收到回答后再调用一次 ask_user，questions 原样使用 ${JSON.stringify(secondQuestions)}。收到第二批回答后，最终回复两批中有内容的实际答案原文，空回答保持跳过。若等待期间收到后台报告，最终回复还须原样包含报告中的验收口令。不调用其他工具。` });
    const runtime = rt;
    const pendingQuestion = (taskId: string) => {
      const current = runtime.store.getTask(taskId)!;
      assert.ok(["queued", "running", "awaiting_confirmation"].includes(current.status), `Question task ended: ${current.status} ${current.errorMessage ?? current.interruptReason ?? ""}`);
      return runtime.listOwnerQuestions(session.id).questions.filter(question => question.taskId === taskId && question.status === "pending");
    };
    await waitFor("first real question", () => pendingQuestion(source.id).length > 0, 100_000);
    const question = rt.listOwnerQuestions(session.id).questions.find(question => question.taskId === source.id && question.status === "pending")!;
    assert.equal(rt.store.getTask(source.id)!.status, "running");
    assert.deepEqual(question.questions, questions);
    assert.ok(rt.store.listAllOccupancy().some(occupancy => occupancy.taskId === source.id), "The waiting Task retains its execution resources");
    const beforeAnswerRequests = rt.store.listSelectionRecordsByTask(source.id).length;
    const reportRun = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "report-during-question", input: null,
      script: `await progress("done", {text:${JSON.stringify(reportMarker)}}); return {acceptance:${JSON.stringify(reportMarker)}};` });
    await waitFor("report persists while original question waits", () => requireWorkflowRun(runtime.store, reportRun.id).delivery?.taskId != null);
    assert.equal(rt.listOwnerQuestions(session.id).questions.find(item => item.id === question.id)!.status, "pending");
    assert.equal(rt.store.listSelectionRecordsByTask(source.id).length, beforeAnswerRequests);
    assert.equal(listAgentReports(rt.store).find(report => report.target.kind === "workflow" && report.target.runId === reportRun.id)!.consumption, null);
    const chat = await rt.submit({ sessionId: session.id, requestId: "ordinary-chat", modelSelection: selection,
      input: "只回复 OWNER_CHAT_OK，不调用工具。" });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(rt.store.getTask(chat.id)!.status, "queued");
    assert.equal(rt.store.listSelectionRecordsByTask(source.id).length, beforeAnswerRequests, "Ordinary submission does not wake an answer wait");
    const answers = [{ text: options.join("\n"), options: [0, 1] }, { text: "" }, { text: answerMarker }];
    const answerInput = { sessionId: session.id, questionId: question.id, version: question.version, requestId: "answer", answers };
    const receipt = await rt.answerOwnerQuestion(answerInput), replay = await rt.answerOwnerQuestion(answerInput);
    assert.deepEqual(replay, receipt);
    assert.equal(receipt.taskId, source.id);
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => rt!.getTaskDetail(task.id)!.task.inputPurpose === "user").length, 2, "Answer acceptance creates no user Task");
    await waitFor("second real question in the original Task", () => pendingQuestion(source.id).some(item => item.id !== question.id), 100_000);
    const second = rt.listOwnerQuestions(session.id).questions.find(item => item.id !== question.id && item.taskId === source.id && item.status === "pending")!;
    assert.deepEqual(second.questions, secondQuestions);
    const secondMarker = `SECOND_${answerMarker}`;
    const secondReceipt = await rt.answerOwnerQuestion({ sessionId: session.id, questionId: second.id, version: second.version,
      requestId: "answer-two", answers: [{ text: secondMarker }] });
    assert.equal(secondReceipt.taskId, source.id);
    await waitFor("real answered Task completion", () => ["completed", "failed", "canceled", "interrupted"].includes(runtime.store.getTask(source.id)!.status), 100_000);
    assert.equal(rt.store.getTask(source.id)!.status, "completed");
    const reply = rt.readTaskReply(source.id)!.text;
    assert.ok(reply.includes(answerMarker) && reply.includes(secondMarker) && reply.includes(reportMarker), "The real model must read both actual tool answers and the pending report");
    await waitFor("same Task completes background report", () => requireWorkflowRun(runtime.store, reportRun.id).delivery?.status === "reported");
    assert.equal(listAgentReports(rt.store).find(report => report.target.kind === "workflow" && report.target.runId === reportRun.id)!.consumption?.taskId, source.id);
    assert.equal(rt.store.listToolOpsByTask(source.id).filter(op => op.toolName === "ask_user").length, 2);
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => ["answer", "answer-two"].includes(task.requestId)).length, 0);
    assert.equal(rt.findOwnerQuestionReceipt(session.id, "answer", "owner_question_answer").receipt?.taskId, source.id);
    await waitFor("queued ordinary chat completion", () => ["completed", "failed", "canceled", "interrupted"].includes(runtime.store.getTask(chat.id)!.status), 100_000);
    assert.equal(rt.store.getTask(chat.id)!.status, "completed");
    assert.match(rt.readTaskReply(chat.id)!.text, /OWNER_CHAT_OK/);

    const guided = await rt.submit({ sessionId: session.id, requestId: "ask-guidance", modelSelection: selection,
      input: `调用 ask_user，questions 原样使用 ${JSON.stringify(secondQuestions)}，等待回答或取消；随后遵循最新引导，不调用其他工具。` });
    await waitFor("real question before guidance", () => pendingQuestion(guided.id).length > 0, 100_000);
    const canceledId = rt.listOwnerQuestions(session.id).questions.find(item => item.taskId === guided.id && item.status === "pending")!.id;
    const guidanceMarker = `GUIDANCE_${answerMarker}`;
    await rt.submit({ sessionId: session.id, requestId: "cancel-by-guidance", modelSelection: selection, guidance: true,
      input: `取消刚才的问题。现在只回复 ${guidanceMarker}，不调用其他工具。` });
    await waitFor("real guidance cancellation completion", () => ["completed", "failed", "canceled", "interrupted"].includes(runtime.store.getTask(guided.id)!.status), 100_000);
    assert.equal(rt.store.getTask(guided.id)!.status, "completed");
    assert.equal(rt.listOwnerQuestions(session.id).questions.find(item => item.id === canceledId)?.status, "canceled");
    assert.match(rt.readTaskReply(guided.id)!.text, new RegExp(guidanceMarker));

    const current = rt.store.getSession(session.id)!;
    assert.ok(current.sessionFile);
    const history = fs.readFileSync(current.sessionFile, "utf8");
    const snapshots = [source.id, guided.id].flatMap(taskId => rt!.store.listSelectionRecordsByTask(taskId).filter(record => record.promptArtifactId).map(record => {
      const artifact = rt!.store.getArtifact(record.promptArtifactId!)!;
      return rt!.artifacts.read(artifact.id, 0, artifact.byteCount).toString("utf8");
    }));
    assert.ok([answerMarker, secondMarker, guidanceMarker].every(text => history.includes(text)));
    assert.ok(snapshots.some(snapshot => snapshot.includes(answerMarker) && snapshot.includes(secondMarker) && snapshot.includes(reportMarker)));
    assert.ok(snapshots.some(snapshot => snapshot.includes(guidanceMarker) && snapshot.includes('canceled')));
    assert.equal(rt.store.listAllOccupancy().length, 0);
    process.stderr.write(`[ruukoto:owner-question-model-evidence] ${JSON.stringify({ provider: selected.provider, model: selected.model.id,
      originalTask: source.id, guidanceTask: guided.id, answerReceipts: [receipt, secondReceipt],
      snapshots: snapshots.map(snapshot => createHash("sha256").update(snapshot).digest("hex")),
      requests: [source.id, guided.id].flatMap(taskId => rt!.store.listSelectionRecordsByTask(taskId).map(record => ({ taskId, callIndex: record.callIndex, estimates: record.estimates }))) })}\n`);
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-issue30-after-model-evidence-"));
    fs.writeFileSync(path.join(evidenceDir, "session.jsonl"), history);
    for (const [index, snapshot] of snapshots.entries()) fs.writeFileSync(path.join(evidenceDir, `request-${index + 1}.json`), snapshot);
    fs.writeFileSync(path.join(evidenceDir, "requests.json"), JSON.stringify(rt.store.listTasksBySession(session.id).flatMap(task =>
      rt!.store.listSelectionRecordsByTask(task.id).map(record => ({ taskId: task.id, callIndex: record.callIndex, estimates: record.estimates }))), null, 2) + "\n");
    process.stderr.write(`[ruukoto:owner-question-model-artifacts] ${evidenceDir}\n`);
    passed = true;
  } finally {
    let stopped = false;
    try { if (rt) await rt.stop("owner_question_model_end"); stopped = true; }
    finally {
      if (passed && stopped) fs.rmSync(root, { recursive: true, force: true });
      else process.stderr.write(`[ruukoto:owner-question-model] 验收未通过或停止未核实，保留隔离档案 ${root}\n`);
    }
  }
});
