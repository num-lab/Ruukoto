import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ModelOption } from "@ruukoto/agent/model-selection.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product } from "/Users/eitrous/mirasim-worktrees/ruukoto/lucky-sailing-sparrow/apps/ruukoto-code/src/product.ts";
import { waitFor } from "/Users/eitrous/mirasim-worktrees/ruukoto/lucky-sailing-sparrow/test/helpers/testkit.ts";

interface AcceptanceModels {
  providers: Record<string, { models: Array<{ id: string }>; [key: string]: unknown }>;
}

test("Coding 真实模型：多选、跳题与自由文本保存实际请求及历史证据", {
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
  assert.equal(selected.provider, "magpie");
  assert.equal(selected.model.id, "workbuddy-ai/deepseek-v4.1-flash");
  const evidenceDir = "/Users/eitrous/mirasim-worktrees/ruukoto/lucky-sailing-sparrow/.scratch/agent-tool-completion/evidence/owner-question-choice-model";
  assert.equal(fs.existsSync(evidenceDir), false, "一次性验收证据目录已存在，请先保留原证据并选新目录");
  const credentialValues = new Set<string>();
  const collectCredentials = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (/api.?key|secret|token|password|authorization/i.test(key) && typeof entry === "string" && entry.length >= 8) credentialValues.add(entry);
      else collectCredentials(entry);
    }
  };
  collectCredentials(raw); collectCredentials(process.env);
  const files: { file: string; bytes: number; sha256: string; artifactSha256?: string }[] = [];
  const writeEvidence = (file: string, text: string, artifactSha256?: string): void => {
    assert.match(file, /^(?:(?:source|chat|answer)-prompt-\d+\.json|session\.jsonl|selection-records\.json|tool-ops\.json|tool-schema-estimates\.json|summary\.json|manifest\.json)$/);
    assert.ok(![...credentialValues].some(value => text.includes(value)), "证据命中凭据值，拒绝落盘");
    const data = Buffer.from(text.endsWith("\n") ? text : text + "\n");
    fs.writeFileSync(path.join(evidenceDir, file), data, { mode: 0o600 });
    if (file !== "manifest.json") files.push({ file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), ...(artifactSha256 ? { artifactSha256 } : {}) });
  };
  const jsonEvidence = (file: string, value: unknown): void => writeEvidence(file, JSON.stringify(value, null, 2));
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
  let rt: Runtime | null = null, passed = false;
  try {
    rt = await Runtime.start({ product: product.runtime, agentDir, dataDir: path.join(root, "data"), socketPath: path.join(root, "c.sock"),
      modelProvider: selected.provider, modelId: selected.model.id, thinkingLevel: "off", qqDisabled: true });
    let option: ModelOption | undefined;
    for (let offset = 0; ;) {
      const page = await rt.modelCatalog.list({ provider: selected.provider, offset });
      option = page.models.find(model => model.modelId === selected.model.id);
      if (option || page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    assert.ok(option?.available && option.thinkingLevels.length, "显式模型配置缺少可用认证或思考模式，不能记作验收通过");
    const selection = { ...rt.defaultSelection, thinkingLevel: option.thinkingLevels.includes("off") ? "off" as const : option.thinkingLevels[0] };
    const session = await rt.createSession({ projectName: "real-owner-questions", cwd: workspace });
    await rt.setSessionDefaultMode({ sessionId: session.id, expectedVersion: session.defaultAccessModeVersion, mode: "full_access" });
    const source = await rt.submit({ sessionId: session.id, requestId: "ask", modelSelection: selection,
      input: `请仅调用一次 ask_user，questions 参数原样使用 ${JSON.stringify(questions)}。提交问题后立即结束本轮，不调用其他工具。收到专用问题入口的三题回答后，只回复有内容的实际答案原文，空回答保持跳过，不调用其他工具。` });
    const runtime = rt;
    await waitFor("真实提问任务终态", () => ["completed", "failed", "canceled", "interrupted"].includes(runtime.store.getTask(source.id)!.status), 100_000);
    assert.equal(rt.store.getTask(source.id)!.status, "completed", "真实提问任务未完成，请检查保留的隔离档案");
    const sourceOps = rt.store.listToolOpsByTask(source.id);
    assert.equal(sourceOps.length, 1, "登记问题后须结束本轮，不继续调用业务工具");
    assert.equal(sourceOps[0].toolName, "ask_user");
    assert.equal(sourceOps[0].isError, false);
    const pending = rt.listOwnerQuestions(session.id).questions;
    assert.equal(pending.length, 1);
    const question = pending[0];
    assert.equal(question.status, "pending");
    assert.deepEqual(question.questions, questions, "持久题目和选项须与真实工具输入一致");
    assert.equal(rt.store.listAllOccupancy().length, 0, "待答问题不占工作目录");
    const chat = await rt.submit({ sessionId: session.id, requestId: "ordinary-chat", modelSelection: selection,
      input: "这是一条普通聊天，请只回复 OWNER_CHAT_OK，不调用工具；此前的问题继续等待专用问题入口回答。" });
    await waitFor("待答期间真实普通聊天终态", () => ["completed", "failed", "canceled", "interrupted"].includes(runtime.store.getTask(chat.id)!.status), 100_000);
    assert.equal(rt.store.getTask(chat.id)!.status, "completed");
    assert.match(rt.readTaskReply(chat.id)!.text, /OWNER_CHAT_OK/);
    assert.equal(rt.listOwnerQuestions(session.id).questions[0].status, "pending", "普通消息不得消费问题");
    const answers = [{ text: options.join("\n"), options: [0, 1] }, { text: "" }, { text: answerMarker }];
    const answerInput = { sessionId: session.id, questionId: question.id, version: question.version, requestId: "answer", answers, modelSelection: selection };
    const continued = await rt.answerOwnerQuestion(answerInput);
    const replay = await rt.answerOwnerQuestion(answerInput);
    assert.equal(replay.id, continued.id, "原键重试只能接回原续接任务");
    await waitFor("真实回答续接终态", () => ["completed", "failed", "canceled", "interrupted"].includes(runtime.store.getTask(continued.id)!.status), 100_000);
    assert.equal(rt.store.getTask(continued.id)!.status, "completed");
    const reply = rt.readTaskReply(continued.id)!.text;
    assert.ok(reply.includes(answers[0].text) && reply.includes(answerMarker), "真实模型须看到完整多选与实际自由文本回答");
    const answered = rt.listOwnerQuestions(session.id).questions[0];
    assert.equal(answered.status, "answered");
    assert.deepEqual(answered.answers, answers);
    assert.equal(answered.continuationTaskId, continued.id);
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => task.requestId === "answer").length, 1);
    const receipt = rt.findOwnerQuestionReceipt(session.id, "answer", "owner_question_answer").receipt;
    assert.ok(receipt && receipt.taskId === continued.id && receipt.question.id === question.id, "持久回执须绑定原问题与唯一续接");
    const current = rt.store.getSession(session.id)!;
    assert.ok(current.sessionFile);
    const history = fs.readFileSync(current.sessionFile, "utf8");
    const snapshots = rt.store.listSelectionRecordsByTask(continued.id).filter(record => record.promptArtifactId).map(record => {
      const artifact = rt!.store.getArtifact(record.promptArtifactId!)!;
      return rt!.artifacts.read(artifact.id, 0, artifact.byteCount).toString("utf8");
    });
    const expectedText = [...questions.map(item => item.question), ...options, "文件放在共同目录", "文件跟随各自模块", answerMarker];
    assert.ok(expectedText.every(text => history.includes(text)), "原题与真实答案须能从 SDK JSONL 历史重建");
    assert.ok(snapshots.some(snapshot => expectedText.every(text => snapshot.includes(text))), "实际模型请求快照须包含完整题目、选项和答案");
    assert.ok(rt.store.getTask(continued.id)!.input.includes("可选备注。\n回答：\n\n3."), "跳题在规范化输入中保留空回答");
    assert.equal(rt.store.listAllOccupancy().length, 0);
    process.stderr.write(`[ruukoto:owner-question-model] ${selected.provider}/${selected.model.id} source=${source.id} continuation=${continued.id} receipt=true snapshots=${snapshots.length}\n`);
    fs.mkdirSync(evidenceDir, { mode: 0o700 });
    const requests = [];
    for (const [label, task] of [["source", source], ["chat", chat], ["answer", continued]] as const) {
      const records = rt.store.listSelectionRecordsByTask(task.id);
      requests.push({ label, taskId: task.id, records: records.map(record => ({
        id: record.id, taskId: record.taskId, sessionId: record.sessionId, callIndex: record.callIndex, model: record.model,
        estimates: record.estimates, budget: record.budget, estimatedTotal: record.estimatedTotal, usage: record.usage,
        promptArtifactId: record.promptArtifactId, createdAt: record.createdAt,
      })) });
      for (const record of records) {
        assert.ok(record.promptArtifactId, "实际模型调用缺少请求快照");
        const artifact = rt.store.getArtifact(record.promptArtifactId)!;
        const bytes = rt.artifacts.read(artifact.id, 0, artifact.byteCount);
        const snapshot: Record<string, unknown> = JSON.parse(bytes.toString("utf8"));
        assert.ok(Object.keys(snapshot).every(key => ["v", "capturedAt", "capturePoint", "recordId", "taskId", "sessionId", "callIndex", "model", "thinkingLevel", "reasoning", "maxTokens", "systemPrompt", "messages", "tools"].includes(key)), "快照包含白名单外字段，停止导出");
        writeEvidence(`${label}-prompt-${record.callIndex}.json`, bytes.toString("utf8"), createHash("sha256").update(bytes).digest("hex"));
      }
    }
    writeEvidence("session.jsonl", history);
    jsonEvidence("selection-records.json", requests);
    jsonEvidence("tool-ops.json", ([["source", source], ["chat", chat], ["answer", continued]] as const).map(([label, task]) => ({
      label, taskId: task.id, ops: rt!.store.listToolOpsByTask(task.id).map(op => ({ toolName: op.toolName, params: op.params, isError: op.isError })),
    })));
    jsonEvidence("tool-schema-estimates.json", {
      singleAskUser: { calibration: 1.5, before: { characters: 679, utf8Bytes: 981, estimatedTokens: 417 }, after: { characters: 1136, utf8Bytes: 1648, estimatedTokens: 699 } },
      historicalRequest: { provider: "agentrouter", modelId: "deepseek-v4-flash", toolSchemas: 11463, systemPrompt: 1506,
        source: "../owner-question-model-final/selection-records.json", comparable: false, reason: "历史请求使用不同provider、模型及完整工具集合，只作历史参考，不能当作本轮同口径前后对比。" },
      actualRequests: requests.map(({ label, records }) => ({ label, calls: records.map(({ callIndex, estimates }) => ({ callIndex, toolSchemas: estimates.toolSchemas, systemPrompt: estimates.systemPrompt })) })),
    });
    jsonEvidence("summary.json", { provider: selected.provider, modelId: selected.model.id, sourceTaskId: source.id, chatTaskId: chat.id, answerTaskId: continued.id,
      question: answered, receipt, reply, passed: true, capturePoint: "SDK发送函数委托提供方之前；不等同于HTTP请求体", credentialExactValueScan: "passed" });
    passed = true;
  } finally {
    let stopped = false;
    try { if (rt) await rt.stop("owner_question_model_end"); stopped = true; }
    finally {
      if (passed && stopped) {
        jsonEvidence("manifest.json", { files, credentialExactValueScan: "passed", runtimeStopped: true,
          captureScope: "普通Coding完全访问主会话；真实模型，3题包含选项说明/推荐、多选、空回答跳题及自由文本；普通聊天不消费、原键唯一续接。",
          exportFormat: "只导出白名单证据。prompt JSON仅补末尾换行，artifactSha256为原产物字节摘要；不复制models.json、环境或任何凭据配置。" });
        fs.rmSync(root, { recursive: true, force: true });
        process.stderr.write(`[ruukoto:owner-question-model-evidence] saved=${evidenceDir} files=${files.length} stopped=true\n`);
      }
      else process.stderr.write(`[ruukoto:owner-question-model] 验收未通过或停止未核实，保留隔离档案 ${root}\n`);
    }
  }
});
