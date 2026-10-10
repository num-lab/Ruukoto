/**
 * 架构工单 03：工具可用性（纯函数，不起 Runtime）。
 *
 * - 会话身份（架构工单 08）：SubAgent / main / 普通开发会话 / 已退役归档（带原因）的纯分类；
 * - 会话类别 × 工具类别的完整矩阵（新工具族默认不可见，「仅 main」只靠清单）；
 * - 本任务允许的工具：计划模式、宿主按任务收窄、关闭的 Web Search 及其组合，拒绝原因；
 * - 执行画像：身份 × 工作 × 宿主评审 × Plan 的画像表，SubAgent 三种工具集与 SDK 签名。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRole, AgentRoleId, SubAgent, ToolCategory } from "@ruukoto/core/types.ts";
import { classifySession, CODING_ROLE_RETIRED, CORE_GROUP_CHAT_RETIRED, type SessionIdentity } from "@ruukoto/core/session-identity.ts";
import { allowsCategory, executionProfile, subAgentAllows, taskToolSet, type ExecutionProfile, type SessionToolClass } from "@ruukoto/agent/tool-availability.ts";

const role = (id: AgentRoleId): AgentRole => ({ id, projectId: "p", sessionId: "s", workDir: "/w", modelSelection: null, tools: [], createdAt: "" });
const agent: SubAgent = { id: "a", parentSessionId: "ps", sessionId: "s", workDir: "/w", activeWorkId: null, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: "" };

test("会话身份：SubAgent 行优先，main 按绑定，其余为普通开发会话；QQ 群与 chat/coding 角色是已退役归档并带原因", () => {
  assert.deepEqual(classifySession({ kind: "dev" }, null, agent), { kind: "subagent", agent }, "会话类别 dev 的 SubAgent 会话仍是 SubAgent 会话");
  assert.deepEqual(classifySession({ kind: "qq_group" }, null, null), { kind: "retired", reason: CORE_GROUP_CHAT_RETIRED }, "qq_sessions 联表查不到角色也不按普通开发会话放行");
  assert.deepEqual(classifySession({ kind: "dev" }, role("chat"), null), { kind: "retired", reason: CORE_GROUP_CHAT_RETIRED });
  assert.deepEqual(classifySession({ kind: "dev" }, role("coding"), null), { kind: "retired", reason: CODING_ROLE_RETIRED });
  assert.deepEqual(classifySession({ kind: "dev" }, role("main"), null), { kind: "main", role: role("main") });
  assert.deepEqual(classifySession({ kind: "dev" }, null, null), { kind: "dev" });
});

test("会话类别 × 工具类别：每个会话类别只开放清单内的类别", () => {
  const categories: ToolCategory[] = ["coding", "host_data", "web_search", "mcp", "app_data", "scheduler", "delegation", "chat_results", "service", "skills", "subagent"];
  const expected: Record<SessionToolClass, ToolCategory[]> = {
    dev: ["coding", "host_data", "web_search", "mcp", "skills", "subagent"],
    // service（agent-direction issue 09）：仅 main；装配另要求产品/Linux/显式部署配置
    main: ["host_data", "web_search", "app_data", "scheduler", "delegation", "chat_results", "service", "skills", "subagent"],
    subagent: [],
  };
  for (const [cls, open] of Object.entries(expected) as Array<[SessionToolClass, ToolCategory[]]>) {
    assert.deepEqual(categories.filter((c) => allowsCategory(cls, c)), open, cls);
  }
});

const REGISTERED = ["read", "edit", "bash", "todo_write", "history_read", "memory_save", "web_search", "skill", "mcp_svc_get", "mcp_svc_put", "mock_new"];
const EFFECTS: Record<string, "read" | "write"> = { mcp_svc_get: "read", mcp_svc_put: "write" };
const tools = (opts: { plan?: boolean; webSearchEnabled?: boolean; narrow?: (name: string, effect?: string) => boolean }) =>
  taskToolSet({ registered: REGISTERED, plan: opts.plan ?? false, webSearchEnabled: opts.webSearchEnabled ?? true, mcpEffect: (name) => EFFECTS[name], narrow: opts.narrow });

test("本任务允许的工具：无收窄时即装配结果；未装配的工具拒绝原因为本会话不开放", () => {
  const set = tools({});
  assert.deepEqual([...set.allowed], REGISTERED);
  assert.equal(set.reasonFor("app_data_query"), "本会话不开放");
});

test("本任务允许的工具：计划模式只留白名单与只读 MCP，今后新增的工具默认不可用", () => {
  const set = tools({ plan: true });
  assert.deepEqual([...set.allowed], ["read", "bash", "todo_write", "history_read", "web_search", "skill", "mcp_svc_get"]);
  for (const name of ["edit", "memory_save", "mcp_svc_put", "mock_new"]) assert.equal(set.reasonFor(name), "计划模式不开放", name);
});

test("本任务允许的工具：宿主按任务收窄（GitHub 评审式：read、read_artifact 与只读 MCP），收到 MCP 类别", () => {
  const seen: Array<[string, string | undefined]> = [];
  const set = tools({ narrow: (name, effect) => { seen.push([name, effect]); return name === "read" || effect === "read"; } });
  assert.deepEqual([...set.allowed], ["read", "mcp_svc_get"]);
  assert.equal(set.reasonFor("bash"), "本任务由宿主收窄");
  assert.deepEqual(seen.find(([name]) => name === "mcp_svc_put"), ["mcp_svc_put", "write"], "收窄函数收到 MCP 工具的类别");
});

test("本任务允许的工具：项目关闭 Web Search 时拒绝 web_search；多种收窄同时生效按先后给出原因", () => {
  const off = tools({ webSearchEnabled: false });
  assert.ok(!off.allowed.has("web_search"));
  assert.equal(off.reasonFor("web_search"), "项目已关闭 Web Search");
  assert.equal(off.allowed.size, REGISTERED.length - 1);

  const all = tools({ plan: true, webSearchEnabled: false, narrow: (name) => name !== "read" });
  assert.deepEqual([...all.allowed], ["bash", "todo_write", "history_read", "skill", "mcp_svc_get"]);
  assert.equal(all.reasonFor("edit"), "计划模式不开放");
  assert.equal(all.reasonFor("read"), "本任务由宿主收窄");
  assert.equal(all.reasonFor("web_search"), "项目已关闭 Web Search");
  assert.equal(all.reasonFor("bash"), "", "允许的工具没有拒绝原因");
});

test("执行画像：身份 × 工作（无 / 只读 / 写入）× 宿主评审 × Plan → 工具集、规划 MCP、资料受限、计划资格与提示键", () => {
  const main: SessionIdentity = { kind: "main", role: role("main") };
  const sub: SessionIdentity = { kind: "subagent", agent };
  const rows: Array<[SessionIdentity, boolean, boolean, boolean, Omit<ExecutionProfile, "toolSignature">]> = [
    // 身份, 写入目标（无工作与只读工作同为 false）, 宿主评审, Plan 选择 → 画像；
    // 写入目标与评审只作用于 SubAgent，计划资格只给普通开发会话
    [{ kind: "dev" }, false, false, false, { toolClass: "dev", subAgentTools: null, planMcp: true, restricted: false, plan: false }],
    [{ kind: "dev" }, false, false, true, { toolClass: "dev", subAgentTools: null, planMcp: true, restricted: false, plan: true }],
    [{ kind: "dev" }, true, true, false, { toolClass: "dev", subAgentTools: null, planMcp: true, restricted: false, plan: false }],
    [main, false, false, false, { toolClass: "main", subAgentTools: null, planMcp: false, restricted: false, plan: false }],
    [main, true, true, true, { toolClass: "main", subAgentTools: null, planMcp: false, restricted: false, plan: false }],
    [sub, false, false, true, { toolClass: "subagent", subAgentTools: { write: false, review: false }, planMcp: false, restricted: true, plan: false }],
    [sub, true, false, false, { toolClass: "subagent", subAgentTools: { write: true, review: false }, planMcp: false, restricted: true, plan: false }],
    [sub, false, true, false, { toolClass: "subagent", subAgentTools: { write: false, review: true }, planMcp: true, restricted: true, plan: false }],
    [sub, true, true, false, { toolClass: "subagent", subAgentTools: { write: true, review: true }, planMcp: true, restricted: true, plan: false }],
  ];
  for (const [identity, writeTarget, review, planMode, expected] of rows) {
    const { toolSignature: _, ...profile } = executionProfile({ identity, writeTarget, review, planMode });
    assert.deepEqual(profile, expected, JSON.stringify({ identity: identity.kind, writeTarget, review, planMode }));
  }
  assert.throws(() => executionProfile({ identity: { kind: "retired", reason: CODING_ROLE_RETIRED }, writeTarget: false, review: false, planMode: false }), /已退役/);
});

test("执行画像：SubAgent 只读 / 写入 / 评审工具集——装配与收窄同一结论，三种 SDK 签名互不相同", () => {
  const sub: SessionIdentity = { kind: "subagent", agent };
  const p = (writeTarget: boolean, review: boolean) => executionProfile({ identity: sub, writeTarget, review, planMode: false });
  const read = p(false, false), write = p(true, false), review = p(false, true);
  const names = ["read", "edit", "write", "bash", "read_artifact", "subagent_message", "mcp_svc_get", "mcp_svc_put"];
  const allowed = (prof: ExecutionProfile) => names.filter((n) => subAgentAllows(prof.subAgentTools!, n, EFFECTS[n]));
  assert.deepEqual(allowed(read), ["read", "read_artifact", "subagent_message"]);
  assert.deepEqual(allowed(write), ["read", "edit", "write", "bash", "read_artifact", "subagent_message"]);
  assert.deepEqual(allowed(review), ["read", "read_artifact", "mcp_svc_get"], "宿主评审另开只读 MCP、关 subagent_message");
  assert.equal(new Set([read, write, review, p(false, false)].map((x) => x.toolSignature)).size, 3);
  assert.notEqual(executionProfile({ identity: { kind: "dev" }, writeTarget: false, review: false, planMode: false }).toolSignature, read.toolSignature);
});
