/**
 * 架构工单 03：工具可用性（纯函数，不起 Runtime）。
 *
 * - 会话类别：QQ 群按会话 kind 归入 chat（不依赖角色绑定），角色会话按绑定，其余为普通开发会话；
 * - 会话类别 × 工具类别的完整矩阵（新工具族默认不可见，「仅 main」只靠清单）；
 * - 本任务允许的工具：计划模式、宿主按任务收窄、关闭的 Web Search 及其组合，拒绝原因。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolCategory } from "../src/core/types.ts";
import { allowsCategory, sessionToolClass, taskToolSet, type SessionToolClass } from "../src/agent/tool-availability.ts";

test("会话类别：QQ 群无论有无角色绑定都归 chat，角色会话按绑定，其余为普通开发会话", () => {
  assert.equal(sessionToolClass("qq_group", null), "chat", "qq_sessions 联表查不到角色也不按普通开发会话放行");
  assert.equal(sessionToolClass("qq_group", "chat"), "chat");
  assert.equal(sessionToolClass("dev", "main"), "main");
  assert.equal(sessionToolClass("dev", "coding"), "coding");
  assert.equal(sessionToolClass("dev", "chat"), "chat");
  assert.equal(sessionToolClass("dev", null), "dev");
});

test("会话类别 × 工具类别：每个会话类别只开放清单内的类别", () => {
  const categories: ToolCategory[] = ["coding", "host_data", "web_search", "mcp", "app_data", "scheduler", "delegation", "chat_results", "skills"];
  const expected: Record<SessionToolClass, ToolCategory[]> = {
    dev: ["coding", "host_data", "web_search", "mcp", "skills"],
    main: ["host_data", "web_search", "app_data", "scheduler", "delegation", "chat_results", "skills"],
    coding: ["coding", "host_data", "web_search", "mcp", "skills"],
    chat: [],
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
