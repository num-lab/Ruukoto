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
import { execFileSync } from "node:child_process";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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
  realTools,
  type TestRuntime,
} from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import type { Session, Task } from "../src/core/types.ts";
import type { HistoryPage } from "../src/core/history.ts";
import type { FlowEntry } from "../src/tui/event-flow.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

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

/** 通过实际上下键遍历输入历史，再回到提交前的空草稿。 */
function assertInputRecall(h: AppHarness, newestFirst: string[]): void {
  const editor = (h.app as any).editor;
  assert.equal(editor.getText(), "");
  for (const text of newestFirst) {
    h.terminal.send("\x1b[A");
    assert.equal(editor.getText(), text, "上键按提交时间倒序调出输入");
  }
  for (const text of [...newestFirst.slice(0, -1).reverse(), ""]) {
    h.terminal.send("\x1b[B");
    assert.equal(editor.getText(), text, "下键向较新输入切换并恢复草稿");
  }
}

/** 同时检查独占布局和当前画面中的四角、两侧边框。 */
function assertWindowFrame(h: AppHarness): void {
  const tui = (h.app as any).tui;
  assert.equal(stripTerminalSequences(tui.currentLayout.lines.join("\n")).trim(), "", "窗口打开时主界面隐藏");
  const lines = tui.previousScreen.map((line: string) => stripTerminalSequences(line));
  const top = lines.findIndex((line: string) => /╭.*╮/.test(line));
  const bottom = lines.findIndex((line: string, index: number) => index > top && /╰.*╯/.test(line));
  assert.ok(top >= 0 && bottom > top, "窗口有完整四角");
  assert.ok(lines.slice(top + 1, bottom).every((line: string) => /│.*│/.test(line)), "窗口两侧边框连续");
}

// ---------- 测试 ----------

