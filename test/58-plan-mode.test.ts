import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";
/**
 * issue 31：持续的 Plan 选择、固定 Auto review、工具白名单、适用会话与继续时选择。
 * TUI 的 /mode、未知 /plan 与状态栏见 test/14-tui-app.test.ts。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { startMockMcp } from "./helpers/mock-mcp.ts";
import type { RecordedRequest, Responder } from "./helpers/mock-provider.ts";
import { createProjectSession, lastUserText, realTools, startTestRuntime, taskStatus, waitFor, type TestRuntime } from "./helpers/testkit.ts";
import { legacyGroupArchive } from "./helpers/legacy-group-archive.ts";
import { seedCodingRole } from "./helpers/legacy-coding.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
const TERMINAL = ["completed", "failed", "interrupted", "canceled"];
const WRITE_TOOLS = ["edit", "write", "memory_save", "memory_revoke", "mcp_svc_put", "mcp_svc_odd"];

const toolNames = (req: RecordedRequest): string[] => (req.tools ?? []).map((t: any) => t?.function?.name ?? t?.name);
const hasPlanPrefix = (req: RecordedRequest) => JSON.stringify(req.messages).includes("[计划模式");
const toolResultsSinceUser = (req: RecordedRequest) => {
  const last = req.messages.map((m) => m.role).lastIndexOf("user");
  return req.messages.slice(last + 1).filter((m) => m.role === "tool").length;
};
const callFor = (t: TestRuntime, input: string) => t.server.calls.find((c) => lastUserText(c) === input)!;

async function submit(t: TestRuntime, sessionId: string, requestId: string, input: string, extra: Record<string, unknown> = {}): Promise<any> {
  return t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: requestId, input, ...extra });
}

async function waitDone(t: TestRuntime, taskId: string): Promise<any> {
  await waitFor("任务终态", async () => TERMINAL.includes((await taskStatus(t.client, taskId)).task.status), 60_000);
  return taskStatus(t.client, taskId);
}

async function planModeTokens(t: TestRuntime, sessionId: string, taskId: string): Promise<{ label: string; tokens: number }> {
  const record = (t.runtime.listSelectionRecords({ taskId }) as any[])[0];
  const breakdown = await t.client.request<any>("get_context_breakdown", { session_id: sessionId, record_id: record.id });
  return breakdown.breakdown.categories.find((c: any) => c.key === "planMode");
}

test("集成：Plan 连续消息保持计划说明、白名单与阻断，手动切换才恢复执行", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "get" }, { name: "put" }, { name: "odd" }] });
  let driver: any;
  let forged = false;
  const steps = [
    { id: "r", name: "read", arguments: { path: "notes.txt" } },
    { id: "b", name: "bash", arguments: { command: "echo PLAN-BASH" } },
    { id: "m", name: "mcp_svc_get", arguments: {} },
  ];
  const responder: Responder = async (req) => {
    if (lastUserText(req) !== "调研登录流程") return { kind: "text", text: "好的" };
    const step = toolResultsSinceUser(req);
    if (step === 0) {
      // 越过 SDK 可见工具直接注入调用：调用门阻断且不登记意图
      for (const toolName of WRITE_TOOLS) {
        const blocked = await driver.handleToolCall({ type: "tool_call", toolCallId: `forge-${toolName}`, toolName, input: {} });
        assert.equal(blocked?.block, true, toolName);
        assert.match(blocked.reason, /任务工具白名单/);
      }
      forged = true;
    }
    return step < steps.length ? { kind: "tool_calls", calls: [steps[step]!] } : { kind: "text", text: "计划：1. 修改 a.ts" };
  };
  const t = await startTestRuntime("plan-tools", responder, { workDirs: 1, config: realTools() });
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    fs.writeFileSync(path.join(t.work[0]!, "notes.txt"), "PLAN-NOTES\n");
    await t.client.request("mcp_configure", {
      project_id: projectId, name: "svc", endpoint: mcp.url,
      tool_allowlist: ["get", { name: "put", effect: "write" }, { name: "odd", effect: "unknown" }],
    });
    driver = await (t.runtime as any).getDriver(t.runtime.store.getSession(sessionId));

    await t.client.request("set_session_mode", { session_id: sessionId, mode: "plan", expected_version: 0 });
    const plan = await submit(t, sessionId, "p1", "调研登录流程");
    assert.equal((await submit(t, sessionId, "p1", "调研登录流程")).id, plan.id, "同键重试返回原任务");
    const done = await waitDone(t, plan.id);
    assert.equal(done.task.status, "completed", done.task.errorMessage ?? done.task.interruptReason ?? "");
    assert.equal(forged, true);
    assert.equal(done.task.input, "调研登录流程", "任务输入照原样保存");
    assert.equal(done.task.accessMode, "auto-review");
    assert.equal(done.task.planMode, true);
    assert.deepEqual(done.toolOps.map((o: any) => [o.toolName, o.isError]), [["read", false], ["bash", false], ["mcp_svc_get", false]]);
    assert.match(done.toolOps[0].resultSummary, /PLAN-NOTES/);
    assert.match(done.toolOps[1].resultSummary, /PLAN-BASH/);
    assert.equal(t.runtime.store.listTasksBySession(sessionId).length, 1, "只有一个任务");

    const planCall = callFor(t, "调研登录流程");
    assert.ok(hasPlanPrefix(planCall), "模型上下文含计划说明前缀");
    assert.deepEqual(toolNames(planCall).sort(), [
      "ask_user", "bash", "history_read", "history_search", "http_request", "list_files", "mcp_svc_get", "memory_list", "memory_read",
      "process_output", "process_status", "process_stop", "read", "read_artifact", "request_file_access", "search_files", "skill", "todo_write", "web_search",
    ], "计划模式只含白名单工具");
    const planCat = await planModeTokens(t, sessionId, plan.id);
    assert.equal(planCat.label, "计划模式");
    assert.ok(planCat.tokens > 0);

    for (const input of ["进一步完善计划", "开始实现"]) {
      const heldPlan = await waitDone(t, (await submit(t, sessionId, input, input)).id);
      assert.equal(heldPlan.task.planMode, true);
      assert.equal(heldPlan.task.accessMode, "auto-review");
      assert.ok(hasPlanPrefix(callFor(t, input)));
      assert.ok(!toolNames(callFor(t, input)).includes("edit"));
      assert.match(JSON.stringify(callFor(t, input).messages), /先提示拥有者切换模式/);
    }
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "full_access", expected_version: 1 });
    assert.equal((await submit(t, sessionId, "p1", "调研登录流程")).id, plan.id, "默认值改变后原请求重试仍返回原任务");
    const next = await waitDone(t, (await submit(t, sessionId, "n1", "按计划执行")).id);
    assert.equal(next.task.status, "completed");
    const nextCall = callFor(t, "按计划执行");
    assert.ok(!hasPlanPrefix(nextCall), "手动切换后没有计划说明");
    for (const name of WRITE_TOOLS) assert.ok(toolNames(nextCall).includes(name), `工具集恢复 ${name}`);
    assert.equal((await planModeTokens(t, sessionId, next.task.id)).tokens, 0);

    // SDK 向发送载荷泄漏写工具：发送前最终检查阻断整个请求
    const sdk = driver.sdk;
    const setActive = sdk.setActiveToolsByName.bind(sdk);
    sdk.setActiveToolsByName = (names: string[]) => setActive([...names, "edit"]);
    const before = t.server.calls.length;
    const leaked = await waitDone(t, (await submit(t, sessionId, "p2", "再调研", { access_mode: "plan" })).id);
    assert.equal(leaked.task.status, "interrupted");
    assert.match(leaked.task.interruptReason, /^task_tools_forbidden:.*edit/);
    assert.equal(t.server.calls.length, before, "越权工具定义没有发送给模型");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("集成：Plan 固定 Auto review，越界文件与 HTTP 读取经独立审查，审批与 Auto review 一致", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-plan-")));
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "OUTSIDE-VALUE\n");
  const service = http.createServer((_req, res) => res.end("REMOTE-VALUE"));
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(service.address() as AddressInfo).port}/data`;
  const responder: Responder = async (req) => {
    if (lastUserText(req).includes("审批审查")) return { kind: "text", text: '{"decision":"approve","reason":"与拥有者请求直接相关的读取"}' };
    const step = toolResultsSinceUser(req);
    if (step === 0) return { kind: "tool_calls", calls: [{ id: "f", name: "request_file_access", arguments: { path: outside, operation: "read", reason: "查看外部配置" } }] };
    if (step === 1) return { kind: "tool_calls", calls: [{ id: "h", name: "http_request", arguments: { method: "GET", url, reason: "获取数据" } }] };
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("plan-approvals", responder, { workDirs: 1, config: realTools() });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const run = async (requestId: string, input: string, mode: string) => {
      const task = await submit(t, sessionId, requestId, input, { access_mode: mode });
      let detail: any;
      await waitFor(`${requestId} 终态`, async () => {
        detail = await taskStatus(t.client, task.id);
        return TERMINAL.includes(detail.task.status);
      }, 60_000);
      assert.equal(detail.task.status, "completed", detail.task.errorMessage ?? detail.task.interruptReason ?? "");
      assert.equal(detail.task.accessMode, "auto-review");
      assert.equal(detail.task.planMode, mode === "plan");
      return {
        confirmations: detail.confirmations.map((c: any) => [c.toolName, c.status, c.decisionSource]),
        ops: detail.toolOps.map((o: any) => [o.toolName, o.isError]),
      };
    };
    const plan = await run("p", "调研外部配置", "plan");
    const normal = await run("n", "调研外部配置", "auto-review");
    assert.deepEqual(plan, normal, "Plan 复用 Auto review 审批策略");
    assert.deepEqual(plan.confirmations, [["request_file_access", "approved", "auto_review"], ["http_request", "approved", "auto_review"]]);
    assert.deepEqual(plan.ops, [["request_file_access", false], ["http_request", false]]);
    const reviewCalls = t.server.calls.filter((c) => lastUserText(c).includes("审批审查"));
    assert.equal(reviewCalls.length, 4);
    assert.ok(reviewCalls.every((c) => c.tools === undefined), "独立审查无工具");
  } finally {
    await t.shutdown();
    await new Promise<void>((resolve) => service.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("集成：Plan 只允许普通开发会话，main 与 IM 的 /plan 是普通文本", async () => {
  const t = await startTestRuntime("plan-sessions", async () => ({ kind: "text", text: "好的" }));
  try {
    const rt = t.runtime;
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const archive = legacyGroupArchive({ store: rt.store, qq: rt.qqStore, workRoot: t.dirs.root });
    archive.seedChatRole();
    const group = archive.seedGroup({ groupId: "100001" });
    const coding = seedCodingRole(rt.store, t.dirs.root);
    const mainId = rt.store.getAgentRole("main")!.sessionId;
    const child = await rt.createSession({ projectName: "child", cwd: t.work[1]! });
    rt.store.insertSubAgent({ definition: fixtureSubAgentDefinition(), id: "plan-child", parentSessionId: sessionId, sessionId: child.id, workDir: child.cwd, activeWorkId: null, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: child.createdAt });
    for (const id of [mainId, rt.store.getAgentRole("chat")!.sessionId, coding.sessionId, group.session.id, child.id]) {
      const before = rt.store.listTasksBySession(id).length;
      const session = rt.store.getSession(id)!;
      await assert.rejects(t.client.request("set_session_mode", { session_id: id, mode: "plan", expected_version: session.defaultAccessModeVersion }));
      await assert.rejects(submit(t, id, "plan", "调研", { access_mode: "plan" }));
      assert.equal(rt.store.listTasksBySession(id).length, before);
      assert.deepEqual(rt.store.getSession(id), session, "被拒设置不改写版本或默认值");
    }
    const ordinary = await waitDone(t, (await submit(t, sessionId, "text", "/plan 调研")).id);
    assert.equal(ordinary.task.planMode, false);
    assert.ok(!hasPlanPrefix(callFor(t, "/plan 调研")));
    const main = await waitDone(t, (await submit(t, mainId, "plain", "/plan main 调研")).id);
    assert.equal(main.task.planMode, false);
    await rt.orchestrator!.registerInboundEvent({ source: "test", externalId: "owner-plan", targetRole: "main", body: "/plan 入站调研" });
    await waitFor("入站任务完成", () => rt.store.listTasksBySession(mainId).some((x) => x.sourceEventId && x.status === "completed"));
    const call = t.server.calls.find((c) => lastUserText(c).startsWith("[入站事件]"))!;
    assert.ok(lastUserText(call).includes("/plan 入站调研"));
    assert.ok(!hasPlanPrefix(call));
  } finally { await t.shutdown(); }
});

test("集成：continue 使用当前默认或显式模式，输入和多级继续链不决定 Plan", async () => {
  const held: Array<() => void> = [];
  const t = await startTestRuntime("plan-continue", async () => {
    await new Promise<void>((resolve) => held.push(resolve));
    return { kind: "text", text: "计划" };
  });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const interrupt = async (task: any, planMode: boolean) => {
      await waitFor(`${task.input} 已发出`, () => t.server.calls.some((c) => lastUserText(c) === task.input));
      const call = callFor(t, task.input);
      assert.equal(task.planMode, planMode);
      assert.equal(hasPlanPrefix(call), planMode);
      assert.equal(toolNames(call).includes("mock_mark"), !planMode);
      await t.client.request("interrupt", { task_id: task.id });
      held.splice(0).forEach((release) => release());
      assert.equal((await waitDone(t, task.id)).task.status, "interrupted");
    };
    const cont = (task: any, input: string, mode?: string) => t.client.request<any>("continue", {
      task_id: task.id, session_id: sessionId, request_id: input, input, model_selection: MODEL,
      ...(mode ? { access_mode: mode } : {}),
    });
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "plan", expected_version: 0 });
    const a = await submit(t, sessionId, "a", "长调研");
    await interrupt(a, true);
    const b = await cont(a, "保持 Plan 继续");
    await interrupt(b, true);
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "full_access", expected_version: 1 });
    assert.equal((await cont(a, "保持 Plan 继续")).id, b.id, "continue 重试不随默认值漂移");
    const c = await cont(b, "切换后执行");
    assert.equal(c.accessMode, "full_access");
    await interrupt(c, false);
    const d = await cont(c, "显式 Plan 覆盖", "plan");
    await interrupt(d, true);
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "plan", expected_version: 2 });
    const e = await cont(c, "执行任务继续到 Plan");
    await interrupt(e, true);
    const f = await cont(e, "显式完全访问覆盖", "full_access");
    await interrupt(f, false);
    // 历史标记文本原样保留，但新任务与继续链均不从文本推导模式。
    const old = await submit(t, sessionId, "old", "/plan 旧输入", { access_mode: "confirm" });
    await interrupt(old, false);
    const resumed = await cont(old, "旧文本继续", "confirm");
    await interrupt(resumed, false);
    for (const task of [a, b, c, d, e, f, old, resumed]) {
      assert.equal(task.permissionVersion, 1);
      assert.deepEqual((await taskStatus(t.client, task.id)).confirmations, [], "继续不继承审批");
    }
  } finally {
    held.splice(0).forEach((release) => release());
    await t.shutdown();
  }
});

test("集成：Plan 写入转人工、审查失败转人工，拒绝任务切换不改版本与待审批", async () => {
  const outside = path.join(fs.realpathSync(os.tmpdir()), `plan-policy-${process.pid}.txt`);
  fs.writeFileSync(outside, "BEFORE");
  const t = await startTestRuntime("plan-policy", async (req) => {
    if (lastUserText(req).includes("审批审查")) return { kind: "text", text: "INVALID-REVIEW" };
    const input = lastUserText(req);
    if (toolResultsSinceUser(req) === 0) return { kind: "tool_calls", calls: [{ id: input, name: "request_file_access", arguments: {
      path: outside, operation: input === "写外部配置" ? "write" : "read", content: "AFTER", reason: input,
    } }] };
    return { kind: "text", text: "完成" };
  }, { config: realTools(), workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "plan", expected_version: 0 });
    for (const input of ["写外部配置", "读取外部配置"]) {
      const task = await submit(t, sessionId, input, input);
      await waitFor("审查完成并待人工审批", async () => {
        const detail = await taskStatus(t.client, task.id);
        return detail.task.status === "awaiting_confirmation" && detail.confirmations[0]?.reviewStatus === "asked_owner";
      });
      const before = await taskStatus(t.client, task.id);
      assert.equal(before.task.planMode, true);
      assert.equal(before.task.accessMode, "auto-review");
      assert.equal(before.confirmations[0].status, "pending");
      assert.equal(fs.readFileSync(outside, "utf8"), "BEFORE", "人工批准前不写入");
      for (const mode of ["plan", "full_access", "confirm", "auto-review"]) {
        await assert.rejects(t.client.request("switch_mode", { task_id: task.id, mode }));
        const after = await taskStatus(t.client, task.id);
        assert.deepEqual(after.task, before.task);
        assert.deepEqual(after.confirmations, before.confirmations);
      }
      // 修改默认值时，等待审批的任务与其后的排队任务保留提交时的 Plan。
      const queued = await submit(t, sessionId, `queued-${input}`, `排队-${input}`);
      const session = await t.client.request<any>("get_session", { session_id: sessionId });
      await t.client.request("set_session_mode", { session_id: sessionId, mode: "full_access", expected_version: session.defaultAccessModeVersion });
      const duplicate = await submit(t, sessionId, input, input);
      assert.equal(duplicate.id, task.id);
      assert.equal(duplicate.planMode, true);
      assert.equal((await taskStatus(t.client, queued.id)).task.planMode, true);
      await t.client.request("cancel", { task_id: queued.id });
      await t.client.request("respond_confirmation", { confirmation_id: before.confirmations[0].id, decision: "reject" });
      await waitDone(t, task.id);
      const now = await t.client.request<any>("get_session", { session_id: sessionId });
      await t.client.request("set_session_mode", { session_id: sessionId, mode: "plan", expected_version: now.defaultAccessModeVersion });
    }
    const reviews = t.server.calls.filter((c) => lastUserText(c).includes("审批审查"));
    assert.equal(reviews.length, 1, "写入不送审；读取审查失败转人工");
    assert.equal(fs.readFileSync(outside, "utf8"), "BEFORE");
  } finally {
    await t.shutdown();
    fs.rmSync(outside, { force: true });
  }
});
