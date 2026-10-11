import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { DriverDeps } from "@ruukoto/agent/driver.ts";
import { startMockMcp } from "./helpers/mock-mcp.ts";
import { createProjectSession, lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

test("宿主任务白名单：只读 MCP、调用门与发送校验，下一普通任务恢复同一 SDK 的全部工具", async () => {
  const mcp = await startMockMcp({ tools: [
    { name: "get" },
    { name: "write", annotations: { readOnlyHint: true } },
    { name: "unknown", annotations: { readOnlyHint: true } },
  ] });
  let driver: any;
  let marker = "";
  let gateChecked = false;
  const t = await startTestRuntime("task-tool-policy", async (req) => {
    const lastUser = req.messages.findLastIndex((m) => m.role === "user");
    if (req.messages.slice(lastUser + 1).some((m) => m.role === "tool")) return { kind: "text", text: "完成" };
    if (lastUserText(req) === "restricted-read") {
      // 直接注入越过 SDK 可见工具过滤的调用，执行门仍不得登记意图。
      for (const toolName of ["mock_mark", "mcp_policy_write", "mcp_policy_unknown"]) {
        const blocked = await driver.handleToolCall({ type: "tool_call", toolCallId: toolName, toolName, input: {} });
        assert.equal(blocked?.block, true);
        assert.match(blocked.reason, /任务工具白名单/);
      }
      assert.equal(t.runtime.store.listToolOpsByTask(driver.currentTaskId).length, 0);
      gateChecked = true;
      return { kind: "tool_calls", calls: [{ id: "read", name: "mcp_policy_get", arguments: {} }] };
    }
    return { kind: "tool_calls", calls: [{ id: "mark", name: "mock_mark", arguments: { path: marker, content: "owner" } }] };
  });
  try {
    const { sessionId, projectId } = await createProjectSession(t.client, t.work[0]!);
    const session = t.runtime.store.getSession(sessionId)!;
    marker = path.join(session.cwdReal, "owner-marker");
    await t.client.request("mcp_configure", {
      project_id: projectId,
      name: "policy",
      endpoint: mcp.url,
      tool_allowlist: ["get", { name: "write", effect: "write" }, { name: "unknown", effect: "unknown" }],
    });
    driver = await (t.runtime as any).getDriver(session);
    (driver.deps as DriverDeps).allowTaskTool = (task, name, effect) =>
      !task.requestId.startsWith("restricted-") || name === "mock_delay" || effect === "read";

    const submit = async (requestId: string) => {
      const task = await t.runtime.submit({
        sessionId: session.id, requestId, input: requestId, modelSelection: t.runtime.defaultSelection,
      });
      await waitFor(requestId, () => ["completed", "interrupted", "failed", "canceled"].includes(t.runtime.store.getTask(task.id)!.status));
      await driver.taskCompletion();
      return t.runtime.store.getTask(task.id)!;
    };
    const namesOf = (index: number) => (t.server.calls[index]!.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name).sort();

    const restricted = await submit("restricted-read");
    assert.equal(restricted.status, "completed", restricted.errorMessage ?? restricted.interruptReason ?? "");
    assert.equal(gateChecked, true);
    assert.deepEqual(namesOf(0), ["mcp_policy_get", "mock_delay"]);
    assert.deepEqual(mcp.hits.filter((hit) => hit.rpcMethod === "tools/call").map((hit) => hit.toolName), ["get"]);
    assert.equal(t.runtime.store.listConfirmationsByTask(restricted.id).length, 0);
    const sdk = driver.sdk;

    const ownerCallIndex = t.server.calls.length;
    const owner = await submit("owner-request");
    assert.equal(owner.status, "completed", owner.errorMessage ?? owner.interruptReason ?? "");
    assert.equal(driver.sdk, sdk, "任务限制变化不重建 SDK 会话");
    assert.equal(readFileSync(marker, "utf8"), "owner\n", "普通任务恢复工具执行能力");
    for (const name of ["mock_mark", "history_search", "web_search", "mcp_policy_write", "mcp_policy_unknown"]) {
      assert.ok(namesOf(ownerCallIndex).includes(name), `下一任务恢复 ${name}`);
    }

    // 模拟 SDK 向发送载荷泄漏已注册的写工具，最终发送门须阻止整个请求。
    const setActiveTools = sdk.setActiveToolsByName.bind(sdk);
    sdk.setActiveToolsByName = (names: string[]) => setActiveTools([...names, "mcp_policy_write"]);
    const beforeLeak = t.server.calls.length;
    const leaked = await submit("restricted-leak");
    assert.equal(leaked.status, "interrupted");
    assert.match(leaked.interruptReason!, /^task_tools_forbidden:/);
    assert.equal(t.server.calls.length, beforeLeak, "越权工具定义没有发送给模型");
    assert.equal(t.runtime.store.listToolOpsByTask(leaked.id).length, 0);
    assert.equal(driver.sdk, sdk);
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});
