import * as fs from "node:fs";
const root = process.argv[2], label = process.argv[3];
const { startTestRuntime, realTools, waitFor, toolNamesOf, lastUserText, lastToolText, afterTool } = await import(`${root}/test/helpers/testkit.ts`);
const { initGitRepo } = await import(`${root}/test/helpers/git-fixture.ts`);
for (const name of ["ruukoto", "ruukoto-code"]) {
  const { product } = await import(`${root}/apps/${name}/src/product.ts`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let instructions = "";
  const kit = await startTestRuntime("workflow-metrics", async request => {
    if (lastUserText(request).startsWith("开始")) {
      if (!afterTool(request)) return { kind: "tool_calls", calls: [{ id: "instructions", name: "workflow_instructions", arguments: {} }] };
      instructions = lastToolText(request);
      await gate;
    }
    return { kind: "text", text: "量化完成" };
  }, { config: { ...realTools(), product: product.runtime, execution: { backend: "native" } } });
  try {
    const rt = kit.runtime;
    fs.writeFileSync(`${kit.work[0]}/value.txt`, "base\n");
    initGitRepo(kit.work[0]);
    fs.writeFileSync(`${kit.work[0]}/value.txt`, "dirty\n");
    const session = await rt.createSession({ projectName: "metrics", cwd: kit.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始工作流接口量化", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("说明进入实际模型请求", () => kit.server.calls.length === 2 && instructions.includes("role/target/verify"));
    const child = await rt.subagents!.delegate({ parentTaskId: parent.id, request: "核查当前目标", key: "review", role: "reviewer", target: ".", paramsDigest: "review" });
    await waitFor("子调用量化", () => ["completed", "failed", "interrupted"].includes(rt.store.getTask(child.task.id)!.status));
    const final = rt.store.getTask(child.task.id)!;
    if (final.status !== "completed") throw new Error(`review ${final.status}: ${final.errorMessage ?? final.interruptReason}`);
    for (const [identity, task, call] of [["parent", parent, kit.server.calls[0]], ["reviewer", child.task, kit.server.calls[2]]] as const) {
      const record = rt.store.listSelectionRecordsByTask(task.id)[0];
      process.stdout.write(JSON.stringify({ label, product: name, identity, systemPrompt: record.estimates.systemPrompt, toolSchemas: record.estimates.toolSchemas,
        tools: toolNamesOf(call), system: call.system, toolDefinitions: call.tools, workflowInstructions: identity === "parent" ? instructions : undefined,
        taskInput: identity === "reviewer" ? child.task.input : parent.input }) + "\n");
    }
    release();
    await waitFor("父收尾", () => rt.store.getTask(parent.id)!.status === "completed");
  } finally { release(); await kit.shutdown(); }
}
