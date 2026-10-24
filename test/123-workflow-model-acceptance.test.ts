import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getWorkflowQuestion, getWorkflowStep, listWorkflowExecutions, listWorkflowRuns, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { AppDataStore } from "@ruukoto/agent/app-data/store.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { waitFor } from "./helpers/testkit.ts";

// Note: 见 .agents/notes/implemented/testing/2026-10-13-workflow-joint-acceptance.md

for (const product of [codeProduct.runtime]) test(`${product.type} 真实模型：通过工具启动命名工作流、人工等待期间聊天、实际工具与唯一最终汇总`, { skip: process.env.RUN_MODEL_CHECK !== "1" }, async () => {
  const file = process.env.RUN_WORKFLOW_MODELS_FILE;
  assert.ok(file, "真实工作流验收必须显式指定 RUN_WORKFLOW_MODELS_FILE");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { providers: Record<string, { models: Array<{ id: string }> }> };
  const selected = Object.entries(raw.providers).flatMap(([provider, value]) => value.models.filter(model => model.id.includes("deepseek")).map(model => ({ provider, model, value })))[0];
  assert.ok(selected, "指定配置没有 DeepSeek 模型");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-workflow-model-")), agentDir = path.join(root, "agent"), workspace = path.join(root, "work");
  fs.mkdirSync(agentDir); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [selected.provider]: { ...selected.value, models: [selected.model] } } }), { mode: 0o600 });
  const coding = product.type === "ruukoto-code";
  fs.writeFileSync(path.join(workspace, "value.txt"), "base\n"); initGitRepo(workspace);
  let rt: Runtime | null = null;
  let passed = false;
  try {
    rt = await Runtime.start({ product, agentDir, dataDir: path.join(root, "data"), socketPath: path.join(root, "c.sock"), modelProvider: selected.provider,
      modelId: selected.model.id, thinkingLevel: "off", qqDisabled: true });
    const session = coding ? await rt.createSession({ projectName: "real-workflow", cwd: workspace }) : rt.store.getSession(rt.store.getAgentRole("main")!.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: session.id, expectedVersion: session.defaultAccessModeVersion, mode: "full_access" });
    const script = coding ? `await ask("hold",{prompt:"继续真实编码验收？",options:["yes"]}); await agent("change",{request:"仅用 write 把 value.txt 写成 changed 加一个换行。不要提交推送。然后回复修改完成。",target:"."}); await agent("verify",{request:'仅用 bash 执行 grep -qx changed value.txt 核实文件。最终仅返回合法 JSON {"passed":true,"reason":"实际检查依据"}；失败时 passed 为 false。不要 Markdown、代码围栏或 JSON 以外的文字。',tools:["bash"],output:{format:"json",schema:{type:"object",properties:{passed:{type:"boolean"},reason:{type:"string"}},required:["passed"],additionalProperties:false}},verify:"change",dependsOn:["change"]}); return await integrate("merge",{steps:["verify"],dependsOn:["verify"],check:"grep -qx changed value.txt"});` :
      'await ask("hold",{prompt:"继续真实个人事务验收？",options:["yes"]}); return await agent("record",{request:"创建 app_data 表 model_workflow，唯一字段 value 类型 text，expected_schema_version=0，然后 app_data_insert 一条记录 {value:DEEPSEEK_WORKFLOW_OK}。只执行这两项并回复完成。",tools:["app_data_define_table","app_data_insert"]});';
    await rt.saveWorkflowDefinition({ name: "real-check", script, expectedDigest: null, requestKey: "save" });
    const source = await rt.submit({ sessionId: session.id, requestId: "start", modelSelection: rt.defaultSelection, input: '请先调用 workflow_instructions，再调用 workflow_start，以 name="real-check",input=null,key="real-check" 启动已保存的后台工作流。返回后立即回复已启动，不轮询，不执行其他工具。' });
    const runtime = rt;
    await waitFor("真实模型发起并进入人工等待", () => {
      const task = runtime.store.getTask(source.id)!;
      assert.ok(!["failed", "canceled", "interrupted"].includes(task.status), JSON.stringify({ status: task.status, error: task.errorMessage }));
      return listWorkflowRuns(runtime.store).length === 1 && requireWorkflowRun(runtime.store, listWorkflowRuns(runtime.store)[0].id).status === "waiting";
    }, 120_000);
    const run = listWorkflowRuns(rt.store)[0];
    await waitFor("真实发起任务结束", () => rt!.store.getTask(source.id)!.status === "completed", 120_000);
    const sourceOps = rt.store.listToolOpsByTask(source.id);
    for (const name of ["workflow_instructions", "workflow_start"]) assert.ok(sourceOps.some(op => op.toolName === name && op.isError === false), name);
    const chat = await rt.submit({ sessionId: session.id, requestId: "chat", modelSelection: rt.defaultSelection, input: "请只回复 CHAT_OK，不调用工具。" });
    await waitFor("人工等待期间真实聊天完成", () => rt!.store.getTask(chat.id)!.status === "completed", 120_000);
    assert.equal(getWorkflowQuestion(rt.store, run.id, "hold")!.status, "pending");
    assert.match(rt.readTaskReply(chat.id)!.text, /CHAT_OK/);
    const question = getWorkflowQuestion(rt.store, run.id, "hold")!;
    rt.answerWorkflowQuestion({ runId: run.id, stepKey: "hold", runVersion: question.runVersion, version: question.version, requestKey: "answer", answer: "yes" });
    await waitFor("真实工作流唯一最终汇总", () => requireWorkflowRun(runtime.store, run.id).delivery?.status === "reported" || requireWorkflowRun(runtime.store, run.id).status === "paused", 180_000);
    const final = requireWorkflowRun(rt.store, run.id);
    assert.equal(final.status, "succeeded", JSON.stringify({ reason: final.reason, steps: rt.getWorkflowDetail(run.id).steps.map(step => ({ ...step, result: getWorkflowStep(rt!.store, run.id, step.key)!.result })) }));
    assert.equal(final.delivery!.status, "reported");
    const summary = rt.readTaskReply(final.delivery!.taskId!)!.text;
    assert.ok(summary.trim(), "真实最终汇总有模型正文");
    assert.equal(final.scriptStopVerified, true);
    assert.ok(listWorkflowExecutions(rt.store, run.id).every(execution => execution.stopVerified === true));
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => task.requestId.startsWith("workflow-final:")).length, 1);
    assert.equal(rt.store.listAllOccupancy().length, 0);
    if (coding) {
      assert.equal(fs.readFileSync(path.join(workspace, "value.txt"), "utf8"), "changed\n");
      assert.equal(getWorkflowStep(rt.store, run.id, "verify")!.verification!.passed, true);
      assert.notEqual(getWorkflowStep(rt.store, run.id, "change")!.frozen!.taskId, getWorkflowStep(rt.store, run.id, "verify")!.verification!.taskId);
      const verifyOps = rt.store.listToolOpsByTask(getWorkflowStep(rt.store, run.id, "verify")!.verification!.taskId);
      assert.ok(verifyOps.some(op => op.toolName === "bash" && op.isError === false && typeof op.params.command === "string" && op.params.command.includes("grep -qx changed value.txt")), "真实验证者实际调用检查命令");
    } else {
      const app = new AppDataStore(path.join(root, "data", "agent-data", "main.db"), { readOnly: true });
      try { assert.deepEqual([...app.scanRows(app.getTable("model_workflow")!, 0, 100)].map(row => row.value), ["DEEPSEEK_WORKFLOW_OK"]); }
      finally { app.close(); }
    }
    process.stdout.write(`[ruukoto:workflow-model] ${product.type} ${selected.provider}/${selected.model.id} run=${run.id} status=${final.status} attempts=${final.attempts}\n`);
    const toolOps = listWorkflowExecutions(rt.store, run.id).flatMap(execution => rt!.store.listToolOpsByTask(execution.taskId)
      .map(op => ({ step: execution.stepKey, taskId: execution.taskId, tool: op.toolName, isError: op.isError, effectUnknown: op.effectUnknown, ...(op.toolName === "bash" ? { command: op.params.command } : {}) })));
    process.stdout.write(JSON.stringify({ product: product.type, runId: run.id, status: final.status, facts: final.delivery!.facts, report: final.delivery!.facts + "\n" + summary, toolOps }, null, 2) + "\n");
    passed = true;
  } finally {
    if (rt) await rt.stop("model_workflow_end");
    if (passed) fs.rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`[ruukoto:workflow-model] 验收失败，保留隔离档案 ${root}\n`);
  }
});
