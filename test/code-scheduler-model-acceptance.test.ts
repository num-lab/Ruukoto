import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createCodingTools } from "@ruukoto/agent/tool-router.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { getCodeScheduleRun, type CodeScheduleConfig } from "@ruukoto/core/code-scheduler.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";

test("真实模型 Scheduled：提问、固定配置续接与单文件精确审批后整项结束", {
  skip: process.env.RUN_MODEL_CHECK !== "1" ? "真实模型仅在 RUN_MODEL_CHECK=1 时执行" : false,
  timeout: 180_000,
}, async () => {
  const file = process.env.RUN_CODE_SCHEDULER_MODELS_FILE;
  assert.ok(file && path.isAbsolute(file), "须显式指定 RUN_CODE_SCHEDULER_MODELS_FILE，不能读取默认凭据目录");
  const source = fs.readFileSync(file), sourceHash = createHash("sha256").update(source).digest("hex");
  let catalog: { providers: Record<string, { models: { id: string }[] }> };
  try { catalog = JSON.parse(source.toString("utf8")) as typeof catalog; }
  catch { throw new Error("显式模型配置无法解析；请核对 JSON，不输出凭据正文。"); }
  const selected = Object.entries(catalog.providers).flatMap(([provider, config]) => config.models.map(model => ({ provider, modelId: model.id })))[0];
  assert.ok(selected, "显式模型配置须含至少一个模型");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-code-scheduler-model-")));
  const agentDir = path.join(root, "agent"), workspace = path.join(root, "work"), models = path.join(agentDir, "models.json");
  fs.mkdirSync(agentDir, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  const markerFile = path.join(workspace, "scheduled-acceptance.txt"), marker = `CODE_SCHEDULED_MODEL_${randomBytes(8).toString("hex")}`;
  const questions = [{ question: "是否允许写入本次固定验收文件？", options: ["允许写入", "停止"] }];
  const fileParams = { path: markerFile, operation: "write", content: marker, reason: "定时单文件权限验收" };
  const evidence: Record<string, unknown> = { status: "running", platform: process.platform, node: process.version, model: selected, sourceModelsSha256: sourceHash };
  let runtime: Runtime | undefined, failure = "", phase = "startup", clock = Date.now(), answered = false, asked = 0, writes = 0, requests = 0;
  const deadline = Date.now() + 165_000;
  const wait = async (condition: () => boolean) => {
    while (!condition()) {
      if (failure) throw new Error(failure);
      assert.ok(Date.now() < deadline, "真实模型验收超过总时限");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(failure, "", "验收遇到异常工具或参数");
  };
  try {
    fs.writeFileSync(models, source, { mode: 0o600 });
    runtime = await Runtime.start({ product: product.runtime, dataDir: path.join(root, "data"), agentDir, socketPath: path.join(root, "c.sock"),
      modelProvider: selected.provider, modelId: selected.modelId, thinkingLevel: "off", qqDisabled: true,
      scheduler: { now: () => clock, tickMs: 60_000 },
      toolFactory: ({ router }) => createCodingTools(router).filter(tool => tool.name === "request_file_access").map(tool => ({ ...tool,
        execute: (...args: Parameters<typeof tool.execute>) => {
          assert.deepEqual(args[1], fileParams, "只允许固定验收文件、内容和原因");
          assert.ok(answered, "必须先经专用问题入口回答");
          return tool.execute(...args);
        } })),
    });
    const rt = runtime, insertRecord = rt.store.insertSelectionRecord.bind(rt.store);
    rt.store.insertSelectionRecord = record => {
      assert.ok(++requests <= 6, "真实模型验收最多六次请求");
      insertRecord(record);
    };
    rt.addEventListener(events => {
      for (const event of events) {
        const body = event.body;
        if (body.type === "task.tool_intent") {
          const allowed = body.toolName === "ask_user" ? !answered && ++asked === 1 && isDeepStrictEqual(body.params, { questions })
            : body.toolName === "request_file_access" && answered && ++writes === 1 && isDeepStrictEqual(body.params, fileParams);
          if (!allowed) failure = "unexpected_tool_or_parameters";
        } else if (body.type === "task.tool_result" && body.isError) failure = "tool_failed";
        else if (["task.failed", "task.interrupted", "task.canceled"].includes(body.type)) failure = "task_did_not_complete";
        if (failure && event.taskId && ["queued", "running", "awaiting_confirmation"].includes(rt.store.getTask(event.taskId)?.status ?? "")) {
          void rt.cancelTask(event.taskId).catch(() => { failure = "unexpected_tool_stop_unverified"; });
        }
      }
    });
    const listed = await rt.models.current.modelCatalog.list({ provider: selected.provider });
    const option = listed.models.find(model => model.modelId === selected.modelId);
    assert.ok(option?.available && option.thinkingLevels.length, "所选模型须有可用认证和思考档位");
    const selection = { ...rt.defaultSelection, thinkingLevel: option.thinkingLevels.includes("off") ? "off" as const : option.thinkingLevels[0] };
    const opened = await rt.openWorkspace({ cwd: workspace, createRequestId: "model-workspace" });
    const instructions = `这是隔离目录中的定时验收。第一轮仅调用一次 ask_user，questions 原样为 ${JSON.stringify(questions)}，随后结束本轮。收到专用问题入口“允许写入”的回答后，仅调用一次 request_file_access，参数原样为 ${JSON.stringify(fileParams)}，等待这一个文件的拥有者审批；写入成功后回复 CODE_SCHEDULED_MODEL_OK 并结束。其他工具和目录不在本次任务范围。不能按此完成时停止并报告原因，不替换工具或参数。`;
    const config: CodeScheduleConfig = { title: "真实模型 Scheduled 验收", instructions, workspaceId: opened.session.projectId, permission: "confirm", modelSelection: selection,
      rule: { kind: "once", at: new Date(clock + 60_000).toISOString(), timeZone: "Asia/Tokyo", disambiguation: "compatible" } };
    const saved = await rt.saveCodeSchedule({ requestId: "model-plan", config });
    assert.deepEqual(saved.plan.config, config);
    clock += 60_000; phase = "scheduled_question";
    await rt.codeScheduler!.scan();
    const run = rt.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    assert.ok(run && run.sessionId !== opened.session.id, "定时运行必须建立独立会话");
    const session = rt.getSession(run.sessionId);
    assert.equal(session.cwdReal, workspace); assert.equal(session.name, config.title);
    await assert.rejects(rt.submit({ sessionId: run.sessionId, requestId: "must-reject", input: "不能混入的人工输入", modelSelection: selection }), { code: "schedule_session_managed" });
    await wait(() => rt.store.getTask(run.rootTaskId)!.status === "completed" && rt.listOwnerQuestions(run.sessionId).questions.length === 1);
    assert.equal(getCodeScheduleRun(rt.store, run.id)!.closedAt, null);
    assert.equal(fs.existsSync(markerFile), false);
    const question = rt.listOwnerQuestions(run.sessionId).questions[0];
    assert.deepEqual(question.questions, questions);
    answered = true; phase = "answer_and_approval";
    const continuation = await rt.answerOwnerQuestion({ sessionId: run.sessionId, questionId: question.id, version: question.version, requestId: "model-answer", answers: [{ text: "允许写入", option: 0 }], modelSelection: selection });
    await wait(() => rt.store.listConfirmationsByTask(continuation.id).some(confirmation => confirmation.status === "pending"));
    const confirmations = rt.store.listConfirmationsByTask(continuation.id);
    assert.equal(confirmations.length, 1);
    const confirmation = confirmations[0];
    assert.equal(confirmation.toolName, "request_file_access"); assert.deepEqual(confirmation.params, fileParams);
    assert.equal(fs.existsSync(markerFile), false, "批准前不得写入文件");
    assert.equal(continuation.accessMode, "confirm"); assert.deepEqual(continuation.modelSelection, selection);
    assert.equal(continuation.codeScheduleRunId, run.id);
    rt.respondConfirmation(confirmation.id, "approved", confirmation.permissionVersion);
    phase = "terminal_and_history";
    await wait(() => getCodeScheduleRun(rt.store, run.id)!.closedAt !== null);
    assert.equal(getCodeScheduleRun(rt.store, run.id)!.status, "completed");
    assert.equal(fs.readFileSync(markerFile, "utf8"), marker);
    assert.deepEqual(fs.readdirSync(workspace), [path.basename(markerFile)], "只允许固定验收文件");
    const tasks = [rt.store.getTask(run.rootTaskId)!, rt.store.getTask(continuation.id)!];
    for (const task of tasks) {
      assert.equal(task.status, "completed"); assert.equal(task.accessMode, config.permission); assert.deepEqual(task.modelSelection, selection);
    }
    const history = fs.readFileSync(rt.store.getSession(run.sessionId)!.sessionFile!, "utf8");
    assert.ok(history.includes(questions[0].question) && history.includes(marker), "完整题目和写入参数须保存在会话历史");
    const records = tasks.flatMap(task => rt.store.listSelectionRecordsByTask(task.id));
    const snapshots = records.map(record => {
      assert.ok(record.promptArtifactId, "模型输入须有持久快照");
      const artifact = rt.store.getArtifact(record.promptArtifactId)!;
      return rt.artifacts.read(artifact.id, 0, artifact.byteCount);
    });
    assert.ok(snapshots.some(snapshot => snapshot.includes(Buffer.from("允许写入")) && snapshot.includes(Buffer.from(marker))), "真实续接请求须包含回答和固定写入要求");
    assert.equal(rt.store.listAllOccupancy().length, 0);
    evidence.status = "passed"; evidence.effort = selection.thinkingLevel; evidence.permission = config.permission;
    evidence.independentSession = true; evidence.workspaceMatches = true; evidence.activeSubmitRejected = true; evidence.approvalCount = confirmations.length;
    evidence.tools = tasks.flatMap(task => rt.store.listToolOpsByTask(task.id)).map(op => ({ tool: op.toolName, isError: op.isError, effectUnknown: op.effectUnknown }));
    evidence.modelRequests = requests; evidence.promptSha256 = snapshots.map(snapshot => createHash("sha256").update(snapshot).digest("hex"));
    evidence.estimates = records.map(record => record.estimates); evidence.markerSha256 = createHash("sha256").update(marker).digest("hex");
  } catch (error) {
    evidence.status = "failed"; evidence.phase = phase;
    const code = error instanceof RuntimeApiError ? error.code : error instanceof assert.AssertionError ? "assertion_failed" : "model_acceptance_failed";
    evidence.code = code;
    throw new Error(`真实模型 Scheduled 验收失败（${phase}/${code}）；查看脱敏验收记录，不自动重试。`);
  } finally {
    let stopped = false;
    try { await runtime?.stop("code_scheduler_model_end"); stopped = true; }
    catch { evidence.status = "failed"; evidence.code = "stop_unverified"; }
    finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
      evidence.credentialCopyRemoved = !fs.existsSync(models);
      evidence.sourceModelsUnchanged = createHash("sha256").update(fs.readFileSync(file)).digest("hex") === sourceHash;
      const output = process.env.RUN_CODE_SCHEDULER_EVIDENCE_FILE;
      if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
      process.stderr.write(`[ruukoto:code-scheduler-model] ${JSON.stringify(evidence)}\n`);
      assert.equal(evidence.sourceModelsUnchanged, true, "源模型配置必须原样保留");
      if (evidence.status === "passed" && stopped) fs.rmSync(root, { recursive: true, force: true });
    }
    assert.equal(stopped, true, "验收后台必须完成停止核实");
  }
});
