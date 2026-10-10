/**
 * MCP 写工具与统一审批（issue 18）：普通 MCP 工具经统一审批桥逐次授权。
 *
 * - 本地副作用类别：允许列表条目 string = 只读（issue 16 行为），
 *   { name, effect: write|unknown } = confirm/auto-review 逐次审批；远端
 *   readOnly 等注解不作为权限依据；
 * - 批准绑定任务/服务/工具/不可变参数/权限与配置版本；批准后 consumeApproval
 *   单次消费，消费前同事务重读服务配置与凭据绑定；执行参数取自审批快照；
 * - 模拟服务验证（两个服务同名工具、有副作用与副作用不明工具），不触网。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  startTestRuntime,
  createProjectSession,
  waitFor,
  taskStatus,
  writeModelsJson,
  pendingConfirmation,
  type TestRuntime,
} from "./helpers/testkit.ts";
import { startMockMcp, MOCK_MCP_SECRET, type MockMcp, type MockMcpToolSpec } from "./helpers/mock-mcp.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { killProcessTree, spawnBackend } from "./helpers/backend.ts";
import { canonicalParamsDigest } from "@ruukoto/agent/mcp/tools.ts";

const SECRET = MOCK_MCP_SECRET;
const quiet: Responder = async () => ({ kind: "text", text: "done" });
const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } as const;

/** 直接写凭据库（同 24 方式）；scope 由配置入口收紧。 */
function addMcpCredential(t: TestRuntime, host: string, name = "mcp-cred"): void {
  t.runtime.credentials.upsert({ name, host, header: "authorization", purpose: "mcp", secret: SECRET });
}

function eventsOf(t: TestRuntime, type: string): any[] {
  return t.runtime.store.getEventsAfter(0).filter((e) => (e.body as any).type === type).map((e) => e.body);
}

