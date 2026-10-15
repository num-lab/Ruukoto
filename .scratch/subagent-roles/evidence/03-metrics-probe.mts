import * as fs from "node:fs";
const root = process.argv[2];
const label = process.argv[3];
const { startTestRuntime, realTools, waitFor, toolNamesOf } = await import(`${root}/test/helpers/testkit.ts`);
const { holdParentResponse } = await import(`${root}/test/helpers/active-parent.ts`);
const { initGitRepo } = await import(`${root}/test/helpers/git-fixture.ts`);
for (const name of ["ruukoto", "ruukoto-code"]) {
  const { product } = await import(`${root}/apps/${name}/src/product.ts`);
  const gate = holdParentResponse(() => ({ kind: "text", text: "量化完成" }));
  const kit = await startTestRuntime("snapshot-metrics", gate.responder, { config: { ...realTools(), product: product.runtime, execution: { backend: "native" } } });
  try {
    const rt = kit.runtime;
    fs.writeFileSync(`${kit.work[0]}/value.txt`, "base\n");
    initGitRepo(kit.work[0]);
    fs.writeFileSync(`${kit.work[0]}/value.txt`, "dirty\n");
    const session = await rt.createSession({ projectName: "metrics", cwd: kit.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "开始快照量化", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("父调用量化", () => kit.server.calls.length === 1);
    const child = await rt.subagents.delegate({ parentTaskId: parent.id, request: "核查当前目标", key: "review", role: "reviewer", mode: "modify", target: ".", paramsDigest: "review" });
    await waitFor("子调用量化", () => ["completed", "failed", "interrupted"].includes(rt.store.getTask(child.task.id).status));
    const final = rt.store.getTask(child.task.id);
    if (final.status !== "completed") throw new Error(`review ${final.status}: ${final.errorMessage ?? final.interruptReason}`);
    for (const [identity, task, call] of [["parent", parent, kit.server.calls[0]], ["reviewer", child.task, kit.server.calls[1]]]) {
      const record = rt.store.listSelectionRecordsByTask(task.id)[0];
      process.stdout.write(JSON.stringify({ label, product: name, identity, systemPrompt: record.estimates.systemPrompt, toolSchemas: record.estimates.toolSchemas,
        tools: toolNamesOf(call), system: call.system, toolDefinitions: call.tools,
        taskInput: identity === "reviewer" ? child.task.input : parent.input }) + "\n");
    }
    gate.release();
    await waitFor("父收尾", () => rt.store.getTask(parent.id).status === "completed");
  } finally { gate.release(); await kit.shutdown(); }
}
