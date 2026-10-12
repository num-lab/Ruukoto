/**
 * MCP 集成测试（issue 16）：通用 MCP 服务配置、工具发现/调用与任务生命周期。
 *
 * - 配置面：mcp_configure / mcp_list / mcp_set_enabled / mcp_remove / mcp_check，
 *   凭据 host/用途/scope 校验、期望版本冲突、事件与脱敏、schema v7→v8 迁移；
 * - 运行面：进程内模拟 Streamable HTTP MCP 服务（回环 http 仅此用途），经真实
 *   Runtime/Driver/宿主工具路径驱动任务，断言远端实际收到的调用次数与授权边界。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import {
  startTestRuntime,
  createProjectSession,
  waitFor,
  taskStatus,
  writeModelsJson,
  connectAuthedClient,
  type TestRuntime,
} from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { startMockMcp, MOCK_MCP_SECRET, type MockMcp } from "./helpers/mock-mcp.ts";
import { killProcessTree, spawnBackend } from "./helpers/backend.ts";
import { validateRemoteTool } from "@ruukoto/agent/mcp/tools.ts";

const SECRET = MOCK_MCP_SECRET;
const quiet: Responder = async () => ({ kind: "text", text: "done" });

/** 直接写凭据库（同 23-web-search 测试方式）；scope 由配置入口收紧。 */
function addMcpCredential(t: TestRuntime, host: string, name = "mcp-cred", purpose = "mcp"): void {
  t.runtime.credentials.upsert({ name, host, header: "authorization", purpose, secret: SECRET });
}

function eventsOf(t: TestRuntime, type: string): any[] {
  return t.runtime.store.getEventsAfter(0).filter((e) => (e.body as any).type === type).map((e) => e.body);
}

// ---------- 配置面 ----------

test("mcp：配置并列出服务（脱敏视图 + 变更事件）", async () => {
  const t = await startTestRuntime("mcp-cfg", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    addMcpCredential(t, "mcp.example.com");
    const service = (await t.client.request<any>("mcp_configure", {
      project_id: projectId,
      name: "docs",
      endpoint: "https://mcp.example.com/mcp/",
      credential: "mcp-cred",
      tool_allowlist: ["get_me", "get_file_contents"],
    })) as any;
    assert.equal(service.name, "docs");
    assert.equal(service.endpoint, "https://mcp.example.com/mcp/");
    assert.equal(service.enabled, true);
    assert.equal(service.configVersion, 1);
    assert.deepEqual(service.toolAllowlist, ["get_me", "get_file_contents"]);
    assert.ok(!JSON.stringify(service).includes(SECRET), "配置视图不得包含秘密值");

    const list = (await t.client.request<any>("mcp_list", { project_id: projectId })) as any;
    assert.equal(list.services.length, 1);
    assert.equal(list.services[0].id, service.id);
    assert.ok(!JSON.stringify(list).includes(SECRET));

    const events = eventsOf(t, "mcp.service_changed");
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "upsert");
    assert.equal(events[0].projectId, projectId);
    assert.ok(!JSON.stringify(events).includes(SECRET), "事件不得包含秘密值");
  } finally {
    await t.shutdown();
  }
});

test("mcp：端点、名称与凭据校验", async () => {
  const t = await startTestRuntime("mcp-cfg-validate", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    addMcpCredential(t, "mcp.example.com");
    addMcpCredential(t, "other.example.com", "other-cred");
    t.runtime.credentials.upsert({ name: "wrong-purpose", host: "mcp.example.com", header: "authorization", purpose: "tavily_search", secret: SECRET });

    const base = { project_id: projectId, name: "docs", endpoint: "https://mcp.example.com/mcp/", tool_allowlist: ["a"] };
    const rejected: Array<[string, Record<string, unknown>]> = [
      ["名称含非法字符", { ...base, name: "Bad Name!" }],
      ["非 https 且非回环", { ...base, endpoint: "http://mcp.example.com/mcp/" }],
      ["端点带 userinfo", { ...base, endpoint: "https://user:pass@mcp.example.com/mcp/" }],
      ["凭据不存在", { ...base, credential: "nope" }],
      ["凭据 host 不匹配", { ...base, credential: "other-cred" }],
      ["凭据用途不匹配", { ...base, credential: "wrong-purpose" }],
      ["允许列表含非字符串", { ...base, tool_allowlist: ["a", 1] }],
      ["项目不存在", { ...base, project_id: "proj_nope" }],
    ];
    for (const [desc, params] of rejected) {
      await assert.rejects(t.client.request("mcp_configure", params), /./, desc);
    }

    // 回环 http 允许（模拟服务唯一用途）；无凭据服务允许
    const local = (await t.client.request<any>("mcp_configure", {
      ...base,
      name: "local-mock",
      endpoint: "http://127.0.0.1:8787/mcp",
    })) as any;
    assert.equal(local.endpoint, "http://127.0.0.1:8787/mcp");
  } finally {
    await t.shutdown();
  }
});

