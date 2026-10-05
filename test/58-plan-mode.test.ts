/**
 * issue 26：计划模式（/plan 标记、计划说明前缀、工具白名单、访问模式不变、适用会话、继续继承）。
 * TUI 的 /plan 命令与状态栏见 test/14-tui-app.test.ts。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { isPlanInput } from "../src/agent/plan-mode.ts";
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

test("isPlanInput：以 /plan 加空白开头且其后有内容", () => {
  for (const s of ["/plan 调研", "/plan\n调研", "/plan\t 调研"]) assert.equal(isPlanInput(s), true, s);
  for (const s of ["/plan", "/plan   ", "/plan\n", "/planx 调研", " /plan 调研", "/plan:调研", "请 /plan 调研", "[入站事件] 来源：telegram\n/plan 调研"]) {
    assert.equal(isPlanInput(s), false, JSON.stringify(s));
  }
});

test("集成：/plan 输入原样、计划说明前缀与「计划模式」类别、白名单工具集与阻断；下一条普通消息恢复", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "get" }, { name: "put" }, { name: "odd" }] });
  let driver: any;
  let forged = false;
  const steps = [
    { id: "r", name: "read", arguments: { path: "notes.txt" } },
    { id: "b", name: "bash", arguments: { command: "echo PLAN-BASH" } },
    { id: "m", name: "mcp_svc_get", arguments: {} },
  ];
  const responder: Responder = async (req) => {
    if (lastUserText(req) !== "/plan 调研登录流程") return { kind: "text", text: "好的" };
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

    const plan = await submit(t, sessionId, "p1", "/plan 调研登录流程");
    assert.equal((await submit(t, sessionId, "p1", "/plan 调研登录流程")).id, plan.id, "同键重试返回原任务");
    const done = await waitDone(t, plan.id);
    assert.equal(done.task.status, "completed", done.task.errorMessage ?? done.task.interruptReason ?? "");
    assert.equal(forged, true);
    assert.equal(done.task.input, "/plan 调研登录流程", "任务输入照原样保存");
    assert.equal(done.task.accessMode, "confirm");
    assert.deepEqual(done.toolOps.map((o: any) => [o.toolName, o.isError]), [["read", false], ["bash", false], ["mcp_svc_get", false]]);
    assert.match(done.toolOps[0].resultSummary, /PLAN-NOTES/);
    assert.match(done.toolOps[1].resultSummary, /PLAN-BASH/);
    assert.equal(t.runtime.store.listTasksBySession(sessionId).length, 1, "只有一个任务");

    const planCall = callFor(t, "/plan 调研登录流程");
    assert.ok(hasPlanPrefix(planCall), "模型上下文含计划说明前缀");
    assert.deepEqual(toolNames(planCall).sort(), [
      "bash", "history_read", "history_search", "http_request", "mcp_svc_get", "memory_list", "memory_read",
      "read", "read_artifact", "request_file_access", "skill", "todo_write", "web_search",
    ], "计划模式只含白名单工具");
    const planCat = await planModeTokens(t, sessionId, plan.id);
    assert.equal(planCat.label, "计划模式");
    assert.ok(planCat.tokens > 0);

    const next = await waitDone(t, (await submit(t, sessionId, "n1", "按计划执行")).id);
    assert.equal(next.task.status, "completed");
    const nextCall = callFor(t, "按计划执行");
    assert.ok(!hasPlanPrefix(nextCall), "下一条普通消息没有计划说明");
    for (const name of WRITE_TOOLS) assert.ok(toolNames(nextCall).includes(name), `工具集恢复 ${name}`);
    assert.equal((await planModeTokens(t, sessionId, next.task.id)).tokens, 0);

    // SDK 向发送载荷泄漏写工具：发送前最终检查阻断整个请求
    const sdk = driver.sdk;
    const setActive = sdk.setActiveToolsByName.bind(sdk);
    sdk.setActiveToolsByName = (names: string[]) => setActive([...names, "edit"]);
    const before = t.server.calls.length;
    const leaked = await waitDone(t, (await submit(t, sessionId, "p2", "/plan 再调研")).id);
    assert.equal(leaked.task.status, "interrupted");
    assert.match(leaked.task.interruptReason, /^task_tools_forbidden:.*edit/);
    assert.equal(t.server.calls.length, before, "越权工具定义没有发送给模型");
  } finally {
    await t.shutdown();
    await mcp.close();
  }
});

test("集成：三种访问模式下以计划模式运行时访问模式不变，request_file_access/http_request 的审批与普通任务一致", async () => {
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
      const approved = new Set<string>();
      let detail: any;
      await waitFor(`${requestId} 终态`, async () => {
        detail = await taskStatus(t.client, task.id);
        const pending = detail.confirmations.find((c: any) => c.status === "pending" && !approved.has(c.id));
        // 自动审查模式由审查调用裁决；其余模式由拥有者逐次批准
        if (mode !== "auto-review" && pending) {
          approved.add(pending.id);
          await t.client.request("respond_confirmation", { confirmation_id: pending.id, decision: "approve" });
        }
        return TERMINAL.includes(detail.task.status);
      }, 60_000);
      assert.equal(detail.task.status, "completed", detail.task.errorMessage ?? detail.task.interruptReason ?? "");
      assert.equal(detail.task.accessMode, mode, `${requestId}：访问模式不变`);
      return {
        confirmations: detail.confirmations.map((c: any) => [c.toolName, c.status, c.decisionSource]),
        ops: detail.toolOps.map((o: any) => [o.toolName, o.isError]),
      };
    };
    for (const mode of ["confirm", "full_access", "auto-review"]) {
      const plan = await run(`p-${mode}`, "/plan 调研外部配置", mode);
      const normal = await run(`n-${mode}`, "调研外部配置", mode);
      assert.deepEqual(plan, normal, `${mode}：审批行为与普通任务一致`);
      assert.equal(plan.confirmations.length, 2, `${mode}：两次逐次审批`);
      assert.deepEqual(plan.ops, [["request_file_access", false], ["http_request", false]]);
    }
  } finally {
    await t.shutdown();
    await new Promise<void>((resolve) => service.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("集成：角色会话与旧 QQ 群会话的 /plan 返回 invalid_params 且不建任务；入站事件包装后不识别为计划模式", async () => {
  const t = await startTestRuntime("plan-sessions", async () => ({ kind: "text", text: "好的" }));
  try {
    const rt = t.runtime;
    await createProjectSession(t.client, t.work[0]!);
    // 旧安装的 chat 角色行与群会话由播种助手按归档形态写入（核心群聊已退役，issue 20）
    const archive = legacyGroupArchive({ store: rt.store, qq: rt.qqStore, workRoot: t.dirs.root });
    archive.seedChatRole();
    const group = archive.seedGroup({ groupId: "100001" });
    const coding = seedCodingRole(rt.store, t.dirs.root);
    const sessions = [...(["main", "chat"] as const).map((id) => rt.store.getAgentRole(id)!.sessionId), coding.sessionId, group.session.id];
    for (const sessionId of sessions) {
      const before = rt.store.listTasksBySession(sessionId).length;
      await assert.rejects(
        rt.submit({ sessionId, requestId: "plan", input: "/plan 调研", modelSelection: rt.defaultSelection }),
        (err: any) => err.code === "invalid_params" && /计划模式/.test(err.message),
      );
      assert.equal(rt.store.listTasksBySession(sessionId).length, before, "不创建任务");
    }
    // 退役群会话与 chat 角色会话是只读归档：普通提交同样被拒（invalid_state），不建任务
    for (const sessionId of [group.session.id, rt.store.getAgentRole("chat")!.sessionId]) {
      const before = rt.store.listTasksBySession(sessionId).length;
      await assert.rejects(
        rt.submit({ sessionId, requestId: "plain", input: "继续聊", modelSelection: rt.defaultSelection }),
        (err: any) => err.code === "invalid_state" && /核心群聊已退役/.test(err.message),
      );
      assert.equal(rt.store.listTasksBySession(sessionId).length, before, "不创建任务");
    }
    // 退役的 coding 角色会话同为只读归档（issue 23）
    await assert.rejects(
      rt.submit({ sessionId: coding.sessionId, requestId: "plain", input: "继续", modelSelection: rt.defaultSelection }),
      (err: any) => err.code === "invalid_state" && /固定 coding 角色已退役/.test(err.message),
    );

    // Telegram/QQ 私聊等入站正文由编排器包装为 [入站事件]…，不以 /plan 开头
    await rt.orchestrator!.registerInboundEvent({ source: "test", externalId: "owner-plan", targetRole: "main", body: "/plan 调研" });
    const main = rt.store.getAgentRole("main")!;
    await waitFor("入站任务完成", () => rt.store.listTasksBySession(main.sessionId).some((x) => x.status === "completed"));
    const call = t.server.calls.find((c) => lastUserText(c).startsWith("[入站事件]"))!;
    assert.ok(lastUserText(call).includes("/plan 调研"));
    assert.ok(!hasPlanPrefix(call), "入站事件不按计划模式运行");
  } finally {
    await t.shutdown();
  }
});

test("集成：以计划模式运行的任务中断后经 continue 继续（含逐级继续）仍按计划模式运行", async () => {
  const held: Array<() => void> = [];
  const t = await startTestRuntime("plan-continue", async (req) => {
    if (["/plan 长调研", "继续一"].includes(lastUserText(req))) await new Promise<void>((resolve) => held.push(resolve));
    return { kind: "text", text: "计划：先改 a" };
  });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const interruptWhenCalled = async (taskId: string, input: string) => {
      await waitFor(`${input} 已发出`, () => t.server.calls.some((c) => lastUserText(c) === input));
      await t.client.request("interrupt", { task_id: taskId });
      held.splice(0).forEach((release) => release());
      assert.equal((await waitDone(t, taskId)).task.status, "interrupted");
    };
    const a = await submit(t, sessionId, "a", "/plan 长调研");
    await interruptWhenCalled(a.id, "/plan 长调研");
    const cont = (taskId: string, requestId: string, input: string) =>
      t.client.request<any>("continue", { task_id: taskId, session_id: sessionId, request_id: requestId, input, model_selection: MODEL });
    const b = await cont(a.id, "b", "继续一");
    await interruptWhenCalled(b.id, "继续一");
    const c = await cont(b.id, "c", "继续二");
    assert.equal((await waitDone(t, c.id)).task.status, "completed");
    for (const input of ["继续一", "继续二"]) {
      const call = callFor(t, input);
      assert.ok(hasPlanPrefix(call), `${input}：继承计划模式`);
      assert.ok(!toolNames(call).includes("mock_mark") && toolNames(call).includes("todo_write"), `${input}：白名单工具集`);
    }

    assert.equal((await waitDone(t, (await submit(t, sessionId, "d", "按计划执行")).id)).task.status, "completed");
    const normal = callFor(t, "按计划执行");
    assert.ok(!hasPlanPrefix(normal) && toolNames(normal).includes("mock_mark"), "普通消息不继承");
  } finally {
    await t.shutdown();
  }
});
