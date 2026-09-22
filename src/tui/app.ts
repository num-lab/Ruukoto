/**
 * TUI 应用：pi-tui 布局、输入路由、命令与覆盖层。
 *
 * 布局（单个全屏页面，窄终端保持纵向结构）：
 *   顶部 header：项目 / 会话 / 工作目录 / 连接状态 / 任务权限模式 / 执行后端；
 *   中间 ScrollView：历史消息与工具记录（折叠）+ 当前活动（预览/工具/提示）；
 *   底部：任务与队列状态行、多行 Editor、快捷键行。
 *
 * 输入：Enter 提交，Alt+Enter（或 Shift+Enter / Ctrl+J）换行；/ 开头为命令；
 * Ctrl+C 清空草稿（空草稿时退出客户端）；/quit 退出。退出只关闭客户端，
 * 不停止后台任务。
 */

import {
  Editor,
  KeybindingsManager,
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Spacer,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type Container as ContainerType,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { ControlConnection } from "../control/connection.ts";
import type { ConnectResult } from "../control/protocol.ts";
import type { SubmissionGuard } from "../control/submission.ts";
import type { PendingRequestStore } from "../control/pending-requests.ts";
import type { HistoryEntryView, HistoryPage } from "../core/history.ts";
import type { ConfirmationRequestView, OutputPreview } from "../core/views.ts";
import type { ModelSelection, Session, PersistentEvent, Task } from "../core/types.ts";
import { sanitizeForDisplay } from "./sanitize.ts";
import { snapUtf8End, snapUtf8Start } from "../core/history.ts";
import {
  ViewState,
  formatAccessMode,
  formatTaskStatus,
  isActiveStatus,
  type SessionView,
  type TranscriptItem,
} from "./state.ts";

const HISTORY_PAGE_SIZE = 50;
const ARTIFACT_PAGE_BYTES = 32 * 1024;
const ENTRY_PAGE_BYTES = 48 * 1024;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** 拥有者输入的底色：与终端背景区分，整行铺满。用 256 色而非基础色，避免被终端主题改色。 */
const userBg = (s: string) => `\x1b[48;5;236m${s}\x1b[0m`;
/** 标记列（❯ / ⚙ / ● 同列）与正文列。 */
const MARKER_COL = 1;
const BODY_COL = 3;
const ASSISTANT_BULLET = "●";
/** 转录区右侧留白（约两个中文字符宽），给滚动条腾出位置。 */
const RIGHT_GUTTER = 4;

const markdownTheme = {
  heading: bold,
  // 链接：蓝色字体（256 色 75，深色/浅色终端都可读），URL 用暗色跟在后面
  link: (s: string) => `\x1b[38;5;75m${s}\x1b[0m`,
  linkUrl: dim,
  code: (s: string) => `\x1b[38;5;79m${s}\x1b[0m`,
  // 围栏代码块：正文用亮色与普通文本区分，边界行加语言标注
  codeBlock: (s: string) => `\x1b[38;5;252m${s}\x1b[0m`,
  codeBlockBorder: dim,
  codeBlockIndent: "  ",
  // 语法高亮由 pi 自带的高亮器提供（256 色；未知语言回退为纯文本着色）
  highlightCode,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: (s: string) => s,
  bold,
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
  strikethrough: (s: string) => `\x1b[9m${s}\x1b[0m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
};

const selectTheme = {
  selectedPrefix: (s: string) => cyan(s),
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: (s: string) => yellow(s),
};

const editorTheme = { borderColor: dim, selectList: selectTheme };

/**
 * 带边框的文本块：圆角边框 + 左右各 1 列留白。宽度按显示宽度计算
 * （中文行不被算宽），在整块内容的最宽行上对齐。
 */
class BorderText extends Text {
  render(width: number): string[] {
    const inner = super.render(Math.max(1, width - 4));
    const innerWidth = inner.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const top = `╭${"─".repeat(innerWidth + 2)}╮`;
    const bottom = `╰${"─".repeat(innerWidth + 2)}╯`;
    const body = inner.map((line) => `│ ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} │`);
    return [dim(top), ...body, dim(bottom)];
  }
}

/**
 * 编辑器 + 悬浮的补全候选。
 *
 * pi-tui 的 Editor 把候选列表画在自己的 render 输出里（位置固定、必然占行），
 * 所以它一定会挤占上方内容。这里把候选行从布局输出里摘掉（布局不再为它留行），
 * 交给 TUI 的覆盖层绘制——覆盖层在布局之后合成，是真正叠在内容之上。
 * 列表仍由 Editor 渲染并响应按键（上下选择、Tab/Enter 采用），只是不再占位。
 */
class AboveEditor extends Editor {
  /** 最近一次渲染出的候选行；由宿主取走画到覆盖层。 */
  overlayLines: string[] = [];
  /** 编辑器在布局中的高度，用于把覆盖层定位到它正上方。 */
  lastHeight = 0;
  /** 候选行变化时通知宿主重画覆盖层。 */
  onOverlayChange: (() => void) | null = null;

  render(width: number): string[] {
    const lines = super.render(width);
    // pi-tui 没暴露这个高度，只有私有字段；取不到就按原样渲染（候选留在下方）
    const height = (this as unknown as { renderedAutocompleteHeight?: number }).renderedAutocompleteHeight;
    if (!Number.isFinite(height) || height! <= 0 || lines.length <= height! + 2) {
      this.lastHeight = lines.length;
      if (this.overlayLines.length > 0) {
        this.overlayLines = [];
        this.onOverlayChange?.();
      }
      return lines;
    }
    const list = lines.slice(lines.length - height!);
    const body = lines.slice(0, lines.length - height!);
    const bottomBorder = body.pop()!;
    const result = [...body, bottomBorder];
    this.lastHeight = result.length;
    if (list.join("\n") !== this.overlayLines.join("\n")) {
      this.overlayLines = list;
      this.onOverlayChange?.();
    }
    return result;
  }
}

/** 记录自身渲染高度的 Text：覆盖层按输入框与底栏的实际高度从底部定位。 */
class MeasuredText extends Text {
  lastHeight = 0;

  render(width: number): string[] {
    const lines = super.render(width);
    this.lastHeight = lines.length;
    return lines;
  }
}

/**
 * 右对齐的 Text：模型信息贴在右下角。
 * Text 已把每行右侧补齐到整宽（补的是普通空格），这里去掉补齐再前置缩进。
 */
class RightText extends Text {
  lastHeight = 0;

  render(width: number): string[] {
    const lines = super.render(width).map((line) => {
      const trimmed = line.replace(/ +$/, "");
      const pad = Math.max(0, width - visibleWidth(trimmed));
      return pad === 0 ? trimmed : " ".repeat(pad) + trimmed;
    });
    this.lastHeight = lines.length;
    return lines;
  }
}

/** 原样输出给定行的组件：候选列表的绘制载体。 */
class LinesComponent implements Component {
  private lines: string[] = [];

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    return this.lines;
  }
}

/**
 * 模型输出：圆点画在标记列（与 ❯ / ⚙ 同列），正文缩进到正文列并整体对齐。
 * 用 Markdown 渲染正文（保留标题/列表/代码块），只在渲染结果上补标记与缩进，
 * 不往 markdown 源里塞字符——否则列表与代码块会被解析成别的东西。
 */
class AssistantOutput implements Component {
  private readonly markdown: Markdown;
  private readonly label?: string;

  constructor(text: string, label?: string) {
    this.markdown = new Markdown(text, 0, 0, markdownTheme);
    this.label = label;
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  render(width: number): string[] {
    // Markdown 已把每行补齐到给定宽度，前缀宽度与 BODY_COL 一致，总宽不变
    const lines = this.markdown.render(Math.max(1, width - BODY_COL));
    const head = this.label ? [`${" ".repeat(MARKER_COL)}${dim(`[${this.label}]`)}`] : [];
    if (lines.length === 0) return head;
    const marker = `${" ".repeat(MARKER_COL)}${cyan(ASSISTANT_BULLET)} `;
    const indent = " ".repeat(BODY_COL);
    return [...head, ...lines.map((line, i) => `${i === 0 ? marker : indent}${line}`)];
  }
}

/**
 * 转录区右侧留白：内容按窄 RIGHT_GUTTER 列渲染，再补齐回来，
 * 文字不会顶到滚动条底下（滚动条画在 ScrollView 的最后一列）。
 */
class GutterContainer extends Container {
  render(width: number): string[] {
    const inner = Math.max(1, width - RIGHT_GUTTER);
    return super.render(inner).map((line) => line + " ".repeat(Math.max(0, width - visibleWidth(line))));
  }
}

/** 覆盖层容器：TUI 把焦点给覆盖层根组件，这里把按键转发给目标（列表或自定义键处理）。 */
class OverlayBox extends VStack {
  focused = false;
  onKey: ((data: string) => void) | null = null;
  forwardTo: { handleInput(data: string): void } | null = null;

  handleInput(data: string): void {
    if (this.onKey) {
      this.onKey(data);
      return;
    }
    this.forwardTo?.handleInput(data);
  }
}

/** 只做固定操作（斜杠命令）的补全；不扫描拥有者本地文件。 */
class SlashCommandAutocomplete implements AutocompleteProvider {
  readonly triggerCharacters = ["/"];
  constructor(private readonly commands: Array<{ name: string; description?: string; argumentHint?: string }>) {}

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
    if (cursorLine !== 0) return null;
    const line = lines[0] ?? "";
    if (!line.startsWith("/") || cursorCol > line.length) return null;
    const token = line.slice(0, cursorCol);
    if (/\s/.test(token)) return null;
    const items: AutocompleteItem[] = this.commands
      .filter((c) => `/${c.name}`.startsWith(token))
      .map((c) => ({
        value: `/${c.name}`,
        label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
        description: c.description,
      }));
    if (items.length === 0) return null;
    return { items, prefix: token };
  }

  applyCompletion(lines: string[], cursorLine: number, _cursorCol: number, item: AutocompleteItem, prefix: string) {
    const line = lines[cursorLine]!;
    const rest = line.slice(prefix.length);
    const next = `${item.value} ${rest}`.replace(/\s+$/, " ");
    const newLines = [...lines];
    newLines[cursorLine] = next;
    return { lines: newLines, cursorLine, cursorCol: item.value.length + 1 };
  }

  shouldTriggerFileCompletion(): boolean {
    return false;
  }
}

interface SlashCommandDef {
  name: string;
  description: string;
  argumentHint?: string;
}

const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "quit", description: "退出客户端（后台任务继续运行）" },
  { name: "help", description: "命令与快捷键说明" },
  { name: "sessions", description: "切换项目与会话" },
  { name: "new-project", description: "创建项目", argumentHint: "<名称>" },
  { name: "new-session", description: "在当前项目创建会话", argumentHint: "<工作目录>" },
  { name: "older", description: "向前翻页加载更早的历史" },
  { name: "history", description: "重新加载当前会话历史" },
  { name: "expand", description: "展开完整条目/工具输出", argumentHint: "<id 前缀>" },
  { name: "artifact", description: "查看工具产物正文（按字节分页）", argumentHint: "<产物 id 前缀>" },
  { name: "approvals", description: "待处理审批列表" },
  { name: "interrupt", description: "中断当前任务", argumentHint: "[taskId]" },
  { name: "cancel", description: "取消排队/活动任务", argumentHint: "<taskId>" },
  { name: "model", description: "选择提供方、模型及思考强度" },
  { name: "thinking", description: "选择当前模型支持的思考强度" },
  { name: "continue", description: "继续已中断任务", argumentHint: "[taskId]" },
  { name: "resume-queue", description: "恢复已暂停的会话队列" },
  { name: "mode", description: "切换任务访问模式", argumentHint: "<confirm|full_access> [taskId]" },
  { name: "status", description: "刷新并查看当前任务详情" },
  { name: "search", description: "搜索会话历史原文（字面关键词）", argumentHint: "<关键词>" },
  { name: "memory", description: "长期记忆：list | show <id> | revoke <id> | restore <id> <版本>", argumentHint: "<子命令>" },
  { name: "context", description: "查看本轮上下文选择记录（预算组成与排除原因）" },
  { name: "github", description: "GitHub：drafts | show <id> | publish <id> pr <n> | publish <id> issue <n>", argumentHint: "<子命令>" },
];

export interface TuiAppOptions {
  connection: ControlConnection;
  guard: SubmissionGuard;
  pendingStore: PendingRequestStore;
  state: ViewState;
  terminal?: Terminal;
  initialSessionId?: string;
  onExit: (code: number, message?: string) => void;
}

export class TuiApp {
  private readonly connection: ControlConnection;
  private readonly guard: SubmissionGuard;
  private readonly pendingStore: PendingRequestStore;
  private readonly state: ViewState;
  private readonly terminal: Terminal;
  private readonly tui: TuiAltScreen;
  private readonly onExit: (code: number, message?: string) => void;
  private readonly initialSessionId?: string;

  private readonly autocompleteOverlayComponent = new LinesComponent();
  private autocompleteOverlay: OverlayHandle | null = null;
  private overlaySyncPending = false;
  /** 已补种过输入历史的会话（每个会话只补一次）。 */
  private readonly seededHistorySessions = new Set<string>();
  private header: Text;
  private transcriptContainer: ContainerType;
  private scroll: ScrollView;
  private statusLine: MeasuredText;
  private footer: RightText;
  private editor: AboveEditor;

  /** 连接批次：每次快照安装递增；异步查询结果按 会话+批次 匹配后更新。 */
  private generation = 0;
  private started = false;
  private exiting = false;
  private submitting = false;
  private continueForTaskId: string | null = null;
  /** 组件缓存：转录条目 key → 组件（避免每帧重建 Markdown）。 */
  private itemComponents = new Map<string, Component>();
  private itemOrder: string[] = [];

  constructor(opts: TuiAppOptions) {
    this.connection = opts.connection;
    this.guard = opts.guard;
    this.pendingStore = opts.pendingStore;
    this.state = opts.state;
    this.initialSessionId = opts.initialSessionId;
    this.onExit = opts.onExit;
    this.terminal = opts.terminal ?? new ProcessTerminal();

    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
    this.tui = new TuiAltScreen(this.terminal, true);

    this.header = new Text("", 1, 0);
    this.transcriptContainer = new GutterContainer();
    this.scroll = new ScrollView(this.transcriptContainer, { follow: "end", primary: true, scrollbar: "auto" });
    this.statusLine = new MeasuredText("", 1, 0);
    // 底栏：右下角显示生效的模型来源/模型名/思考强度（按键提示改由 /help 提供）
    this.footer = new RightText("", 1, 0);
    this.editor = new AboveEditor(this.tui, editorTheme, {});
    this.editor.setAutocompleteProvider(new SlashCommandAutocomplete(SLASH_COMMANDS));
    this.editor.onSubmit = (text) => void this.handleSubmit(text);
    this.editor.onChange = () => {
      const view = this.currentView();
      // 草稿保留展开后的原文（大段粘贴的折叠标记只用于展示）
      if (view) view.draft = this.editor.getExpandedText();
    };
    // 候选列表经覆盖层绘制：覆盖层在布局之后合成，叠在转录区之上而不挤占它。
    // 回调来自 render 内部，showOverlay 会触发重渲染，必须推到下一 tick 再调。
    this.editor.onOverlayChange = () => {
      if (this.overlaySyncPending) return;
      this.overlaySyncPending = true;
      process.nextTick(() => {
        this.overlaySyncPending = false;
        this.syncAutocompleteOverlay();
      });
    };

    const root = new VStack([
      { component: this.header, grow: 0, shrink: 1 },
      { component: this.scroll, grow: 1, shrink: 1, minSize: 1 },
      { component: this.statusLine, grow: 0, shrink: 1, maxSize: 3 },
      { component: this.editor, grow: 0, shrink: 1, minSize: 3 },
      { component: this.footer, grow: 0, shrink: 0 },
    ]);
    this.tui.addChild(root);
    this.tui.setLayoutRoot(root);
    this.tui.setFocus(this.editor);

    // Ctrl+C：有草稿先清草稿，空草稿退出客户端（不停止后台任务）
    this.tui.addInputListener((data) => {
      if (data === "\x03") {
        if (this.editor.getText().trim().length > 0) {
          this.editor.setText("");
          this.notify("草稿已清空；再按一次 Ctrl+C 退出");
        } else {
          this.quit(0);
        }
        return { consume: true };
      }
      return undefined;
    });
  }

  /** 右下角信息：模型来源 · 模型名 · 思考强度（未握手完成时显示占位）。 */
  private modelInfoText(): string {
    const session = this.state.sessions.find((s) => s.id === this.state.currentSessionId);
    if (session) return `后续任务：${this.selectionText(session.modelSelection)} · /model /thinking`;
    const m = this.state.defaultModel;
    return m.provider ? `启动默认：${m.provider}/${m.id} · 思考 ${m.thinkingLevel}` : "模型：连接中…";
  }

  /**
   * 把候选列表画到输入框正上方（覆盖层，不占布局行）。
   * 位置从底部反推：底栏 + 编辑器高度之上的那一行起画。
   */
  private syncAutocompleteOverlay(): void {
    const lines = this.editor.overlayLines;
    if (lines.length === 0) {
      this.autocompleteOverlay?.hide();
      this.autocompleteOverlay = null;
      return;
    }
    this.autocompleteOverlayComponent.setLines(lines);
    if (this.autocompleteOverlay) {
      // 已显示：内容就地更新，并请求重画（否则新选中项要等下一次按键才出现）
      this.tui.requestRender();
      return;
    }
    // 从底部反推：底栏 + 输入框之上的那一行起画
    const fromBottom = this.editor.lastHeight + this.footer.lastHeight;
    this.autocompleteOverlay = this.tui.showOverlay(this.autocompleteOverlayComponent, {
      width: "100%",
      anchor: "bottom-left",
      offsetY: -fromBottom,
      margin: 0,
      nonCapturing: true, // 焦点留在输入框，按键仍由 Editor 处理
    });
  }

  // ---------- 生命周期 ----------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.tui.start();
    this.refreshChrome();
    // 连接在后台进行；状态经回调更新（连接失败/重连由 connection 层报告）
    void this.connection.start().catch((err) => {
      this.notify(`初始连接失败：${(err as Error).message}`);
    });
  }

  /** 连接层回调：状态变化。 */
  onConnectionState(state: "connecting" | "online" | "reconnecting" | "failed" | "closed", detail?: string): void {
    this.state.connection = { state, detail: detail ?? null, lastSyncAt: this.connection.lastSyncAt };
    if (state === "online") {
      void this.afterOnline();
    }
    this.refreshChrome();
  }

  /** 连接层回调：安装快照。 */
  onSnapshot(result: ConnectResult, ctx: { resync: boolean; instanceChanged: boolean }): void {
    this.generation++;
    this.state.applySnapshot(result, ctx.instanceChanged);
    if (this.initialSessionId && !this.state.currentSessionId) {
      const wanted = this.initialSessionId;
      const target = this.state.sessions.find((s) => s.id === wanted || s.id.startsWith(wanted));
      if (!target) {
        // 指定会话不存在：明确报错退出，不自动新建或提交任务
        this.quit(1, `会话不存在：${wanted}（不会自动新建或提交任务）`);
        return;
      }
      this.switchSession(target.id);
    }
    if (!this.state.currentSessionId && this.state.sessions.length > 0 && !ctx.resync) {
      // 默认进入会话选择
      this.openSessionPicker();
    }
    const current = this.state.currentSessionId;
    if (current) {
      // 重同步/重连：重新加载历史与最新预览（不依赖上次内存）
      void this.loadHistory(current, "replace");
      void this.refreshTaskDetails();
    }
    this.refreshAll();
  }

  /** 连接层回调：事件应用后刷新界面；落盘条目增量补齐正文。 */
  onEvent(event: PersistentEvent, kind: "live" | "replay"): void {
    this.state.applyEvent(event, kind);
    const body = event.body;
    if (body.type === "task.output_entry") {
      void this.loadEntry(body.sessionId, body.entryId);
    }
    this.refreshAll();
  }

  private async afterOnline(): Promise<void> {
    // 重连只恢复观察后的核实：待确认输入按 session_id+request_id 查询
    const pending = this.pendingStore.list();
    this.state.pendingInputs = pending.records;
    this.state.corruptPendingFiles = pending.corrupt;
    if (pending.records.length > 0 || pending.corrupt.length > 0) {
      this.notify(`发现 ${pending.records.length} 条待核实输入${pending.corrupt.length > 0 ? `（另有 ${pending.corrupt.length} 条损坏记录待人工处理）` : ""}，正在核实…`);
      const outcomes = await this.guard.reconcileAll();
      for (const outcome of outcomes) {
        switch (outcome.kind) {
          case "linked":
            this.notify(`输入 ${outcome.requestId} 已由后台接收：关联原任务 ${outcome.taskId}`);
            break;
          case "resent":
            this.notify(`输入 ${outcome.requestId} 后台未接收：已按原键原参数重发（任务 ${outcome.taskId}）`);
            break;
          case "kept":
            this.notify(`输入 ${outcome.requestId} 仍待核实：${outcome.reason}`);
            break;
          case "needs_resubmit": {
            const sessionId = String(outcome.params["session_id"] ?? "");
            this.showSelection("旧请求明确未接收且缺少模型：恢复原文后通过 /model 选择并提交（Esc 保留记录）", [{ value: "restore", label: "恢复原文到所属会话并清除旧待确认记录" }], () => {
              const view = this.state.openSession(sessionId);
              const text = String(outcome.params["input"] ?? "");
              view.draft = view.draft ? `${view.draft}\n${text}` : text;
              this.pendingStore.clear(outcome.requestId);
              this.state.pendingInputs = this.pendingStore.list().records;
              this.switchSession(sessionId);
              if (typeof outcome.params["task_id"] === "string") this.continueForTaskId = outcome.params["task_id"];
              this.editor.setText(view.draft);
              this.notify("原文已恢复，请通过 /model 选择后提交");
            });
            break;
          }
          case "rejected": {
            const sessionId = String(outcome.params["session_id"] ?? "");
            const view = this.state.openSession(sessionId);
            const text = String(outcome.params["input"] ?? "");
            view.draft = view.draft ? `${view.draft}\n${text}` : text;
            if (this.state.currentSessionId === sessionId) this.editor.setText(view.draft);
            this.state.note(sessionId, `后台明确拒绝：${outcome.reason}；输入已恢复`);
            break;
          }
          case "foreign_instance":
            this.notify(red(`输入 ${outcome.requestId} 属于其他数据实例：保留待拥有者处理，未重发`));
            break;
        }
      }
      this.state.pendingInputs = this.pendingStore.list().records;
    }
    this.refreshChrome();
  }

  /** 退出客户端：关闭 socket、停止 TUI、恢复终端；不发送 stop 或取消任务。 */
  quit(code = 0, message?: string): void {
    if (this.exiting) return;
    this.exiting = true;
    // 退出前保留尚未确认接收的请求（pendingStore 已在磁盘）；不发送 stop/取消
    this.connection.close();
    const pending = this.pendingStore.list();
    const note =
      message ??
      `已退出 TUI；后台任务继续运行。重新连接：ruukoto tui` +
        (pending.records.length > 0 ? `\n有 ${pending.records.length} 条输入尚未确认后台接收，下次启动时将自动核实。` : "");
    void (async () => {
      try {
        await this.terminal.drainInput(1000);
      } catch {
        // 忽略
      }
      this.tui.stop({ preserveScreen: true });
      this.onExit(code, note);
    })();
  }

  // ---------- 会话与历史 ----------

  private currentView(): SessionView | null {
    return this.state.currentSessionId ? (this.state.sessionViews.get(this.state.currentSessionId) ?? null) : null;
  }

  private switchSession(sessionId: string): void {
    const prev = this.currentView();
    if (prev) {
      // 草稿与滚动位置随会话保留（草稿用展开后的原文）
      prev.draft = this.editor.getExpandedText();
      prev.scrollTop = this.scroll.isFollowingEnd ? null : this.scroll.scrollTop;
    }
    this.state.currentSessionId = sessionId;
    const view = this.state.openSession(sessionId);
    this.continueForTaskId = null;
    this.itemComponents.clear();
    this.itemOrder = [];
    this.editor.setText(view.draft);
    if (!view.historyLoaded) {
      void this.loadHistory(sessionId, "replace");
    }
    this.refreshAll();
    if (view.scrollTop !== null) this.scroll.scrollTo(view.scrollTop, { disableFollow: true });
  }

  /**
   * 用会话已落盘的历史消息补种输入框的上下键历史。
   *
   * Editor 的历史只在内存里（提交时 addToHistory），重开 TUI 就空了，其他
   * 客户端（CLI）提交的消息也进不来。这里按会话把用户消息补进去：编辑器按
   * 时间倒序保存（unshift），所以从最早一条开始喂，最新一条才会落在最前。
   * 补种只在每个会话首次加载历史时做一次，避免翻页重复灌入。
   */
  private seedInputHistory(sessionId: string, page: HistoryPage): void {
    if (this.seededHistorySessions.has(sessionId)) return;
    this.seededHistorySessions.add(sessionId);
    const userTexts = page.entries
      .filter((e) => e.role === "user" && e.text.trim().length > 0)
      .map((e) => e.text);
    for (const text of userTexts) this.editor.addToHistory(text);
  }

  private async loadHistory(sessionId: string, mode: "replace" | "prepend"): Promise<void> {
    const generation = this.generation;
    const view = this.state.openSession(sessionId);
    try {
      const page = await this.connection.request<HistoryPage>("read_history", {
        session_id: sessionId,
        before: mode === "prepend" ? (view.historyCursor ?? undefined) : undefined,
        limit: HISTORY_PAGE_SIZE,
      });
      // 异步结果按 会话+连接批次 匹配：过期结果不得覆盖新页面
      if (generation !== this.generation) return;
      this.state.installHistoryPage(sessionId, page, mode);
      this.seedInputHistory(sessionId, page);
      this.refreshTranscript();
    } catch (err) {
      if (generation !== this.generation) return;
      this.notify(`历史读取失败：${(err as Error).message}`);
    }
  }

  /** output_entry 事件驱动：按条目 ID 补齐正文（增量追加到转录）。 */
  async loadEntry(sessionId: string, entryId: string): Promise<void> {
    const generation = this.generation;
    try {
      const entry = await this.connection.request<HistoryEntryView>("read_history_entry", {
        session_id: sessionId,
        entry_id: entryId,
        length: ENTRY_PAGE_BYTES,
      });
      if (generation !== this.generation) return;
      if (this.state.appendEntryView(sessionId, entry)) this.refreshTranscript();
    } catch {
      // 条目可能尚未对读取可见（尾部写入中）；下一次翻页/重载会补齐
    }
  }

  private async refreshTaskDetails(): Promise<void> {
    const generation = this.generation;
    const current = this.state.currentSessionId;
    if (!current) return;
    const active = this.state.activeTaskFor(current);
    if (!active) return;
    try {
      const detail = await this.connection.request<{ task: Task; outputPreview: unknown }>("get_task", { task_id: active.id });
      if (generation !== this.generation) return;
      this.state.upsertTask(detail.task);
      const view = this.currentView();
      if (view && detail.outputPreview) {
        const preview = detail.outputPreview as OutputPreview;
        if (preview.seq >= view.previewSeq) {
          view.preview = { ...preview, taskId: active.id };
          view.previewSeq = preview.seq;
        }
      }
      this.refreshAll();
    } catch {
      // 任务详情刷新失败不阻断界面
    }
  }

  // ---------- 输入提交 ----------

  private async handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
      return;
    }
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话：/sessions 选择，或 /new-project、/new-session 创建");
      return;
    }
    if (this.connection.state !== "online") {
      // 断线期间允许编辑，但不自动发送：恢复草稿，由拥有者在线后提交
      this.editor.setText(text);
      this.notify("当前离线：草稿已保留，恢复在线后请重新提交");
      return;
    }
    if (this.submitting) {
      this.editor.setText(text);
      this.notify("上一条输入提交中，请稍候（重复提交不会产生第二个任务）");
      return;
    }
    this.submitting = true;
    this.editor.addToHistory(text);
    try {
      const continueTaskId = this.continueForTaskId;
      const modelSelection = this.state.sessions.find((s) => s.id === view.sessionId)?.modelSelection;
      if (!modelSelection) throw new Error("请先通过 /model 选择模型");
      const outcome = continueTaskId
        ? await this.guard.submit("continue", { task_id: continueTaskId, session_id: view.sessionId, input: text, model_selection: modelSelection })
        : await this.guard.submit("submit", { session_id: view.sessionId, input: text, model_selection: modelSelection });
      switch (outcome.kind) {
        case "accepted": {
          this.state.upsertTask(outcome.task);
          const wasContinue = this.continueForTaskId !== null;
          this.continueForTaskId = null;
          const current = this.currentView();
          if (current?.queueState === "paused") {
            // 队列暂停时明确显示：新任务在排队，不宣称已开始执行
            this.notify(
              `${wasContinue ? "继续任务" : "新任务"}已创建并排队（队列暂停：${current.queuePauseReason ?? ""}）；恢复：/resume-queue`,
            );
          } else if (wasContinue) {
            this.notify("继续任务已创建");
          }
          break;
        }
        case "pending_verification":
          this.state.pendingInputs = this.pendingStore.list().records;
          this.notify(yellow(`应答丢失：输入 ${outcome.requestId} 接收结果待核实（不会重复发送）`));
          break;
        case "rejected":
          view.draft = text;
          if (this.state.currentSessionId === view.sessionId) this.editor.setText(text);
          this.state.note(view.sessionId, `提交被拒绝：${outcome.message}`);
          break;
        case "conflict":
          this.notify(red(`提交冲突：${outcome.message}；请核实原任务，不会换新键重发`));
          break;
      }
    } catch (err) {
      this.editor.setText(text);
      this.notify(red(`提交失败：${(err as Error).message}`));
    } finally {
      this.submitting = false;
      this.refreshAll();
    }
  }

  // ---------- 命令 ----------

  private async handleCommand(line: string): Promise<void> {
    const [name, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (name) {
      case "quit":
        this.quit(0);
        return;
      case "help":
        this.openHelp();
        return;
      case "sessions":
        this.openSessionPicker();
        return;
      case "new-project":
        await this.cmdNewProject(arg);
        return;
      case "new-session":
        await this.cmdNewSession(arg);
        return;
      case "older": {
        const view = this.currentView();
        if (!view?.historyCursor) {
          this.notify(view?.trimmedOlder || view?.historyLoaded ? "没有更早的历史" : "历史尚未加载");
          return;
        }
        await this.loadHistory(view.sessionId, "prepend");
        return;
      }
      case "history": {
        const view = this.currentView();
        if (view) await this.loadHistory(view.sessionId, "replace");
        return;
      }
      case "expand":
        await this.cmdExpand(arg);
        return;
      case "artifact":
        await this.cmdArtifact(arg);
        return;
      case "approvals":
        this.openApprovals();
        return;
      case "interrupt":
        await this.cmdInterrupt(arg);
        return;
      case "cancel":
        await this.cmdCancel(arg);
        return;
      case "continue":
        await this.cmdContinue(arg);
        return;
      case "resume-queue":
        await this.cmdResumeQueue();
        return;
      case "model":
      case "thinking":
        await this.openModelPicker(name === "thinking");
        return;
      case "mode":
        await this.cmdMode(rest);
        return;
      case "status":
        await this.refreshTaskDetails();
        this.notify("已刷新任务状态");
        return;
      case "search":
        await this.cmdSearch(arg);
        return;
      case "memory":
        await this.cmdMemory(rest);
        return;
      case "context":
        await this.cmdContext();
        return;
      case "github":
        await this.cmdGithub(rest);
        return;
      default:
        this.notify(`未知命令：/${name}（/help 查看命令列表）`);
        return;
    }
  }

  private async cmdNewProject(name: string): Promise<void> {
    if (!name) {
      this.notify("用法：/new-project <名称>");
      return;
    }
    try {
      await this.connection.request("create_project", { name });
      this.notify(`项目已创建：${name}；用 /new-session <工作目录> 创建会话`);
    } catch (err) {
      this.notify(red(`创建项目失败：${(err as Error).message}`));
    }
  }

  private async cmdNewSession(cwd: string): Promise<void> {
    const view = this.currentView();
    const projectId = view?.projectId ?? this.state.projects[0]?.id;
    if (!projectId) {
      this.notify("尚无项目：先 /new-project <名称>");
      return;
    }
    if (!cwd) {
      this.notify("用法：/new-session <工作目录>（目录属于后台工作区，不做本地路径补全）");
      return;
    }
    try {
      const session = await this.connection.request<{ id: string }>("create_session", { project_id: projectId, cwd });
      this.notify(`会话已创建：${session.id}`);
      this.switchSession(session.id);
    } catch (err) {
      this.notify(red(`创建会话失败：${(err as Error).message}`));
    }
  }

  private async cmdInterrupt(arg: string): Promise<void> {
    const view = this.currentView();
    const task = arg ? this.state.getTask(this.resolveTaskId(arg) ?? "") : view ? this.state.activeTaskFor(view.sessionId) : null;
    if (!task) {
      this.notify("没有运行中的任务（/interrupt [taskId]）");
      return;
    }
    try {
      await this.connection.request("interrupt", { task_id: task.id });
      this.notify(`已请求中断任务 ${task.id}`);
    } catch (err) {
      this.notify(red(`中断失败：${(err as Error).message}`));
    }
  }

  private async cmdCancel(arg: string): Promise<void> {
    const taskId = this.resolveTaskId(arg);
    if (!taskId) {
      this.notify("用法：/cancel <taskId>（/status 查看任务列表）");
      return;
    }
    try {
      await this.connection.request("cancel", { task_id: taskId });
      this.notify(`已请求取消任务 ${taskId}`);
    } catch (err) {
      this.notify(red(`取消失败：${(err as Error).message}`));
    }
  }

  private async cmdContinue(arg: string): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话");
      return;
    }
    if (this.continueForTaskId && !arg) {
      // 再次输入 /continue：取消继续模式
      this.continueForTaskId = null;
      this.notify("已取消继续模式");
      return;
    }
    let task: Task | null = null;
    if (arg) {
      task = this.state.getTask(this.resolveTaskId(arg) ?? "");
    } else {
      const interrupted = this.state.tasksFor(view.sessionId).filter((t) => t.status === "interrupted");
      task = interrupted.at(-1) ?? null;
    }
    if (!task || task.sessionId !== view.sessionId || task.status !== "interrupted") {
      this.notify("没有可继续的中断任务（/continue [taskId]）");
      return;
    }
    this.continueForTaskId = task.id;
    const effectNote = task.effectUnknown ? "；存在效果未知的工具操作（不能当作可安全重试）" : "";
    this.notify(
      `继续任务 ${task.id}：中断原因 ${task.interruptReason ?? "未知"}${effectNote}。\n` +
        `原任务模型：${this.selectionText(task.modelSelection)}。下一条输入使用后续任务选择：${this.selectionText(this.state.sessions.find((s) => s.id === view.sessionId)?.modelSelection)}（新任务默认请求确认）。输入 /continue 取消继续模式。`,
    );
    // 展示旧任务的已完成操作，供继续决策参考
    try {
      const detail = await this.connection.request<{
        toolOps: Array<{ toolName: string; resultSummary: string | null; isError: boolean | null; effectUnknown: boolean }>;
      }>("get_task", { task_id: task.id });
      if (detail.toolOps.length > 0) {
        const lines = detail.toolOps.map((op) => {
          const state = op.effectUnknown
            ? "效果未知"
            : op.resultSummary === null
              ? "结果缺失"
              : op.isError
                ? "失败"
                : "完成";
          return `  ${op.toolName}：${state}${op.resultSummary ? `（${op.resultSummary.slice(0, 80)}）` : ""}`;
        });
        this.notify(`旧任务的工具操作：\n${lines.join("\n")}`);
      }
    } catch {
      // 详情读取失败不阻塞继续流程
    }
    if (this.editor.getText().trim() === "/continue" || this.editor.getText().trim() === "") this.editor.setText("");
  }

  private async cmdResumeQueue(): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话");
      return;
    }
    try {
      const legacy = this.state.queuedTasksFor(view.sessionId).filter((t) => !t.modelSelection);
      const selection = this.state.sessions.find((s) => s.id === view.sessionId)?.modelSelection;
      if (legacy.length) {
        this.showSelection(`为 ${legacy.length} 个旧排队任务补配置：${this.selectionText(selection)}`, [{ value: "yes", label: "确认补齐并恢复队列" }], () => {
          void this.connection.request("resume_queue", { session_id: view.sessionId, model_selection: selection })
            .then(() => { this.state.note(view.sessionId, "队列已恢复"); this.refreshAll(); })
            .catch((err) => { this.state.note(view.sessionId, `恢复失败：${err.message}`); this.refreshAll(); });
        });
        return;
      }
      await this.connection.request("resume_queue", { session_id: view.sessionId });
      this.notify("队列已恢复");
    } catch (err) {
      this.notify(red(`恢复队列失败：${(err as Error).message}`));
    }
  }

  private async cmdMode(rest: string[]): Promise<void> {
    const mode = rest[0];
    if (mode !== "confirm" && mode !== "full_access") {
      this.notify("用法：/mode <confirm|full_access> [taskId]");
      return;
    }
    const view = this.currentView();
    const task = rest[1]
      ? this.state.getTask(this.resolveTaskId(rest[1]) ?? "")
      : view
        ? (this.state.activeTaskFor(view.sessionId) ?? this.state.queuedTasksFor(view.sessionId).at(-1) ?? null)
        : null;
    if (!task) {
      this.notify("没有可切换模式的任务");
      return;
    }
    if (mode === "full_access") {
      // 完全访问必须经明确的模式操作选择：展示目标任务与权限范围
      this.openModeConfirm(task, mode);
      return;
    }
    await this.sendModeSwitch(task.id, mode);
  }

  private async sendModeSwitch(taskId: string, mode: "confirm" | "full_access"): Promise<void> {
    try {
      await this.connection.request("switch_mode", { task_id: taskId, mode });
      this.notify(`已请求切换为 ${mode === "full_access" ? "完全访问" : "请求确认"}；生效以模式事件为准`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "connection_unavailable" || code === "closed" || code === "request_timeout") {
        // 应答丢失：先查询实际状态，不盲目重放
        try {
          const detail = await this.connection.request<{ task: Task }>("get_task", { task_id: taskId });
          const actual = detail.task.accessMode;
          const pending = detail.task.pendingAccessMode;
          this.notify(
            `模式切换应答丢失；后台实际状态：${actual === "full_access" ? "完全访问" : "请求确认"}` +
              `${pending ? `（待切换：${pending === "full_access" ? "完全访问" : "请求确认"}）` : ""}（未自动重放请求）`,
          );
        } catch {
          this.notify(yellow("模式切换应答丢失且暂时无法查询；恢复在线后核实"));
        }
        return;
      }
      // 切换失败展示后台原因，不乐观宣称已获得或收回权限
      this.notify(red(`模式切换失败：${(err as Error).message}`));
    }
  }

  // ---------- 历史搜索与记忆（issue 05 §6 入口） ----------

  /** 本轮上下文：最近一次模型调用的选择记录（预算组成、排除原因、来源版本）。 */
  private async cmdContext(): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话");
      return;
    }
    try {
      const records = await this.connection.request<
        Array<{
          id: string;
          taskId: string;
          callIndex: number;
          strategy: string;
          configVersion: number;
          model: string;
          totalMessages: number;
          includedIndices: number[];
          excluded: Array<{ index: number; reason: string }>;
          includedMemories: Array<{ memoryId: string; version: number }>;
          excludedMemories: Array<{ memoryId: string; version: number; reason: string }>;
          instructionVersion: string;
          cappedToolResults: Array<{ index: number; originalChars: number; viewChars: number }>;
          estimates: Record<string, number>;
          budget: number;
          estimatedTotal: number;
          usage: { input: number; output: number } | null;
        }>
      >("list_selection_records", { session_id: view.sessionId, limit: 1 });
      const record = records[0];
      if (!record) {
        this.notify("本会话还没有选择记录（任务发出第一次模型调用后生成）");
        return;
      }
      const lines: string[] = [
        `本轮上下文（任务 ${record.taskId.slice(0, 12)} 第 ${record.callIndex} 次调用，${record.strategy}@${record.configVersion}，${record.model}）：`,
        `  预算 ${record.budget} · 估算 ${record.estimatedTotal}${record.usage ? ` · 实际 ${record.usage.input}+${record.usage.output}` : " · 实际 usage 未回填"}`,
        `  估算明细：${Object.entries(record.estimates)
          .map(([k, v]) => `${k}=${v}`)
          .join("，")}`,
        `  消息：选入 ${record.includedIndices.length} / 共 ${record.totalMessages}；排除 ${record.excluded.length}`,
      ];
      if (record.excluded.length > 0) {
        const reasons = new Map<string, number>();
        for (const e of record.excluded) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
        lines.push(`  排除原因：${[...reasons.entries()].map(([r, n]) => `${r} ×${n}`).join("，")}`);
      }
      if (record.instructionVersion) lines.push(`  项目指令版本：${record.instructionVersion}`);
      if (record.includedMemories.length > 0) {
        lines.push(`  注入记忆：${record.includedMemories.map((m) => `${m.memoryId.slice(0, 10)}@v${m.version}`).join("，")}`);
      }
      for (const m of record.excludedMemories) {
        lines.push(`  未注入记忆 ${m.memoryId.slice(0, 10)}@v${m.version}（${m.reason}）`);
      }
      if (record.cappedToolResults.length > 0) {
        lines.push(
          `  有界视图：${record.cappedToolResults.map((c) => `#${c.index} ${c.originalChars}→${c.viewChars} 字符`).join("，")}（原文可用 history_read / read_artifact 读取）`,
        );
      }
      this.notify(lines.join("\n"));
    } catch (err) {
      this.notify(red(`查询失败：${(err as Error).message}`));
    }
  }

  private async cmdSearch(query: string): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话");
      return;
    }
    if (!query) {
      this.notify("用法：/search <关键词>（在当前会话历史原文中做字面搜索）");
      return;
    }
    try {
      const result = await this.connection.request<{
        hits: Array<{ entryId: string; role: string | null; timestamp: string | null; snippet: string; matchCount: number }>;
        complete: boolean;
        scanned: number;
      }>("search_history", { query, session_id: view.sessionId, limit: 20 });
      if (result.hits.length === 0) {
        this.notify(`没有命中：「${query}」（扫描 ${result.scanned} 条${result.complete ? "" : "，结果不完整"}）`);
        return;
      }
      const lines = result.hits.map(
        (h) =>
          `  [${h.entryId.slice(0, 8)}] ${h.role ?? "?"} ×${h.matchCount}  ${h.snippet.replace(/\n/g, " ")}`,
      );
      this.notify(
        `命中 ${result.hits.length} 条（扫描 ${result.scanned} 条${result.complete ? "" : "，结果不完整，可缩小范围"}）：\n${lines.join("\n")}`,
      );
    } catch (err) {
      this.notify(red(`搜索失败：${(err as Error).message}`));
    }
  }

  private async cmdMemory(rest: string[]): Promise<void> {
    const sub = rest[0] ?? "list";
    const view = this.currentView();
    if (sub === "list") {
      try {
        const result = await this.connection.request<{
          memories: Array<{ id: string; category: string; status: string; currentVersion: number; scope: string; updatedAt: string }>;
        }>("list_memories", view ? { project_id: view.projectId } : {});
        if (result.memories.length === 0) {
          this.notify("当前项目没有记忆（代理可在任务中经 memory_save 创建；拥有者经 CLI memory save 管理）");
          return;
        }
        const lines = result.memories.map(
          (m) => `  [${m.id.slice(0, 10)}] ${m.category} v${m.currentVersion} ${m.status}${m.scope === "personal" ? "（个人共享）" : ""}  ${m.updatedAt}`,
        );
        this.notify(`记忆（${result.memories.length} 条）：\n${lines.join("\n")}\n/memory show <id> 查看正文与版本`);
      } catch (err) {
        this.notify(red(`查询失败：${(err as Error).message}`));
      }
      return;
    }
    if (sub === "show") {
      const id = rest[1];
      if (!id) {
        this.notify("用法：/memory show <id>");
        return;
      }
      try {
        const detail = await this.connection.request<{
          memory: { id: string; category: string; status: string; currentVersion: number; content: string; sourceRefs: unknown[] };
          versions: Array<{ version: number; author: string; reason: string; createdAt: string }>;
        }>("get_memory", { memory_id: id });
        const m = detail.memory;
        const history = detail.versions
          .map((v) => `  v${v.version} ${v.author} ${v.createdAt}${v.reason ? `（${v.reason}）` : ""}`)
          .join("\n");
        this.notify(
          `记忆 ${m.id}（${m.category}，${m.status}，当前 v${m.currentVersion}）：\n${m.content}\n版本历史：\n${history}`,
        );
      } catch (err) {
        this.notify(red(`查询失败：${(err as Error).message}`));
      }
      return;
    }
    if (sub === "revoke" || sub === "restore") {
      const id = rest[1];
      const versionArg = rest[2];
      if (!id || !versionArg || !/^\d+$/.test(versionArg)) {
        this.notify(
          sub === "revoke"
            ? "用法：/memory revoke <id> <当前版本号>（条件更新，版本不符会拒绝）"
            : "用法：/memory restore <id> <恢复自版本号>（创建新修订）",
        );
        return;
      }
      try {
        if (sub === "revoke") {
          await this.connection.request("revoke_memory", { memory_id: id, expected_version: Number(versionArg) });
          this.notify(`记忆 ${id} 已撤销（历史版本保留可查；/memory restore 可恢复）`);
        } else {
          await this.connection.request("restore_memory", { memory_id: id, from_version: Number(versionArg) });
          this.notify(`记忆 ${id} 已自 v${versionArg} 恢复（创建了新修订）`);
        }
      } catch (err) {
        this.notify(red(`操作失败：${(err as Error).message}`));
      }
      return;
    }
    this.notify("用法：/memory [list | show <id> | revoke <id> <当前版本> | restore <id> <自版本>]");
  }

  private resolveTaskId(prefix: string): string | null {
    if (!prefix) return null;
    const matches = [...this.state.tasks.keys()].filter((id) => id === prefix || id.startsWith(prefix));
    return matches.length === 1 ? matches[0]! : null;
  }

  // ---------- GitHub（issue 06：草稿查看与发布入口；发布意图只能由拥有者发起） ----------

  private async cmdGithub(rest: string[]): Promise<void> {
    const sub = rest[0] ?? "drafts";
    const view = this.currentView();
    if (sub === "drafts") {
      try {
        const result = await this.connection.request<{
          drafts: Array<{ id: string; version: number; kind: string; status: string; staleReason: string | null; bodyBytes: number; updatedAt: string; revisions: Record<string, unknown> }>;
        }>("github_list_drafts", view ? { project_id: view.projectId } : {});
        if (result.drafts.length === 0) {
          this.notify("没有 GitHub 草稿（代理在任务中经 github_save_draft 创建）");
          return;
        }
        const lines = result.drafts.map((d) => {
          const rev = d.revisions["headSha"] ? ` head ${String(d.revisions["headSha"]).slice(0, 8)}` : d.revisions["runId"] ? ` run ${d.revisions["runId"]}` : "";
          return `  [${d.id.slice(0, 12)}] ${d.kind} v${d.version} ${d.status}${d.staleReason ? `（${d.staleReason}）` : ""} ${d.bodyBytes} 字节${rev}  ${d.updatedAt}`;
        });
        this.notify(`GitHub 草稿（${result.drafts.length} 份）：\n${lines.join("\n")}\n/github show <id> 查看正文；/github publish <id> pr|issue <n> 发布`);
      } catch (err) {
        this.notify(red(`查询失败：${(err as Error).message}`));
      }
      return;
    }
    if (sub === "show") {
      const prefix = rest[1];
      if (!prefix) {
        this.notify("用法：/github show <草稿 id 前缀>");
        return;
      }
      try {
        const { drafts } = await this.connection.request<{ drafts: Array<{ id: string }> }>("github_list_drafts", {});
        const matches = drafts.filter((d) => d.id.startsWith(prefix));
        if (matches.length !== 1) {
          this.notify(matches.length === 0 ? `找不到草稿：${prefix}` : `草稿 id 前缀不唯一：${prefix}`);
          return;
        }
        const draft = await this.connection.request<{
          id: string; version: number; kind: string; status: string; staleReason: string | null;
          body: string; bodySha256: string; revisions: Record<string, unknown>; evidenceArtifactIds: string[];
        }>("github_get_draft", { draft_id: matches[0]!.id });
        const revLines = Object.entries(draft.revisions).map(([k, v]) => `  ${k}: ${String(v)}`);
        await this.openPager({
          title: `草稿 ${draft.id.slice(0, 12)} v${draft.version}`,
          header:
            `${bold(`GitHub 草稿 ${draft.id} v${draft.version}`)}（${draft.kind}，${draft.status}${draft.staleReason ? `：${draft.staleReason}` : ""}）\n` +
            `正文 sha256 ${draft.bodySha256.slice(0, 16)}… · 证据产物：${draft.evidenceArtifactIds.join(", ") || "无"}\n` +
            `分析修订：\n${revLines.join("\n")}\n` +
            dim("本地草稿与证据 ≠ 公开来源；发布经 /github publish 或 CLI（默认只交付草稿）"),
          fetch: async (offset, length) => ({
            text: draft.body.slice(offset, offset + length),
            offset,
            totalBytes: Buffer.byteLength(draft.body, "utf8"),
            truncated: offset + length < Buffer.byteLength(draft.body, "utf8"),
          }),
        });
      } catch (err) {
        this.notify(red(`查询失败：${(err as Error).message}`));
      }
      return;
    }
    if (sub === "publish") {
      const prefix = rest[1];
      const kindArg = rest[2];
      const num = Number(rest[3]);
      if (!prefix || (kindArg !== "pr" && kindArg !== "issue") || !Number.isInteger(num) || num <= 0) {
        this.notify("用法：/github publish <草稿 id 前缀> pr <PR 编号> | /github publish <草稿 id 前缀> issue <编号>");
        return;
      }
      try {
        const { drafts } = await this.connection.request<{ drafts: Array<{ id: string; status: string }> }>("github_list_drafts", {});
        const matches = drafts.filter((d) => d.id.startsWith(prefix));
        if (matches.length !== 1) {
          this.notify(matches.length === 0 ? `找不到草稿：${prefix}` : `草稿 id 前缀不唯一：${prefix}`);
          return;
        }
        const draftId = matches[0]!.id;
        const op = await this.connection.request<{ id: string; status: string; remoteUrl: string | null; errorMessage: string | null }>(
          "github_publish",
          {
            draft_id: draftId,
            kind: kindArg === "pr" ? "pr_review_comment" : "issue_comment",
            target: kindArg === "pr" ? { prNumber: num } : { issueNumber: num },
          },
        );
        if (op.status === "sent") {
          this.notify(`已发布：${op.remoteUrl ?? op.id}`);
        } else if (op.status === "effect_unknown") {
          this.notify(yellow(`发布结果未知（${op.errorMessage ?? ""}）：已按 effect_unknown 记录，不会自动重发；请人工核实远端`));
        } else {
          this.notify(red(`发布未完成（${op.status}）：${op.errorMessage ?? ""}`));
        }
      } catch (err) {
        this.notify(red(`发布失败：${(err as Error).message}`));
      }
      return;
    }
    this.notify("用法：/github [drafts | show <id 前缀> | publish <id 前缀> pr|issue <编号>]");
  }

  // ---------- 展开查看 ----------

  private async cmdExpand(arg: string): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话");
      return;
    }
    if (!arg) {
      this.notify("用法：/expand <条目或工具 id 前缀>");
      return;
    }
    const entryItem = view.transcript.find((i) => i.entryId.startsWith(arg));
    if (entryItem) {
      await this.openEntryPager(view.sessionId, entryItem.entryId);
      return;
    }
    const tool = view.tools.find((t) => t.toolOpId.startsWith(arg));
    if (tool) {
      await this.openToolDetail(tool.toolOpId);
      return;
    }
    this.notify(`找不到条目或工具：${arg}`);
  }

  private async openEntryPager(sessionId: string, entryId: string): Promise<void> {
    await this.openPager({
      title: `条目 ${entryId}`,
      fetch: async (offset, length) => {
        const slice = await this.connection.request<HistoryEntryView>("read_history_entry", {
          session_id: sessionId,
          entry_id: entryId,
          offset,
          length,
        });
        return { text: slice.text, offset: slice.offset, totalBytes: slice.totalBytes, truncated: slice.truncated };
      },
    });
  }

  private async openToolDetail(toolOpId: string): Promise<void> {
    const view = this.currentView();
    const tool = view?.tools.find((t) => t.toolOpId === toolOpId);
    const lines: string[] = [];
    lines.push(bold(`工具操作 ${toolOpId}`));
    if (tool) {
      lines.push(`工具：${sanitizeForDisplay(tool.toolName)} · 状态：${tool.status}`);
      if (tool.resultSummary) lines.push(`结果摘要：${sanitizeForDisplay(tool.resultSummary)}`);
      if (tool.artifactIds.length > 0) {
        lines.push(`产物：${tool.artifactIds.join(", ")}（/artifact <id 前缀> 查看正文）`);
      }
    }
    // 完整参数按 ID 分段读取
    await this.openPager({
      title: `工具参数 ${toolOpId}`,
      header: lines.join("\n"),
      fetch: async (offset, length) => {
        const slice = await this.connection.request<{ params: { text: string; offset: number; totalBytes: number; truncated: boolean } }>(
          "get_tool_op_params",
          { tool_op_id: toolOpId, offset, length },
        );
        return slice.params;
      },
    });
  }

  /** 产物正文查看：按字节分页；partial/complete 标识；二进制不直接输出。 */
  private async cmdArtifact(arg: string): Promise<void> {
    if (!arg) {
      this.notify("用法：/artifact <产物 id 前缀>（/expand 查看工具产物列表）");
      return;
    }
    const matches = [...this.state.artifacts.values()].filter((a) => a.id.startsWith(arg));
    if (matches.length !== 1) {
      this.notify(matches.length === 0 ? `找不到产物：${arg}` : `产物 id 前缀不唯一：${arg}（${matches.length} 个匹配）`);
      return;
    }
    const artifact = matches[0]!;
    const header =
      `产物 ${artifact.id} · ${sanitizeForDisplay(artifact.name)}\n` +
      `共 ${artifact.byteCount} 字节 · ${artifact.status === "partial" ? yellow("partial（中断/写失败前的已捕获部分）") : "complete"}`;
    await this.openPager({
      title: `产物 ${artifact.id.slice(0, 12)}…`,
      header,
      pageBytes: ARTIFACT_PAGE_BYTES,
      fetch: async (offset, length) => {
        const result = await this.connection.request<{
          artifact: { byteCount: number };
          encoding: "base64";
          data: string;
        }>("read_artifact", { task_id: artifact.taskId, artifact_id: artifact.id, offset, length });
        const buf = Buffer.from(result.data, "base64");
        // 二进制检测：含 NUL 或高比例控制字节 → 显示类型与字节数，不作为终端文本输出
        let binary = buf.includes(0);
        if (!binary) {
          let control = 0;
          for (const b of buf) {
            if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
          }
          binary = buf.length > 0 && control / buf.length > 0.05;
        }
        if (binary) {
          const hex = buf.subarray(0, 128).toString("hex").replace(/(..)/g, "$1 ").trim();
          return {
            text: `[二进制内容，本页 ${buf.length} 字节，不作为终端文本输出]\n前 128 字节 hex：\n${hex}`,
            offset,
            totalBytes: result.artifact.byteCount,
            truncated: offset + buf.length < result.artifact.byteCount,
            nextOffset: offset + buf.length,
          };
        }
        // 文本：按 UTF-8 字符边界对齐后解码（顺序翻页不乱码）
        const start = snapUtf8Start(buf, 0);
        const end = snapUtf8End(buf, buf.length);
        return {
          text: buf.subarray(start, end).toString("utf8"),
          offset,
          totalBytes: result.artifact.byteCount,
          truncated: offset + buf.length < result.artifact.byteCount,
          // 实际消费到缓冲区的 end 处（切半的字符留给下一页）
          nextOffset: offset + end,
        };
      },
    });
  }

  /** 通用分页正文查看器：n/空格 下一页，p 上一页，Esc 关闭（关闭不等于任何确认）。 */
  private async openPager(opts: {
    title: string;
    header?: string;
    pageBytes?: number;
    fetch: (offset: number, length: number) => Promise<{
      text: string;
      offset: number;
      totalBytes: number;
      truncated: boolean;
      /** 下一页起点（实际消费的字节数决定；缺省按 offset + 正文实际字节数）。 */
      nextOffset?: number;
    }>;
  }): Promise<void> {
    const generation = this.generation;
    const pageBytes = opts.pageBytes ?? ENTRY_PAGE_BYTES;
    let offset = 0;
    let total = 0;
    let nextOffset = 0;
    const children: Array<{ component: Component; grow?: number }> = [];
    if (opts.header) children.push({ component: new Text(opts.header, 1, 0), grow: 0 });
    const content = new Text("加载中…", 1, 0);
    const footerText = new Text("", 1, 0);
    children.push({ component: content, grow: 1 }, { component: footerText, grow: 0 });
    const box = new OverlayBox(children);
    const handle = this.tui.showOverlay(box, { width: "90%", anchor: "center", maxHeight: "80%" });
    const load = async (off: number) => {
      try {
        const slice = await opts.fetch(off, pageBytes);
        if (generation !== this.generation) return;
        offset = slice.offset;
        total = slice.totalBytes;
        // 前进按实际消费的字节数（UTF-8 边界对齐后可能小于 pageBytes），
        // 避免跨页字符被两页同时丢弃
        nextOffset = slice.nextOffset ?? slice.offset + Buffer.byteLength(slice.text, "utf8");
        content.setText(sanitizeForDisplay(slice.text));
        footerText.setText(dim(`${opts.title} · 偏移 ${slice.offset}/${slice.totalBytes} 字节 · n 下一页 · p 上一页 · Esc 关闭`));
        this.tui.requestRender();
      } catch (err) {
        content.setText(red(`读取失败：${(err as Error).message}`));
        this.tui.requestRender();
      }
    };
    box.onKey = (data: string) => {
      if (data === "\x1b" || data === "q") {
        handle.hide();
        this.tui.setFocus(this.editor);
        return;
      }
      if (data === "n" || data === " ") {
        if (nextOffset > offset && nextOffset < total) void load(nextOffset);
        return;
      }
      if (data === "p") {
        void load(Math.max(0, offset - pageBytes));
        return;
      }
    };
    await load(0);
  }

  // ---------- 审批 ----------

  private openApprovals(): void {
    const pending = this.state.pendingApprovals();
    if (pending.length === 0) {
      this.notify("没有待处理的审批");
      return;
    }
    const items: SelectItem[] = pending.map((c) => ({
      value: c.id,
      label: `${c.toolName} · 任务 ${c.taskId.slice(0, 12)}…`,
      description: `会话 ${c.sessionId.slice(0, 12)}… · ${this.scopeSummary(c)}`,
    }));
    const list = new SelectList(items, Math.min(items.length, 10), selectTheme);
    const box = new OverlayBox([
      { component: new Text(bold("待处理审批（打开详情后才有批准/拒绝操作）"), 1, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    box.forwardTo = list;
    const handle = this.tui.showOverlay(box, { width: "80%", anchor: "center", maxHeight: "60%" });
    list.onSelect = (item) => {
      handle.hide();
      const confirmation = this.state.pendingApprovals().find((c) => c.id === item.value);
      if (confirmation) void this.openApprovalDetail(confirmation);
    };
    list.onCancel = () => {
      handle.hide();
      this.tui.setFocus(this.editor);
    };
  }

  private scopeSummary(c: ConfirmationRequestView): string {
    switch (c.scope.kind) {
      case "tool":
        return c.scope.workspaceOnly ? "工作区内工具" : "工作区外工具";
      case "file_operation":
        return `文件 ${c.scope.access === "read" ? "读取" : "写入"}：${c.scope.path}`;
      case "http_request":
        return `HTTP ${c.scope.method} ${c.scope.url}`;
      case "github_publish":
        return `GitHub 发布：${c.scope.owner}/${c.scope.repo} ${c.scope.publishKind === "pr_review_comment" ? `PR #${c.scope.target["prNumber"]} 评审评论` : `issue #${c.scope.target["issueNumber"]} 评论`}（草稿 ${c.scope.draftId} v${c.scope.draftVersion}，${c.scope.bodyBytes} 字节）`;
    }
  }

  private async openApprovalDetail(c: ConfirmationRequestView): Promise<void> {
    const generation = this.generation;
    const task = this.state.getTask(c.taskId);
    const header = new Text("", 1, 0);
    const renderHeader = (version: number, status: string) => {
      const lines: string[] = [];
      lines.push(bold(`审批 ${c.id}`));
      lines.push(`任务：${c.taskId} · 会话：${c.sessionId}`);
      lines.push(`工作目录：${task ? sanitizeForDisplay(this.state.sessions.find((s) => s.id === c.sessionId)?.cwd ?? "") : "未知"}`);
      lines.push(`操作：${sanitizeForDisplay(c.toolName)} · 权限版本：${version || "（读取中）"}`);
      lines.push(`状态：${status}`);
      lines.push(`范围：${sanitizeForDisplay(this.scopeSummary(c))}`);
      if (c.scope.kind === "http_request") {
        lines.push(`凭据：${c.scope.credentials.map((cred) => `${cred.name}（${cred.purpose}）`).join(", ") || "无"}（值不展示）`);
      }
      if (c.scope.kind === "file_operation" && c.scope.contentBytes !== null) {
        lines.push(`待写内容：${c.scope.contentBytes} 字节（sha256 ${c.scope.contentSha256?.slice(0, 16)}…）`);
      }
      header.setText(lines.join("\n"));
    };
    renderHeader(c.permissionVersion, c.status);
    const paramsText = new Text("参数加载中…", 1, 0);
    const footerText = new Text(dim("a 批准 · r 拒绝 · n/p 参数翻页 · Esc 关闭（关闭不等于拒绝）"), 1, 0);
    const box = new OverlayBox([
      { component: header, grow: 0 },
      { component: paramsText, grow: 1 },
      { component: footerText, grow: 0 },
    ]);
    const handle = this.tui.showOverlay(box, { width: "90%", anchor: "center", maxHeight: "85%" });

    let offset = 0;
    let total = c.paramsTruncated ? c.paramsBytes : 0;
    let nextOffset = 0;
    // 详情展示以服务端最新记录为准（权限版本可能已变化）
    let currentVersion = c.permissionVersion;
    const loadParams = async (off: number) => {
      try {
        const slice = await this.connection.request<{
          confirmation: { permissionVersion: number; status: string };
          params: { text: string; offset: number; totalBytes: number; truncated: boolean };
        }>("get_confirmation_params", { confirmation_id: c.id, offset: off, length: ENTRY_PAGE_BYTES });
        if (generation !== this.generation) return;
        offset = slice.params.offset;
        total = slice.params.totalBytes;
        // 前进按实际消费字节数（UTF-8 边界对齐），跨页字符不丢
        nextOffset = slice.params.offset + Buffer.byteLength(slice.params.text, "utf8");
        currentVersion = slice.confirmation.permissionVersion;
        renderHeader(currentVersion, slice.confirmation.status);
        if (slice.confirmation.status !== "pending") {
          footerText.setText(yellow(`该审批当前状态：${slice.confirmation.status}（已不可批准/拒绝） · Esc 关闭`));
        }
        paramsText.setText(sanitizeForDisplay(slice.params.text));
        this.tui.requestRender();
      } catch (err) {
        paramsText.setText(red(`参数读取失败：${(err as Error).message}`));
        this.tui.requestRender();
      }
    };
    void loadParams(0);

    const respond = async (decision: "approve" | "reject") => {
      footerText.setText(dim("已发送应答，等待后台状态…"));
      this.tui.requestRender();
      try {
        // 批准绑定原请求 ID 与详情页展示的权限版本
        await this.connection.request("respond_confirmation", {
          confirmation_id: c.id,
          decision,
          ...(currentVersion > 0 ? { permission_version: currentVersion } : {}),
        });
        handle.hide();
        this.tui.setFocus(this.editor);
        this.notify(
          decision === "approve"
            ? "已批准（批准不等于执行成功，执行结果以任务状态为准）"
            : "已拒绝",
        );
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "stale_confirmation" || code === "not_found") {
          footerText.setText(yellow("审批已失效、已被其他客户端处理或任务已结束；请关闭后刷新"));
        } else if (code === "connection_unavailable" || code === "closed" || code === "request_timeout") {
          // 应答丢失：先查询实际状态，不盲目重放
          footerText.setText(yellow("应答结果未知：正在查询实际状态…"));
          try {
            const detail = await this.connection.request<{ confirmations: ConfirmationRequestView[] }>("get_task", { task_id: c.taskId });
            const current = detail.confirmations.find((x) => x.id === c.id);
            footerText.setText(yellow(`应答结果未知；后台实际状态：${current?.status ?? "已不存在"}（不自动重放）`));
          } catch {
            footerText.setText(yellow("应答结果未知且暂时无法查询；恢复在线后核实"));
          }
        } else {
          footerText.setText(red(`应答失败：${(err as Error).message}`));
        }
      }
      this.tui.requestRender();
    };

    box.onKey = (data: string) => {
      if (data === "\x1b") {
        handle.hide();
        this.tui.setFocus(this.editor);
        return;
      }
      if (data === "a") void respond("approve");
      else if (data === "r") void respond("reject");
      else if (data === "n") {
        if (nextOffset > offset && nextOffset < total) void loadParams(nextOffset);
      } else if (data === "p") {
        void loadParams(Math.max(0, offset - ENTRY_PAGE_BYTES));
      }
    };
  }

  // ---------- 模式切换确认 ----------

  private openModeConfirm(task: Task, mode: "full_access"): void {
    const lines = [
      bold("切换为完全访问模式"),
      `目标任务：${task.id}（会话 ${task.sessionId}）`,
      "范围：任务在容器外使用专用执行账户已有权限，不再逐次确认；不额外赋权。",
      "该选择只作用于本任务，不扩散到下一个任务或其他会话。",
      task.grantedPaths.length > 0
        ? `工作区外授予路径：${task.grantedPaths.map((g) => `${g.path}（${g.access}，${g.purpose}）`).join("；")}`
        : "无工作区外授予路径。",
    ];
    const items: SelectItem[] = [
      { value: "confirm", label: "确认切换为完全访问" },
      { value: "cancel", label: "取消" },
    ];
    const list = new SelectList(items, 2, selectTheme);
    const box = new OverlayBox([
      { component: new Text(lines.join("\n"), 1, 0), grow: 0 },
      { component: list, grow: 0 },
    ]);
    box.forwardTo = list;
    const handle = this.tui.showOverlay(box, { width: "80%", anchor: "center" });
    list.onSelect = (item) => {
      handle.hide();
      this.tui.setFocus(this.editor);
      if (item.value === "confirm") void this.sendModeSwitch(task.id, mode);
    };
    list.onCancel = () => {
      handle.hide();
      this.tui.setFocus(this.editor);
    };
  }

  private selectionText(selection: ModelSelection | null | undefined): string {
    return selection ? sanitizeForDisplay(`${selection.provider}/${selection.modelId} · 思考 ${selection.thinkingLevel}`) : "模型配置未记录";
  }

  private showSelection(title: string, items: SelectItem[], select: (item: SelectItem) => void): void {
    const list = new SelectList(items, Math.min(items.length, 10), selectTheme);
    const box = new OverlayBox([
      { component: new Text(sanitizeForDisplay(title), 1, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    box.forwardTo = list;
    const handle = this.tui.showOverlay(box, { width: "85%", anchor: "center", maxHeight: "70%" });
    const close = () => { handle.hide(); this.tui.setFocus(this.editor); };
    list.onCancel = close;
    list.onSelect = (item) => { close(); select(item); };
  }

  private async openModelPicker(thinkingOnly: boolean): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === this.state.currentSessionId);
    if (!session) { this.notify("尚未选择会话"); return; }
    const sessionId = session.id;
    const version = session.modelSelectionVersion;
    const current = session.modelSelection;
    type Choice = { provider: string; modelId: string; name: string; thinkingLevels: ModelSelection["thinkingLevel"][]; available: boolean };
    try {
      const models: Choice[] = [];
      let offset: number | null = 0;
      do {
        const page: { models: Choice[]; nextOffset: number | null } = await this.connection.request("list_models", { offset, limit: 100, ...(thinkingOnly ? { provider: current?.provider } : {}) });
        models.push(...page.models);
        offset = page.nextOffset;
      } while (offset !== null);
      if (this.state.currentSessionId !== sessionId) return;
      const chooseThinking = (model: Choice) => {
        if (!model.available) { this.notify("此模型认证材料不可用，请在后台配置后重试"); return; }
        this.showSelection(`${model.provider} · ${model.name}：选择思考强度（Esc 取消）`, model.thinkingLevels.map((level) => ({ value: level, label: `${level}${current?.provider === model.provider && current?.modelId === model.modelId && current.thinkingLevel === level ? " ✓" : ""}` })), (item) => {
          void this.saveModelSelection(sessionId, version, { provider: model.provider, modelId: model.modelId, thinkingLevel: item.value as ModelSelection["thinkingLevel"] });
        });
      };
      if (thinkingOnly) {
        const model = models.find((m) => m.provider === current?.provider && m.modelId === current?.modelId);
        if (!model) { this.notify("当前模型不在可用目录中，请通过 /model 重新选择"); return; }
        chooseThinking(model);
      } else if (models.length) {
        this.showSelection("选择提供方与模型（Esc 取消）", models.map((m, i) => ({ value: String(i), label: sanitizeForDisplay(`${m.provider} · ${m.name}（${m.modelId}）${m.provider === current?.provider && m.modelId === current?.modelId ? " ✓" : ""}`), description: m.available ? "认证材料可用；远程连通性未验证" : "认证材料不可用" })), (item) => chooseThinking(models[Number(item.value)]!));
      } else this.notify("后台未配置模型");
    } catch (err) { this.notify(`模型目录读取失败：${(err as Error).message}`); }
  }

  private async saveModelSelection(sessionId: string, version: number, selection: ModelSelection): Promise<void> {
    this.state.note(sessionId, "模型选择保存中，等待后台确认…");
    this.refreshAll();
    try {
      const saved = await this.connection.request<Session>("set_session_model", { session_id: sessionId, expected_version: version, model_selection: selection });
      this.state.applySessionModel(sessionId, saved.modelSelection, saved.modelSelectionVersion);
      this.state.note(sessionId, `后续任务选择已保存：${this.selectionText(saved.modelSelection)}；已提交任务保持原配置`);
    } catch (err) {
      this.state.note(sessionId, `模型设置未确认：${(err as Error).message}；正在查询后台状态`);
      try {
        const saved = await this.connection.request<Session>("get_session", { session_id: sessionId });
        this.state.applySessionModel(sessionId, saved.modelSelection, saved.modelSelectionVersion);
      } catch { this.state.note(sessionId, "状态查询失败，重连后恢复；未自动重发设置"); }
    }
    this.refreshAll();
  }

  // ---------- 会话选择 ----------

  private openSessionPicker(): void {
    const items: SelectItem[] = this.state.sessions.map((s) => {
      const active = this.state.activeTaskFor(s.id);
      const queued = this.state.queuedTasksFor(s.id).length;
      return {
        value: s.id,
        label: `${this.state.projectName(s.projectId)} · ${s.id.slice(0, 14)}…`,
        description: `${s.cwd} · ${s.queueState === "paused" ? "队列暂停" : "队列正常"}${active ? ` · ${formatTaskStatus(active.status)}` : ""}${queued > 0 ? ` · 排队 ${queued}` : ""}`,
      };
    });
    if (items.length === 0) {
      this.notify("尚无会话：/new-project <名称> 创建项目，/new-session <工作目录> 创建会话");
      return;
    }
    const list = new SelectList(items, Math.min(items.length, 12), selectTheme);
    const box = new OverlayBox([
      { component: new Text(bold("选择会话（项目 · 会话 · 工作目录 · 状态）"), 1, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    box.forwardTo = list;
    const handle = this.tui.showOverlay(box, { width: "85%", anchor: "center", maxHeight: "70%" });
    list.onSelect = (item) => {
      handle.hide();
      this.tui.setFocus(this.editor);
      this.switchSession(item.value);
    };
    list.onCancel = () => {
      handle.hide();
      this.tui.setFocus(this.editor);
    };
  }

  // ---------- 帮助 ----------

  private openHelp(): void {
    const lines = [
      bold("命令"),
      ...SLASH_COMMANDS.map((c) => `  /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description}`),
      "",
      bold("输入"),
      "  Enter 提交 · Alt+Enter / Shift+Enter / Ctrl+J 换行 · 大段粘贴自动折叠显示（提交保留原文）",
      "  Ctrl+C：有草稿先清空草稿，空草稿退出客户端；/quit 直接退出",
      "  退出只关闭客户端：后台任务继续运行，重新打开 TUI 即可重连",
      "",
      bold("滚动"),
      "  PageUp/PageDown 或鼠标滚轮翻页；滚动后新输出不会把视口拉回底部；",
      "  End 返回最新位置（恢复跟随）；/older 向前翻页加载更早历史",
      "",
      bold("终端限制"),
      "  部分终端不支持 Shift+Enter 修饰键上报，可用 Alt+Enter 或 Ctrl+J 换行；",
      "  中文输入法候选窗位置依赖终端的 Kitty 键盘协议支持；",
      "  链接不自动打开；状态不只靠颜色表达（均有文字标注）。",
    ];
    const box = new OverlayBox([{ component: new BorderText(lines.join("\n"), 1, 1), grow: 1 }]);
    const handle = this.tui.showOverlay(box, { width: "85%", anchor: "center", maxHeight: "85%" });
    box.onKey = (data: string) => {
      if (data === "\x1b" || data === "q") {
        handle.hide();
        this.tui.setFocus(this.editor);
      }
    };
  }

  // ---------- 渲染 ----------

  /** 运行期间的日志/错误入口：转为界面内提示，不直接写入终端。 */
  log(text: string): void {
    this.notify(text);
  }

  private notify(text: string): void {
    this.state.note(this.state.currentSessionId, text);
    this.refreshAll();
  }

  private refreshAll(): void {
    this.refreshChrome();
    this.refreshTranscript();
  }

  /** 顶部与底部状态行（连接状态、权限模式、任务/队列/审批计数）。 */
  private refreshChrome(): void {
    const view = this.currentView();
    const conn = this.state.connection;
    const connText =
      conn.state === "online"
        ? "在线"
        : conn.state === "reconnecting"
          ? `重连中（${conn.detail ?? ""}）`
          : conn.state === "failed"
            ? `离线：${conn.detail ?? ""}`
            : "连接中…";
    const lastSync = conn.lastSyncAt ? conn.lastSyncAt.toLocaleTimeString() : "从未";
    this.footer.setText(dim(this.modelInfoText()));
    if (!view) {
      this.header.setText(
        `${bold("ruukoto")} · 未选择会话 · 连接：${connText}\n` +
          dim(`执行后端：${this.state.execution.backend || "未知"}（${this.state.execution.note || "握手后显示"}）`),
      );
      this.statusLine.setText(`待审批 ${this.state.pendingApprovals().length} · 待核实输入 ${this.state.pendingInputs.length} · 最后同步 ${lastSync}`);
      this.tui.requestRender();
      return;
    }
    const session = this.state.sessions.find((s) => s.id === view.sessionId);
    const active = this.state.activeTaskFor(view.sessionId);
    const modeTask = active ?? this.state.queuedTasksFor(view.sessionId).at(-1) ?? null;
    const modeText = modeTask ? formatAccessMode(modeTask.accessMode, modeTask.pendingAccessMode) : "—";
    this.header.setText(
      `${bold(this.state.projectName(view.projectId))} · 会话 ${view.sessionId.slice(0, 14)}… · ${sanitizeForDisplay(view.cwd)}\n` +
        `连接：${connText} · 模式：${modeText} · 执行：${this.state.execution.backend}${this.state.execution.backend === "local" ? yellow("（无隔离，仅开发用）") : ""}`,
    );
    const queued = this.state.queuedTasksFor(view.sessionId);
    const parts = [
      active ? `任务 ${formatTaskStatus(active.status)} ${active.id.slice(0, 12)}… · 使用 ${this.selectionText(active.modelSelection)}` : "无活动任务",
      `排队 ${queued.length}`,
      view.queueState === "paused" ? yellow(`队列已暂停（${view.queuePauseReason ?? ""}）`) : "队列正常",
      `待审批 ${this.state.pendingApprovals().length}`,
    ];
    if (this.state.pendingInputs.length > 0) parts.push(yellow(`待核实输入 ${this.state.pendingInputs.length}`));
    if (this.continueForTaskId) parts.push(cyan(`继续模式：${this.continueForTaskId.slice(0, 12)}…`));
    parts.push(`最后同步 ${lastSync}`);
    this.statusLine.setText(parts.join(" · "));
    this.tui.requestRender();
  }

  /** 转录区：历史条目 + 当前活动（预览/工具/提示）。按键缓存组件。 */
  private refreshTranscript(): void {
    const view = this.currentView();
    const desired: Array<[string, Component]> = [];
    if (view) {
      if (view.trimmedOlder || view.historyCursor) {
        desired.push(["$top", new Text(dim("— 更早历史可经 /older 翻页加载 —"), 1, 0)]);
      }
      for (const item of view.transcript) {
        desired.push([item.entryId, this.componentForItem(item)]);
      }
      if (view.preview) {
        const p = view.preview;
        const stateLabel = p.state === "generating" ? "生成中…" : "中断前已捕获部分";
        // 流式预览与最终条目同款标记，到达时不跳版
        const text = sanitizeForDisplay(p.text);
        const label = `${stateLabel}${p.truncated ? " · 预览截断" : ""}`;
        desired.push([
          `$preview:${p.messageId}`,
          this.cached(`$preview:${p.messageId}`, text, () => new AssistantOutput(text, label)),
        ]);
      }
      for (const tool of view.tools) {
        const key = `$tool:${tool.toolOpId}`;
        const statusText =
          tool.status === "running"
            ? "执行中"
            : tool.status === "done"
              ? "完成"
              : tool.status === "error"
                ? "失败"
                : "效果未知";
        const summary = tool.resultSummary ? `：${sanitizeForDisplay(tool.resultSummary).slice(0, 120)}` : "";
        const tail = `${summary}${tool.artifactIds.length > 0 ? ` · 产物 ${tool.artifactIds.length} 个` : ""}${tool.paramsTruncated ? " · 参数过大（/expand 查看）" : ""}`;
        // 工具调用整体虚化，失败状态保持醒目
        const text =
          dim(`⚙ ${sanitizeForDisplay(tool.toolName)} · `) +
          (tool.status === "error" ? red(statusText) : dim(statusText)) +
          dim(tail);
        desired.push([key, this.cached(key, text, () => new Text(text, 1, 0))]);
      }
      for (const note of view.notes) {
        desired.push([note.key, this.cached(note.key, note.text, () => new Text(dim(sanitizeForDisplay(note.text)), 1, 0))]);
      }
      if (view.transcript.length === 0 && !view.preview) {
        desired.push([
          "$empty",
          this.cached("$empty", "empty", () =>
            new Text(dim(view.historyLoaded ? "（暂无历史消息）" : "历史加载中…"), 1, 1),
          ),
        ]);
      }
    } else {
      desired.push([
        "$welcome",
        this.cached("$welcome", "welcome", () =>
          new Text(
            `${bold("ruukoto TUI")}\n\n` +
              "只连接已运行的后台；退出或断开不影响任务执行。\n" +
              "使用 /sessions 选择会话，或 /new-project、/new-session 创建。\n" +
              "/help 查看全部命令与终端限制。",
            1,
            1,
          ),
        ),
      ]);
      for (const note of this.state.globalNotes) {
        desired.push([note.key, this.cached(note.key, note.text, () => new Text(dim(sanitizeForDisplay(note.text)), 1, 0))]);
      }
    }

    const keys = desired.map(([k]) => k);
    if (keys.join("") !== this.itemOrder.join("")) {
      this.transcriptContainer.clear();
      desired.forEach(([, component], i) => {
        if (i > 0) this.transcriptContainer.addChild(new Spacer(1)); // 条目之间留一行间距
        this.transcriptContainer.addChild(component);
      });
      this.itemOrder = keys;
      const alive = new Set(keys);
      for (const key of this.itemComponents.keys()) {
        if (!alive.has(key) && !key.startsWith("$")) this.itemComponents.delete(key);
      }
    }
    this.tui.requestRender();
  }

  private cached(key: string, content: string, make: () => Component): Component {
    // 内容哈希变化即重建组件（Markdown/Text 按内容缓存渲染）
    const hash = `${content.length}:${content.slice(0, 128)}`;
    const cachedEntry = this.itemComponents.get(key) as (Component & { __hash?: string }) | undefined;
    if (cachedEntry && cachedEntry.__hash === hash) return cachedEntry;
    const component = make() as Component & { __hash?: string };
    component.__hash = hash;
    this.itemComponents.set(key, component);
    return component;
  }

  private componentForItem(item: TranscriptItem): Component {
    if (item.kind === "message") {
      const truncatedNote = item.truncated
        ? dim(`\n[正文 ${item.totalBytes} 字节，/expand ${item.entryId.slice(0, 8)} 展开]`)
        : "";
      const body = `${sanitizeForDisplay(item.text)}${truncatedNote}`;
      if (item.role === "user") {
        // 拥有者输入：整行底色 + 起始标记（与模型输出区分）
        const text = `❯ ${body}`;
        return this.cached(item.entryId, text, () => new Text(text, 1, 0, userBg));
      }
      if (item.role === "assistant") {
        // 模型输出：圆点在标记列，正文缩进到正文列（续行对齐）
        return this.cached(item.entryId, body, () => new AssistantOutput(body));
      }
      const text = `${item.role}: ${body}`;
      return this.cached(item.entryId, text, () => new Text(text, 1, 0));
    }
    // 工具结果条目：默认折叠为操作与结果摘要；整体虚化，只有失败标记保持醒目
    const text =
      dim(`⚙ ${sanitizeForDisplay(item.toolName)} `) +
      (item.isError ? red("失败") : dim("完成")) +
      dim(` · ${item.totalBytes} 字节 · /expand ${item.entryId.slice(0, 8)} 展开`);
    return this.cached(item.entryId, text, () => new Text(text, 1, 0));
  }
}