test("mcp：期望版本冲突与配置版本递增", async () => {
  const t = await startTestRuntime("mcp-cfg-version", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    const created = (await t.client.request<any>("mcp_configure", {
      project_id: projectId,
      name: "docs",
      endpoint: "https://mcp.example.com/mcp/",
      tool_allowlist: ["a"],
    })) as any;
    assert.equal(created.configVersion, 1);

    await assert.rejects(
      t.client.request("mcp_configure", {
        project_id: projectId,
        name: "docs",
        endpoint: "https://mcp.example.com/mcp/",
        tool_allowlist: ["a", "b"],
        expected_version: 99,
      }),
      /版本/,
    );

    const updated = (await t.client.request<any>("mcp_configure", {
      project_id: projectId,
      name: "docs",
      endpoint: "https://mcp.example.com/mcp/",
      tool_allowlist: ["a", "b"],
      expected_version: 1,
    })) as any;
    assert.equal(updated.configVersion, 2);
    assert.deepEqual(updated.toolAllowlist, ["a", "b"]);

    await assert.rejects(
      t.client.request("mcp_set_enabled", { service_id: updated.id, enabled: false, expected_version: 1 }),
      /版本/,
    );
  } finally {
    await t.shutdown();
  }
});

test("mcp：禁用/启用与删除（事件 + 凭据 scope 收紧）", async () => {
  const t = await startTestRuntime("mcp-cfg-enable", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    const { projectId: otherProject } = await createProjectSession(t.client, t.work[1]!);
    addMcpCredential(t, "mcp.example.com");
    const service = (await t.client.request<any>("mcp_configure", {
      project_id: projectId,
      name: "docs",
      endpoint: "https://mcp.example.com/mcp/",
      credential: "mcp-cred",
      tool_allowlist: ["a"],
    })) as any;

    // 配置后凭据 scope 收紧到本项目 + mcp 操作
    const cred = t.runtime.credentials.get("mcp-cred");
    assert.deepEqual(cred?.scope, { projectId, operations: ["mcp"] });
    // 其他项目不得借用同一凭据
    await assert.rejects(
      t.client.request("mcp_configure", {
        project_id: otherProject,
        name: "docs",
        endpoint: "https://mcp.example.com/mcp/",
        credential: "mcp-cred",
        tool_allowlist: ["a"],
      }),
      /范围|scope/i,
    );

    const disabled = (await t.client.request<any>("mcp_set_enabled", { service_id: service.id, enabled: false })) as any;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.configVersion, 2);
    const enabled = (await t.client.request<any>("mcp_set_enabled", { service_id: service.id, enabled: true })) as any;
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.configVersion, 3);

    const removed = (await t.client.request<any>("mcp_remove", { service_id: service.id })) as any;
    assert.equal(removed.removed, true);
    const list = (await t.client.request<any>("mcp_list", {})) as any;
    assert.equal(list.services.length, 0);

    const actions = eventsOf(t, "mcp.service_changed").map((e) => e.action);
    assert.deepEqual(actions, ["upsert", "disabled", "enabled", "removed"]);
  } finally {
    await t.shutdown();
  }
});

// ---------- 模拟 Streamable HTTP MCP 服务（helpers/mock-mcp.ts） ----------

// ---------- 任务路径集成 ----------

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } as const;

async function submitAndWait(t: TestRuntime, sessionId: string, requestId: string, input: string) {
  const task = (await t.client.request<any>("submit", {
    model_selection: MODEL,
    session_id: sessionId,
    request_id: requestId,
    input,
  })) as any;
  await waitFor(`任务终态 ${requestId}`, async () => {
    const s = await taskStatus(t.client, task.id);
    return ["completed", "failed", "interrupted", "canceled"].includes(s.task.status);
  });
  return taskStatus(t.client, task.id);
}