/** 配置一个指向模拟服务的项目内 MCP 服务（含凭据）；允许列表支持副作用类别条目。 */
async function configureMockService(
  t: TestRuntime,
  projectId: string,
  mcp: MockMcp,
  opts: { name?: string; allowlist: unknown[]; credential?: boolean },
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

async function submitAndWait(t: TestRuntime, sessionId: string, requestId: string, input: string, accessMode?: string) {
  const task = (await t.client.request<any>("submit", {
    model_selection: MODEL,
    session_id: sessionId,
    request_id: requestId,
    input,
    ...(accessMode ? { access_mode: accessMode } : {}),
  })) as any;
  await waitFor(`任务终态 ${requestId}`, async () => {
    const s = await taskStatus(t.client, task.id);
    return ["completed", "failed", "interrupted", "canceled"].includes(s.task.status);
  });
  return taskStatus(t.client, task.id);
}

/** 模型首次请求可见的工具名。 */
function offeredToolNames(t: TestRuntime, callIndex = 0): string[] {
  return ((t.server.calls[callIndex]?.tools ?? []) as any[]).map((x) => String(x?.function?.name ?? x?.name ?? ""));
}

function toolCalls(mcp: MockMcp, toolName?: string) {
  return mcp.hits.filter((h) => h.rpcMethod === "tools/call" && (toolName === undefined || h.toolName === toolName));
}

// ---------- 配置面：副作用类别 ----------

test("mcp 写：允许列表携带本地副作用类别（字符串 = 只读；对象显式声明）", async () => {
  const t = await startTestRuntime("mcp-write-cfg", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    const service = (await t.client.request<any>("mcp_configure", {
      project_id: projectId,
      name: "docs",
      endpoint: "https://mcp.example.com/mcp/",
      tool_allowlist: ["get_me", { name: "create_issue", effect: "write" }, { name: "sync", effect: "unknown" }],
    })) as any;
    assert.deepEqual(service.toolAllowlist, ["get_me", { name: "create_issue", effect: "write" }, { name: "sync", effect: "unknown" }]);
    assert.ok(!JSON.stringify(service).includes(SECRET));

    // 非法条目：坏 effect、空名、同名类别冲突、超长
    const base = { project_id: projectId, name: "docs", endpoint: "https://mcp.example.com/mcp/" };
    const rejected: Array<[string, unknown[]]> = [
      ["effect 非法", [{ name: "a", effect: "maybe" }]],
      ["对象缺 name", [{ effect: "write" }]],
      ["同名类别冲突", ["a", { name: "a", effect: "write" }]],
      ["工具名超长", ["x".repeat(129)]],
      ["条目类型非法", [42]],
    ];
    for (const [desc, tool_allowlist] of rejected) {
      await assert.rejects(t.client.request("mcp_configure", { ...base, tool_allowlist }), /./, desc);
    }

    // 同名同类别去重（幂等）
    const deduped = (await t.client.request<any>("mcp_configure", {
      ...base,
      tool_allowlist: ["a", "a", { name: "b", effect: "write" }, { name: "b", effect: "write" }],
    })) as any;
    assert.deepEqual(deduped.toolAllowlist, ["a", { name: "b", effect: "write" }]);
  } finally {
    await t.shutdown();
  }
});

test("mcp 写：mcp check 标注每个工具的副作用类别", async () => {
  const mcp = await startMockMcp({
    tools: [
      { name: "get_me", description: "只读" },
      { name: "create_issue", description: "写" },
      { name: "mystery", description: "副作用不明" },
      { name: "not_allowed", description: "未允许" },
    ],
  });
  const t = await startTestRuntime("mcp-write-check", quiet);
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    addMcpCredential(t, mcp.host);
    const service = (await t.client.request<any>("mcp_configure", {
      project_id: projectId,
      name: "mock",
      endpoint: mcp.url,
      credential: "mcp-cred",
      tool_allowlist: ["get_me", { name: "create_issue", effect: "write" }, { name: "mystery", effect: "unknown" }],
    })) as any;
    const ok = (await t.client.request<any>("mcp_check", { service_id: service.id })) as any;
    assert.equal(ok.ok, true);
    assert.deepEqual(
      ok.tools.map((x: any) => [x.name, x.allowed, x.effect ?? null]),
      [
        ["get_me", true, "read"],
        ["create_issue", true, "write"],
        ["mystery", true, "unknown"],
        ["not_allowed", false, null],
      ],
    );
    assert.ok(!JSON.stringify(ok).includes(SECRET));
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

// ---------- 统一审批：写工具与副作用不明工具 ----------

test("mcp 写：confirm 模式写工具批准前零调用，批准后按批准参数执行一次", async () => {
  const mcp = await startMockMcp({
    requireAuth: true,
    tools: [
      {
        name: "create_issue",
        description: "创建 issue",
        inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] },
        result: { content: [{ type: "text", text: "created:#7" }] },
      },
    ],
  });
  const args = { title: "发布计划", body: "正文内容" };
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: args }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-approve", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const service = await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }] });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建一个 issue" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);

    // 审批范围：服务/配置版本/远端工具/工具定义版本/参数摘要/凭据引用名/操作类别
    assert.equal(conf.toolName, "mcp_mock_create_issue");
    assert.equal(conf.scope.kind, "mcp_tool");
    assert.equal(conf.scope.serviceId, service.id);
    assert.equal(conf.scope.serviceName, "mock");
    assert.equal(conf.scope.endpoint, mcp.url);
    assert.equal(conf.scope.configVersion, service.configVersion);
    assert.equal(conf.scope.remoteName, "create_issue");
    assert.equal(typeof conf.scope.toolSignature, "string");
    assert.equal(conf.scope.paramsSha256, canonicalParamsDigest(args));
    assert.equal(conf.scope.credential, "mcp-cred-mock", "凭据只出现引用名");
    assert.equal(conf.scope.operationCategory, "write");
    assert.deepEqual(conf.params, args, "审批保存不可变参数");
    assert.equal(toolCalls(mcp).length, 0, "批准前不得发送网络请求");
    assert.equal((await taskStatus(t.client, task.id)).task.status, "awaiting_confirmation");

    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("任务完成", async () => ["completed", "failed"].includes((await taskStatus(t.client, task.id)).task.status));
    const final = await taskStatus(t.client, task.id);
    assert.equal(final.task.status, "completed");

    // 恰好一次调用，参数与批准快照一致，携带凭据
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "批准后只执行一次");
    assert.deepEqual(toolCalls(mcp, "create_issue")[0]!.args, args, "执行参数来自批准的不可变快照");
    assert.ok(toolCalls(mcp)[0]!.hasAuth, "请求携带凭据");

    const op = final.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.equal(op.isError, false);
    const consumed = final.confirmations.find((c: any) => c.id === conf.id);
    assert.equal(consumed.status, "approved");
    assert.ok(consumed.consumedAt, "批准已单次消费");
    assert.equal(final.task.effectUnknown, false);

    // 脱敏：审批、操作记录、事件均不含秘密值
    assert.ok(!JSON.stringify(final).includes(SECRET), "任务详情不含秘密值");
    assert.ok(!JSON.stringify(eventsOf(t, "task.awaiting_confirmation")).includes(SECRET), "事件不含秘密值");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：拒绝执行零次，操作已知未执行", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue", result: { content: [{ type: "text", text: "created" }] } }] });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
    return { kind: "text", text: "按拒绝结果继续" };
  };
  const t = await startTestRuntime("mcp-write-reject", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);
    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "reject" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    const final = await taskStatus(t.client, task.id);
    assert.equal(toolCalls(mcp).length, 0, "拒绝的操作不得执行");
    const op = final.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.equal(op.isError, true);
    assert.match(op.resultSummary, /拥有者拒绝/);
    assert.equal(final.task.effectUnknown, false, "拒绝 = 已知未执行");
    assert.equal(final.confirmations[0].consumedAt, null, "拒绝的批准不消费");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：重复响应只有一次成功，操作只执行一次", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue" }] });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-dupe", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);
    const results = await Promise.allSettled([
      t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" }),
      t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "重复响应只有一次成功");
    assert.equal(rejected.length, 1);
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /失效|stale/);

    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "批准最多发送一次");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：批准等待期间配置变化，旧批准失效且不发送", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue" }] });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-stale", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const service = await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);

    // 批准等待期间拥有者变更配置（版本递增）→ 旧批准不得消费
    await t.client.request("mcp_configure", {
      project_id: projectId,
      name: "mock",
      endpoint: mcp.url,
      tool_allowlist: [{ name: "create_issue", effect: "write" }],
      expected_version: service.configVersion,
    });
    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    const final = await taskStatus(t.client, task.id);
    assert.equal(toolCalls(mcp).length, 0, "配置变化后旧批准不得发送");
    const op = final.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.equal(op.isError, true);
    assert.match(op.resultSummary, /配置已变化/, "应说明配置变化导致未执行");
    const staleConf = final.confirmations.find((c: any) => c.id === conf.id);
    assert.equal(staleConf.consumedAt, null, "失效批准不得消费");
    assert.equal(staleConf.status, "stale", "复核失败的批准标为失效（架构工单 04）");
    assert.equal(final.task.effectUnknown, false, "未消费 = 已知未执行");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：不同参数的再次调用需要新的审批（批准不复用）", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue" }] });
  const responder: Responder = async (req) => {
    const done = req.messages.filter((m: any) => m?.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "第一" } }] };
    if (done === 1) return { kind: "tool_calls", calls: [{ id: "c2", name: "mcp_mock_create_issue", arguments: { title: "第二" } }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-no-reuse", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建两个 issue" })) as any;
    const first = await pendingConfirmation(t.client, task.id);
    assert.equal(first.scope.paramsSha256, canonicalParamsDigest({ title: "第一" }));
    await t.client.request("respond_confirmation", { confirmation_id: first.id, decision: "approve" });

    const second = await pendingConfirmation(t.client, task.id, [first.id]);
    assert.notEqual(second.id, first.id, "参数变化必须重新申请");
    assert.equal(second.scope.paramsSha256, canonicalParamsDigest({ title: "第二" }));
    await t.client.request("respond_confirmation", { confirmation_id: second.id, decision: "approve" });

    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    const calls = toolCalls(mcp, "create_issue");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => (c.args as any).title), ["第一", "第二"], "各次按各自批准的参数执行");
    const final = await taskStatus(t.client, task.id);
    assert.equal(final.confirmations.filter((c: any) => c.consumedAt !== null).length, 2, "两次批准各自单次消费");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：full_access 跳过逐次审批，但不越过允许列表", async () => {
  const mcp = await startMockMcp({
    tools: [
      { name: "create_issue", result: { content: [{ type: "text", text: "created" }] } },
      { name: "delete_all", description: "未允许的写工具" },
    ],
  });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-full", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const done = await submitAndWait(t, sessionId, "r1", "创建 issue", "full_access");
    assert.equal(done.task.status, "completed");
    assert.equal(done.confirmations.length, 0, "full_access 不产生逐次审批");
    assert.equal(toolCalls(mcp, "create_issue").length, 1);
    const offered = offeredToolNames(t);
    assert.ok(offered.includes("mcp_mock_create_issue"));
    assert.ok(!offered.some((n) => n.includes("delete_all")), "未允许的工具不注册（full_access 不越过服务范围）");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：auto-review 一律转拥有者（不扩大自动批准范围）", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue" }] });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-autoreview", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue", access_mode: "auto-review" })) as any;
    // 自动审查对 mcp_tool 范围直接转人工：审批保持 pending，等待拥有者
    let conf: any = null;
    await waitFor("审查转人工", async () => {
      const s = await taskStatus(t.client, task.id);
      conf = s.confirmations.find((c: any) => c.reviewStatus === "asked_owner" && c.status === "pending") ?? null;
      return conf !== null;
    });
    assert.equal(conf.scope.kind, "mcp_tool");
    assert.equal(toolCalls(mcp).length, 0, "转人工前不得发送");
    assert.ok(eventsOf(t, "task.confirmation_reviewed").length >= 1, "应有转人工事件");

    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "拥有者批准后执行一次");
    const final = await taskStatus(t.client, task.id);
    assert.equal(final.confirmations[0].decisionSource, "owner", "最终批准者是拥有者");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：副作用不明工具默认逐次审批；两个服务同名工具各自独立", async () => {
  const mcpA = await startMockMcp({ tools: [{ name: "post_comment", result: { content: [{ type: "text", text: "posted-A" }] } }] });
  const mcpB = await startMockMcp({ tools: [{ name: "post_comment", result: { content: [{ type: "text", text: "posted-B" }] } }] });
  const responder: Responder = async (req) => {
    const done = req.messages.filter((m: any) => m?.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_alt_post_comment", arguments: { text: "hi" } }] };
    if (done === 1) return { kind: "tool_calls", calls: [{ id: "c2", name: "mcp_mock_post_comment", arguments: { text: "hi" } }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-twosvc", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 同名工具：mock 服务声明 write，alt 服务声明 unknown（副作用不明默认审批）
    await configureMockService(t, projectId, mcpA, { name: "mock", allowlist: [{ name: "post_comment", effect: "write" }], credential: false });
    await configureMockService(t, projectId, mcpB, { name: "alt", allowlist: [{ name: "post_comment", effect: "unknown" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "两个服务各发一次评论" })) as any;

    // alt（unknown 类别）：审批范围标明副作用不明
    const confB = await pendingConfirmation(t.client, task.id);
    assert.equal(confB.toolName, "mcp_alt_post_comment");
    assert.equal(confB.scope.serviceName, "alt");
    assert.equal(confB.scope.operationCategory, "unknown");
    await t.client.request("respond_confirmation", { confirmation_id: confB.id, decision: "approve" });

    const confA = await pendingConfirmation(t.client, task.id, [confB.id]);
    assert.equal(confA.toolName, "mcp_mock_post_comment");
    assert.equal(confA.scope.serviceName, "mock");
    assert.equal(confA.scope.operationCategory, "write");
    await t.client.request("respond_confirmation", { confirmation_id: confA.id, decision: "approve" });

    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    assert.equal(toolCalls(mcpA, "post_comment").length, 1, "批准 mock 只发 mock");
    assert.equal(toolCalls(mcpB, "post_comment").length, 1, "批准 alt 只发 alt");
  } finally {
    await t.shutdown();
    await mcpA.close();
    await mcpB.close();
  }
});

test("mcp 写：规范化参数摘要键序稳定", () => {
  assert.equal(
    canonicalParamsDigest({ a: 1, b: { c: 2, d: [3, 4] } }),
    canonicalParamsDigest({ b: { d: [3, 4], c: 2 }, a: 1 }),
    "键序不影响摘要",
  );
  assert.notEqual(canonicalParamsDigest({ a: 1 }), canonicalParamsDigest({ a: 2 }));
});

// ---------- 生命周期：取消、断线与崩溃恢复（effect_unknown 语义） ----------

test("mcp 写：审批等待中取消任务 —— 零调用、已知未执行、审批失效", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue" }] });
  const responder: Responder = async () => ({ kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] });
  const t = await startTestRuntime("mcp-write-cancel-pending", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);
    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务中断", async () => ["interrupted", "canceled"].includes((await taskStatus(t.client, task.id)).task.status));

    const final = await taskStatus(t.client, task.id);
    assert.equal(toolCalls(mcp).length, 0, "取消等待中的审批不发送请求");
    const staleConf = final.confirmations.find((c: any) => c.id === conf.id);
    assert.equal(staleConf.status, "stale", "取消后未决审批失效");
    assert.equal(staleConf.consumedAt, null);
    const op = final.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.equal(op.isError, true);
    assert.match(op.resultSummary, /未执行/, "未消费的批准 = 已知未执行");
    assert.equal(op.effectUnknown, false);
    assert.equal(final.task.effectUnknown, false);

    // 迟到的批准被拒绝，不触发执行
    await assert.rejects(
      t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" }),
      /失效|stale/,
    );
    assert.equal(toolCalls(mcp).length, 0, "迟到批准不得执行");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：在途写调用取消（批准已消费）—— effect_unknown，不重发", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue", delayMs: 30_000 }] });
  const responder: Responder = async () => ({ kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] });
  const t = await startTestRuntime("mcp-write-cancel-flight", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);
    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("tools/call 已发出", () => toolCalls(mcp, "create_issue").length === 1);

    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务中断", async () => ["interrupted", "canceled"].includes((await taskStatus(t.client, task.id)).task.status));

    const final = await taskStatus(t.client, task.id);
    const op = final.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.ok(op, "在途调用有操作记录");
    assert.equal(op.effectUnknown, true, "已消费批准的在途调用 = 效果不明");
    assert.equal(final.task.effectUnknown, true);
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "取消后不重发");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

