import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { isAgentReportParked, listAgentReports, listAgentWaits } from "@ruukoto/core/agent-wait.ts";
import { listWorkflowRuns, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { lastToolText, lastUserText, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

test("已排队单目标补报仍受父轮等待闭包约束：拥有者先处理，全部结果终态后原任务唯一汇总", async () => {
  let releaseChild!: () => void;
  const childReady = new Promise<void>(resolve => { releaseChild = resolve; });
  let phase = 0, firstId = "", secondId = "", canonicalId = "", summaryCalls = 0;
  const t = await startTestRuntime("wait-queued-group", async request => {
    const input = lastUserText(request);
    if (input === "父轮") {
      if (phase++ === 0) return { kind: "tool_calls", calls: [{ id: "first", name: "workflow_start", arguments: { title: "后台处理", key: "first", input: null,
        script: 'return await agent("result",{request:"FIRST_CHILD",tools:[]});' } }] };
      if (phase === 2) {
        firstId = (JSON.parse(lastToolText(request)) as { run: { id: string } }).run.id;
        await waitFor("第一项在选择等待前已有原排队补报", () => {
          const run = requireWorkflowRun(t.runtime.store, firstId);
          canonicalId = run.delivery?.taskId ?? "";
          return run.status === "succeeded" && !!canonicalId && t.runtime.store.getTask(canonicalId)?.status === "queued";
        });
        return { kind: "tool_calls", calls: [{ id: "wait-first", name: "wait", arguments: { targets: [{ kind: "workflow", run_id: firstId }] } }] };
      }
      if (phase === 3) return { kind: "tool_calls", calls: [{ id: "second", name: "workflow_start", arguments: { title: "后台处理", key: "second", input: null,
        script: 'return await agent("result",{request:"SECOND_CHILD",tools:[]});' } }] };
      secondId = (JSON.parse(lastToolText(request)) as { run: { id: string } }).run.id;
      return { kind: "tool_calls", calls: [{ id: "wait-second", name: "wait", arguments: { targets: [{ kind: "workflow", run_id: secondId }] } }] };
    }
    if (input.includes("FIRST_CHILD")) return { kind: "text", text: "FIRST_RESULT" };
    if (input.includes("SECOND_CHILD")) { await childReady; return { kind: "text", text: "SECOND_RESULT" }; }
    if (input.startsWith("[工作流最终回报]") || input.startsWith("[后台工作最终回报]")) {
      summaryCalls++; assert.deepEqual(toolNamesOf(request), []);
      assert.equal(requireWorkflowRun(t.runtime.store, secondId).status, "succeeded", "未完成闭包前不得请求补报模型");
      return { kind: "text", text: "唯一组汇总" };
    }
    return { kind: "text", text: "拥有者已处理" };
  }, { config: { product: codeProduct.runtime }, workDirs: 1 });
  try {
    const session = await t.runtime.createSession({ projectName: "queued-group", cwd: t.work[0] });
    const parent = await t.runtime.submit({ sessionId: session.id, requestId: "parent", input: "父轮", modelSelection: t.runtime.defaultSelection });
    await waitFor("父轮已消费第一结果并等待第二项", () => listAgentWaits(t.runtime.store, { taskId: parent.id }).some(wait => wait.phase === "waiting" && wait.targets.some(target => target.kind === "workflow" && target.runId === secondId)));
    const original = t.runtime.store.getTask(canonicalId)!;
    const firstConsumption = listAgentReports(t.runtime.store).find(report => report.target.kind === "workflow" && report.target.runId === firstId)!.consumption;
    assert.equal(firstConsumption?.taskId, parent.id);
    const owner = await t.runtime.submit({ sessionId: session.id, requestId: "owner", input: "新输入", modelSelection: t.runtime.defaultSelection });
    await waitFor("拥有者在未完成组前先结束", () => t.runtime.store.getTask(owner.id)?.status === "completed");
    assert.equal(summaryCalls, 0); assert.equal(t.runtime.store.getTask(canonicalId)?.status, "queued");
    assert.equal(isAgentReportParked(t.runtime.store, canonicalId), true); assert.equal(t.runtime.getTaskDetail(canonicalId)!.task.reportParked, true);
    releaseChild();
    await waitFor("全部结果终态后的唯一组汇总", () => listAgentReports(t.runtime.store).length === 2 && listAgentReports(t.runtime.store).every(report => report.status === "reported"));
    const reports = listAgentReports(t.runtime.store), canonical = t.runtime.store.getTask(canonicalId)!;
    assert.equal(summaryCalls, 1); assert.equal(canonical.status, "completed");
    assert.equal(canonical.requestId, original.requestId); assert.equal(canonical.input, original.input); assert.equal(canonical.submissionDigest, original.submissionDigest);
    assert.equal(requireWorkflowRun(t.runtime.store, firstId).delivery!.taskId, canonicalId);
    assert.equal(reports.every(report => report.fallbackTaskId === canonicalId), true); assert.deepEqual(reports[0].proof, reports[1].proof);
    assert.equal(reports[0].proof!.taskId, canonicalId); assert.ok(reports[0].proof!.entryId);
    assert.deepEqual(reports.find(report => report.target.kind === "workflow" && report.target.runId === firstId)!.consumption, firstConsumption);
    assert.equal(t.runtime.readTaskReply(canonicalId)!.text, "唯一组汇总");
    assert.equal(t.runtime.store.listTasksBySession(session.id).filter(task => t.runtime.getTaskDetail(task.id)!.task.inputPurpose === "internal_report").length, 1);
    const record = fs.readFileSync(t.runtime.store.getSession(session.id)!.sessionFile!, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { customType?: string; data?: { reportKeys: string[]; text: string } });
    const marker = record.find(entry => entry.customType === "ruukoto_agent_report_context")!;
    assert.deepEqual(new Set(marker.data!.reportKeys), new Set(reports.map(report => report.key)));
    for (const run of listWorkflowRuns(t.runtime.store)) assert.ok(marker.data!.text.includes(run.id));
  } finally { releaseChild(); await t.shutdown(); }
});