/** 模型实际收到的全部 tool 结果文本。 */
function toolResultTexts(t: TestRuntime): string[] {
  return t.server.calls
    .flatMap((c) => c.messages)
    .filter((m: any) => m.role === "tool")
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

/** 模型首次请求可见的工具名。 */
function offeredToolNames(t: TestRuntime, callIndex = 0): string[] {
  return ((t.server.calls[callIndex]?.tools ?? []) as any[]).map((x) => String(x?.function?.name ?? x?.name ?? ""));
}

/** 配置一个指向模拟服务的项目内 MCP 服务（含凭据）。 */
async function configureMockService(
  t: TestRuntime,
  projectId: string,
  mcp: MockMcp,
  opts: { name?: string; allowlist: string[]; credential?: boolean },
): Promise<any> {
  if (opts.credential !== false) addMcpCredential(t, mcp.host, `mcp-cred-${opts.name ?? "mock"}`);
  return t.client.request<any>("mcp_configure", {
    project_id: projectId,
    name: opts.name ?? "mock",
    endpoint: mcp.url,
    credential: opts.credential === false ? null : `mcp-cred-${opts.name ?? "mock"}`,
    tool_allowlist: opts.allowlist,
  });
}

test("mcp：任务内发现与只读调用（经真实宿主路径，凭据注入且不外泄）", async () => {
  const mcp = await startMockMcp({
    requireAuth: true,
    tools: [
      { name: "get_me", description: "查询当前用户", result: { content: [{ type: "text", text: "login=octocat" }] } },
      // 伪造只读标注的写工具：不在允许列表，不得注册
      { name: "create_issue", description: "创建 issue", annotations: { readOnlyHint: true } },
    ],
  });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_get_me", arguments: {} }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-run", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: ["get_me"] });

    const done = await submitAndWait(t, sessionId, "r1", "查一下我是谁");
    assert.equal(done.task.status, "completed");

    // 模型可见工具：mcp_mock_get_me 注册；未允许的 create_issue 不注册（伪造只读标注无效）
    const offered = offeredToolNames(t);
    assert.ok(offered.includes("mcp_mock_get_me"), `应注册 mcp_mock_get_me：${offered.join(",")}`);
    assert.ok(!offered.some((n) => n.includes("create_issue")), "未允许的工具不得注册");

    // 远端实际收到：initialize + tools/list + tools/call 各一次，均带凭据
    const methods = mcp.hits.map((h) => h.rpcMethod);
    assert.deepEqual(
      methods.filter((m) => m === "initialize" || m === "tools/list" || m === "tools/call"),
      ["initialize", "tools/list", "tools/call"],
    );
    assert.ok(mcp.hits.every((h) => h.hasAuth), "所有请求必须携带凭据");

    // 操作记录与结果：isError=false，模型看到头部与正文
    const op = done.toolOps.find((o: any) => o.toolName === "mcp_mock_get_me");
    assert.ok(op, "应有 mcp_mock_get_me 操作记录");
    assert.equal(op.isError, false);
    const seen = toolResultTexts(t).join("\n");
    assert.ok(seen.includes("[mcp｜mock/get_me]"), "结果应带服务/工具来源头");
    assert.ok(seen.includes("login=octocat"), "模型应看到工具结果正文");
    assert.ok(!JSON.stringify(t.server.calls).includes(SECRET), "凭据不得进入模型上下文");
    assert.ok(!JSON.stringify(done.toolOps).includes(SECRET), "凭据不得进入操作记录");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：分页发现、重名与不支持 schema 的处理", async () => {
  const mcp = await startMockMcp({
    pageSize: 2,
    tools: [
      { name: "get_me", result: { content: [{ type: "text", text: "me" }] } },
      { name: "list_repos", result: { content: [{ type: "text", text: "repos" }] } },
      // 转义后同名：get me → get_me，与 get_me 冲突 → 后者禁用
      { name: "get me", result: { content: [{ type: "text", text: "dup" }] } },
      // 超过 schema 大小上限：SDK 接受（合法 object schema），客户端明确禁用
      { name: "bad_schema", inputSchema: { type: "object", properties: { pad: { type: "string", description: "x".repeat(20000) } } } },
      { name: "extra", description: "未允许" },
    ],
  });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_list_repos", arguments: {} }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-pages", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: ["get_me", "list_repos", "get me", "bad_schema"], credential: false });

    const done = await submitAndWait(t, sessionId, "r1", "列出仓库");
    assert.equal(done.task.status, "completed");

    // 分页：pageSize=2，5 个工具 → 3 页
    assert.equal(mcp.hits.filter((h) => h.rpcMethod === "tools/list").length, 3);

    const offered = offeredToolNames(t);
    assert.ok(offered.includes("mcp_mock_get_me"));
    assert.ok(offered.includes("mcp_mock_list_repos"));
    assert.equal(offered.filter((n) => n === "mcp_mock_get_me").length, 1, "重名工具只注册一个");
    assert.ok(!offered.includes("mcp_mock_bad_schema"), "不支持的 schema 不得注册");
    assert.ok(!offered.some((n) => n.includes("extra")), "未允许的工具不得注册");

    const op = done.toolOps.find((o: any) => o.toolName === "mcp_mock_list_repos");
    assert.ok(op && !op.isError);
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：参数校验失败不发送网络请求", async () => {
  const mcp = await startMockMcp({
    tools: [
      {
        name: "get_file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        result: { content: [{ type: "text", text: "file" }] },
      },
    ],
  });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_get_file", arguments: {} }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-badparams", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: ["get_file"], credential: false });
    const done = await submitAndWait(t, sessionId, "r1", "读文件");
    // SDK 在 tool_call 门前校验参数：畸形调用不记录操作、不发送请求
    assert.equal(mcp.hits.filter((h) => h.rpcMethod === "tools/call").length, 0, "参数校验失败不得发送 tools/call");
    assert.equal(done.task.status, "completed");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：结构化结果、isError 与传输错误的区分", async () => {
  const mcp = await startMockMcp({
    tools: [
      {
        name: "get_pr",
        result: {
          content: [{ type: "text", text: "PR #42" }],
          structuredContent: { number: 42, state: "open" },
        },
      },
      { name: "failing", result: { content: [{ type: "text", text: "仓库不存在" }], isError: true } },
      { name: "broken", rpcError: { code: -32603, message: "backend exploded" } },
    ],
  });
  const calls = ["mcp_mock_get_pr", "mcp_mock_failing", "mcp_mock_broken"];
  const responder: Responder = async (req) => {
    const toolResults = (req.messages as any[]).filter((m) => m.role === "tool").length;
    if (toolResults < calls.length) {
      return { kind: "tool_calls", calls: [{ id: `c${toolResults}`, name: calls[toolResults]!, arguments: {} }] };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-results", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: ["get_pr", "failing", "broken"], credential: false });
    const done = await submitAndWait(t, sessionId, "r1", "依次调用三个工具");
    assert.equal(done.task.status, "completed");

    const seen = toolResultTexts(t).join("\n");
    assert.ok(seen.includes("PR #42"), "文本结果");
    assert.ok(seen.includes('"number": 42'), "结构化结果应随结果返回");
    assert.ok(seen.includes("远端工具执行错误"), "isError 应标注为工具执行错误");
    assert.ok(seen.includes("仓库不存在"), "isError 保留远端说明");

    const opOk = done.toolOps.find((o: any) => o.toolName === "mcp_mock_get_pr");
    const opToolErr = done.toolOps.find((o: any) => o.toolName === "mcp_mock_failing");
    const opTransport = done.toolOps.find((o: any) => o.toolName === "mcp_mock_broken");
    assert.equal(opOk.isError, false);
    assert.equal(opToolErr.isError, true, "isError 保留");
    assert.ok(opToolErr.resultSummary.includes("远端工具执行错误"));
    assert.equal(opTransport.isError, true, "传输错误也是失败操作");
    assert.ok(!opTransport.resultSummary.includes("远端工具执行错误"), "传输错误与工具执行错误区分");
    assert.equal(mcp.hits.filter((h) => h.rpcMethod === "tools/call").length, 3);
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：超大结果入产物、不支持内容类型明确说明", async () => {
  const bigText = "x".repeat(100 * 1024);
  const mcp = await startMockMcp({
    tools: [
      { name: "big", result: { content: [{ type: "text", text: bigText }] } },
      {
        name: "with_image",
        result: {
          content: [
            { type: "text", text: "见图" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        },
      },
    ],
  });
  const responder: Responder = async (req) => {
    const toolResults = (req.messages as any[]).filter((m) => m.role === "tool").length;
    if (toolResults === 0) return { kind: "tool_calls", calls: [{ id: "c0", name: "mcp_mock_big", arguments: {} }] };
    if (toolResults === 1) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_with_image", arguments: {} }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-big", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: ["big", "with_image"], credential: false });
    const done = await submitAndWait(t, sessionId, "r1", "调用两个工具");
    assert.equal(done.task.status, "completed");

    // 超大结果：模型只收预览 + 产物引用；产物可完整读回
    const seen = toolResultTexts(t).join("\n");
    assert.ok(seen.includes("超过内联上限"), "应标注截断");
    const artifacts = t.runtime.store.listArtifactsByTask(done.task.id);
    const mcpArtifact = artifacts.find((a: any) => a.name === "mcp-tool-result");
    assert.ok(mcpArtifact, "大结果应保存为任务产物");
    const body = t.runtime.artifacts.read(mcpArtifact.id, 0, 200 * 1024);
    assert.ok(body.toString("utf8").includes("x".repeat(1000)), "产物含结果正文");
    assert.ok(body.toString("utf8").includes("capture-meta"), "产物含采集元信息");

    // 图片内容：不下载、不展示，明确说明
    assert.ok(seen.includes("未展示的内容类型"), "不支持的内容类型应明确说明");
    assert.ok(seen.includes("image"));
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

// ---------- 生命周期与授权边界 ----------

test("mcp：认证失败 → 服务列为不可用，任务不带其工具继续", async () => {
  const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "get_me" }] });
  const t = await startTestRuntime("mcp-auth-fail", quiet);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 配置无凭据服务（服务端要求认证）→ 初始化即 401
    await configureMockService(t, projectId, mcp, { allowlist: ["get_me"], credential: false });

    const done = await submitAndWait(t, sessionId, "r1", "查一下");
    assert.equal(done.task.status, "completed", "服务不可用不阻断任务");
    assert.ok(!offeredToolNames(t).some((n) => n.startsWith("mcp_")), "初始化失败的服务不注册工具");
    const unavail = eventsOf(t, "mcp.service_unavailable");
    assert.equal(unavail.length, 1);
    assert.equal(unavail[0].name, "mock");
    assert.ok(unavail[0].reason.length > 0);
    assert.ok(!JSON.stringify(unavail).includes(SECRET));
    // 只有 initialize 尝试，无 tools/call
    assert.equal(mcp.hits.filter((h) => h.rpcMethod === "tools/call").length, 0);
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：调用超时与断线（不自动重试）", async () => {
  const slow = await startMockMcp({ tools: [{ name: "slow", delayMs: 5000 }] });
  const t = await startTestRuntime("mcp-timeout", async (req) => {
    const toolResults = (req.messages as any[]).filter((m) => m.role === "tool").length;
    if (toolResults === 0) return { kind: "tool_calls", calls: [{ id: "c0", name: "mcp_mock_slow", arguments: {} }] };
    return { kind: "text", text: "完成" };
  }, { config: { mcp: { callTimeoutMs: 300 } } });
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, slow, { allowlist: ["slow"], credential: false });
    const done = await submitAndWait(t, sessionId, "r1", "调用慢工具");
    assert.equal(done.task.status, "completed");
    const op = done.toolOps.find((o: any) => o.toolName === "mcp_mock_slow");
    assert.equal(op.isError, true);
    assert.ok(op.resultSummary.includes("超时"), `应标注超时：${op.resultSummary}`);
    assert.equal(slow.hits.filter((h) => h.rpcMethod === "tools/call").length, 1, "超时不自动重试");
  } finally {
    await t.shutdown();
    await slow.close();
  }

  const dropping = await startMockMcp({ tools: [{ name: "fragile" }], dropOnCall: true });
  const t2 = await startTestRuntime("mcp-drop", async (req) => {
    const toolResults = (req.messages as any[]).filter((m) => m.role === "tool").length;
    if (toolResults === 0) return { kind: "tool_calls", calls: [{ id: "c0", name: "mcp_mock_fragile", arguments: {} }] };
    return { kind: "text", text: "完成" };
  });
  try {
    const { projectId, sessionId } = await createProjectSession(t2.client, t2.work[0]!);
    await configureMockService(t2, projectId, dropping, { allowlist: ["fragile"], credential: false });
    const done = await submitAndWait(t2, sessionId, "r1", "调用会断线的工具");
    assert.equal(done.task.status, "completed");
    const op = done.toolOps.find((o: any) => o.toolName === "mcp_mock_fragile");
    assert.equal(op.isError, true);
    assert.equal(dropping.hits.filter((h) => h.rpcMethod === "tools/call").length, 1, "断线不自动重放调用");
  } finally {
    await t2.shutdown();
    await dropping.close();
  }
});

