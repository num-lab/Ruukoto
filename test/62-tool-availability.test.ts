import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";
/** Tool availability follows host-bound identities, task restrictions and frozen child authority. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubAgent, ToolCategory } from "@ruukoto/core/types.ts";
import { classifySession, type SessionIdentity } from "@ruukoto/core/session-identity.ts";
import { allowsCategory, executionProfile, subAgentAllows, taskToolSet, type ExecutionProfile, type SessionToolClass } from "@ruukoto/agent/tool-availability.ts";

const agent: SubAgent = { definition: fixtureSubAgentDefinition(), id: "a", parentSessionId: "ps", sessionId: "s", workDir: "/w", activeWorkId: null, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: "" };


test("conversation identity follows child and side-chat bindings; unbound conversations are development", () => {
  assert.deepEqual(classifySession(agent), { kind: "subagent", agent });
  const workflow = { runId: "run", stepKey: "step", sourceSessionId: "parent" };
  assert.deepEqual(classifySession(agent, workflow), { kind: "subagent", agent, workflow });
  assert.deepEqual(classifySession(null, null, "parent"), { kind: "side", parentSessionId: "parent" });
  assert.deepEqual(classifySession(null), { kind: "dev" });
});

test("会话类别 × 工具类别：每个会话类别只开放清单内的类别", () => {
  const categories: ToolCategory[] = ["coding", "host_data", "web_search", "browser", "desktop_browser", "mcp", "skills", "subagent", "workflow", "owner_question", "background_process"];
  const expected: Record<SessionToolClass, ToolCategory[]> = {
    dev: [...categories],
    subagent: [],
    side: [],
  };
  for (const [cls, open] of Object.entries(expected) as Array<[SessionToolClass, ToolCategory[]]>) {
    assert.deepEqual(categories.filter((c) => allowsCategory(cls, c)), open, cls);
  }
});

const REGISTERED = ["read", "list_files", "search_files", "edit", "bash", "todo_write", "history_read", "memory_save", "web_search", "skill", "mcp__svc__get", "mcp__svc__put", "mock_new"];
const EFFECTS: Record<string, "read" | "write"> = { mcp__svc__get: "read", mcp__svc__put: "write" };
const tools = (opts: { plan?: boolean; webSearchEnabled?: boolean; narrow?: (name: string, effect?: string) => boolean }) =>
  taskToolSet({ registered: REGISTERED, plan: opts.plan ?? false, webSearchEnabled: opts.webSearchEnabled ?? true, mcpEffect: (name) => EFFECTS[name], narrow: opts.narrow });

test("本任务允许的工具：无收窄时即装配结果；未装配的工具拒绝原因为本会话不开放", () => {
  const set = tools({});
  assert.deepEqual([...set.allowed], REGISTERED);
  assert.equal(set.reasonFor("unregistered_tool"), "本会话不开放");
});

test("内部对话阶段：等待与后台查询开放，工作目录、技能、MCP 和新工具默认拒绝，原任务收窄仍有效", () => {
  const registered = ["wait", "subagent_result", "workflow_query", "history_read", "read_artifact", "read", "list_files", "search_files", "write", "bash", "skill", "mcp__svc__get", "mock_new", "browser"];
  const input = { registered, resourcePhase: "conversation" as const, plan: false, browserEnabled: true, webSearchEnabled: true, mcpEffect: (name: string) => EFFECTS[name] };
  const set = taskToolSet(input);
  assert.deepEqual([...set.allowed], registered.slice(0, 5));
  for (const name of registered.slice(5)) assert.match(set.reasonFor(name), /执行资源未取得/, name);
  assert.deepEqual([...taskToolSet({ ...input, narrow: () => false }).allowed], [], "无工具汇总身份不会因对话阶段取得等待工具");
  assert.equal(subAgentAllows({ write: false }, "wait"), false);
  assert.equal(subAgentAllows({ write: true }, "wait"), false);
  const workflow = executionProfile({ identity: { kind: "subagent", agent, workflow: { runId: "r", stepKey: "s", sourceSessionId: "parent" } },
    writeTarget: false, planMode: false, workflow: { toolClass: "dev", sourceProjectId: "p", categories: ["workflow", "coding"] } });
  assert.ok(!workflow.workflow!.categories.includes("workflow"), "工作流步骤不会注册等待工具族");
});

test("本任务允许的工具：计划模式只留白名单与只读 MCP，今后新增的工具默认不可用", () => {
  const set = tools({ plan: true });
  assert.deepEqual([...set.allowed], ["read", "list_files", "search_files", "bash", "todo_write", "history_read", "web_search", "skill", "mcp__svc__get"]);
  for (const name of ["edit", "memory_save", "mcp__svc__put", "mock_new"]) assert.equal(set.reasonFor(name), "计划模式不开放", name);
});

test("本任务允许的工具：宿主按任务收窄（GitHub 评审式：read、read_artifact 与只读 MCP），收到 MCP 类别", () => {
  const seen: Array<[string, string | undefined]> = [];
  const set = tools({ narrow: (name, effect) => { seen.push([name, effect]); return name === "read" || effect === "read"; } });
  assert.deepEqual([...set.allowed], ["read", "mcp__svc__get"]);
  assert.equal(set.reasonFor("bash"), "本任务由宿主收窄");
  assert.deepEqual(seen.find(([name]) => name === "mcp__svc__put"), ["mcp__svc__put", "write"], "收窄函数收到 MCP 工具的类别");
});

test("本任务允许的工具：Web Search 停用时拒绝 web_search；多种收窄同时生效按先后给出原因", () => {
  const off = tools({ webSearchEnabled: false });
  assert.ok(!off.allowed.has("web_search"));
  assert.equal(off.reasonFor("web_search"), "Web Search 已停用");
  assert.equal(off.allowed.size, REGISTERED.length - 1);

  const all = tools({ plan: true, webSearchEnabled: false, narrow: (name) => name !== "read" });
  assert.deepEqual([...all.allowed], ["list_files", "search_files", "bash", "todo_write", "history_read", "skill", "mcp__svc__get"]);
  assert.equal(all.reasonFor("edit"), "计划模式不开放");
  assert.equal(all.reasonFor("read"), "本任务由宿主收窄");
  assert.equal(all.reasonFor("web_search"), "Web Search 已停用");
  assert.equal(all.reasonFor("bash"), "", "允许的工具没有拒绝原因");
});

test("execution profiles pin development, child and side-chat tools and Plan eligibility", () => {
  const sub: SessionIdentity = { kind: "subagent", agent };
  const rows: Array<[SessionIdentity, boolean, boolean, Omit<ExecutionProfile, "toolSignature">]> = [
    [{ kind: "dev" }, false, false, { toolClass: "dev", subAgentTools: null, planMcp: true, restricted: false, plan: false }],
    [{ kind: "dev" }, false, true, { toolClass: "dev", subAgentTools: null, planMcp: true, restricted: false, plan: true }],
    [sub, false, true, { toolClass: "subagent", subAgentTools: { write: false }, planMcp: false, restricted: true, plan: false }],
    [sub, true, false, { toolClass: "subagent", subAgentTools: { write: true }, planMcp: false, restricted: true, plan: false }],
    [{ kind: "side", parentSessionId: "parent" }, false, true, { toolClass: "side", subAgentTools: null, planMcp: false, restricted: false, plan: false }],
  ];
  for (const [identity, writeTarget, planMode, expected] of rows) {
    const { toolSignature: _, ...profile } = executionProfile({ identity, writeTarget, planMode });
    assert.deepEqual(profile, expected, JSON.stringify({ identity: identity.kind, writeTarget, planMode }));
  }
});

test("child read and write tool sets have distinct stable SDK signatures", () => {
  const sub: SessionIdentity = { kind: "subagent", agent };
  const p = (writeTarget: boolean) => executionProfile({ identity: sub, writeTarget, planMode: false });
  const read = p(false), write = p(true);
  const names = ["read", "list_files", "search_files", "edit", "write", "bash", "read_artifact", "subagent_message", "mcp__svc__get", "mcp__svc__put"];
  const allowed = (prof: ExecutionProfile) => names.filter((n) => subAgentAllows(prof.subAgentTools!, n));
  assert.deepEqual(allowed(read), ["read", "list_files", "search_files", "read_artifact", "subagent_message"]);
  assert.deepEqual(allowed(write), ["read", "list_files", "search_files", "edit", "write", "bash", "read_artifact", "subagent_message"]);
  assert.equal(new Set([read, write, p(false)].map((x) => x.toolSignature)).size, 2);
  assert.notEqual(executionProfile({ identity: { kind: "dev" }, writeTarget: false, planMode: false }).toolSignature, read.toolSignature);
});

test("browser 在宿主资格未核实时默认关闭，Plan 仍拒绝", () => {
  const base = { registered: ["browser", "read"], plan: false, webSearchEnabled: true, mcpEffect: () => undefined };
  assert.deepEqual([...taskToolSet(base).allowed], ["read"]);
  assert.deepEqual([...taskToolSet({ ...base, browserEnabled: true }).allowed], ["browser", "read"]);
  assert.deepEqual([...taskToolSet({ ...base, browserEnabled: true, plan: true }).allowed], ["read"]);
});
