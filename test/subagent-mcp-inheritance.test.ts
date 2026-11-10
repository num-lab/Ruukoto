import assert from "node:assert/strict";
import { test } from "node:test";
import { startMockMcp, withMcpDiscovery } from "./helpers/mock-mcp.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

// Ordinary SubAgents inherit instance MCP through their frozen source authority.
test("Coding delegation retains MCP discovery and actual read calls", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "get_pr", result: { structuredContent: { number: 7 } } }] });
  const fixture = await startTestRuntime("subagent-mcp-inheritance", withMcpDiscovery(async request => {
    const input = lastUserText(request);
    if (input.includes("[SubAgent 委派")) {
      return afterTool(request) ? { kind: "text", text: "SUB-MCP complete" }
        : { kind: "tool_calls", calls: [{ id: "child-pr", name: "mcp__github__get_pr", arguments: {} }] };
    }
    if (afterTool(request)) return { kind: "text", text: "Delegated" };
    return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { request: "Inspect the pull request using MCP", key: "inspect" } }] };
  }), { config: realTools() });
  try {
    fixture.runtime.mcpConfigure({ name: "github", endpoint: mcp.url, toolAllowlist: ["get_pr"] });
    const session = await fixture.runtime.createSession({ projectName: "mcp-parent", cwd: fixture.work[0] });
    await fixture.runtime.submit({ sessionId: session.id, requestId: "delegate", input: "Inspect the pull request", modelSelection: fixture.runtime.defaultSelection, accessMode: "full_access" });
    await waitFor("SubAgent completes MCP work", () => {
      const works = fixture.runtime.store.listWorkDelegationsBySession(session.id);
      return works.length === 1 && fixture.runtime.store.listTasksByWork(works[0].id).some(task => task.status === "completed" && task.resultSummary !== null);
    });
    const childRequests = fixture.server.calls.filter(request => lastUserText(request).includes("[SubAgent 委派"));
    assert.ok(childRequests.length > 0);
    assert.ok(childRequests.some(request => toolNamesOf(request).includes("tool_search")));
    assert.ok(childRequests.some(request => toolNamesOf(request).includes("bash")));
    assert.deepEqual(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").map(hit => hit.toolName), ["get_pr"]);
  } finally { await fixture.shutdown(); await mcp.close(); }
});
