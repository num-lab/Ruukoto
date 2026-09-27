/**
 * TUI 应用集成（无终端：假 Terminal + 真实后台与控制协议）。
 *
 * 覆盖 issue 04 §6 的交互路径：
 * 1. 提交多行中文输入；流式预览不重复追加；最终消息只出现一次；
 * 2. 任务运行中关闭 TUI，重连后看到仍在运行的任务/最新预览/最终历史，
 *    全程不自动新建任务；
 * 3. 审批：通知不抢焦点、详情查看、批准/拒绝、其他客户端已处理的失效展示；
 * 4. 中断与继续：/interrupt、/continue 的继续指令生成带 resumes 的新任务；
 * 5. 会话切换保留各自草稿。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ControlConnection } from "../src/control/connection.ts";
import type { OpParams, TuiOp } from "../src/control/ops.ts";
import { PendingRequestStore } from "../src/control/pending-requests.ts";
import { SubmissionGuard } from "../src/control/submission.ts";
import { readOwnerToken } from "../src/control/owner-token.ts";
import { ViewState } from "../src/tui/state.ts";
import { CommandHistoryStore } from "../src/tui/command-history.ts";
import { TuiApp } from "../src/tui/app.ts";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  taskStatus,
  lastUserText,
  type TestRuntime,
} from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import type { Task } from "../src/core/types.ts";
import type { HistoryPage } from "../src/core/history.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";

interface AppHarness {
  app: TuiApp;
  connection: ControlConnection;
  terminal: FakeTerminal;
  state: ViewState;
  pendingStore: PendingRequestStore;
  exitCode(): number | null;
  exitMessage(): string | null;
}

let harnessCounter = 0;

async function startApp(t: TestRuntime, opts: { sessionId?: string; requests?: Array<{ op: string; params?: Record<string, unknown> }> } = {}): Promise<AppHarness> {
  // 调用方负责在 finally 中 app.quit()（失败时也不能遗留连接/定时器）
  const state = new ViewState(new CommandHistoryStore(path.join(t.dirs.root, "tui", "commands.sqlite")));
  let appRef: TuiApp | null = null;
  const connection = new ControlConnection(
    { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
    {
      onState: (s, d) => appRef?.onConnectionState(s, d),
      onSnapshot: (r, ctx) => appRef?.onSnapshot(r, ctx),
      onEvent: (e, kind) => appRef?.onEvent(e, kind),
    },
  );
  if (opts.requests) {
    const request = connection.request.bind(connection);
    connection.request = <K extends TuiOp>(op: K, params: OpParams<K>, timeoutMs?: number) => {
      opts.requests!.push({ op, params });
      return request(op, params, timeoutMs);
    };
  }
  const pendingStore = new PendingRequestStore(path.join(t.dirs.root, `pending-${harnessCounter++}`));
  const guard = new SubmissionGuard(pendingStore, connection);
  const terminal = new FakeTerminal();
  let exitCode: number | null = null;
  let exitMessage: string | null = null;
  const app = new TuiApp({
    connection,
    guard,
    pendingStore,
    state,
    terminal,
    initialSessionId: opts.sessionId,
    onExit: (code, message) => {
      exitCode = code;
      exitMessage = message ?? null;
    },
  });
  appRef = app;
  await app.start();
  await waitFor("TUI 上线", () => connection.state === "online");
  return {
    app,
    connection,
    terminal,
    state,
    pendingStore,
    exitCode: () => exitCode,
    exitMessage: () => exitMessage,
  };
}

/** 测试收尾：退出全部 TUI 实例（重复调用安全）。 */
function quitAll(apps: AppHarness[]): void {
  for (const h of apps) h.app.quit(0);
}

/** 等渲染合并窗口过去（TUI 16ms 节流）。 */
async function renderFlush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

async function submitViaEditor(h: AppHarness, text: string): Promise<void> {
  h.terminal.send(text);
  h.terminal.send("\r");
  await renderFlush();
}

