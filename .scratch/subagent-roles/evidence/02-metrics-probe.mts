import * as fs from "node:fs";
const root = process.argv[2];
const label = process.argv[3];
const { startTestRuntime, realTools, waitFor, toolNamesOf } = await import(`${root}/test/helpers/testkit.ts`);
const { requireWorkflowRun, listWorkflowExecutions } = await import(`${root}/packages/core/src/workflow.ts`);
const { randomId } = await import(`${root}/packages/core/src/types.ts`);
for (const productName of ["ruukoto", "ruukoto-code"]) {
  const { product } = await import(`${root}/apps/${productName}/src/product.ts`);
  const kit = await startTestRuntime("source-metrics", () => ({ kind: "text", text: "量化完成" }), { config: { ...realTools(), product: product.runtime } });
  try {
    const rt = kit.runtime;
    const session = await rt.createSession({ projectName: "metrics", cwd: kit.work[0] });
    const parent = rt.store.withTx(() => {
      rt.store.setSessionQueueState(session.id, "paused", "metrics-source");
      const id = randomId("source");
      const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: id, input: "量化来源能力", modelSelection: rt.defaultSelection,
        submissionDigest: id, accessMode: "full_access" }).task;
      rt.store.transitionTask(task.id, ["queued"], "running");
      return rt.store.getTask(task.id);
    });
    const ordinary = await rt.subagents.delegate({ parentTaskId: parent.id, request: "量化来源能力", key: "ordinary", readPaths: ["."], paramsDigest: "ordinary" });
    await waitFor("普通量化完成", () => ["completed", "failed", "interrupted"].includes(rt.store.getTask(ordinary.task.id).status));
    const task = rt.store.getTask(ordinary.task.id);
    if (task.status !== "completed") throw new Error(`ordinary ${task.status}: ${task.errorMessage ?? task.interruptReason}`);
    const ordinaryRecord = rt.store.listSelectionRecordsByTask(task.id)[0];
    const ordinaryNames = toolNamesOf(kit.server.calls[0]);
    process.stdout.write(JSON.stringify({ label, product: productName, entrance: "ordinary", role: "general", accessMode: "full_access", readPaths: ["."],
      systemPrompt: ordinaryRecord.estimates.systemPrompt, toolSchemas: ordinaryRecord.estimates.toolSchemas, tools: ordinaryNames }) + "\n");
    const oldCalls = kit.server.calls.length;
    const run = rt.workflows.start({ sourceTaskId: parent.id, requestKey: "workflow", input: null, script: 'return await agent("probe",{request:"量化来源能力"});' });
    await waitFor("工作流量化完成", () => ["succeeded", "failed", "paused", "partial", "canceled"].includes(requireWorkflowRun(rt.store, run.id).status));
    const finished = requireWorkflowRun(rt.store, run.id);
    if (finished.status !== "succeeded") throw new Error(`workflow ${finished.status}: ${finished.reason}`);
    const childId = listWorkflowExecutions(rt.store, run.id).find(execution => execution.kind === "agent").taskId;
    const record = rt.store.listSelectionRecordsByTask(childId)[0];
    process.stdout.write(JSON.stringify({ label, product: productName, entrance: "workflow", role: "general", accessMode: "full_access",
      systemPrompt: record.estimates.systemPrompt, toolSchemas: record.estimates.toolSchemas, tools: toolNamesOf(kit.server.calls[oldCalls]) }) + "\n");
    rt.store.endTask(parent.id, ["running"], "completed");
  } finally { await kit.shutdown(); }
}
