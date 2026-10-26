import assert from "node:assert/strict";
import { test } from "node:test";
import type { Driver } from "@ruukoto/agent/driver.ts";
import { startMockMcp } from "./helpers/mock-mcp.ts";
import { createProjectSession, startTestRuntime, waitFor } from "./helpers/testkit.ts";

test("工具搜索：真实请求按命中激活、跨任务保留发现与Plan过滤", async t => {
  const mcp = await startMockMcp({ tools: [{ name: "get_me", description: "查询用户" }, { name: "get_other", description: "其他资料" }, { name: "put", description: "写入资料" }] });
  t.after(() => mcp.close());
  let phase = 0, driver: Driver;
  const runtime = await startTestRuntime("tool-search", async req => {
    const names = (req.tools ?? []).map(tool => (tool.function as { name: string }).name);
    if (phase === 0) {
      assert.ok(names.includes("tool_search"));
      assert.ok(!names.some(name => name.startsWith("mcp_")), "新任务初轮不泄漏延迟工具定义");

    }
    switch (phase++) {
      case 0: return { kind: "tool_calls", calls: [{ id: "discover", name: "tool_search", arguments: { query: "get_me", limit: 1 } }] };
      case 1:
        assert.ok(names.includes("mcp__mock__get_me"));
        assert.ok(!names.includes("mcp__mock__get_other"));
        return { kind: "tool_calls", calls: [{ id: "invoke", name: "mcp__mock__get_me", arguments: {} }] };
      case 2: return { kind: "tool_calls", calls: [{ id: "empty", name: "tool_search", arguments: { query: "not-a-tool" } }] };
      case 3: return { kind: "text", text: "首轮完成" };
      case 4: return { kind: "tool_calls", calls: [{ id: "discover-plan", name: "tool_search", arguments: { query: "mock", limit: 20 } }] };
      case 5:
        assert.ok(names.includes("mcp__mock__get_me") && names.includes("mcp__mock__get_other"));
        assert.ok(!names.includes("mcp__mock__put"), "搜索不能恢复Plan禁止的工具");
        return { kind: "text", text: "计划完成" };
      default: throw new Error("unexpected model request");
    }
  });
  t.after(() => runtime.shutdown());
  const { sessionId } = await createProjectSession(runtime.client, runtime.work[0]);
  await runtime.client.request("mcp_configure", { name: "mock", endpoint: mcp.url, tool_allowlist: ["get_me", "get_other", { name: "put", effect: "write" }] });
  driver = await Reflect.get(runtime.runtime, "getDriver").call(runtime.runtime, runtime.runtime.store.getSession(sessionId));
  const submit = async (planMode: boolean) => {
    const task = await runtime.runtime.submit({ sessionId, requestId: planMode ? "plan" : "owner", input: "查询资料", modelSelection: runtime.runtime.defaultSelection, accessMode: planMode ? "plan" : "confirm" });
    await waitFor("搜索任务完成", () => ["completed", "failed", "interrupted"].includes(runtime.runtime.store.getTask(task.id)!.status));
    await driver.taskCompletion();
    const finished = runtime.runtime.store.getTask(task.id)!;
    assert.equal(finished.status, "completed", finished.errorMessage ?? finished.interruptReason ?? "");
    return task;
  };
  const first = await submit(false);
  const records = runtime.runtime.store.listSelectionRecordsByTask(first.id);
  const snapshots = records.slice(0, 2).map(record => JSON.parse(runtime.runtime.artifacts.read(record.promptArtifactId!, 0, 1024 * 1024).toString()));
  assert.ok(!JSON.stringify(snapshots[0].tools).includes("mcp__mock__get_me"));
  assert.ok(JSON.stringify(snapshots[1].tools).includes("mcp__mock__get_me"));
  assert.ok(records[1].estimates.toolSchemas > records[0].estimates.toolSchemas);
  t.diagnostic(JSON.stringify(records.slice(0, 2).map(record => ({ toolSchemas: record.estimates.toolSchemas, systemPrompt: record.estimates.systemPrompt }))));
  const ops = runtime.runtime.store.listToolOpsByTask(first.id);
  assert.ok(!ops.some(op => op.toolName === "mcp__mock__get_other"));
  assert.deepEqual(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").map(hit => hit.toolName), ["get_me"]);
  await submit(true);
});