// ---------- 后台崩溃重启（真实子进程 + SIGKILL） ----------

const CRASH_MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } as const;

async function crashSetup(prefix: string, mcp: MockMcp) {
  const modelServer = new MockModelServer(async () => ({
    kind: "tool_calls",
    calls: [{ id: "c0", name: "mcp_mock_create_issue", arguments: { title: "崩溃验证" } }],
  }));
  const baseUrl = await modelServer.start();
  try {
    // macOS Unix socket 路径上限 104 字符：临时目录前缀必须短
    const root = await mkdtemp(path.join(tmpdir(), `rk-${prefix}-`));
    const dataDir = path.join(root, "data");
    const agentDir = path.join(root, "agent");
    const workDir = path.join(root, "work");
    await mkdir(dataDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeModelsJson({ root, dataDir, agentDir }, baseUrl);
    const backend = await spawnBackend(dataDir, agentDir);
    const { projectId, sessionId } = await createProjectSession(backend.client, workDir);
    await backend.client.request("mcp_configure", {
      project_id: projectId,
      name: "mock",
      endpoint: mcp.url,
      tool_allowlist: [{ name: "create_issue", effect: "write" }],
    });
    return { modelServer, root, dataDir, agentDir, backend, sessionId };
  } catch (err) {
    // 建立失败时回收已开的模型服务，避免悬挂测试进程
    await modelServer.close().catch(() => {});
    throw err;
  }
}

test("mcp 写：崩溃重启 —— 已消费的在途写调用标 effect_unknown，不重放", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue", delayMs: 30_000 }] });
  const ctx = await crashSetup("mcp-write-crash-sent", mcp);
  let backend = ctx.backend;
  try {
    const task = (await backend.client.request<any>("submit", {
      model_selection: CRASH_MODEL,
      session_id: ctx.sessionId,
      request_id: "r1",
      input: "创建 issue",
    })) as any;
    // 批准并等待调用实际发出（批准已消费、结果未落盘的崩溃窗口）
    let conf: any = null;
    await waitFor("出现待审批", async () => {
      const s = await taskStatus(backend.client, task.id);
      conf = s.confirmations.find((c: any) => c.status === "pending") ?? null;
      return conf !== null;
    });
    await backend.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("tools/call 已发出", () => toolCalls(mcp, "create_issue").length === 1);

    backend.client.close();
    killProcessTree(backend.child);
    await new Promise<void>((resolve) => {
      backend.child.once("exit", () => resolve());
      setTimeout(resolve, 5000);
    });

    backend = await spawnBackend(ctx.dataDir, ctx.agentDir);
    const s = await taskStatus(backend.client, task.id);
    assert.equal(s.task.status, "interrupted");
    assert.equal(s.task.interruptReason, "backend_restart");
    const op = s.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.ok(op, "在途写调用有操作记录");
    assert.equal(op.effectUnknown, true, "批准已消费且结果未落盘 → effect_unknown");
    const crashedConf = s.confirmations.find((c: any) => c.id === conf.id);
    assert.ok(crashedConf.consumedAt, "批准已消费的事实保留");
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "重启不重放已发出的写调用");
  } finally {
    backend.client.close();
    killProcessTree(backend.child);
    await ctx.modelServer.close();
    await mcp.close();
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("mcp 写：崩溃重启 —— 审批待决未消费 = 已知未执行，不标 effect_unknown", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue" }] });
  const ctx = await crashSetup("mcp-write-crash-pending", mcp);
  let backend = ctx.backend;
  try {
    const task = (await backend.client.request<any>("submit", {
      model_selection: CRASH_MODEL,
      session_id: ctx.sessionId,
      request_id: "r1",
      input: "创建 issue",
    })) as any;
    // 等审批待决落盘后在批准前崩溃（批准未消费 = 已知未执行）
    let conf: any = null;
    await waitFor("出现待审批", async () => {
      const s = await taskStatus(backend.client, task.id);
      conf = s.confirmations.find((c: any) => c.status === "pending") ?? null;
      return conf !== null;
    });

    backend.client.close();
    killProcessTree(backend.child);
    await new Promise<void>((resolve) => {
      backend.child.once("exit", () => resolve());
      setTimeout(resolve, 5000);
    });

    backend = await spawnBackend(ctx.dataDir, ctx.agentDir);
    const s = await taskStatus(backend.client, task.id);
    assert.equal(s.task.status, "interrupted");
    const op = s.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.ok(op);
    assert.match(op.resultSummary ?? "", /已知未执行/, "审批未消费即重启 = 已知未执行");
    assert.equal(op.effectUnknown, false);
    assert.equal(s.task.effectUnknown, false);
    const crashedConf = s.confirmations.find((c: any) => c.id === conf.id);
    assert.equal(crashedConf.status, "stale", "重启后未决审批失效");
    assert.equal(crashedConf.consumedAt, null);
    assert.equal(toolCalls(mcp).length, 0, "未消费的批准不发送、不重放");
  } finally {
    backend.client.close();
    killProcessTree(backend.child);
    await ctx.modelServer.close();
    await mcp.close();
    await rm(ctx.root, { recursive: true, force: true });
  }
});

// ---------- 结果无法确认的写调用：effect_unknown（issue 18 §3） ----------

test("mcp 写：已发送写调用断线 —— 结果无法确认标 effect_unknown，不重发", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue" }], dropOnCall: true });
  const responder: Responder = async (_req, callIndex) => {
    if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-drop", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);
    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    const final = await taskStatus(t.client, task.id);
    const op = final.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.equal(op.isError, true, "断线是失败结果");
    assert.equal(op.effectUnknown, true, "已发送写调用断线 = 结果无法确认");
    assert.equal(final.task.effectUnknown, true, "任务保留效果不明事实");
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "断线不自动重发");
    assert.ok(eventsOf(t, "task.tool_effect_unknown").some((e) => e.toolOpId === op.id), "应有 effect_unknown 事件");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：已发送写调用超时 —— effect_unknown；只读超时只是普通失败", async () => {
  const mcp = await startMockMcp({
    tools: [
      { name: "create_issue", delayMs: 5000 },
      { name: "get_me", delayMs: 5000, result: { content: [{ type: "text", text: "me" }] } },
    ],
  });
  const responder: Responder = async (req) => {
    const done = req.messages.filter((m: any) => m?.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
    if (done === 1) return { kind: "tool_calls", calls: [{ id: "c2", name: "mcp_mock_get_me", arguments: {} }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-timeout", responder, { config: { mcp: { callTimeoutMs: 300 } } });
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }, "get_me"], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "先写后读" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);
    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);

    const final = await taskStatus(t.client, task.id);
    const writeOp = final.toolOps.find((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.equal(writeOp.isError, true);
    assert.match(writeOp.resultSummary, /超时/);
    assert.equal(writeOp.effectUnknown, true, "写调用超时 = 结果无法确认");
    const readOp = final.toolOps.find((o: any) => o.toolName === "mcp_mock_get_me");
    assert.equal(readOp.isError, true);
    assert.equal(readOp.effectUnknown, false, "只读调用超时无外部副作用，只是已知失败");
    assert.equal(final.task.effectUnknown, true);
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "超时不重发");
    assert.equal(toolCalls(mcp, "get_me").length, 1);
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：审批等待中切换模式 —— 旧审批失效不执行，切换后按新模式执行", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "create_issue" }] });
  const responder: Responder = async (req) => {
    // 两次工具结果（第一次=审批失效，第二次=切换后执行）后收尾
    if (req.messages.filter((m: any) => m?.role === "tool").length >= 2) return { kind: "text", text: "完成" };
    return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
  };
  const t = await startTestRuntime("mcp-write-modeswitch", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue" })) as any;
    const conf = await pendingConfirmation(t.client, task.id);

    // 等待期间拥有者切换到 full_access：待决审批立即失效（不自动执行旧操作）
    await t.client.request("switch_mode", { task_id: task.id, mode: "full_access" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    const final = await taskStatus(t.client, task.id);
    const staleConf = final.confirmations.find((c: any) => c.id === conf.id);
    assert.equal(staleConf.status, "stale", "模式切换使待决审批失效");
    assert.equal(staleConf.consumedAt, null);
    const ops = final.toolOps.filter((o: any) => o.toolName === "mcp_mock_create_issue");
    assert.equal(ops.length, 2);
    assert.equal(ops[0].isError, true);
    assert.match(ops[0].resultSummary, /审批已失效/, "旧待批准操作不自动执行");
    assert.equal(ops[1].isError, false, "切换后按 full_access 直接执行");
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "只有切换后的调用真正发送");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("mcp 写：工具定义变化 → 下一任务钉版新签名（旧批准不跨任务复用）", async () => {
  const toolSpec: MockMcpToolSpec = {
    name: "create_issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  };
  const mcp = await startMockMcp({ tools: [toolSpec] });
  // 每个任务的首轮（最后一条是 user 输入）调用写工具；工具结果返回后收尾
  const responder: Responder = async (req) => {
    if (req.messages.at(-1)?.role === "user") {
      return { kind: "tool_calls", calls: [{ id: "c1", name: "mcp_mock_create_issue", arguments: { title: "x" } }] };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-defchange", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, { allowlist: [{ name: "create_issue", effect: "write" }], credential: false });

    // 任务 1：拒绝（保留未消费批准）；记录工具定义版本
    const task1 = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "创建 issue" })) as any;
    const conf1 = await pendingConfirmation(t.client, task1.id);
    const signatureV1 = conf1.scope.toolSignature;
    await t.client.request("respond_confirmation", { confirmation_id: conf1.id, decision: "reject" });
    await waitFor("任务 1 完成", async () => (await taskStatus(t.client, task1.id)).task.status === "completed");

    // 远端工具定义变化（schema 增加字段）：任务 2 重新发现，钉版新签名
    toolSpec.inputSchema = { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] };
    const task2 = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r2", input: "再创建 issue" })) as any;
    const conf2 = await pendingConfirmation(t.client, task2.id);
    assert.notEqual(conf2.scope.toolSignature, signatureV1, "工具定义变化产生新的定义版本");
    assert.notEqual(conf2.id, conf1.id, "新调用必须重新申请（批准绑定任务与不可变参数）");

    await t.client.request("respond_confirmation", { confirmation_id: conf2.id, decision: "approve" });
    await waitFor("任务 2 完成", async () => (await taskStatus(t.client, task2.id)).task.status === "completed");
    assert.equal(toolCalls(mcp, "create_issue").length, 1, "只有任务 2 的批准被执行");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

// ---------- 远端已应答的错误是已知结果（架构工单 05） ----------

test("mcp 写：远端 JSON-RPC 错误应答记已知错误；结构化结果不符 schema 写明远端已执行，都不标 effect_unknown", async () => {
  const mcp = await startMockMcp({
    tools: [
      { name: "bad_args", rpcError: { code: -32602, message: "invalid params: title required" } },
      {
        name: "typed_write",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
        result: { content: [{ type: "text", text: "created" }], structuredContent: { id: "oops" } },
      },
    ],
  });
  const calls = ["mcp_mock_bad_args", "mcp_mock_typed_write"];
  const responder: Responder = async (req) => {
    const done = (req.messages as any[]).filter((m) => m.role === "tool").length;
    return done < calls.length ? { kind: "tool_calls", calls: [{ id: `c${done}`, name: calls[done]!, arguments: {} }] } : { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("mcp-write-remote-error", responder);
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    await configureMockService(t, projectId, mcp, {
      allowlist: [{ name: "bad_args", effect: "write" }, { name: "typed_write", effect: "write" }],
      credential: false,
    });
    const task = (await t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: "r1", input: "两次写" })) as any;
    const seen: string[] = [];
    for (let i = 0; i < calls.length; i++) {
      const conf = await pendingConfirmation(t.client, task.id, seen);
      seen.push(conf.id);
      await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    }
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    const final = await taskStatus(t.client, task.id);
    const badArgs = final.toolOps.find((o: any) => o.toolName === "mcp_mock_bad_args");
    const typed = final.toolOps.find((o: any) => o.toolName === "mcp_mock_typed_write");
    assert.equal(badArgs.isError, true);
    assert.equal(badArgs.effectUnknown, false, "远端已应答的错误是已知结果");
    assert.match(badArgs.resultSummary, /MCP 服务返回错误（-32602）/);
    assert.equal(typed.isError, true, "结构化结果不符 schema 仍算失败");
    assert.equal(typed.effectUnknown, false, "远端成功应答即已执行，不是效果未知");
    assert.match(typed.resultSummary, /远端已执行/);
    assert.equal(final.task.effectUnknown, false);
    assert.equal(toolCalls(mcp, "typed_write").length, 1, "不自动重发");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});