test("mcp：任务取消中断在途调用并回收连接", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "slow", delayMs: 30_000 }] });
  const t = await startTestRuntime("mcp-cancel", async () => ({ kind: "tool_calls", calls: [{ id: "c0", name: "mcp_mock_slow", arguments: {} }] }));
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: ["slow"], credential: false });
    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "调用慢工具" })) as any;
    await waitFor("tools/call 已发出", () => mcp.hits.some((h) => h.rpcMethod === "tools/call"));
    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务终态", async () => {
      const s = await taskStatus(t.client, task.id);
      return ["interrupted", "canceled"].includes(s.task.status);
    });
    const done = await taskStatus(t.client, task.id);
    const op = done.toolOps.find((o: any) => o.toolName === "mcp_mock_slow");
    assert.ok(op, "在途调用有操作记录");
    assert.equal(mcp.hits.filter((h) => h.rpcMethod === "tools/call").length, 1, "取消后不重发");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：任务间工具刷新（允许列表变化 → 下一任务生效）", async () => {
  const mcp = await startMockMcp({
    tools: [
      { name: "tool_a", result: { content: [{ type: "text", text: "A" }] } },
      { name: "tool_b", result: { content: [{ type: "text", text: "B" }] } },
    ],
  });
  const responder: Responder = async () => ({ kind: "text", text: "完成" });
  const t = await startTestRuntime("mcp-refresh", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const service = await configureMockService(t, projectId, mcp, { allowlist: ["tool_a"], credential: false });

    const first = await submitAndWait(t, sessionId, "r1", "第一个任务");
    assert.equal(first.task.status, "completed");
    const offeredFirst = offeredToolNames(t, 0);
    assert.ok(offeredFirst.includes("mcp_mock_tool_a"));
    assert.ok(!offeredFirst.includes("mcp_mock_tool_b"), "新增工具不得进入既有任务");

    // 拥有者扩大允许列表 → 下一任务生效（SDK 会话重建）
    await t.client.request("mcp_configure", {
      project_id: projectId,
      name: "mock",
      endpoint: mcp.url,
      tool_allowlist: ["tool_a", "tool_b"],
      expected_version: service.configVersion,
    });
    const second = await submitAndWait(t, sessionId, "r2", "第二个任务");
    assert.equal(second.task.status, "completed");
    const offeredSecond = offeredToolNames(t, t.server.calls.length - 1);
    assert.ok(offeredSecond.includes("mcp_mock_tool_b"), "新工具从下一任务生效");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：运行中禁用服务 → 后续调用立即阻止且不发请求", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "get_me", result: { content: [{ type: "text", text: "me" }] } }] });
  let serviceId = "";
  const responder: Responder = async (req) => {
    const toolResults = (req.messages as any[]).filter((m) => m.role === "tool").length;
    if (toolResults === 0) return { kind: "tool_calls", calls: [{ id: "c0", name: "mcp_mock_get_me", arguments: {} }] };
    if (toolResults === 1) {
      // 第二次调用前等待拥有者禁用服务（确定性时序）
      await waitFor("服务已禁用", () => t.runtime.mcp.getService(serviceId)?.enabled === false);
      return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_get_me", arguments: {} }] };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-mid-disable", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const service = await configureMockService(t, projectId, mcp, { allowlist: ["get_me"], credential: false });
    serviceId = service.id;

    const submit = await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "调用两次" });
    // 第一次调用落盘后禁用服务
    await waitFor("第一次调用完成", async () => {
      const s = await taskStatus(t.client, submit.id);
      return s.toolOps.some((o: any) => o.toolName === "mcp_mock_get_me" && !o.isError);
    });
    await t.client.request("mcp_set_enabled", { service_id: serviceId, enabled: false });

    await waitFor("任务终态", async () => {
      const s = await taskStatus(t.client, submit.id);
      return ["completed", "failed", "interrupted", "canceled"].includes(s.task.status);
    });
    const final = await taskStatus(t.client, submit.id);
    assert.equal(final.task.status, "completed");
    const ops = final.toolOps.filter((o: any) => o.toolName === "mcp_mock_get_me");
    assert.equal(ops.length, 2);
    assert.equal(ops[0].isError, false);
    assert.equal(ops[1].isError, true, "禁用后调用被阻止");
    assert.ok(ops[1].resultSummary.includes("禁用"), `应说明禁用：${ops[1].resultSummary}`);
    assert.equal(mcp.hits.filter((h) => h.rpcMethod === "tools/call").length, 1, "被阻止的调用不发送网络请求");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：运行中撤销凭据 → 后续调用失败且不再发出认证请求", async () => {
  const mcp = await startMockMcp({ requireAuth: true, tools: [{ name: "get_me", result: { content: [{ type: "text", text: "me" }] } }] });
  const responder: Responder = async (req) => {
    const toolResults = (req.messages as any[]).filter((m) => m.role === "tool").length;
    if (toolResults === 0) return { kind: "tool_calls", calls: [{ id: "c0", name: "mcp_mock_get_me", arguments: {} }] };
    if (toolResults === 1) {
      await waitFor("凭据已撤销", () => !t.runtime.credentials.get("mcp-cred-mock"));
      return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_get_me", arguments: {} }] };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-mid-revoke", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: ["get_me"] });

    const submit = await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "调用两次" });
    await waitFor("第一次调用完成", async () => {
      const s = await taskStatus(t.client, submit.id);
      return s.toolOps.some((o: any) => o.toolName === "mcp_mock_get_me" && !o.isError);
    });
    t.runtime.credentials.remove("mcp-cred-mock");

    await waitFor("任务终态", async () => {
      const s = await taskStatus(t.client, submit.id);
      return ["completed", "failed", "interrupted", "canceled"].includes(s.task.status);
    });
    const final = await taskStatus(t.client, submit.id);
    const ops = final.toolOps.filter((o: any) => o.toolName === "mcp_mock_get_me");
    assert.equal(ops.length, 2);
    assert.equal(ops[0].isError, false);
    assert.equal(ops[1].isError, true, "撤销后调用失败");
    assert.ok(ops[1].resultSummary.includes("认证") || ops[1].resultSummary.includes("凭据"), `应说明认证失败：${ops[1].resultSummary}`);
    assert.equal(mcp.hits.filter((h) => h.rpcMethod === "tools/call").length, 1, "凭据撤销后不再发出请求");
    assert.ok(!JSON.stringify(final.toolOps).includes(SECRET));
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：跨项目隔离与第二服务同一路径", async () => {
  const mcpA = await startMockMcp({ tools: [{ name: "get_me", result: { content: [{ type: "text", text: "from-A" }] } }] });
  const mcpB = await startMockMcp({ tools: [{ name: "get_time", result: { content: [{ type: "text", text: "from-B" }] } }] });
  const responder: Responder = async (req) => {
    const text = JSON.stringify(req.messages.at(-1)?.content ?? "");
    if (text.includes("用B")) return { kind: "tool_calls", calls: [{ id: "cb", name: "mcp_alt_get_time", arguments: {} }] };
    if (text.includes("用A")) return { kind: "tool_calls", calls: [{ id: "ca", name: "mcp_mock_get_me", arguments: {} }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-xproj", responder);
  try {
    const a = await createProjectSession(t.client, t.work[0]!);
    const b = await createProjectSession(t.client, t.work[1]!);
    // 项目 A 配置两个服务（同名工具路径一致）；项目 B 不配置
    await configureMockService(t, a.projectId, mcpA, { name: "mock", allowlist: ["get_me"], credential: false });
    await configureMockService(t, a.projectId, mcpB, { name: "alt", allowlist: ["get_time"], credential: false });

    const doneA = await submitAndWait(t, a.sessionId, "ra", "用A 查询");
    assert.equal(doneA.task.status, "completed");
    assert.ok(toolResultTexts(t).join("\n").includes("from-A"));
    assert.equal(mcpA.hits.filter((h) => h.rpcMethod === "tools/call").length, 1);
    assert.equal(mcpB.hits.filter((h) => h.rpcMethod === "tools/call").length, 0, "未调用的服务不收请求");

    // 跨项目并发：两个项目的任务同时推进，各自只见自己的服务
    const callsBefore = t.server.calls.length;
    const taskA2 = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: a.sessionId, request_id: "ra2", input: "用B 查询" })) as any;
    const taskB = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: b.sessionId, request_id: "rb", input: "用A 查询" })) as any;
    await waitFor("两个任务终态", async () => {
      const sa = await taskStatus(t.client, taskA2.id);
      const sb = await taskStatus(t.client, taskB.id);
      return [sa, sb].every((s) => ["completed", "failed", "interrupted", "canceled"].includes(s.task.status));
    });
    const doneA2 = await taskStatus(t.client, taskA2.id);
    const doneB = await taskStatus(t.client, taskB.id);
    assert.equal(doneA2.task.status, "completed");
    assert.equal(mcpB.hits.filter((h) => h.rpcMethod === "tools/call").length, 1, "第二服务走同一发现/调用路径");
    assert.equal(doneB.task.status, "completed");
    // 并发下按请求内容定位项目 B 的模型调用（其输入为"用A 查询"）
    const bCall = t.server.calls.slice(callsBefore).find((c: any) => JSON.stringify(c.messages).includes("用A 查询"));
    const offeredB = ((bCall?.tools ?? []) as any[]).map((x) => String(x?.function?.name ?? x?.name ?? ""));
    assert.ok(bCall, "应有项目 B 的模型调用");
    assert.ok(!offeredB.some((n) => n.startsWith("mcp_")), "无配置项目不注册 MCP 工具");
    assert.equal(mcpA.hits.filter((h) => h.rpcMethod === "tools/call").length, 1, "项目 B 不得触达项目 A 的服务");
  } finally {
    await t.shutdown();
    await mcpA.close();
    await mcpB.close();
  }
});

