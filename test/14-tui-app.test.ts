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
import * as path from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { ControlConnection } from "../src/control/connection.ts";
import { PendingRequestStore } from "../src/control/pending-requests.ts";
import { SubmissionGuard } from "../src/control/submission.ts";
import { readOwnerToken } from "../src/control/owner-token.ts";
import { ViewState } from "../src/tui/state.ts";
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

// ---------- 假终端 ----------

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 30;
  readonly kittyProtocolActive = false;
  private written: string[] = [];
  private onInput: ((data: string) => void) | null = null;
  private onResize: (() => void) | null = null;
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /**
   * 模拟 StdinBuffer 的分帧：控制键（\r \n \x03 \x1b 开头序列）与文本分别
   * 到达——真实终端不会把 "/cmd\r" 合成一个输入事件。
   */
  send(data: string): void {
    let textBuf = "";
    const flush = () => {
      if (textBuf) {
        this.onInput?.(textBuf);
        textBuf = "";
      }
    };
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        flush();
        // ESC 序列（如 \x1b[B）作为整体
        const rest = data.slice(i);
        const m = /^\x1b\[[A-Za-z]~?/.exec(rest) ?? /^\x1b./.exec(rest);
        const seq = m ? m[0] : "\x1b";
        this.onInput?.(seq);
        i += seq.length - 1;
      } else if (ch === "\r" || ch === "\n" || ch === "\x03" || ch === "\t") {
        flush();
        this.onInput?.(ch);
      } else {
        textBuf += ch;
      }
    }
    flush();
  }
  output(): string {
    return this.written.join("");
  }
  clearOutput(): void {
    this.written = [];
  }
}

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

async function startApp(t: TestRuntime, opts: { sessionId?: string } = {}): Promise<AppHarness> {
  // 调用方负责在 finally 中 app.quit()（失败时也不能遗留连接/定时器）
  const state = new ViewState();
  let appRef: TuiApp | null = null;
  const connection = new ControlConnection(
    { socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! },
    {
      onState: (s, d) => appRef?.onConnectionState(s, d),
      onSnapshot: (r, ctx) => appRef?.onSnapshot(r, ctx),
      onEvent: (e, kind) => appRef?.onEvent(e, kind),
    },
  );
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

test("提交多行中文与流式显示：片段替换预览，最终消息只出现一次", async () => {
  const t = await startTestRuntime("tui-basic", async (req, callIndex) => {
    void callIndex;
    const text = lastUserText(req);
    await new Promise((r) => setTimeout(r, 300));
    return { kind: "text", text: `收到：${text}` };
  });
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);

    // 多行中文输入（Alt+Enter 换行语义无终端模拟，直接送多行文本）
    await submitViaEditor(h, "第一行\n第二行：帮我总结一下");
    await waitFor("任务完成", async () => {
      const tasks = [...h.state.tasks.values()];
      return tasks.length === 1 && tasks[0]!.status === "completed";
    });
    await waitFor("历史补齐", () => {
      const view = h.state.sessionViews.get(sessionId)!;
      return view.transcript.some((i) => i.kind === "message" && i.role === "assistant" && i.text.includes("收到："));
    });
    const view = h.state.sessionViews.get(sessionId)!;
    const assistantTexts = view.transcript.filter((i) => i.kind === "message" && i.role === "assistant" && i.text.includes("收到："));
    assert.equal(assistantTexts.length, 1, "最终消息只出现一次");
    assert.equal(view.preview, null, "最终条目落盘后预览已清除");
    const userEntry = view.transcript.find((i) => i.kind === "message" && i.role === "user");
    assert.ok(userEntry && userEntry.text.includes("第一行\n第二行"), "多行中文原文完整");
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
      return v.transcript.some((i) => i.kind === "message" && i.role === "assistant" && i.text.includes("慢任务结果"));
    });
    h2.app.quit(0);
    await waitFor("h2 退出", () => h2.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
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

    h.terminal.send("/new\r");
    await waitFor("新会话出现", () => h.state.sessions.length === 2);
    const first = h.state.currentSessionId!;
    assert.notEqual(first, sessionId);
    const firstInfo = h.state.sessions.find((s) => s.id === first)!;
    assert.equal(firstInfo.projectId, projectId);
    assert.equal(firstInfo.cwd, t.work[0]!);

    // 重复执行：再创建一个独立会话
    h.terminal.send("/new\r");
    await waitFor("第二个新会话出现", () => h.state.sessions.length === 3);
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

    h.terminal.send("/new\r");
    await renderFlush();
    assert.equal(h.state.sessions.length, 1, "不应创建新会话");
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

test("/context：无记录时明确提示，不打开悬浮层", async () => {
  const t = await startTestRuntime("tui-context-empty", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const h = await startApp(t, { sessionId });
    apps.push(h);
    h.terminal.send("/context");
    h.terminal.send("\r");
    await renderFlush();
    const notes = h.state.sessionViews.get(sessionId)!.notes.map((n) => n.text).join("\n");
    assert.ok(notes.includes("还没有模型调用记录"), `实际提示：${notes}`);
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