// ---------- 测试 ----------

test("提交多行中文与流式显示：终端持续呈现中间帧，最终消息沿用唯一条目", async () => {
  const t = await startTestRuntime("tui-basic", async (req, callIndex) => {
    void callIndex;
    const text = lastUserText(req);
    await new Promise((r) => setTimeout(r, 300));
    return { kind: "text", text: `收到：${text}\n${"输出中".repeat(20)}\n第二段标记，${"继续".repeat(16)}\n终态标记。`, chunkDelayMs: 300 };
  });
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);

    // 多行中文输入（Alt+Enter 换行语义无终端模拟，直接送多行文本）
    await submitViaEditor(h, "第一行\n第二行：帮我总结一下");
    await waitFor("首个流式终端帧", () => stripTerminalSequences(h.terminal.output()).includes("收到：第一行"));
    assert.equal([...h.state.tasks.values()][0]!.status, "running", "首帧在任务完成前渲染");
    const flow = h.state.sessionViews.get(sessionId)!.flow;
    const initialOutput = flow.items.find((entry) => entry.kind === "message" && entry.role === "assistant");
    assert.ok(initialOutput?.kind === "message" && initialOutput.streaming);
    h.terminal.clearOutput();
    await waitFor("更新后的流式终端帧", () => stripTerminalSequences(h.terminal.output()).includes("第二段标记"));
    assert.equal([...h.state.tasks.values()][0]!.status, "running", "同一消息的后续内容在任务完成前渲染");
    assert.ok(!stripTerminalSequences(h.terminal.output()).includes("终态标记"), "中间帧还不包含最终正文");
    await waitFor("任务完成", async () => {
      const tasks = [...h.state.tasks.values()];
      return tasks.length === 1 && tasks[0]!.status === "completed";
    });
    await waitFor("历史补齐", () => {
      const view = h.state.sessionViews.get(sessionId)!;
      return view.flow.items.some((i) => i.kind === "message" && i.role === "assistant" && !i.streaming && i.text.includes("收到："));
    });
    const view = h.state.sessionViews.get(sessionId)!;
    const assistantTexts = view.flow.items.filter((i) => i.kind === "message" && i.role === "assistant" && i.text.includes("收到："));
    assert.equal(assistantTexts.length, 1, "最终消息只出现一次");
    const finalOutput = assistantTexts[0]!;
    assert.ok(finalOutput.kind === "message" && !finalOutput.streaming, "历史补齐把原条目标为完整");
    assert.equal(finalOutput.key, initialOutput.key, "落盘前后使用同一身份");
    const userEntry = view.flow.items.find((i) => i.kind === "message" && i.role === "user");
    assert.ok(userEntry?.kind === "message" && userEntry.text.includes("第一行\n第二行"), "多行中文原文完整");
    await waitFor("最终终端帧", () => stripTerminalSequences(h.terminal.output()).includes("终态标记"));
    assert.equal(h.pendingStore.list().records.length, 0, "无待确认记录残留");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("任务运行中退出 TUI：重连后看到运行状态与最终历史，不重复建任务", async () => {
  const t = await startTestRuntime("tui-reconnect", async (req) => {
    const text = lastUserText(req);
    await new Promise((r) => setTimeout(r, 1200));
    return { kind: "text", text: `慢任务结果：${text}` };
  });
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h1 = await startApp(t, { sessionId });
    apps.push(h1);
    await submitViaEditor(h1, "慢任务");
    await waitFor("任务开始", () => [...h1.state.tasks.values()][0]?.status === "running");
    // 首次回复前关闭 TUI
    h1.app.quit(0);
    await waitFor("h1 退出", () => h1.exitCode() === 0);
    assert.ok(h1.exitMessage()?.includes("后台任务继续运行"), "退出提示说明任务继续");

    // 重连：仍在运行
    const h2 = await startApp(t, { sessionId });
    apps.push(h2);
    const running = [...h2.state.tasks.values()][0];
    assert.equal(running.status, "running", "重连后看到真实运行状态");
    assert.equal([...h2.state.tasks.values()].length, 1, "不自动新建任务");
    const view2 = h2.state.sessionViews.get(sessionId)!;
    assert.ok(view2.historyLoaded, "历史已从后台重建");

    await waitFor("任务完成", async () => (await taskStatus(t.client, running.id)).task.status === "completed");
    await waitFor("最终消息进入历史", () => {
      const v = h2.state.sessionViews.get(sessionId)!;
      return v.flow.items.some((i) => i.kind === "message" && i.role === "assistant" && !i.streaming && i.text.includes("慢任务结果"));
    });
    h2.app.quit(0);
    await waitFor("h2 退出", () => h2.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("斜杠命令及结果在退出后重进同一会话时恢复，且不重新执行", async () => {
  const t = await startTestRuntime("tui-command-history", async () => ({ kind: "text", text: "不应调用模型" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const first = await startApp(t, { sessionId });
    apps.push(first);
    await submitViaEditor(first, "/context");
    first.terminal.send("\x1b");
    await submitViaEditor(first, "/mode");
    first.terminal.send("\x1b[B");
    first.terminal.send("\r");
    await waitFor("命令结果显示", () => first.state.openSession(sessionId).flow.items.some((entry) => entry.kind === "command" && entry.result?.includes("Switched to")));
    const commands = first.state.openSession(sessionId).flow.items.filter((entry) => entry.kind === "command");
    assert.deepEqual(commands.map((entry) => entry.line), ["/context", "/mode"]);
    first.app.quit(0);
    await waitFor("首个客户端退出", () => first.exitCode() === 0);

    const requests: Array<{ op: string; params?: Record<string, unknown> }> = [];
    const second = await startApp(t, { sessionId, requests });
    apps.push(second);
    await waitFor("新客户端历史加载", () => second.state.openSession(sessionId).historyLoaded);
    assert.deepEqual(second.state.openSession(sessionId).flow.items.filter((entry) => entry.kind === "command"), commands, "命令正文、结果、身份和原始时间均应恢复");
    assert.ok(!requests.some((request) => request.op === "set_session_mode" || request.op === "get_context_breakdown"), "恢复只显示记录，不重新执行命令");
    await submitViaEditor(second, "/context");
    const updated = second.state.openSession(sessionId).flow.items.filter((entry) => entry.kind === "command");
    assert.equal(updated.length, 3, "重启后新命令不会覆盖旧记录");
    assert.equal(new Set(updated.map((entry) => entry.key)).size, 3);
    assert.deepEqual(updated.slice(0, 2), commands);
    // 第二个客户端仍运行时，第三个客户端已经能读到新记录。
    const third = await startApp(t, { sessionId });
    apps.push(third);
    await waitFor("另一客户端历史加载", () => third.state.openSession(sessionId).historyLoaded);
    assert.deepEqual(third.state.openSession(sessionId).flow.items.filter((entry) => entry.kind === "command"), updated);
    const other = await createProjectSession(t.client, t.work[0]!);
    assert.deepEqual(third.state.openSession(other.sessionId).flow.items.filter((entry) => entry.kind === "command"), [], "不同会话不串命令");
    assert.equal(t.server.calls.length, 0);
  } finally {
    quitAll(apps);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.shutdown();
  }
});

test("长正文生成中退出后冷重连：超过历史单页的正文完整恢复且只显示一次", async () => {
  const output = "长文头部标记\n" + "连续的中文内容。".repeat(2500) + "\n长文尾部标记";
  assert.ok(Buffer.byteLength(output) > 48 * 1024);
  const t = await startTestRuntime("tui-long-reconnect", async () => ({ kind: "text", text: output, chunkDelayMs: 1 }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const first = await startApp(t, { sessionId });
    apps.push(first);
    await submitViaEditor(first, "返回长正文");
    await waitFor("至少 8KiB 的流式正文", () => first.state.sessionViews.get(sessionId)!.flow.items.some((entry) => entry.kind === "message" && entry.role === "assistant" && entry.streaming && Buffer.byteLength(entry.text) > 8 * 1024));
    const taskId = [...first.state.tasks.keys()][0]!;
    first.app.quit(0);
    await waitFor("首个客户端退出", () => first.exitCode() === 0);
    await waitFor("后台独立完成长正文", async () => (await taskStatus(t.client, taskId)).task.status === "completed");

    const requests: Array<{ op: string; params?: Record<string, unknown> }> = [];
    const second = await startApp(t, { sessionId, requests });
    apps.push(second);
    await waitFor("冷重连完整历史恢复", () => second.state.sessionViews.get(sessionId)!.flow.items.some((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.streaming && !entry.truncated && entry.text === output));
    const answers = second.state.sessionViews.get(sessionId)!.flow.items.filter((entry) => entry.kind === "message" && entry.role === "assistant");
    assert.equal(answers.length, 1, "历史与事件补读合并为唯一正文");
    assert.ok(requests.some((request) => request.op === "read_history_entry" && Number(request.params?.offset ?? 0) > 0 && request.params?.length === 48 * 1024), "实际请求后续 48KiB 历史页（偏移按 UTF-8 边界对齐）");
    await waitFor("终端显示正文尾部", () => stripTerminalSequences(second.terminal.output()).includes("长文尾部标记"));
    second.terminal.clearOutput();
    (second.app as any).scroll.scrollTo(0, { disableFollow: true });
    (second.app as any).tui.requestRender();
    await waitFor("滚回顶部看到完整正文开头", () => stripTerminalSequences(second.terminal.output()).includes("长文头部标记"));
    assert.equal([...second.state.tasks.keys()].filter((id) => id === taskId).length, 1);
  } finally {
    quitAll(apps);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.shutdown();
  }
});

test("空历史的排队取消任务在冷启动后恢复原始输入和 Canceled 终态", async () => {
  const t = await startTestRuntime("tui-empty-canceled", async () => ({ kind: "text", text: "不应调用模型" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    t.runtime.store.withTx(() => t.runtime.store.setSessionQueueState(sessionId, "paused", "test"));
    const queued = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "queued-cancel", input: "尚未执行就取消的原始输入", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
    await t.client.request("cancel", { task_id: queued.id });
    const page = await t.client.request<HistoryPage>("read_history", { session_id: sessionId });
    assert.equal(page.entries.length, 0, "取消发生在用户消息落盘之前");
    const h = await startApp(t, { sessionId });
    apps.push(h);
    await waitFor("空历史任务恢复", () => {
      const screen = stripTerminalSequences(h.terminal.output());
      return screen.includes("尚未执行就取消的原始输入") && screen.includes("Canceled");
    });
    assert.equal(t.server.calls.length, 0);
    assert.ok(!stripTerminalSequences(h.terminal.output()).includes("Done"));
  } finally {
    quitAll(apps);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.shutdown();
  }
});

test("审批：通知、详情、批准与拒绝；其他客户端处理后显示失效", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    // 仅当本轮（最后一条 user 之后）尚未得到工具结果时才发起工具调用
    const lastUserIdx = req.messages.map((m) => (m as any).role).lastIndexOf("user");
    const hasToolResult = req.messages.slice(lastUserIdx + 1).some((m) => (m as any).role === "tool");
    if (text.includes("批准路径") && !hasToolResult) {
      return { kind: "tool_calls", calls: [{ id: "call_a", name: "mock_gate", arguments: { note: "批准我" } }] };
    }
    if (text.includes("拒绝路径") && !hasToolResult) {
      return { kind: "tool_calls", calls: [{ id: "call_r", name: "mock_gate", arguments: { note: "拒绝我" } }] };
    }
    if (text.includes("失效路径") && !hasToolResult) {
      return { kind: "tool_calls", calls: [{ id: "call_s", name: "mock_gate", arguments: { note: "抢先处理" } }] };
    }
    return { kind: "text", text: "收尾" };
  };
  const t = await startTestRuntime("tui-approval", responder);
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!, { confirmTools: ["mock_gate"] });
    const h = await startApp(t, { sessionId });
    apps.push(h);

    // 批准路径
    await submitViaEditor(h, "批准路径");
    await waitFor("审批到达", () => h.state.pendingApprovals().length === 1);
    h.terminal.send("/approvals\r");
    await renderFlush();
    h.terminal.send("\r"); // 选择第一条 → 详情
    await renderFlush();
    assert.ok(h.terminal.output().includes("批准我") || h.terminal.output().includes("mock_gate"), "详情展示审批参数");
    h.terminal.send("a");
    await waitFor("批准生效", async () => {
      const tasks = [...h.state.tasks.values()];
      return tasks[0]?.status === "completed";
    });
    assert.equal(h.state.pendingApprovals().length, 0);

    // 拒绝路径
    await submitViaEditor(h, "拒绝路径");
    await waitFor("审批到达", () => h.state.pendingApprovals().length === 1);
    h.terminal.send("/approvals\r");
    await renderFlush();
    h.terminal.send("\r");
    await renderFlush();
    h.terminal.send("r");
    await waitFor("拒绝后任务收尾", () => [...h.state.tasks.values()].at(-1)?.status === "completed");

    // 失效路径：其他客户端先处理
    await submitViaEditor(h, "失效路径");
    await waitFor("审批到达", () => h.state.pendingApprovals().length === 1);
    const staleConf = h.state.pendingApprovals()[0]!;
    await t.client.request("respond_confirmation", { confirmation_id: staleConf.id, decision: "reject" });
    h.terminal.send("/approvals\r");
    await renderFlush();
    // 已被处理的审批不再出现在待处理列表
    assert.equal(h.state.pendingApprovals().length, 0);
    await waitFor("失效路径任务结束", () => [...h.state.tasks.values()].at(-1)?.status === "completed");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("中断与继续：新任务带 resumes 关联；会话切换保留各自草稿", async () => {
  const t = await startTestRuntime("tui-interrupt", async (req) => {
    const text = lastUserText(req);
    if (text.includes("长跑")) {
      await new Promise((r) => setTimeout(r, 5000));
      return { kind: "text", text: "长跑结束" };
    }
    return { kind: "text", text: `继续完成：${text}` };
  });
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const { sessionId: sessionB } = await createProjectSession(t.client, t.work[1]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    await submitViaEditor(h, "长跑任务");
    await waitFor("任务运行", () => [...h.state.tasks.values()][0]?.status === "running");

    h.terminal.send("/interrupt\r");
    await waitFor("任务中断", () => [...h.state.tasks.values()][0]?.status === "interrupted");

    // 继续模式：下一条输入作为继续指令
    h.terminal.send("/continue\r");
    await renderFlush();
    await submitViaEditor(h, "继续完成它");
    await waitFor("继续任务创建", () => [...h.state.tasks.values()].length === 2);
    const continued = [...h.state.tasks.values()][1]!;
    assert.equal(continued.resumesTaskId, [...h.state.tasks.values()][0]!.id);
    await waitFor("继续任务完成", () => [...h.state.tasks.values()][1]?.status === "completed");

    // 草稿：A 会话输入，切到 B 再切回，草稿恢复
    h.terminal.send("未发送的草稿");
    await renderFlush();
    (h.app as any).switchSession(sessionB);
    await renderFlush();
    assert.equal((h.app as any).editor.getText(), "", "切走后编辑器清空");
    (h.app as any).switchSession(sessionId);
    await renderFlush();
    assert.equal((h.app as any).editor.getText(), "未发送的草稿", "切回后草稿恢复");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("--session 指定不存在的会话：明确报错退出，不新建", async () => {
  const t = await startTestRuntime("tui-badsession", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId: "sess_不存在" });
    apps.push(h);
    await waitFor("报错退出", () => h.exitCode() === 1, 5000);
    assert.ok(h.exitMessage()?.includes("会话不存在"));
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/new：在当前工作区创建并切换会话，可重复创建独立会话", async () => {
  const t = await startTestRuntime("tui-new", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);

    // 后台另有编排器角色会话（issue 01），断言相对变化而非绝对数量
    const base = h.state.sessions.length;
    h.terminal.send("/new\r");
    await waitFor("新会话出现", () => h.state.sessions.length === base + 1);
    const first = h.state.currentSessionId!;
    assert.notEqual(first, sessionId);
    const firstInfo = h.state.sessions.find((s) => s.id === first)!;
    assert.equal(firstInfo.projectId, projectId);
    assert.equal(firstInfo.cwd, t.work[0]!);

    // 重复执行：再创建一个独立会话
    h.terminal.send("/new\r");
    await waitFor("第二个新会话出现", () => h.state.sessions.length === base + 2);
    const second = h.state.currentSessionId!;
    assert.notEqual(second, first);
    assert.notEqual(second, sessionId);

    // 旧会话仍在，可切回
    (h.app as any).switchSession(sessionId);
    assert.equal(h.state.currentSessionId, sessionId);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/new：未选择会话时不创建，提示下一步操作", async () => {
  const t = await startTestRuntime("tui-new-nosession", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t);
    apps.push(h);
    // 启动后默认进入会话选择，不选中任何会话
    assert.equal(h.state.currentSessionId, null);
    h.terminal.send("\x1b"); // 关闭选择面板，避免拦截后续输入
    await renderFlush();
    const before = h.state.sessions.length;

    h.terminal.send("/new\r");
    await renderFlush();
    // 不创建新会话（后台另有编排器角色会话，断言相对变化而非绝对数量）
    assert.equal(h.state.sessions.length, before, "不应创建新会话");
    assert.equal(h.state.currentSessionId, null);
    const notes = h.state.globalNotes.map((n) => n.text).join("\n");
    assert.ok(notes.includes("尚未选择会话"), `提示应指向 /new-project 或 /new-session，实际：${notes}`);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/context：展示当前上下文窗口分解（不提供切换）", async () => {
  const t = await startTestRuntime("tui-context", async (req, callIndex) => {
    if (callIndex === 0) {
      return { kind: "tool_calls", calls: [{ id: "c1", name: "mock_mark", arguments: { path: "/tmp/ruukoto-tui-ctx.txt", content: "数据" } }] };
    }
    return { kind: "text", text: "总结完成" };
  });
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    await submitViaEditor(h, "写入标记然后总结");
    await waitFor("任务完成", () => [...h.state.tasks.values()][0]?.status === "completed");
    await waitFor("两条选择记录", async () => {
      const list = await h.connection.request<any>("list_selection_records", { session_id: sessionId, limit: 5 });
      return list.records.length === 2;
    });

    // 当前状态：最近一次调用（第 2 次）的分解
    h.terminal.clearOutput();
    h.terminal.send("/context");
    h.terminal.send("\r");
    // 只展示长条与图例：标题为「上下文窗口」，明细文字已移除
    await waitFor("分解展示", () => h.terminal.output().includes("上下文窗口"));
    const detail = h.terminal.output();
    assert.ok(detail.includes("█"), "长条已渲染");
    // 出现过的分类都要在图例里（本次消息少，不一定有历史轮次）
    assert.ok(detail.includes("系统提示") && detail.includes("工具定义"), "分类图例齐全");
    assert.ok(detail.includes("预留") && detail.includes("尚余输入"), "预留与余量在图例中");
    // 不再提供切换：按 l 不应打开任何列表
    h.terminal.clearOutput();
    h.terminal.send("l");
    await renderFlush();
    assert.ok(!h.terminal.output().includes("第 1 次调用"), "不提供切换历史调用");

    // Esc 关闭，不再渲染分解
    h.terminal.send("\x1b");
    await renderFlush();
    h.terminal.clearOutput();
    await renderFlush();
    assert.ok(!h.terminal.output().includes("上下文窗口"), "Esc 关闭悬浮层");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/skill 与 /skills：显式调用提交 /skill:<名称> 任务，列表展示技能与诊断", async () => {
  const t = await startTestRuntime("tui-skill", async () => ({ kind: "text", text: "照做" }));
  const apps: AppHarness[] = [];
  try {
    const skillDir = path.join(t.dirs.agentDir, "skills", "beta");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: beta\ndescription: BETA-DESC\ndisable-model-invocation: true\n---\nBETA-BODY");
    fs.mkdirSync(path.join(t.dirs.agentDir, "skills", "nodesc"));
    fs.writeFileSync(path.join(t.dirs.agentDir, "skills", "nodesc", "SKILL.md"), "---\nname: nodesc\n---\nx");
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);

    h.terminal.send("/skills");
    h.terminal.send("\r");
    await waitFor("技能列表", () => stripTerminalSequences(h.terminal.output()).includes("BETA-DESC"));
    const listing = stripTerminalSequences(h.terminal.output());
    assert.ok(listing.includes("仅显式调用") && listing.includes("nodesc"), "显示仅显式标记与诊断");
    h.terminal.send("\x1b");
    await renderFlush();

    await submitViaEditor(h, "/skill beta 参数甲");
    await waitFor("任务完成", () => [...h.state.tasks.values()][0]?.status === "completed");
    const tasks = [...h.state.tasks.values()];
    assert.equal(tasks.length, 1, "只提交一个任务");
    assert.equal(tasks[0]!.input, "/skill:beta 参数甲");
    assert.ok(lastUserText(t.server.calls[0]!).includes("BETA-BODY"), "任务开始时展开为技能正文");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/plan：不带内容只显示用法；带内容原样提交与显示，运行时状态栏显示「计划」，继续后仍显示", async () => {
  const held: Array<() => void> = [];
  const t = await startTestRuntime("tui-plan", async (req) => {
    if (["/plan 调研登录", "接着调研"].includes(lastUserText(req))) await new Promise<void>((resolve) => held.push(resolve));
    return { kind: "text", text: "先改 a" };
  });
  const apps: AppHarness[] = [];
  const screen = () => stripTerminalSequences(h.terminal.output());
  const footer = () => stripTerminalSequences((h.app as any).footer.render(100)[0]);
  let h!: AppHarness;
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    h = await startApp(t, { sessionId });
    apps.push(h);

    await submitViaEditor(h, "/plan");
    await waitFor("用法提示", () => screen().includes("用法：/plan <内容>"));
    assert.equal(h.state.tasks.size, 0, "不带内容不提交");

    await submitViaEditor(h, "/plan 调研登录");
    await waitFor("计划模式的任务运行", () => [...h.state.tasks.values()][0]?.status === "running" && held.length > 0);
    const first = [...h.state.tasks.values()][0]!;
    assert.equal(first.input, "/plan 调研登录", "整行作为任务输入");
    await waitFor("状态栏显示计划", () => footer().startsWith("Ask for approval · 计划 · "));
    assert.ok(screen().includes("❯ /plan 调研登录"), "事件流原样显示输入");

    h.terminal.send("/interrupt\r");
    await waitFor("任务中断", () => first.status === "interrupted" || h.state.getTask(first.id)?.status === "interrupted");
    held.splice(0).forEach((release) => release());
    await waitFor("无活动任务时不显示", () => !footer().includes("计划"));

    h.terminal.send("/continue\r");
    await renderFlush();
    await submitViaEditor(h, "接着调研");
    await waitFor("继续任务运行", () => [...h.state.tasks.values()].some((x) => x.resumesTaskId === first.id && x.status === "running") && held.length > 0);
    await waitFor("继续的任务仍显示计划", () => footer().startsWith("Ask for approval · 计划 · "));
    held.splice(0).forEach((release) => release());
    await waitFor("完成", () => [...h.state.tasks.values()].every((x) => x.status !== "running"));
  } finally {
    held.splice(0).forEach((release) => release());
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作清单面板：todo_write 后显示，重连后按工具记录恢复", async () => {
  const list = [{ content: "读代码", status: "completed" }, { content: "改代码", status: "in_progress" }, { content: "跑测试", status: "pending" }];
  const t = await startTestRuntime("tui-todo", async (req) => {
    const last = req.messages.map((m) => m.role).lastIndexOf("user");
    return req.messages.slice(last + 1).some((m) => m.role === "tool")
      ? { kind: "text", text: "好的" }
      : { kind: "tool_calls", calls: [{ id: "todo", name: "todo_write", arguments: { todos: list } }] };
  });
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h1 = await startApp(t, { sessionId });
    apps.push(h1);
    await submitViaEditor(h1, "多步任务");
    await waitFor("面板显示", () => {
      const out = stripTerminalSequences(h1.terminal.output());
      return out.includes("▶ 改代码") && out.includes("☐ 跑测试") && out.includes("☑ 读代码");
    });
    assert.ok(stripTerminalSequences(h1.terminal.output()).includes("⎿ 1/3"), "事件流只显示完成数/总数");
    await waitFor("任务完成", () => [...h1.state.tasks.values()][0]?.status === "completed");
    h1.app.quit(0);
    await waitFor("h1 退出", () => h1.exitCode() === 0);

    const h2 = await startApp(t, { sessionId });
    apps.push(h2);
    await waitFor("重连后面板恢复", () => stripTerminalSequences(h2.terminal.output()).includes("▶ 改代码"));
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/context：无记录提示在面板呈现，事件流仅保留命令", async () => {
  const t = await startTestRuntime("tui-context-empty", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    h.terminal.send("/context");
    h.terminal.send("\r");
    await waitFor("无记录提示", () => stripTerminalSequences(h.terminal.output()).includes("还没有模型调用记录"));
    const entries = h.state.sessionViews.get(sessionId)!.flow.items;
    assert.ok(entries.some((entry) => entry.kind === "command" && entry.line === "/context" && entry.result === null));
    assert.ok(!entries.some((entry) => entry.kind === "note" && entry.text.includes("还没有模型调用记录")), "普通命令说明不写入事件流");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/mode：列表含 Auto review 并可选择，状态栏显示 Auto review", async () => {
  const t = await startTestRuntime("tui-mode", async () => ({ kind: "text", text: "done" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);

    h.terminal.send("/mode\r");
    await waitFor("模式列表", () => h.terminal.output().includes("Auto review"));
    const listOut = h.terminal.output();
    assert.ok(listOut.includes("Ask for approval") && listOut.includes("Full access") && listOut.includes("Auto review"), "三种模式都在列表中");

    // 列表顺序 confirm / full_access / auto-review：下移两项选中 Auto review
    h.terminal.clearOutput();
    h.terminal.send("\x1b[B");
    h.terminal.send("\x1b[B");
    await renderFlush();
    h.terminal.send("\r");
    await waitFor("模式已切换", () => h.state.sessions.find((s) => s.id === sessionId)?.defaultAccessMode === "auto-review");
    const session = await t.client.request<any>("get_session", { session_id: sessionId });
    assert.equal(session.defaultAccessMode, "auto-review", "set_session_mode 落库");

    // 选择后的渲染帧里，状态区（模式：X · 工作区）显示 Auto review
    await waitFor("状态栏显示 Auto review", () => h.terminal.output().includes("Auto review ·"));
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});