test("mcp：mcp_check 连接检查与工具列表（含失败路径）", async () => {
  const mcp = await startMockMcp({
    requireAuth: true,
    tools: [
      { name: "get_me", description: "允许的只读工具" },
      { name: "delete_all", description: "未允许的写工具" },
    ],
  });
  const t = await startTestRuntime("mcp-check", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    const service = await configureMockService(t, projectId, mcp, { allowlist: ["get_me"] });
    const ok = (await t.client.request<any>("mcp_check", { service_id: service.id })) as any;
    assert.equal(ok.ok, true);
    assert.equal(ok.serverInfo.name, "mock-mcp");
    assert.deepEqual(
      ok.tools.map((x: any) => [x.name, x.allowed, x.reason ?? null]),
      [
        ["get_me", true, null],
        ["delete_all", false, "不在允许列表"],
      ],
    );
    assert.ok(!JSON.stringify(ok).includes(SECRET), "检查结果不含秘密值");

    // 失败路径：服务不可达 → ok:false + 错误说明（不抛错）
    const dead = await t.client.request<any>("mcp_configure", {
      project_id: projectId,
      name: "dead",
      endpoint: "http://127.0.0.1:1/mcp",
      tool_allowlist: ["x"],
    });
    const fail = (await t.client.request<any>("mcp_check", { service_id: (dead as any).id })) as any;
    assert.equal(fail.ok, false);
    assert.ok(fail.error.length > 0);
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：工具定义计入上下文预算", async () => {
  const mcp = await startMockMcp({
    tools: [{ name: "get_me", description: "查询当前用户", inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } } }],
  });
  const t = await startTestRuntime("mcp-budget", quiet);
  try {
    const withMcp = await createProjectSession(t.client, t.work[0]!);
    const plain = await createProjectSession(t.client, t.work[1]!);
    await configureMockService(t, withMcp.projectId, mcp, { allowlist: ["get_me"], credential: false });

    const doneWith = await submitAndWait(t, withMcp.sessionId, "r1", "你好");
    const donePlain = await submitAndWait(t, plain.sessionId, "r2", "你好");
    assert.equal(doneWith.task.status, "completed");
    assert.equal(donePlain.task.status, "completed");
    const recWith = t.runtime.store.listSelectionRecordsByTask(doneWith.task.id)[0];
    const recPlain = t.runtime.store.listSelectionRecordsByTask(donePlain.task.id)[0];
    assert.ok(recWith && recPlain, "两个任务都应有选择记录");
    assert.ok(
      recWith.estimates.toolSchemas > recPlain.estimates.toolSchemas,
      `MCP 工具定义应计入预算（${recWith.estimates.toolSchemas} > ${recPlain.estimates.toolSchemas}）`,
    );
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

// ---------- 后台重启（真实子进程 + SIGKILL，helpers/backend.ts） ----------

test("mcp：后台崩溃重启 —— 在途调用标 effect_unknown，不重放", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "slow", delayMs: 30_000 }] });
  const modelServer = new MockModelServer(async () => ({
    kind: "tool_calls",
    calls: [{ id: "c0", name: "mcp_mock_slow", arguments: {} }],
  }));
  const baseUrl = await modelServer.start();
  const root = await mkdtemp(path.join(tmpdir(), "ruukoto-it-mcp-crash-"));
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  const workDir = path.join(root, "work");
  await mkdir(dataDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeModelsJson({ root, dataDir, agentDir }, baseUrl);

  let backend = await spawnBackend(dataDir, agentDir);
  try {
    const { projectId, sessionId } = await createProjectSession(backend.client, workDir);
    await backend.client.request("add_credential", {
      name: "mcp-cred",
      host: mcp.host,
      header: "authorization",
      purpose: "mcp",
      secret: SECRET,
    });
    await backend.client.request("mcp_configure", {
      project_id: projectId,
      name: "mock",
      endpoint: mcp.url,
      credential: "mcp-cred",
      tool_allowlist: ["slow"],
    });
    const task = (await backend.client.request<any>("submit", {
      model_selection: MODEL,
      session_id: sessionId,
      request_id: "r1",
      input: "调用慢工具",
    })) as any;
    await waitFor("tools/call 已发出", () => mcp.hits.some((h) => h.rpcMethod === "tools/call"));

    // SIGKILL 后台：在途 MCP 调用结果未落盘
    backend.client.close();
    killProcessTree(backend.child);
    await new Promise<void>((resolve) => {
      backend.child.once("exit", () => resolve());
      setTimeout(resolve, 5000);
    });

    backend = await spawnBackend(dataDir, agentDir);
    const s = await taskStatus(backend.client, task.id);
    assert.equal(s.task.status, "interrupted");
    assert.equal(s.task.interruptReason, "backend_restart");
    const op = s.toolOps.find((o: any) => o.toolName === "mcp_mock_slow");
    assert.ok(op, "在途调用有操作记录");
    assert.equal(op.effectUnknown, true, "结果未落盘的在途调用标 effect_unknown");
    assert.equal(mcp.hits.filter((h) => h.rpcMethod === "tools/call").length, 1, "重启不重放已发出的调用");
  } finally {
    backend.client.close();
    killProcessTree(backend.child);
    await modelServer.close();
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("mcp：断连重放保留服务变更与工具活动事件（脱敏）", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "get_me", result: { content: [{ type: "text", text: "me" }] } }] });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_get_me", arguments: {} }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-reconnect", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const cursor = t.client.getSeq();
    await configureMockService(t, projectId, mcp, { allowlist: ["get_me"] });
    const done = await submitAndWait(t, sessionId, "r1", "查一下");
    assert.equal(done.task.status, "completed");

    // 断开后以旧游标重连：补发事件应含 MCP 服务变更与工具意图/结果
    t.client.close();
    const clientB = await connectAuthedClient(t.runtime);
    const handshake = await clientB.handshake(cursor);
    const types = handshake.replay.map((e: any) => e.body?.type);
    assert.ok(types.includes("mcp.service_changed"), "补发含服务变更事件");
    assert.ok(types.includes("task.tool_intent") && types.includes("task.tool_result"), "补发含工具活动事件");
    const mcpIntent = handshake.replay.find(
      (e: any) => e.body?.type === "task.tool_intent" && String(e.body?.toolName ?? "").startsWith("mcp_"),
    );
    assert.ok(mcpIntent, "补发含 MCP 工具意图");
    assert.ok(!JSON.stringify(handshake.replay).includes(SECRET), "补发事件不含秘密值");
    clientB.close();
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：声明的结构化输出被校验（不匹配即失败）", async () => {
  const mcp = await startMockMcp({
    tools: [
      {
        name: "typed",
        inputSchema: { type: "object", properties: {} },
        result: { content: [{ type: "text", text: "typed ok" }], structuredContent: { count: 1 } },
      },
      {
        name: "lying",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        // 声明 outputSchema 但返回不匹配的 structuredContent → SDK 输出校验拒绝
        result: { content: [{ type: "text", text: "bad" }], structuredContent: { count: "oops" } },
      },
    ],
  });
  const responder: Responder = async (req) => {
    const toolResults = (req.messages as any[]).filter((m) => m.role === "tool").length;
    if (toolResults === 0) return { kind: "tool_calls", calls: [{ id: "c0", name: "mcp_mock_typed", arguments: {} }] };
    if (toolResults === 1) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_lying", arguments: {} }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-outschema", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: ["typed", "lying"], credential: false });
    const done = await submitAndWait(t, sessionId, "r1", "调用两个工具");
    assert.equal(done.task.status, "completed");
    const opOk = done.toolOps.find((o: any) => o.toolName === "mcp_mock_typed");
    const opBad = done.toolOps.find((o: any) => o.toolName === "mcp_mock_lying");
    assert.equal(opOk.isError, false);
    assert.ok(toolResultTexts(t).join("\n").includes('"count": 1'), "匹配的结构化结果正常返回");
    assert.equal(opBad.isError, true, "结构化输出与声明 outputSchema 不匹配即失败");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp：outputSchema 与 inputSchema 同一套预检，钉版为结果校验器（架构工单 05）", () => {
  const bad = validateRemoteTool({ name: "x", inputSchema: { type: "object" }, outputSchema: { type: "array" } as any });
  assert.ok("disabledReason" in bad && /outputSchema 根类型必须是 object/.test(bad.disabledReason));
  const plain = validateRemoteTool({ name: "x", inputSchema: { type: "object" } });
  assert.ok(!("disabledReason" in plain) && plain.checkOutput === undefined, "未声明 outputSchema 不校验");
  const typed = validateRemoteTool({ name: "x", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } });
  assert.ok(!("disabledReason" in typed) && typed.checkOutput);
  assert.equal(typed.checkOutput!({ n: 1 }), true);
  assert.equal(typed.checkOutput!({ n: "1" }), false);
});