test("输入框上横线右侧显示工作区名，长输入与粘贴保留边框和可见光标", async () => {
  const t = await startTestRuntime("tui-editor-height", async () => ({ kind: "text", text: "收到" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const { sessionId: sessionB } = await createProjectSession(t.client, t.work[1]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    const app = h.app as any;
    const editor = app.editor;
    const assertEditor = async (text: string): Promise<number> => {
      await renderFlush();
      const boxes = (box: any): any[] => [box, ...box.children.flatMap(boxes)];
      const box = boxes(app.tui.currentLayout.root).find((candidate) => candidate.component === editor);
      assert.ok(box, "编辑器参与真实布局");
      const rendered: string[] = editor.render(box.rect.width);
      assert.equal(box.rect.height, rendered.length, "布局保留编辑器实际高度，不裁剪原生边框");
      const cwd = h.state.sessionViews.get(h.state.currentSessionId!)!.cwd;
      const workspace = path.basename(cwd);
      const top = stripTerminalSequences(rendered[0]!);
      assert.equal(visibleWidth(top), box.rect.width, "上横线与编辑器等宽");
      assert.ok(top.includes(workspace), "上横线包含当前工作区目录名");
      assert.ok(visibleWidth(top.slice(top.indexOf(workspace))) <= visibleWidth(workspace) + 3, "工作区名位于上横线右侧");
      const footer = stripTerminalSequences(app.footer.render(h.terminal.columns).join("\n"));
      assert.ok(!footer.includes(cwd) && !footer.includes(workspace), "底栏不再显示工作区路径或目录名");
      const screen: string[] = app.tui.previousScreen;
      for (const row of [0, rendered.length - 1]) {
        assert.equal(stripTerminalSequences(screen[box.rect.y + row] ?? ""), stripTerminalSequences(rendered[row]!), "上下横线完整出现在终端画面");
      }
      const cursorRow = rendered.findIndex((line) => line.includes(CURSOR_MARKER));
      assert.ok(cursorRow > 0 && cursorRow < box.rect.height - 1, "光标位于两条横线之间");
      assert.ok((screen[box.rect.y + cursorRow] ?? "").includes("\x1b[7m"), "光标所在输入行在画面中可见");
      assert.equal(editor.getExpandedText(), text, "全文不因可视区域限制而丢失");
      return box.rect.height;
    };
    const emptyHeight = await assertEditor("");
    let typed = "";
    for (let i = 0; i < 4; i++) {
      const chunk = "连续输入的中文文本".repeat(8);
      typed += chunk;
      h.terminal.send(chunk);
      assert.ok(await assertEditor(typed) > emptyHeight, "连续输入时自动增高");
    }
    h.terminal.send("\x03");
    assert.equal(await assertEditor(""), emptyHeight, "清空后缩回初始高度");

    h.state.openSession(sessionId).flow.note("long-history", Array.from({ length: 80 }, (_, i) => `历史事件 ${i}`).join("\n"), new Date().toISOString());
    app.refreshAll();
    const pasted = Array.from({ length: 8 }, (_, i) => `粘贴第 ${i} 行：${"很长的中文段落".repeat(8)}`).join("\n");
    editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    app.tui.requestRender();
    assert.ok(await assertEditor(pasted) > emptyHeight, "长历史事件流下粘贴内容仍能增加高度");
    h.terminal.send("\x03");
    assert.equal(await assertEditor(""), emptyHeight, "长粘贴清空后恢复高度");

    app.switchSession(sessionB);
    await waitFor("切换到另一工作区", () => h.state.sessionViews.get(h.state.currentSessionId!)?.cwd === t.work[1]);
    await assertEditor("");
    app.switchSession(sessionId);
    await waitFor("切回原工作区", () => h.state.sessionViews.get(h.state.currentSessionId!)?.cwd === t.work[0]);
    h.terminal.columns = 16;
    app.tui.requestRender();
    await assertEditor("");
    h.terminal.send("窄屏中文输入".repeat(20));
    assert.ok(await assertEditor("窄屏中文输入".repeat(20)) > emptyHeight, "窄屏长输入仍自动增高并保留两条横线");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

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
    assertInputRecall(first, ["/mode", "/context"]);
    first.app.quit(0);
    await waitFor("首个客户端退出", () => first.exitCode() === 0);

    const requests: Array<{ op: string; params?: Record<string, unknown> }> = [];
    const second = await startApp(t, { sessionId, requests });
    apps.push(second);
    await waitFor("新客户端历史加载", () => second.state.openSession(sessionId).historyLoaded);
    assert.deepEqual(second.state.openSession(sessionId).flow.items.filter((entry) => entry.kind === "command"), commands, "命令正文、结果、身份和原始时间均应恢复");
    assertInputRecall(second, ["/mode", "/context"]);
    assert.ok(!requests.some((request) => request.op === "set_session_mode" || request.op === "get_context_breakdown"), "恢复及上下键调出只显示记录，不重新执行命令");
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

test("命令与普通消息共享上下键输入历史，重开后保持提交顺序", async () => {
  const t = await startTestRuntime("tui-mixed-input-history", async () => ({ kind: "text", text: "已完成" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const first = await startApp(t, { sessionId });
    apps.push(first);
    await submitViaEditor(first, "/context");
    await submitViaEditor(first, "普通消息");
    await waitFor("普通任务完成", () => [...first.state.tasks.values()].some((task) => task.status === "completed"));
    await submitViaEditor(first, "/mode");
    first.terminal.send("\x1b");
    assertInputRecall(first, ["/mode", "普通消息", "/context"]);
    first.app.quit(0);
    await waitFor("首个客户端退出", () => first.exitCode() === 0);

    const requests: Array<{ op: string; params?: Record<string, unknown> }> = [];
    const second = await startApp(t, { sessionId, requests });
    apps.push(second);
    await waitFor("混合输入历史恢复", () => second.state.openSession(sessionId).historyLoaded);
    assertInputRecall(second, ["/mode", "普通消息", "/context"]);
    assert.ok(!requests.some((request) => ["set_session_mode", "get_context_breakdown", "submit"].includes(request.op)), "调出历史不会执行命令或提交任务");
    assert.equal(t.server.calls.length, 1, "上下键不触发额外模型调用");
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
    const app = second.app as any;
    app.scroll.scrollTo(20, { disableFollow: true });
    app.tui.requestRender();
    await renderFlush();
    const historyScreen = app.tui.previousScreen.map((line: string) => stripTerminalSequences(line));
    const promptRow = historyScreen.findIndex((line: string) => line.includes("❯ 返回长正文"));
    assert.ok(promptRow >= 0 && promptRow < 5, "历史滚动时任务输入固定在事件流顶部");
    assert.equal(historyScreen.filter((line: string) => line.includes("返回长正文")).length, 1);
    app.scroll.scrollToEnd();
    app.tui.requestRender();
    await renderFlush();
    assert.doesNotMatch(stripTerminalSequences(app.tui.previousScreen.join("\n")), /返回长正文/, "恢复跟随末尾后取消置顶");
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

test("置顶用户消息在任务边界切换时，向下及向上每次只移动一行", async () => {
  const t = await startTestRuntime("tui-sticky-boundary", async () => ({ kind: "text", text: "不应调用模型" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    await waitFor("初始历史加载", () => h.state.openSession(sessionId).historyLoaded);
    await renderFlush();
    const app = h.app as any;
    const message = (key: string, taskId: string, role: string, text: string): FlowEntry => ({
      key, taskId, kind: "message", role, text, at: "2026-09-30T00:00:00.000Z", seq: 0,
      entryId: null, totalBytes: Buffer.byteLength(text), truncated: false, streaming: false,
    });
    app.eventFlowView.setEntries([
      message("first-input", "first-task", "user", "第一任务输入"),
      message("first-answer", "first-task", "assistant", Array.from({ length: 8 }, (_, i) => `前文${i}`).join("\n")),
      message("second-input", "second-task", "user", "第二任务输入"),
      message("second-answer", "second-task", "assistant", "边界后的正文锚点\n" + Array.from({ length: 60 }, (_, i) => `后文${i}`).join("\n")),
    ]);
    app.tui.requestRender();
    await renderFlush();
    const lines = app.eventFlowView.render(h.terminal.columns - 2).map((line: string) => stripTerminalSequences(line));
    const secondStart = lines.findIndex((line: string) => line.includes("第二任务输入"));
    assert.ok(secondStart > 1);
    app.scroll.scrollTo(secondStart - 1, { disableFollow: true });
    app.tui.requestRender();
    await renderFlush();
    const screen = (): string[] => app.tui.previousScreen.map((line: string) => stripTerminalSequences(line));
    const before = screen();
    assert.ok(before.some((line) => line.includes("第一任务输入")), "任务边界前显示第一任务置顶输入");
    const anchorRow = before.findIndex((line) => line.includes("边界后的正文锚点"));
    assert.ok(anchorRow >= 0, "屏幕中包含用于检测滚动距离的正文锚点");
    const top = app.scroll.scrollTop;
    const height = app.scroll.viewportHeight;
    app.scroll.scrollBy(1);
    app.tui.requestRender();
    await renderFlush();
    const after = screen();
    assert.equal(after.findIndex((line) => line.includes("边界后的正文锚点")), anchorRow - 1, "向下滚动一行时正文只上移一行");
    assert.equal(app.scroll.scrollTop, top + 1);
    assert.equal(app.scroll.viewportHeight, height, "置顶输入消失时视口高度不变");
    assert.ok(!after.some((line) => line.includes("第一任务输入")), "第二任务输入进入顶部时取消上一任务置顶");
    app.scroll.scrollBy(-1);
    app.tui.requestRender();
    await renderFlush();
    assert.equal(screen().findIndex((line) => line.includes("边界后的正文锚点")), anchorRow, "向上滚动一行恢复原来的正文位置");
    assert.equal(app.scroll.scrollTop, top);
    assert.equal(app.scroll.viewportHeight, height);
    assert.ok(screen().some((line) => line.includes("第一任务输入")), "向上跨任务边界恢复第一任务置顶");
    assert.equal(t.server.calls.length, 0);
  } finally {
    quitAll(apps);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.shutdown();
  }
});

test("滚到事件流顶部自动加载更早历史，重复上滚只请求一次并保留正文位置", async () => {
  const t = await startTestRuntime("tui-auto-older", async () => ({ kind: "text", text: "不应调用模型" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    await waitFor("初始历史加载", () => h.state.openSession(sessionId).historyLoaded);
    await renderFlush();
    const app = h.app as any;
    const entry = (entryId: string, timestamp: string, text: string): HistoryPage["entries"][number] => ({
      entryId, parentId: null, role: "assistant", timestamp, text, offset: 0,
      totalBytes: Buffer.byteLength(text), truncated: false, toolCalls: [], toolCallId: null,
      toolName: null, isError: null, hasNonTextContent: false,
    });
    const current = entry("current-page", "2026-10-01T00:00:00.000Z",
      "当前页正文锚点\n" + Array.from({ length: 70 }, (_, i) => `当前正文 ${i}`).join("\n"));
    const older = entry("older-page", "2026-09-30T00:00:00.000Z", "更早历史正文\n" + "旧正文\n".repeat(10));
    h.state.installHistoryPage(sessionId, { fileAvailable: true, hasPartialTail: false, entries: [current], nextBefore: current.entryId }, "replace");
    app.refreshTranscript();
    await renderFlush();
    const originalRequest = h.connection.request.bind(h.connection);
    const requests: Record<string, unknown>[] = [];
    let finishPage!: (page: HistoryPage) => void;
    h.connection.request = ((op: string, params: Record<string, unknown>, timeout?: number) => {
      if (op !== "read_history") return originalRequest(op as TuiOp, params, timeout);
      requests.push(params);
      return new Promise<HistoryPage>((resolve) => { finishPage = resolve; });
    }) as typeof h.connection.request;
    app.scroll.scrollBy(-10000);
    app.scroll.scrollBy(-1);
    app.scroll.scrollBy(-1);
    app.tui.requestRender();
    await waitFor("顶部触发历史请求", () => requests.length > 0);
    await renderFlush();
    const screen = (): string[] => app.tui.previousScreen.map((line: string) => stripTerminalSequences(line));
    const anchorPosition = (): number => {
      const boxes = (box: any): any[] => [box, ...box.children.flatMap(boxes)];
      const viewport = boxes(app.tui.currentLayout.root).find((box) => box.component === app.scroll);
      assert.ok(viewport, "事件流具有实际滚动视口");
      return screen().findIndex((line) => line.includes("当前页正文锚点")) - viewport.rect.y;
    };
    const anchorRow = anchorPosition();
    assert.ok(anchorRow >= 0, "分页开始前显示当前正文开头");
    assert.equal(requests.length, 1, "加载中连续上滚不会发起重复请求");
    assert.equal(requests[0]!.session_id, sessionId);
    assert.equal(requests[0]!.before, current.entryId, "使用最早条目的游标向前翻页");
    finishPage({ fileAvailable: true, hasPartialTail: false, entries: [older, current], nextBefore: null });
    await waitFor("更早历史安装", () => h.state.openSession(sessionId).flow.items.some((item) => item.kind === "message" && item.entryId === older.entryId));
    await renderFlush();
    assert.equal(anchorPosition(), anchorRow, "前插更早正文后在滚动视口中的查看位置不跳动");
    assert.equal(h.state.openSession(sessionId).flow.items.filter((item) => item.kind === "message" && item.entryId === current.entryId).length, 1, "重叠的历史条目不会重复显示");
    app.scroll.scrollBy(-10000);
    app.tui.requestRender();
    await renderFlush();
    assert.ok(screen().some((line) => line.includes("更早历史正文")), "继续上滚可查看新增的更早正文");
    assert.equal(requests.length, 1, "没有更早游标时停止请求");
    assert.equal(t.server.calls.length, 0);
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
    for (const key of ["q", "\x1b"]) {
      for (const detail of [false, true]) {
        h.terminal.send("/approvals\r");
        await renderFlush();
        if (detail) {
          h.terminal.send("\r");
          await renderFlush();
        }
        assert.equal((h.app as any).windows.length, 1, "审批列表或详情已打开");
        h.terminal.send(key);
        await renderFlush();
        assert.equal((h.app as any).windows.length, 0, "q 和 Esc 均关闭审批窗口");
        assert.equal(h.state.pendingApprovals().length, 1, "关闭窗口不批准或拒绝审批");
        assert.equal((h.app as any).editor.getText(), "", "关闭按键不进入草稿");
      }
    }
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
    // 启动后默认进入项目选择，不选中任何会话
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

test("/context：最近一次上下文窗口分解写入事件流", async () => {
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
    await waitFor("分解展示", () => h.state.sessionViews.get(sessionId)!.flow.items.some((entry) => entry.kind === "command" && entry.line === "/context" && stripTerminalSequences(entry.result ?? "").startsWith("Context Usage")));
    const detail = stripTerminalSequences(h.terminal.output());
    assert.ok(detail.includes("❯ /context") && detail.includes("⎿ Context Usage"), "命令与标题在事件流");
    assert.ok(detail.includes("█"), "长条已渲染");
    // 出现过的分类都要在图例里（本次消息少，不一定有历史轮次）
    assert.ok(detail.includes("系统提示") && detail.includes("工具定义"), "分类图例齐全");
    assert.ok(detail.includes("预留") && detail.includes("尚余输入"), "预留与余量在图例中");
    const command = h.state.sessionViews.get(sessionId)!.flow.items.find((entry) => entry.kind === "command" && entry.line === "/context");
    const resultText = command?.kind === "command" ? command.result : null;
    assert.ok(resultText);
    assert.ok(resultText.includes("尚余输入"));
    assert.match(resultText, /\x1b\[38;5;75m█/, "持久结果保留分类颜色");
    assert.match(resultText, /\x1b\[38;5;131m█/, "预留段使用不同颜色");
    assert.match(stripTerminalSequences(resultText), /\d+(?:\.\d+)?[km]/, "上下文用量带 k/m 单位");
    for (const width of [32, 120, 80]) {
      const bar = (h.app as any).eventFlowView.render(width).find((line: string) => /^█+$/.test(stripTerminalSequences(line)));
      assert.ok(bar);
      assert.equal(visibleWidth(bar), width, "实际命令结果在缩窄和放大后仍是等宽长条");
    }
    // 命令结果随历史保留，不受 Esc 影响。
    h.terminal.send("\x1b");
    await renderFlush();
    assert.equal(command?.kind === "command" ? command.result : null, resultText);

    // /prompt 的详情覆盖列表；逐层关闭时先恢复列表，再恢复主界面。
    const windows = () => (h.app as any).windows as Array<{ isHidden(): boolean }>;
    const mainFrame = () => stripTerminalSequences((h.app as any).tui.currentLayout.lines.join("\n"));
    const screen = () => stripTerminalSequences((h.app as any).tui.previousScreen.join("\n"));
    const snapshot = {
      v: 1, model: { provider: "mock", id: "test-model" },
      systemPrompt: `系统正文起点\n${"汉".repeat(17_000)}\n系统正文终点`,
      messages: [
        { role: "user", content: [{ type: "text", text: "首条用户消息跨页保留" }] },
        { role: "assistant", content: [{ type: "text", text: "助手正文可查阅" }] },
      ],
      tools: [{ name: "read", description: "读取文件", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    };
    let snapshotBytes = Buffer.from(JSON.stringify(snapshot));
    // 强制 48 KiB 分页切进一个汉字，逐页解码会丢字或产生替换字符。
    while ((snapshotBytes[48 * 1024]! & 0xc0) !== 0x80) {
      snapshot.systemPrompt = `a${snapshot.systemPrompt}`;
      snapshotBytes = Buffer.from(JSON.stringify(snapshot));
    }
    const offsets: number[] = [];
    const request = h.connection.request.bind(h.connection);
    h.connection.request = ((op: TuiOp, params: any, timeoutMs?: number) => {
      if (op !== "read_prompt_snapshot") return request(op, params, timeoutMs);
      const offset = params.offset ?? 0;
      offsets.push(offset);
      return Promise.resolve({ artifact: { byteCount: snapshotBytes.length }, encoding: "base64", data: snapshotBytes.subarray(offset, offset + params.length).toString("base64") });
    }) as typeof h.connection.request;
    for (const key of ["q", "\x1b"]) {
      h.terminal.clearOutput();
      h.terminal.send("/prompt\r");
      await waitFor("模型请求列表", () => windows().length === 1 && stripTerminalSequences(h.terminal.output()).includes("模型请求"));
      assert.equal(windows()[0]!.isHidden(), false);
      assertWindowFrame(h);

      h.terminal.send("\r");
      await waitFor("prompt 详情", () => windows().length === 2);
      await renderFlush();
      assert.equal(windows()[0]!.isHidden(), true, "列表在详情下方隐藏");
      assert.equal(windows()[1]!.isHidden(), false, "详情显示在最上层");
      assertWindowFrame(h);
      await waitFor("快照全部分页解析完成", () => screen().includes("系统提示") && !screen().includes("加载中"));
      assert.ok(offsets.includes(48 * 1024), "完整读取第二页后再解析 JSON");
      let rendered = screen();
      for (let i = 0; i < 60 && !rendered.includes("助手正文可查阅"); i++) {
        for (let line = 0; line < 12; line++) h.terminal.send("\x1b[B");
        await renderFlush();
        rendered += `\n${screen()}`;
      }
      assert.ok(rendered.includes("系统正文起点") && rendered.includes("系统正文终点"), "长系统提示的首尾均可查阅");
      assert.ok(rendered.includes("用户") && rendered.includes("首条用户消息跨页保留"), "滚动后可查阅第一条用户正文");
      assert.ok(rendered.includes("助手") && rendered.includes("助手正文可查阅"), "助手消息使用可读标题与正文");
      assert.doesNotMatch(rendered, /systemPrompt|messages|tools|\ufffd/, "不显示 JSON 原文键，也不损坏跨页中文");

      h.terminal.send(key);
      await renderFlush();
      assert.equal(windows().length, 1);
      assert.equal(windows()[0]!.isHidden(), false, "关闭详情后列表恢复");
      assert.equal(mainFrame().trim(), "", "列表仍打开时主布局隐藏");
      h.terminal.send(key);
      await renderFlush();
      assert.equal(windows().length, 0);
      assert.ok(mainFrame().includes("❯ /context"), "关闭列表后事件流恢复");
      assert.equal((h.app as any).editor.getText(), "", "关闭按键不进入草稿");
    }

    snapshotBytes = Buffer.from('{"systemPrompt":"损坏原文不应展示');
    h.terminal.send("/prompt\r");
    await waitFor("损坏快照请求列表", () => windows().length === 1);
    h.terminal.send("\r");
    await waitFor("快照解析错误", () => screen().includes("读取失败") && screen().includes("无法解析"));
    assert.ok(!screen().includes("损坏原文不应展示"), "解析错误只显示说明，不倾倒原文");
    h.terminal.send("\x1b");
    await renderFlush();
    assert.equal(windows().length, 1, "错误详情也能返回请求列表");
    h.terminal.send("q");
    await renderFlush();

    const reopened = await startApp(t, { sessionId });
    apps.push(reopened);
    await waitFor("分色结果恢复", () => reopened.state.openSession(sessionId).flow.items.some((entry) => entry.kind === "command" && entry.line === "/context" && entry.result === resultText));
    assert.match(reopened.terminal.output(), /\x1b\[38;5;75m/, "重进会话后仍显示分色长条");
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

test("Plan 持续用于普通消息和继续，状态栏显示固定任务模式与默认值，重连不重复提交", async () => {
  const held: Array<() => void> = [];
  const t = await startTestRuntime("tui-plan", async () => {
    await new Promise<void>((resolve) => held.push(resolve));
    return { kind: "text", text: "先改 a" };
  });
  const apps: AppHarness[] = [];
  let h!: AppHarness;
  const footer = () => stripTerminalSequences((h.app as any).footer.render(180)[0]);
  const setMode = async (mode: "plan" | "full_access") => {
    const session = h.state.sessions.find((s) => s.id === h.state.currentSessionId)!;
    await (h.app as any).sendSessionMode(session.id, session.defaultAccessModeVersion, mode, (text: string, isError?: boolean) => assert.ok(!isError, text));
  };
  const active = () => h.state.activeTaskFor(h.state.currentSessionId!)!;
  const interrupt = async (id: string) => {
    await submitViaEditor(h, "/interrupt");
    await waitFor("任务中断", () => h.state.getTask(id)?.status === "interrupted");
    held.splice(0).forEach((release) => release());
  };
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    h = await startApp(t, { sessionId });
    apps.push(h);
    for (const input of ["/plan", "/plan 调研登录"]) {
      await submitViaEditor(h, input);
      assert.equal(h.state.tasks.size, 0, "已移除命令不能提交任务");
    }
    assert.ok(stripTerminalSequences(h.terminal.output()).includes("未知命令：/plan"));

    await setMode("plan");
    await submitViaEditor(h, "调研登录");
    await waitFor("Plan 任务运行", () => active()?.status === "running" && held.length > 0);
    const first = active();
    assert.equal(first.input, "调研登录");
    assert.equal(first.planMode, true);
    assert.equal(first.accessMode, "auto-review");
    assert.ok(footer().startsWith("☷ Plan"));
    await interrupt(first.id);
    assert.ok(footer().startsWith("☷ Plan"), "中断后会话仍选中 Plan");

    await submitViaEditor(h, "/continue");
    await submitViaEditor(h, "接着调研");
    await waitFor("继续任务运行", () => active()?.resumesTaskId === first.id && held.length > 0);
    const second = active();
    assert.equal(second.planMode, true);
    assert.equal(second.accessMode, "auto-review");
    held.splice(0).forEach((release) => release());
    await waitFor("计划完成", () => h.state.getTask(second.id)?.status === "completed");
    assert.ok(footer().startsWith("☷ Plan"), "计划完成不退出 Plan");

    await submitViaEditor(h, "开始实现");
    await waitFor("开始实现仍是 Plan", () => active()?.input === "开始实现" && held.length > 0);
    const third = active();
    assert.equal(third.planMode, true);
    await setMode("full_access");
    assert.ok(footer().startsWith("☷ Plan · 会话默认 ⏵⏵ Full access"), "默认值切换不改当前任务");
    h.app.quit(0);
    h = await startApp(t, { sessionId });
    apps.push(h);
    await waitFor("重连恢复实际模式", () => footer().startsWith("☷ Plan · 会话默认 ⏵⏵ Full access"));
    assert.equal(h.state.tasks.size, 3, "重连不重复建任务");
    await interrupt(third.id);
    await submitViaEditor(h, "/continue");
    await submitViaEditor(h, "按计划实现");
    await waitFor("切换后继续运行", () => active()?.resumesTaskId === third.id && held.length > 0);
    assert.equal(active().planMode, false, "继续使用提交时的选择，不继承 Plan");
    assert.equal(active().accessMode, "full_access");
    assert.ok(footer().startsWith("⏵⏵ Full access") && !footer().includes("Plan"));
    held.splice(0).forEach((release) => release());
    await waitFor("完成", () => !active());
  } finally {
    held.splice(0).forEach((release) => release());
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/todo：右上角带边框悬浮层保留主界面与输入焦点，重复命令关闭，重连后可查看", async () => {
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
    const app = h1.app as any;
    await waitFor("工具记录恢复清单", () => h1.state.openSession(sessionId).flow.tools.some((tool) => tool.name === "todo_write" && tool.status === "done"));
    await renderFlush();
    assert.ok(stripTerminalSequences(h1.terminal.output()).includes("⎿ 1/3"), "事件流只显示完成数/总数");
    await waitFor("任务完成", () => [...h1.state.tasks.values()][0]?.status === "completed");
    await renderFlush();
    assert.doesNotMatch(stripTerminalSequences(app.tui.previousScreen.join("\n")), /▶ 改代码|⏸ 跑测试|✓ 读代码/, "不再常驻显示清单");
    await submitViaEditor(h1, "/todo");
    assert.ok(app.todoOverlay);
    const bounds = app.todoOverlay.getBounds();
    assert.ok(bounds && bounds.col > 0 && bounds.row === 1, "右上角展示");
    const popup = app.tui.previousScreen.slice(bounds.row, bounds.row + bounds.height).map((line: string) => stripTerminalSequences(line));
    for (const marker of ["▶ 改代码", "⏸ 跑测试", "✓ 读代码", "╭", "╮", "╰", "╯"]) assert.ok(popup.join("\n").includes(marker), marker);
    assert.match(stripTerminalSequences(app.tui.currentLayout.lines.join("\n")), /连接：/, "主界面保留");
    assert.equal(app.windows.length, 0);
    assert.equal(app.tui.getFocusedComponent(), app.editor, "输入框保留焦点，可以再次输入命令");
    const tool = h1.state.openSession(sessionId).flow.tools.find((tool) => tool.name === "todo_write" && tool.status === "done")!;
    tool.params.todos = Array.from({ length: 20 }, (_, i) => ({ content: `完整清单第${i + 1}项`, status: "completed" }));
    app.refreshAll();
    await renderFlush();
    assert.match(stripTerminalSequences(app.tui.previousScreen.join("\n")), /✓ 完整清单第1项/, "实时更新并保留完成项");
    const scrollBounds = app.todoOverlay.getBounds();
    const top = app.scroll.scrollTop;
    for (let i = 0; i < 12; i++) app.tui.handleViewportInput(`\x1b[<65;${scrollBounds.col + 3};${scrollBounds.row + 3}M`);
    await renderFlush();
    assert.match(stripTerminalSequences(app.tui.previousScreen.join("\n")), /✓ 完整清单第20项/, "滚轮可查看整张长清单");
    assert.equal(app.scroll.scrollTop, top, "悬浮层滚动不移动事件流");
    assert.equal(app.tui.getFocusedComponent(), app.editor, "滚轮不会抢输入焦点");
    tool.params.todos = [];
    app.refreshAll();
    await renderFlush();
    assert.match(stripTerminalSequences(app.tui.previousScreen.join("\n")), /暂无工作清单/);
    tool.params.todos = list;
    app.refreshAll();
    await renderFlush();
    await submitViaEditor(h1, "/help");
    assert.doesNotMatch(stripTerminalSequences(app.tui.previousScreen.join("\n")), /▶ 改代码/, "窗口打开时暂时隐藏清单");
    h1.terminal.send("\x1b");
    await renderFlush();
    assert.match(stripTerminalSequences(app.tui.previousScreen.join("\n")), /▶ 改代码/, "关闭窗口后恢复清单");
    await submitViaEditor(h1, "/todo");
    assert.equal(app.todoOverlay, null, "重复命令关闭悬浮层");
    h1.app.quit(0);
    await waitFor("h1 退出", () => h1.exitCode() === 0);

    const h2 = await startApp(t, { sessionId });
    apps.push(h2);
    await waitFor("重连后工具记录恢复", () => h2.state.openSession(sessionId).flow.tools.some((tool) => tool.name === "todo_write" && tool.status === "done"));
    assert.equal((h2.app as any).todoOverlay, null, "重开不自动打开清单");
    await submitViaEditor(h2, "/todo");
    assert.match(stripTerminalSequences((h2.app as any).tui.previousScreen.join("\n")), /▶ 改代码/);
    h2.terminal.send("\x1b");
    await renderFlush();
    assert.equal((h2.app as any).todoOverlay, null, "Esc 关闭清单");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/context：无记录提示写在命令下", async () => {
  const t = await startTestRuntime("tui-context-empty", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    h.terminal.send("/context");
    h.terminal.send("\r");
    await waitFor("无记录提示", () => stripTerminalSequences(h.terminal.output()).includes("暂无记录"));
    const entries = h.state.sessionViews.get(sessionId)!.flow.items;
    assert.ok(entries.some((entry) => entry.kind === "command" && entry.line === "/context" && entry.result?.includes("暂无记录")));
    assert.ok(!entries.some((entry) => entry.kind === "note" && entry.text.includes("暂无记录")), "普通命令说明不写入事件流");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("Shift+Tab 循环切换默认模式，连续按键落盘且保留草稿，悬浮层和窗口不触发切换", async () => {
  const t = await startTestRuntime("tui-mode-shortcut", async () => ({ kind: "text", text: "done" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const requests: Array<{ op: string; params?: Record<string, unknown> }> = [];
    const h = await startApp(t, { sessionId, requests });
    apps.push(h);
    const app = h.app as any;
    const current = () => h.state.sessions.find((session) => session.id === sessionId)!;
    const initialVersion = current().defaultAccessModeVersion;
    assert.equal(current().defaultAccessMode, "confirm");
    h.terminal.send("未提交草稿");

    for (const [index, mode] of ["full_access", "auto-review", "plan", "confirm"].entries()) {
      h.terminal.send("\x1b[Z");
      await waitFor(`快捷键切换至 ${mode}`, () => current().defaultAccessModeVersion === initialVersion + index + 1);
      const saved = await t.client.request<any>("get_session", { session_id: sessionId });
      assert.equal(saved.defaultAccessMode, mode);
      assert.equal(saved.defaultAccessModeVersion, initialVersion + index + 1, "每次切换增加一个版本并落盘");
      assert.equal(app.editor.getText(), "未提交草稿", "切换模式不改变草稿");
    }

    h.terminal.send("\x1b[Z\x1b[Z\x1b[Z\x1b[Z");
    await waitFor("连续四次切换全部完成", () => current().defaultAccessModeVersion === initialVersion + 8);
    const saved = await t.client.request<any>("get_session", { session_id: sessionId });
    assert.equal(saved.defaultAccessMode, "confirm", "连续四次切换完成完整循环");
    assert.equal(saved.defaultAccessModeVersion, initialVersion + 8);
    assert.deepEqual(requests.filter((request) => request.op === "set_session_mode").map((request) => request.params?.expected_version), Array.from({ length: 8 }, (_, index) => initialVersion + index), "连续按键按后台版本串行提交，不冲突或丢失");

    for (const open of [() => app.cmdMode([], () => {}), () => app.openHelp()]) {
      await open();
      await renderFlush();
      assert.equal(app.tui.hasOverlay(), true);
      h.terminal.send("\x1b[Z");
      await renderFlush();
      const unchanged = await t.client.request<any>("get_session", { session_id: sessionId });
      assert.equal(unchanged.defaultAccessModeVersion, initialVersion + 8, "悬浮层和窗口获得焦点时不修改模式");
      assert.equal(requests.filter((request) => request.op === "set_session_mode").length, 8);
      h.terminal.send("\x1b");
      assert.equal(app.editor.getText(), "未提交草稿");
    }
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("切换会话沿用当前模式、模型与思考强度，提交等待目标设置落盘", async () => {
  const t = await startTestRuntime("tui-carry-settings", async () => ({ kind: "text", text: "done" }));
  const apps: AppHarness[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const file = path.join(t.dirs.agentDir, "models.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.providers.second = { ...config.providers.mock, models: [{ ...config.providers.mock.models[0], id: "reasoner", reasoning: true, maxTokens: 4096 }] };
    fs.writeFileSync(file, JSON.stringify(config));
    await (t.runtime as any).rebuildModelStack();
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const { sessionId: sessionB } = await createProjectSession(t.client, t.work[1]!);
    const requests: Array<{ op: string; params?: Record<string, unknown> }> = [];
    const h = await startApp(t, { sessionId, requests });
    apps.push(h);
    const app = h.app as any;
    const current = () => h.state.sessions.find((session) => session.id === h.state.currentSessionId)!;
    const low = { provider: "second", modelId: "reasoner", thinkingLevel: "low" };
    const checkResult = (text: string, isError?: boolean) => assert.ok(!isError, text);
    await app.sendSessionMode(sessionId, current().defaultAccessModeVersion, "plan", checkResult);
    await app.saveModelSelection(sessionId, current().modelSelectionVersion, low, checkResult);
    const request = h.connection.request.bind(h.connection);
    let settingsBlocked = false;
    h.connection.request = async <K extends TuiOp>(op: K, params: OpParams<K>, timeoutMs?: number) => {
      if (op === "set_session_model" && (params as any).session_id === sessionB) {
        settingsBlocked = true;
        await blocked;
      }
      return request(op, params, timeoutMs);
    };

    app.switchSession(sessionB);
    await waitFor("目标模型设置正在同步", () => settingsBlocked);
    await submitViaEditor(h, "切换后立即提交");
    assert.equal(requests.filter((item) => item.op === "submit").length, 0, "同步完成前不能使用目标会话旧设置提交");
    release();
    await waitFor("切换后的任务完成", () => [...h.state.tasks.values()].some((task) => task.sessionId === sessionB && task.status === "completed"));
    const task = [...h.state.tasks.values()].find((item) => item.sessionId === sessionB)!;
    assert.equal(task.accessMode, "auto-review");
    assert.equal(task.planMode, true);
    assert.deepEqual(task.modelSelection, low);
    const savedB = await t.client.request<any>("get_session", { session_id: sessionB });
    assert.equal(savedB.defaultAccessMode, "plan");
    assert.deepEqual(savedB.modelSelection, low, "沿用的模型与思考强度在目标会话落盘");

    const high = { ...low, thinkingLevel: "high" };
    await app.sendSessionMode(sessionB, current().defaultAccessModeVersion, "auto-review", checkResult);
    await app.saveModelSelection(sessionB, current().modelSelectionVersion, high, checkResult);
    app.switchSession(sessionId);
    await app.sessionSettingsSync;
    const savedA = await t.client.request<any>("get_session", { session_id: sessionId });
    assert.equal(savedA.defaultAccessMode, "auto-review", "切回时沿用最新选择");
    assert.deepEqual(savedA.modelSelection, high, "切回时不恢复目标会话旧思考强度");
    assert.deepEqual(current().modelSelection, high);
  } finally {
    release();
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/mode：列表提供四种模式并可选择 Plan，取消不改状态", async () => {
  const t = await startTestRuntime("tui-mode", async () => ({ kind: "text", text: "done" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);

    const before = h.state.sessions.find((s) => s.id === sessionId)!;
    const initialVersion = before.defaultAccessModeVersion;
    for (const command of ["/mode", "/model"]) {
      for (const key of ["q", "\x1b"]) {
        h.terminal.clearOutput();
        h.terminal.send(`${command}\r`);
        const label = command === "/mode" ? "Auto review" : "Mock Model";
        await waitFor(`${command} 悬浮层`, () => stripTerminalSequences(h.terminal.output()).includes(label));
        await renderFlush();
        const tui = (h.app as any).tui;
        assert.match(stripTerminalSequences(tui.currentLayout.lines.join("\n")), /连接：/, `${command} 悬浮层保留主界面`);
        assert.ok(stripTerminalSequences(tui.previousScreen.join("\n")).includes(label), `${command} 面板在当前画面中`);
        assert.equal((h.app as any).windows.length, 0, `${command} 不打开窗口`);
        h.terminal.send(key);
        await renderFlush();
        assert.equal(tui.hasOverlay(), false, `${command} 可用 q 和 Esc 关闭`);
        assert.equal((h.app as any).editor.getText(), "", "关闭按键不进入草稿");
        assert.equal(before.defaultAccessMode, "confirm");
        assert.equal(before.defaultAccessModeVersion, initialVersion, "取消不修改默认模式");
      }
    }

    h.terminal.clearOutput();
    h.terminal.send("/mode\r");
    await waitFor("模式列表", () => h.terminal.output().includes("Auto review"));
    await renderFlush();
    assert.match(stripTerminalSequences((h.app as any).tui.currentLayout.lines.join("\n")), /连接：/, "模式列表保持原有主界面布局");
    assert.match(stripTerminalSequences((h.app as any).tui.previousScreen.join("\n")), /Auto review/, "模式列表仍在当前画面中");
    const listOut = h.terminal.output();
    assert.ok(listOut.includes("Ask for approval") && listOut.includes("Full access") && listOut.includes("Auto review") && listOut.includes("Plan"), "四种模式都在列表中");

    // 列表顺序 confirm / full_access / auto-review / plan：下移三项选中 Plan
    h.terminal.clearOutput();
    h.terminal.send("\x1b[B");
    h.terminal.send("\x1b[B");
    h.terminal.send("\x1b[B");
    await renderFlush();
    h.terminal.send("\r");
    await waitFor("模式已切换", () => h.state.sessions.find((s) => s.id === sessionId)?.defaultAccessMode === "plan");
    const session = await t.client.request<any>("get_session", { session_id: sessionId });
    assert.equal(session.defaultAccessMode, "plan", "set_session_mode 落库");

    // 选择后状态区显示会话持久化的 Plan
    await waitFor("状态栏显示 Plan", () => h.terminal.output().includes("Plan ·"));
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("非普通开发身份的 /mode 与 Shift+Tab 仅提供三个访问模式，Plan 不随会话切换进入", async () => {
  const t = await startTestRuntime("tui-plan-identity", async () => ({ kind: "text", text: "done" }));
  const apps: AppHarness[] = [];
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const create = async () => t.client.request<Session>("create_session", { project_id: projectId, cwd: t.work[0]! });
    const main = t.runtime.store.getSession(t.runtime.store.getAgentRole("main")!.sessionId)!;
    const sub = await create();
    t.runtime.store.insertSubAgent({ id: "sub-mode", parentSessionId: sessionId, sessionId: sub.id, workDir: sub.cwd, activeWorkId: null, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
    const archive = await create();
    t.runtime.store.db.prepare("UPDATE sessions SET kind = 'qq_group' WHERE id = ?").run(archive.id);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    const app = h.app as any;
    const result = (text: string, isError?: boolean) => assert.ok(!isError, text);
    await app.sendSessionMode(sessionId, 0, "plan", result);
    for (const id of [main.id, sub.id, archive.id]) {
      app.switchSession(id);
      await app.sessionSettingsSync;
      assert.equal(h.state.sessions.find((s) => s.id === id)!.defaultAccessMode, "confirm", "Plan 不同步进无资格身份");
      await app.cmdMode([], result);
      await renderFlush();
      const screen = stripTerminalSequences(app.tui.previousScreen.join("\n"));
      assert.ok(screen.includes("Auto review") && !screen.includes("Plan"));
      h.terminal.send("\x1b");
      if (id === sub.id) {
        h.terminal.send("\x1b[Z");
        await renderFlush();
        assert.equal(h.state.sessions.find((s) => s.id === id)!.defaultAccessMode, "confirm", "SubAgent 原有默认模式修改禁令保留");
        continue;
      }
      for (const mode of ["full_access", "auto-review", "confirm"]) {
        h.terminal.send("\x1b[Z");
        await waitFor(`无 Plan 循环至 ${mode}`, () => h.state.sessions.find((s) => s.id === id)!.defaultAccessMode === mode);
      }
    }
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("其他客户端排队的 Plan 通过事件标记显示，版本冲突后恢复后台默认值", async () => {
  const t = await startTestRuntime("tui-plan-remote", async () => ({ kind: "text", text: "done" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    t.runtime.store.setSessionQueueState(sessionId, "paused", "owner_pause");
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "full_access", expected_version: 0 });
    const h = await startApp(t, { sessionId });
    apps.push(h);
    const app = h.app as any;
    const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "remote-plan", input: "外部客户端调研", access_mode: "plan", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
    await waitFor("其他客户端的 Plan 排队事件", () => h.state.getTask(task.id)?.planMode === true);
    assert.equal(h.state.getTask(task.id)!.input, "", "事件无需携带输入");
    const footer = () => stripTerminalSequences(app.footer.render(180)[0]);
    assert.ok(footer().startsWith("☷ Plan · 会话默认 ⏵⏵ Full access"));
    await t.client.request("set_session_mode", { session_id: sessionId, mode: "plan", expected_version: 1 });
    const errors: string[] = [];
    await app.sendSessionMode(sessionId, 1, "confirm", (text: string, isError?: boolean) => { if (isError) errors.push(text); });
    assert.ok(errors.some((text) => text.includes("其他客户端修改")));
    const session = h.state.sessions.find((s) => s.id === sessionId)!;
    assert.equal(session.defaultAccessMode, "plan");
    assert.equal(session.defaultAccessModeVersion, 2);
    assert.ok(footer().startsWith("☷ Plan") && !footer().includes("会话默认"));
    assert.equal(h.state.getTask(task.id)!.accessMode, "auto-review");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("/resume 只列当前项目会话，/project 经项目窗口进入目标会话", async () => {
  const t = await startTestRuntime("tui-project-resume", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!, { projectName: "当前项目" });
    const sessionA2 = await t.client.request<any>("create_session", { project_id: projectId, cwd: t.work[0]!, confirm_tools: [] });
    const target = await createProjectSession(t.client, t.work[1]!, { projectName: "目标项目" });
    const h = await startApp(t, { sessionId });
    apps.push(h);
    const app = h.app as any;
    const screen = () => stripTerminalSequences(app.tui.previousScreen.join("\n"));
    await submitViaEditor(h, "最早用户消息作为会话名");
    await waitFor("首轮任务完成", () => [...h.state.tasks.values()].some((task) => task.sessionId === sessionId && task.status === "completed"));
    await submitViaEditor(h, "后续消息不覆盖会话名");
    await waitFor("第二轮任务完成", () => [...h.state.tasks.values()].filter((task) => task.sessionId === sessionId && task.status === "completed").length === 2);
    await submitViaEditor(h, "/resume");
    await waitFor("resume 窗口读取完成", () => app.windows.length === 1 && screen().includes("选择会话 · 当前项目"));
    assertWindowFrame(h);
    assert.ok(screen().includes("最早用户消息作为会话名") && screen().includes(sessionA2.id.slice(0, 14)), "首条用户消息作为默认名称，空会话有占位名称");
    assert.ok(!screen().includes("后续消息不覆盖会话名"), "后续消息不替换会话名称");
    const titleLine = screen().split("\n").findIndex((line) => line.includes("最早用户消息作为会话名"));
    assert.match(screen().split("\n")[titleLine + 1]!, /\d+ seconds? ago/, "标题下一行显示最近活跃时间间隔");
    assert.ok(!screen().includes("目标项目") && !screen().includes(t.work[1]!), "其他项目会话不进入 resume 列表");
    h.terminal.send("\x1b[B\r");
    await waitFor("resume 切换当前项目会话", () => h.state.currentSessionId === sessionA2.id);
    h.terminal.columns = 160;
    await submitViaEditor(h, "/project");
    assertWindowFrame(h);
    const projectLines = screen().split("\n");
    const currentProjectLine = projectLines.findIndex((line) => line.includes("当前项目 · 2 个会话"));
    assert.ok(currentProjectLine >= 0, "项目首行显示名称及会话数");
    assert.ok(projectLines[currentProjectLine + 1]!.includes(t.work[0]!), "项目第二行显示工作区路径");
    assert.ok(!projectLines[currentProjectLine + 2]!.replace(/[│ ]/g, ""), "项目之间有一行空白");
    const index = h.state.projects.findIndex((project) => project.id === target.projectId);
    for (let i = 0; i < index; i++) h.terminal.send("\x1b[B");
    await renderFlush();
    const targetLines = screen().split("\n");
    const targetProjectLine = targetLines.findIndex((line) => line.includes("目标项目 · 1 个会话"));
    assert.ok(targetProjectLine >= 0, "选中的项目显示名称及会话数");
    assert.ok(targetLines[targetProjectLine + 1]!.includes(t.work[1]!), "选中的项目第二行显示工作区路径");
    h.terminal.send("\r");
    await waitFor("目标项目会话窗口读取完成", () => screen().includes("选择会话 · 目标项目"));
    assertWindowFrame(h);
    assert.ok(screen().includes("选择会话 · 目标项目") && !screen().includes(t.work[0]!));
    h.terminal.send("\r");
    await waitFor("project 切换目标项目会话", () => h.state.currentSessionId === target.sessionId);
    assert.equal(h.state.openSession(target.sessionId).projectId, target.projectId);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("启动项目窗口与空项目选择，创建会话归属所选项目", async () => {
  const t = await startTestRuntime("tui-empty-project", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    await createProjectSession(t.client, t.work[0]!);
    const empty = await t.client.request<any>("create_project", { name: "空项目" });
    const h = await startApp(t);
    apps.push(h);
    await renderFlush();
    assertWindowFrame(h);
    assert.match(stripTerminalSequences((h.app as any).tui.previousScreen.join("\n")), /选择项目/);
    const index = h.state.projects.findIndex((project) => project.id === empty.id);
    for (let i = 0; i < index; i++) h.terminal.send("\x1b[B");
    await renderFlush();
    const projectLines = stripTerminalSequences((h.app as any).tui.previousScreen.join("\n")).split("\n");
    const emptyLine = projectLines.findIndex((line) => line.includes("空项目 · 0 个会话"));
    assert.ok(emptyLine >= 0, "空项目显示零个会话");
    assert.ok(projectLines[emptyLine + 1]!.includes("尚无工作区"), "空项目工作区有占位说明");
    h.terminal.send("\r");
    await waitFor("空项目列表读取完成", () => (h.app as any).windows.length === 0);
    assert.equal(h.state.currentSessionId, null);
    assert.equal((h.app as any).windows.length, 0);
    await submitViaEditor(h, `/new-session ${t.work[1]}`);
    await waitFor("空项目新建会话", () => h.state.currentSessionId !== null);
    assert.equal(h.state.openSession(h.state.currentSessionId!).projectId, empty.id);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("帮助、会话与项目窗口独占画面并有完整边框，关闭后恢复事件流和未提交草稿", async () => {
  const t = await startTestRuntime("tui-overlay", async () => ({ kind: "text", text: "事件流恢复标记" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    await submitViaEditor(h, "检查窗口");
    await waitFor("回复进入事件流", () => h.state.openSession(sessionId).flow.items.some((entry) => entry.kind === "message" && entry.role === "assistant" && entry.text.includes("事件流恢复标记")));
    h.terminal.send("未提交草稿");
    await renderFlush();
    const frame = () => stripTerminalSequences((h.app as any).tui.currentLayout.lines.join("\n"));
    assert.ok(frame().includes("事件流恢复标记") && frame().includes("未提交草稿"), "打开前事件流和草稿都可见");

    for (const key of ["q", "\x1b"]) {
      for (const open of [() => (h.app as any).openHelp(), () => (h.app as any).openSessionPicker(), () => (h.app as any).openProjectPicker()]) {
        open();
        await waitFor("窗口打开", () => (h.app as any).windows.length === 1);
        await renderFlush();
        assertWindowFrame(h);
        h.terminal.send(key);
        await renderFlush();
        assert.equal((h.app as any).windows.length, 0, "q 和 Esc 均关闭窗口");
        assert.ok(frame().includes("事件流恢复标记") && frame().includes("未提交草稿"), "关闭后恢复原会话内容和草稿");
        assert.equal((h.app as any).editor.getText(), "未提交草稿", "关闭按键不进入草稿");
      }
    }
    h.terminal.send("q继续");
    await renderFlush();
    assert.equal((h.app as any).editor.getText(), "未提交草稿q继续", "关闭窗口后焦点回到输入框，q 正常输入");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("底栏累计当前会话 token：实时更新、会话隔离、重开恢复与窄屏隐藏", async () => {
  const t = await startTestRuntime("tui-session-usage", async () => ({ kind: "text", text: "已完成" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const { sessionId: otherSessionId } = await createProjectSession(t.client, t.work[1]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    const footer = () => stripTerminalSequences((h.app as any).footer.render(200)[0]);
    await waitFor("新会话 token 为零", () => footer().includes("↑ 0 ↓ 0 · mock/mock-model · off"));
    for (const [text, input, output] of [["第一轮", 100, 10], ["第二轮", 200, 20]] as const) {
      await submitViaEditor(h, text);
      await waitFor("任务完成并累计实际用量", () => footer().includes(`↑ ${input} ↓ ${output} · mock/mock-model · off`));
    }
    (h.app as any).switchSession(otherSessionId);
    await waitFor("切换会话后不串用量", () => footer().includes("↑ 0 ↓ 0 · mock/mock-model · off"));
    (h.app as any).switchSession(sessionId);
    await waitFor("切回保留累计用量", () => footer().includes("↑ 200 ↓ 20 · mock/mock-model · off"));
    h.app.quit(0);
    const reopened = await startApp(t, { sessionId });
    apps.push(reopened);
    const footerLine = (reopened.app as any).footer;
    await waitFor("重开从后台恢复用量", () => stripTerminalSequences(footerLine.render(200)[0]).includes("↑ 200 ↓ 20 · mock/mock-model · off"));

    const record = t.runtime.store.listSelectionRecordsBySession(sessionId)[0]!;
    for (const [input, inputText, output, outputText] of [
      [999, "999", 514, "514"],
      [1000, "1K", 1540, "1.5K"],
      [114000, "114K", 1000000, "1M"],
      [1250000, "1.3M", 1000000000, "1B"],
      [1200000000, "1.2B", 1000000000, "1B"],
      [999950, "1M", 999950, "1M"],
    ] as const) {
      t.runtime.store.setSelectionRecordUsage(record.id, { input: input - 400, output: output - 10, cacheRead: 200, cacheWrite: 100 });
      await (reopened.app as any).refreshSessionUsage(sessionId);
      assert.ok(stripTerminalSequences(footerLine.render(200)[0]).includes(`↑ ${inputText} ↓ ${outputText} · mock/mock-model · off`), "自动转换单位并累计缓存读取与写入，省略尾 .0");
    }

    footerLine.set("模式", "\x1b[2mmock/mock-model · off\x1b[0m", "↑ 114K ↓ 514");
    const suffix = "↑ 114K ↓ 514 · mock/mock-model · off";
    const exactWidth = visibleWidth(`模式 ${suffix}`);
    const fits = footerLine.render(exactWidth)[0];
    assert.equal(stripTerminalSequences(fits), `模式 ${suffix}`, "恰好容纳时完整显示 token 与模型");
    assert.ok(/\x1b\[2m[^\x1b]*↑ 114K ↓ 514/.test(fits), "token 使用灰体");
    const narrow = footerLine.render(exactWidth - 1)[0];
    assert.ok(!stripTerminalSequences(narrow).includes("↑") && !stripTerminalSequences(narrow).includes("↓"), "不足一个显示列时完全隐藏 token");
    assert.ok(stripTerminalSequences(narrow).includes("mock/mock-model · off"), "隐藏 token 后完整保留模型信息");
    assert.equal(visibleWidth(narrow), exactWidth - 1, "窄屏仍保持底栏宽度");
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("点击工具返回行在事件流展开 Write 原文和 Edit 实际 diff，再次点击收起", async () => {
  let file = "";
  const t = await startTestRuntime("tui-inline-tool", async (req) => {
    const count = req.messages.filter((message) => message.role === "tool").length;
    if (count === 0) return { kind: "tool_calls", calls: [{ id: "inline-write", name: "write", arguments: { path: file, content: "const value = 41;\n" } }] };
    if (count === 1) return { kind: "tool_calls", calls: [{ id: "inline-edit", name: "edit", arguments: { path: file, edits: [{ oldText: "41", newText: "42" }] } }] };
    return { kind: "text", text: "已修改" };
  }, { config: realTools() });
  const apps: AppHarness[] = [];
  try {
    file = path.join(t.work[0]!, "a.ts");
    execFileSync("git", ["init", "-q"], { cwd: t.work[0]! });
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    await submitViaEditor(h, "写入并修改代码");
    await waitFor("两次工具完成并关联历史", () => {
      const tools = h.state.openSession(sessionId).flow.tools;
      return ["write", "edit"].every((name) => tools.some((tool) => tool.name === name && tool.status === "done" && tool.entryId));
    });
    await waitFor("任务完成", () => [...h.state.tasks.values()].some((task) => task.status === "completed"));
    const app = h.app as any;
    app.scroll.scrollTo(0, { disableFollow: true });
    app.tui.requestRender();
    await renderFlush();
    const click = async (name: string) => {
      const screen = app.tui.previousScreen.map((line: string) => stripTerminalSequences(line));
      const row = screen.findIndex((line: string) => line.includes(`● ${name}`)) + 1;
      assert.ok(row > 0, `${name} 工具结果行可见`);
      app.tui.handleViewportInput(`\x1b[<0;10;${row + 1}M`);
      app.tui.handleViewportInput(`\x1b[<0;10;${row + 1}m`);
      await renderFlush();
    };
    await click("Write");
    await waitFor("Write 原文展开", () => stripTerminalSequences(app.tui.previousScreen.join("\n")).includes("1 const value = 41;"));
    assert.match(app.tui.previousScreen.join("\n"), /\x1b\[38;(?:2|5);/);
    assert.doesNotMatch(app.tui.previousScreen.join("\n"), /48;2;0;55;0m|48;5;52m|```/);
    assert.equal(app.windows.length, 0);
    assert.equal(app.tui.hasOverlay(), false, "不打开悬浮层");
    assert.equal(app.tui.getFocusedComponent(), app.editor);
    await click("Write");
    assert.doesNotMatch(stripTerminalSequences(app.tui.previousScreen.join("\n")), /const value = 41;/);
    await click("Edit");
    await waitFor("Edit 实际补丁展开", () => stripTerminalSequences(app.tui.previousScreen.join("\n")).includes("1 + const value = 42;"));
    assert.match(app.tui.previousScreen.join("\n"), /\x1b\[48;5;52m/);
    assert.match(app.tui.previousScreen.join("\n"), /\x1b\[48;2;0;55;0m/);
    await click("Edit");
    assert.doesNotMatch(stripTerminalSequences(app.tui.previousScreen.join("\n")), /const value = 42;/);
    assert.equal(app.expandedTools.size, 0);
    app.eventFlowView.setEntries([
      { key: "earlier", kind: "note", text: "较早的记录\n".repeat(40), at: "", seq: 0 },
      ...h.state.openSession(sessionId).flow.items,
    ]);
    app.tui.requestRender();
    await renderFlush();
    app.scroll.scrollTo(35, { disableFollow: true });
    app.tui.requestRender();
    await renderFlush();
    assert.ok(app.scroll.scrollTop > 0);
    await click("Write");
    await waitFor("滚动后仍能点击正确的工具", () => stripTerminalSequences(app.tui.previousScreen.join("\n")).includes("1 const value = 41;"));
    await click("Write");
    assert.equal(app.expandedTools.size, 0);
  } finally {
    quitAll(apps);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.shutdown();
  }
});
