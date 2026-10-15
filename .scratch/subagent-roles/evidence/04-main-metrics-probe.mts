import assert from "node:assert/strict";
import * as fs from "node:fs";
const root = process.argv[2], label = process.argv[3], output = process.argv[4];
const { startTestRuntime, realTools, waitFor, toolNamesOf, afterTool, lastToolText } = await import(`${root}/test/helpers/testkit.ts`);
const { product } = await import(`${root}/apps/ruukoto/src/product.ts`);
const kit = await startTestRuntime("workflow-main-metrics", (request, index) => {
  if (index === 0) return { kind: "tool_calls", calls: [{ id: "instructions", name: "workflow_instructions", arguments: {} }] };
  assert.equal(index, 1);
  assert.equal(afterTool(request), true);
  return { kind: "text", text: "量化完成" };
}, { config: { ...realTools(), product: product.runtime, execution: { backend: "local" } }, workDirs: 0 });
try {
  const rt = kit.runtime, main = rt.store.getAgentRole("main")!;
  assert.ok(main);
  assert.equal(rt.store.getSessionIdentity(main.sessionId)?.kind, "main");
  const task = await rt.submit({ sessionId: main.sessionId, requestId: "main-metrics", input: "读取工作流说明后结束量化。", accessMode: "full_access", modelSelection: rt.defaultSelection });
  await waitFor("main 实际两轮模型输入", () => rt.store.getTask(task.id)?.status === "completed");
  assert.equal(kit.server.calls.length, 2);
  const records = rt.store.listSelectionRecordsByTask(task.id);
  assert.equal(records.length, 2);
  const instructions = lastToolText(kit.server.calls[1]);
  assert.ok(instructions.includes("agent("));
  assert.equal(rt.store.listSubAgents().length, 0);
  assert.deepEqual(rt.store.listToolOpsByTask(task.id).map(op => op.toolName), ["workflow_instructions"]);
  const rows = kit.server.calls.map((call, index) => ({ label, product: "ruukoto", identity: "main", identityKind: rt.store.getSessionIdentity(main.sessionId)?.kind,
    callIndex: records[index].callIndex, systemPrompt: records[index].estimates.systemPrompt, toolSchemas: records[index].estimates.toolSchemas,
    estimates: records[index].estimates, tools: toolNamesOf(call), system: call.system, toolDefinitions: call.tools, messages: call.messages,
    workflowInstructions: index === 1 ? instructions : undefined, taskInput: task.input,
    executedTools: rt.store.listToolOpsByTask(task.id).map(op => ({ name: op.toolName, isError: op.isError })), subAgents: rt.store.listSubAgents().length }));
  fs.writeFileSync(output, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  process.stdout.write(JSON.stringify({ label, identity: "main", calls: rows.map(row => ({ callIndex: row.callIndex, systemPrompt: row.systemPrompt, toolSchemas: row.toolSchemas, tools: row.tools.length })),
    instructionsBytes: Buffer.byteLength(instructions), modeMention: instructions.includes("mode?"), roleTargetVerify: instructions.includes("role/target/verify"), output }) + "\n");
} finally { await kit.shutdown(); }
