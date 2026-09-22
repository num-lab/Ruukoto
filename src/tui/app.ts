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
  matchesKey,
  truncateToWidth,
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
import type { AccessMode, ModelSelection, Session, PersistentEvent, Task } from "../core/types.ts";
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
 * 悬浮层：圆角边框 + 内边距，包住任意组件（列表、文本、自定义面板）。
 *
 * 边框在容器层绘制，内容按（宽度 − 边框与留白）渲染后逐行补齐，所以内容
 * 多宽都能对齐；中文按显示宽度算，不会被当成两倍宽。不强制撑满宽度。
 * 高度由覆盖层给定（maxHeight）：内容超出时开窗滚动，上下边框始终保留。
 */
class FloatingPanel implements Component {
  /** 内边距：左右各 1 列，上下各 1 行。 */
  private static readonly PAD_X = 1;
  private static readonly PAD_Y = 1;
  /** 边框占宽：左右竖线 + 两侧内边距。 */
  private static readonly CHROME_X = 2 * (FloatingPanel.PAD_X + 1);
  /** 内容区可见行数上限（0 = 不限制，按内容全展开）。 */
  private maxRows = 0;
  /** 内容区滚动起点：内容超出时由 setScroll 调整。 */
  private scrollTop = 0;
  /** 内容区总行数（最近一次渲染记录），用于判断是否需要滚动提示。 */
  private contentRows = 0;

  constructor(private readonly content: Component) {}

  invalidate(): void {
    this.content.invalidate?.();
  }

  /** 内容区可用行数 = 总高 − 上下边框与内边距。 */
  private bodyRows(height: number): number {
    return Math.max(1, height - 2 * (FloatingPanel.PAD_Y + 1));
  }

  /**
   * 由覆盖层在定高后调用：把面板高度钉死，内容超出即开窗。
   * 返回内容区实际可见行数，供调用方判断是否需要滚动提示。
   */
  setHeight(height: number): void {
    this.maxRows = this.bodyRows(height);
  }

  /** 内容区行数（含上下内边距与边框）——覆盖层定高用。 */
  heightFor(width: number): number {
    const inner = Math.max(1, width - FloatingPanel.CHROME_X);
    return this.content.render(inner).length + 2 * FloatingPanel.PAD_Y + 2;
  }

  /** 滚动内容区：delta 为行数（正数向下）。 */
  scrollBy(delta: number): void {
    const max = Math.max(0, this.contentRows - this.maxRows);
    this.scrollTop = Math.max(0, Math.min(max, this.scrollTop + delta));
  }

  /** 是否还有未显示的内容（用于滚动提示）。 */
  overflow(): { above: number; below: number } {
    const max = Math.max(0, this.contentRows - this.maxRows);
    return { above: this.scrollTop, below: max - this.scrollTop };
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - FloatingPanel.CHROME_X);
    const pad = " ".repeat(FloatingPanel.PAD_X);
    const all = this.content.render(inner);
    this.contentRows = all.length;
    // 内容超出可见区时开窗；边框永远保留，不随内容被裁掉
    const visible = this.maxRows > 0 ? Math.min(all.length, this.maxRows) : all.length;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, all.length - visible)));
    const body = all.slice(this.scrollTop, this.scrollTop + visible).map((line) => {
      const padded = line + " ".repeat(Math.max(0, inner - visibleWidth(line)));
      return `${dim("│")}${pad}${padded}${pad}${dim("│")}`;
    });
    const innerWidth = inner + 2 * FloatingPanel.PAD_X;
    const blank = `${dim("│")}${" ".repeat(innerWidth)}${dim("│")}`;
    const edge = (left: string, right: string) => dim(`${left}${"─".repeat(innerWidth)}${right}`);
    return [
      edge("╭", "╮"),
      ...Array.from({ length: FloatingPanel.PAD_Y }, () => blank),
      ...body,
      ...Array.from({ length: FloatingPanel.PAD_Y }, () => blank),
      edge("╰", "╯"),
    ];
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

/** 模型面板列宽比例：提供方 / 模型 / 思考强度。 */
const MODEL_PANEL_RATIO = [0.3, 0.45, 0.25];
const MODEL_PANEL_GAP = 3;

/**
 * 按固定比例把可用宽度分给三列，总和（含列间距）不超过给定宽度。
 * 先扣掉列间距再按比例分，避免窄终端下溢出被终端截断。
 */
function columnWidths(width: number, ratio: number[] = MODEL_PANEL_RATIO): number[] {
  const usable = Math.max(3, width - MODEL_PANEL_GAP * (ratio.length - 1));
  const raw = ratio.map((r) => Math.max(1, Math.floor(usable * r)));
  // 取整误差：把差额补给最宽的一列，保证总和正好等于 usable
  const diff = usable - raw.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    const widest = raw.indexOf(Math.max(...raw));
    raw[widest] = Math.max(1, raw[widest]! + diff);
  }
  return raw;
}

/** 后台 list_models 返回的单个模型选项。 */
interface ModelChoice {
  provider: string;
  modelId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: ModelSelection["thinkingLevel"][];
  available: boolean;
}

/**
 * 模型切换面板：三列（提供方 / 模型 / 思考强度），左右键切列，上下键列内切换。
 *
 * 三列互相约束：模型列表随所选提供方过滤，思考强度随所选模型变化。列宽按各列
 * 最长项计算（中文按显示宽度），不足时截断并加省略号。回车确认，Esc 取消。
 */
class ModelPanel implements Component {
  /** 各列的当前光标位置（列内索引）。 */
  private cursor = [0, 0, 0];
  private activeCol = 0;
  private rows: string[][] = [[], [], []];

  constructor(
    private readonly providers: string[],
    private readonly modelsByProvider: Map<string, ModelChoice[]>,
    private readonly onPick: (provider: string, model: ModelChoice, thinkingLevel: string) => void,
    private readonly onCancel: () => void,
    /** 会话当前生效的选择，用于打 ✓ 标记。 */
    private readonly isCurrent: (provider: string, modelId: string, level: string) => boolean,
    /** 当前光标所指模型的状态说明（可用性或预算）。 */
    private readonly note: (model: ModelChoice) => string,
  ) {
    this.rows[0] = providers;
    this.refresh();
  }

  invalidate(): void {}

  /** 面板固定占用的行数（构造时注入）：粗边框 + 表头 + 分隔 + 内容区 + 空行 + 说明。 */
  viewportRows = 0;

  /** 内容区可见行数 = 固定高度 − 边框、表头、分隔、空行与说明。 */
  private visibleRows(): number {
    return Math.max(1, this.viewportRows - 5);
  }

  /** 某列的可见窗口起点：光标在窗口外时把窗口滚动到光标处。 */
  private windowStart(col: number, visible: number): number {
    const len = this.rows[col]!.length;
    if (len <= visible) return 0;
    const cursor = this.cursor[col]!;
    if (cursor < visible) return 0;
    return Math.min(cursor - visible + 1, len - visible);
  }

  /** 光标所指的模型（模型列为空时返回 undefined）。 */
  private selected(): { provider: string; model: ModelChoice; level: string } | undefined {
    const provider = this.providers[this.cursor[0]!];
    const model = provider ? (this.modelsByProvider.get(provider) ?? [])[this.cursor[1]!] : undefined;
    const level = model?.thinkingLevels[this.cursor[2]!];
    return provider && model && level ? { provider, model, level } : undefined;
  }

  /** 按当前光标重建各列内容（模型列随提供方、思考强度列随模型变化）。 */
  private refresh(): void {
    const provider = this.providers[this.cursor[0]!];
    const models = provider ? (this.modelsByProvider.get(provider) ?? []) : [];
    this.cursor[1] = Math.max(0, Math.min(this.cursor[1]!, models.length - 1));
    const levels = models[this.cursor[1]!]?.thinkingLevels ?? [];
    this.cursor[2] = Math.max(0, Math.min(this.cursor[2]!, levels.length - 1));
    this.rows = [this.providers, models.map((m) => m.name), levels];
  }

  /** 光标移动：左右换列，上下列内移动；越界不循环。 */
  handleInput(data: string): void {
    if (matchesKey(data, "left")) {
      this.activeCol = Math.max(0, this.activeCol - 1);
    } else if (matchesKey(data, "right")) {
      this.activeCol = Math.min(2, this.activeCol + 1);
    } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const col = this.rows[this.activeCol]!;
      if (col.length === 0) return;
      const delta = matchesKey(data, "up") ? -1 : 1;
      this.cursor[this.activeCol] = Math.max(0, Math.min(col.length - 1, this.cursor[this.activeCol]! + delta));
      // 换提供方要重置模型列；换模型要重置思考强度列
      if (this.activeCol === 0) this.cursor[1] = 0;
      if (this.activeCol < 2) {
        this.cursor[2] = 0;
        this.refresh();
      }
    } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const picked = this.selected();
      if (picked) this.onPick(picked.provider, picked.model, picked.level);
    } else if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
      this.onCancel();
    }
  }

  render(width: number): string[] {
    const gap = MODEL_PANEL_GAP;
    // 固定比例分配宽度：列宽不随内容变化，切换提供方时右侧列不会左右跳。
    // 内容超出列宽就截断加省略号（长模型名会被截，但占位始终可预测）。
    const widths = columnWidths(width);

    // 光标所在的提供方与模型：✓ 标记只在这两个上下文里判断
    const curProvider = this.providers[this.cursor[0]!] ?? "";
    const curModels = this.modelsByProvider.get(curProvider) ?? [];
    const curModel = curModels[this.cursor[1]!];

    /** 该项是否为会话当前生效的选择。 */
    const inEffect = (col: number, row: number): boolean => {
      if (col === 0) return this.isCurrent(this.providers[row] ?? "", "", "");
      if (col === 1) return this.isCurrent(curProvider, curModels[row]?.modelId ?? "", "");
      return this.isCurrent(curProvider, curModel?.modelId ?? "", this.rows[2]![row] ?? "");
    };

    const cell = (text: string, w: number, col: number, row: number): string => {
      const selected = this.cursor[col] === row;
      const active = this.activeCol === col;
      // 光标位与 ✓ 位各占固定一列：选项名在所有行都从同一列开始，列表不会参差
      const prefix = `${selected ? "▸" : " "}${inEffect(col, row) ? "✓" : " "} `;
      const body = truncateToWidth(`${prefix}${text}`, w, "…");
      const pad = " ".repeat(Math.max(0, w - visibleWidth(body)));
      // 未选中列整体变灰；选中列里光标项高亮、其余正常
      const styled = !active ? dim(body) : selected ? `${cyan("▸")}${bold(body.slice(1))}` : body;
      return styled + pad;
    };

    const header = [0, 1, 2]
      .map((i) => {
        const text = truncateToWidth(["提供方", "模型", "思考强度"][i]!, widths[i]!, "…");
        const padded = text + " ".repeat(Math.max(0, widths[i]! - visibleWidth(text)));
        return this.activeCol === i ? bold(padded) : dim(padded);
      })
      .join(" ".repeat(gap));

    // 粗边框压在面板顶部，与上方内容明确分开
    const lines: string[] = [dim("━".repeat(width)), header, dim("─".repeat(width))];
    // 固定高度：内容不足补空行，超出则按窗口滚动（光标所在行始终可见）
    const visible = this.visibleRows();
    const starts = [0, 1, 2].map((col) => this.windowStart(col, visible));
    for (let i = 0; i < visible; i++) {
      const parts = [0, 1, 2].map((col) => {
        const text = this.rows[col]![starts[col]! + i];
        return text === undefined ? " ".repeat(widths[col]!) : cell(text, widths[col]!, col, starts[col]! + i);
      });
      lines.push(parts.join(" ".repeat(gap)));
    }
    lines.push("");
    lines.push(dim(truncateToWidth(curModel ? this.note(curModel) : "←→ 切列 · ↑↓ 列内切换 · Enter 确认 · Esc 取消", width, "…")));
    return lines;
  }
}

/**
 * 底栏：左侧模式与工作区，右侧模型信息，各占一端。
 * 两边内容都按显示宽度算，中间用空格补齐；总宽不够时右侧优先截断。
 */
class FooterLine implements Component {
  private left = "";
  private right = "";
  lastHeight = 0;

  set(left: string, right: string): void {
    this.left = left;
    this.right = right;
  }

  invalidate(): void {}

  render(width: number): string[] {
    // 左侧优先保留（模式与工作区是当前状态）：超宽时先截左侧，再截右侧。
    // 右侧被截空时不补间隔空格，否则总宽会超出。
    const left = visibleWidth(this.left) > width ? truncateToWidth(this.left, width, "…") : this.left;
    const leftWidth = visibleWidth(left);
    const room = Math.max(0, width - leftWidth - 1);
    const right = visibleWidth(this.right) > room ? truncateToWidth(this.right, room, "…") : this.right;
    const rightWidth = visibleWidth(right);
    const gap = rightWidth === 0 ? Math.max(0, width - leftWidth) : Math.max(1, width - leftWidth - rightWidth);
    const line = left + " ".repeat(gap) + right;
    const lines = [line + " ".repeat(Math.max(0, width - visibleWidth(line)))];
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

/** 悬浮层尺寸：按可用宽度取比例，并按内容定高（不超过终端）。 */
interface FloatingOptions {
  /** 占终端宽度的比例（0–1）。 */
  widthRatio: number;
  /** 内容组件；会被包进边框。 */
  content: Component;
  /** 按键转发目标（如 SelectList）；给了它就不再用 onKey。 */
  forwardTo?: { handleInput(data: string): void };
  /** 自定义按键处理（Esc 关闭之外）。 */
  onKey?: (data: string) => void;
  /** 关闭时的额外回调（如取消请求）。 */
  onClose?: () => void;
  /** 高度上限占终端行数的比例（默认 0.85）。 */
  maxHeightRatio?: number;
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
  { name: "new", description: "在当前工作区创建会话" },
  { name: "older", description: "向前翻页加载更早的历史" },
  { name: "history", description: "重新加载当前会话历史" },
  { name: "expand", description: "展开完整条目/工具输出", argumentHint: "<id 前缀>" },
  { name: "artifact", description: "查看工具产物正文（按字节分页）", argumentHint: "<产物 id 前缀>" },
  { name: "approvals", description: "待处理审批列表" },
  { name: "interrupt", description: "中断当前任务", argumentHint: "[taskId]" },
  { name: "cancel", description: "取消排队/活动任务", argumentHint: "<taskId>" },
  { name: "model", description: "模型切换面板（提供方 / 模型 / 思考强度）" },
  { name: "thinking", description: "同上：模型切换面板（可直接切到思考强度列）" },
  { name: "continue", description: "继续已中断任务", argumentHint: "[taskId]" },
  { name: "resume-queue", description: "恢复已暂停的会话队列" },
  { name: "mode", description: "选择当前会话的默认访问模式（新任务生效）" },
  { name: "status", description: "刷新并查看当前任务详情" },
  { name: "search", description: "搜索会话历史原文（字面关键词）", argumentHint: "<关键词>" },
  { name: "memory", description: "长期记忆：list | show <id> | revoke <id> | restore <id> <版本>", argumentHint: "<子命令>" },
  { name: "context", description: "查看本轮上下文选择记录（预算组成与排除原因）" },
  { name: "prompt", description: "查看本会话模型请求列表与每次调用的 prompt 详情" },
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
  private footer: FooterLine;
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
    // 底栏：左侧模式与工作区，右侧模型来源/模型名/思考强度（按键提示由 /help 提供）
    this.footer = new FooterLine();
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
    if (session) return `${this.selectionText(session.modelSelection)}`;
    const m = this.state.defaultModel;
    return m.provider ? `${m.provider}/${m.id} · ${m.thinkingLevel}` : "connecting";
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
      case "new":
        await this.cmdNew();
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
        await this.openModelPicker();
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
      case "prompt":
        await this.cmdPrompt();
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
    if (!cwd) {
      this.notify("用法：/new-session <工作目录>（目录属于后台工作区，不做本地路径补全）");
      return;
    }
    const view = this.currentView();
    const projectId = view?.projectId ?? this.state.projects[0]?.id;
    if (!projectId) {
      this.notify("尚无项目：先 /new-project <名称>");
      return;
    }
    await this.createAndSwitch(projectId, cwd);
  }

  private async cmdNew(): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话：/new-project <名称> 创建项目，或 /new-session <工作目录> 创建会话");
      return;
    }
    await this.createAndSwitch(view.projectId, view.cwd);
  }

  private async createAndSwitch(projectId: string, cwd: string): Promise<void> {
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
        `原任务模型：${this.selectionText(task.modelSelection)}。下一条输入使用后续任务选择：${this.selectionText(this.state.sessions.find((s) => s.id === view.sessionId)?.modelSelection)}（新任务沿用会话默认模式）。输入 /continue 取消继续模式。`,
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
    if (rest.length > 0) {
      this.notify("用法：/mode（无参数，列表选择当前会话的默认模式；作用于之后新建的任务）");
      return;
    }
    const view = this.currentView();
    const session = view ? this.state.sessions.find((s) => s.id === view.sessionId) : undefined;
    if (!session) {
      this.notify("尚未选择会话");
      return;
    }
    const sessionId = session.id;
    const version = session.defaultAccessModeVersion;
    const current = session.defaultAccessMode;
    const label = (mode: AccessMode) => (mode === "full_access" ? "完全访问" : "Ask for approval");
    const items: SelectItem[] = (["confirm", "full_access"] as const).map((mode) => ({
      value: mode,
      label: `${label(mode)}${mode === current ? "（当前）" : ""}`,
      description:
        mode === "confirm"
          ? "已授权范围内自主执行，越界操作逐次确认"
          : "使用执行账户已有权限，不再逐次确认；不额外赋权",
    }));
    this.showSelection(`会话默认模式（当前：${label(current)}；作用于之后新建的任务，Esc 取消）`, items, (item) => {
      const mode = item.value as AccessMode;
      if (mode === "full_access") {
        // 完全访问必须经明确的模式操作选择：展示权限范围后二次确认
        this.openSessionModeConfirm(sessionId, version, mode);
        return;
      }
      void this.sendSessionMode(sessionId, version, mode);
    });
  }

  private async sendSessionMode(sessionId: string, version: number, mode: AccessMode): Promise<void> {
    const label = mode === "full_access" ? "完全访问" : "Ask for approval";
    try {
      const saved = await this.connection.request<Session>("set_session_mode", { session_id: sessionId, mode, expected_version: version });
      this.state.applySessionDefaultMode(sessionId, saved.defaultAccessMode, saved.defaultAccessModeVersion);
      this.state.note(sessionId, `会话默认模式已切换为 ${label}；之后新建的任务生效`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "connection_unavailable" || code === "closed" || code === "request_timeout") {
        // 应答丢失：先查询后台实际状态，不盲目重放
        this.state.note(sessionId, `默认模式设置应答丢失；正在查询后台状态（未自动重发）`);
        try {
          const saved = await this.connection.request<Session>("get_session", { session_id: sessionId });
          this.state.applySessionDefaultMode(sessionId, saved.defaultAccessMode, saved.defaultAccessModeVersion);
        } catch {
          this.state.note(sessionId, "状态查询失败，重连后恢复");
        }
      } else if (code === "default_mode_conflict") {
        // 版本冲突：刷新后台真实值，不覆盖其他客户端的新选择
        this.state.note(sessionId, `默认模式已被其他客户端修改：${(err as Error).message}`);
        try {
          const saved = await this.connection.request<Session>("get_session", { session_id: sessionId });
          this.state.applySessionDefaultMode(sessionId, saved.defaultAccessMode, saved.defaultAccessModeVersion);
        } catch { /* 重连后由快照恢复 */ }
      } else {
        this.state.note(sessionId, `默认模式设置失败：${(err as Error).message}`);
      }
    }
    this.refreshAll();
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

  // ---------- /prompt：模型请求列表与 prompt 详情（issue 13） ----------

  /**
   * 打开当前会话的模型请求列表悬浮层。列表按时间从新到旧分页加载；
   * Enter 进入该次调用的 prompt 详情（分段加载），Esc 返回列表并保留位置，
   * 再 Esc 关闭并恢复编辑器焦点。所有读取经拥有者认证通道；查看不触发
   * 任何模型调用或任务变更。
   */
  private async cmdPrompt(): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话");
      return;
    }
    const sessionId = view.sessionId;
    const generation = this.generation;
    const stale = () => closed || generation !== this.generation || this.state.currentSessionId !== sessionId;

    interface PromptRecordRow {
      id: string;
      taskId: string;
      callIndex: number;
      model: string;
      usage: { input: number; output: number } | null;
      promptArtifactId: string | null;
      createdAt: string;
    }

    const PAGE = 30;
    let closed = false;
    let records: PromptRecordRow[] = [];
    let hasMore = false;
    let loadingMore = false;
    let selectedIndex = 0;

    const title = new Text("", 1, 0);
    const hint = new Text("", 1, 0);
    let list: SelectList | null = null;
    let box: OverlayBox | null = null;
    let handle: OverlayHandle | null = null;

    const closeAll = () => {
      closed = true;
      handle?.hide();
      this.tui.setFocus(this.editor);
    };

    const rowLabel = (r: PromptRecordRow): SelectItem => ({
      value: r.id,
      label: `${r.createdAt.slice(0, 19).replace("T", " ")} · 任务 ${r.taskId.slice(0, 12)} · 第 ${r.callIndex} 次调用`,
      description: `${r.model}${r.usage ? ` · usage ${r.usage.input}+${r.usage.output}` : " · 发送结果未回填（失败/中断或未知）"}${r.promptArtifactId ? "" : " · prompt 正文未记录"}`,
    });

    const rebuildItems = () => {
      const items = records.map(rowLabel);
      if (hasMore) items.push({ value: "$more", label: dim("加载更多…"), description: "Enter 加载下一页" });
      // SelectList 不支持动态增项：追加一页后重建列表并恢复选中位置
      const oldList = list;
      list = new SelectList(items, 12, selectTheme);
      list.onSelectionChange = (item) => {
        const idx = items.indexOf(item);
        if (idx >= 0) selectedIndex = idx;
      };
      list.onSelect = (item) => {
        if (item.value === "$more") {
          void loadPage();
          return;
        }
        const record = records.find((r) => r.id === item.value);
        if (record) void this.openPromptDetail(sessionId, record, generation, () => stale());
      };
      list.onCancel = () => closeAll();
      list.setSelectedIndex(Math.min(selectedIndex, Math.max(0, items.length - 1)));
      if (!box) {
        box = new OverlayBox([
          { component: title, grow: 0 },
          { component: list, grow: 1 },
          { component: hint, grow: 0 },
        ]);
        handle = this.tui.showOverlay(box, { width: "85%", anchor: "center", maxHeight: "70%" });
      } else {
        // SelectList 不支持动态增项：换实例后替换栈中子组件
        box.removeChild(oldList!);
        box.addChild(list, { grow: 1 });
      }
      box.forwardTo = list;
      title.setText(bold(`模型请求（${records.length} 条${hasMore ? "，还有更多" : ""}）`));
      hint.setText(dim("Enter 查看 prompt 详情 · Esc 关闭"));
      this.tui.requestRender();
    };

    const loadPage = async () => {
      if (loadingMore) return;
      loadingMore = true;
      try {
        const last = records[records.length - 1];
        const page = await this.connection.request<{ records: PromptRecordRow[]; hasMore: boolean }>(
          "list_prompt_requests",
          { session_id: sessionId, limit: PAGE, cursor: last ? { createdAt: last.createdAt, id: last.id } : undefined },
        );
        if (stale()) return;
        records = records.concat(page.records);
        hasMore = page.hasMore;
        rebuildItems();
      } catch (err) {
        if (stale()) return;
        hint.setText(red(`读取失败：${(err as Error).message}`));
        this.tui.requestRender();
      } finally {
        loadingMore = false;
      }
    };

    title.setText("加载中…");
    await loadPage();
    if (stale()) return;
    if (records.length === 0 && !hasMore) {
      closeAll();
      this.notify("本会话还没有模型调用记录（任务发出第一次模型调用后生成）");
    }
  }

  /**
   * 单次调用的 prompt 详情：快照 JSON 按字节分页展示（UTF-8 边界对齐，
   * 长正文不静默截断）。快照在发送前捕获；usage 为空表示发送结果未回填。
   * Esc 返回列表（由 onBack 回调处理），不关闭整个面板。
   */
  private async openPromptDetail(
    sessionId: string,
    record: { id: string; taskId: string; callIndex: number; model: string; usage: { input: number; output: number } | null; promptArtifactId: string | null; createdAt: string },
    generation: number,
    isStale: () => boolean,
  ): Promise<void> {
    const headerLines = [
      `任务 ${record.taskId} · 第 ${record.callIndex} 次调用 · ${record.model}`,
      `捕获位置：SDK 发送函数之前（systemPrompt/messages/tools；不等同于适配器转换后的 HTTP 请求体）`,
      record.usage
        ? `发送结果：usage 已回填（输入 ${record.usage.input} · 输出 ${record.usage.output}）`
        : yellow("发送结果未回填：请求失败、被中断或结果未知；以下为发送前捕获的输入"),
    ];
    if (!record.promptArtifactId) {
      this.notify(`该次 prompt 正文未记录（记录创建于快照捕获上线之前）；任务 ${record.taskId.slice(0, 12)} 第 ${record.callIndex} 次调用`);
      return;
    }
    await this.openPager({
      title: `prompt ${record.id.slice(0, 12)}…`,
      header: headerLines.join("\n"),
      pageBytes: ENTRY_PAGE_BYTES,
      onBack: () => {
        // 返回列表：只关闭详情页（列表悬浮层仍在，位置保留）
        this.tui.hideOverlay();
      },
      fetch: async (offset, length) => {
        if (isStale() || generation !== this.generation) throw new Error("视图已切换");
        const result = await this.connection.request<{
          artifact: { byteCount: number };
          encoding: "base64";
          data: string;
        }>("read_prompt_snapshot", { record_id: record.id, session_id: sessionId, offset, length });
        const buf = Buffer.from(result.data, "base64");
        const start = snapUtf8Start(buf, 0);
        const end = snapUtf8End(buf, buf.length);
        return {
          text: buf.subarray(start, end).toString("utf8"),
          offset,
          totalBytes: result.artifact.byteCount,
          truncated: offset + buf.length < result.artifact.byteCount,
          nextOffset: offset + end,
        };
      },
    });
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
    /** Esc/q 时的额外行为（默认关闭悬浮层并还焦点；详情→列表场景覆盖）。 */
    onBack?: () => void;
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
    let closed = false;
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
        if (closed || generation !== this.generation) return;
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
        closed = true;
        if (opts.onBack) {
          opts.onBack();
          return;
        }
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

  // ---------- 会话默认模式确认 ----------

  private openSessionModeConfirm(sessionId: string, version: number, mode: "full_access"): void {
    const lines = [
      bold("将会话默认模式切换为完全访问"),
      `目标会话：${sessionId}`,
      "范围：之后新建的任务在容器外使用专用执行账户已有权限，不再逐次确认；不额外赋权。",
      "该选择只作用于本会话之后新建的任务；已运行、排队和等待审批的任务保留创建时的模式。",
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
      if (item.value === "confirm") void this.sendSessionMode(sessionId, version, mode);
    };
    list.onCancel = () => {
      handle.hide();
      this.tui.setFocus(this.editor);
    };
  }

  private selectionText(selection: ModelSelection | null | undefined): string {
    return selection ? sanitizeForDisplay(`${selection.provider}/${selection.modelId} · ${selection.thinkingLevel}`) : "模型配置未记录";
  }

  /**
   * 打开一个悬浮层：内容包进圆角边框，居中显示，Esc 关闭并把焦点还给输入框。
   *
   * 高度按内容算（含边框两行），并夹在终端行数的上限内；宽度按比例取。
   * 返回 handle 供调用方在选中后主动关闭。
   */
  private openFloating(opts: FloatingOptions): OverlayHandle {
    const termWidth = this.terminal.columns || 80;
    const termRows = this.terminal.rows || 24;
    const width = Math.max(12, Math.floor(termWidth * opts.widthRatio));
    const frame = new FloatingPanel(opts.content);
    const maxHeight = Math.max(3, Math.floor(termRows * (opts.maxHeightRatio ?? 0.85)));
    const height = Math.min(frame.heightFor(width), maxHeight);
    // 内容超出给定高度时开窗滚动：上下边框始终保留，不被裁掉
    frame.setHeight(height);

    const box = new OverlayBox([{ component: frame, grow: 1 }]);
    const handle = this.tui.showOverlay(box, { width, anchor: "center", maxHeight: height });

    const close = () => {
      handle.hide();
      this.tui.setFocus(this.editor);
      opts.onClose?.();
    };
    // 按键先经这里：Esc/q 关闭，无转发目标时方向键滚动内容，
    // 其余一律交给内容组件（列表的 Enter/Tab/方向键不能在这里被吞掉）。
    box.onKey = (data: string) => {
      if (data === "\x1b" || data === "q") {
        close();
        return;
      }
      // 内容超高时滚动；带 forwardTo 的面板由内容自己处理方向键
      if (!opts.forwardTo && (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
        const up = matchesKey(data, "up") || matchesKey(data, "pageUp");
        const step = matchesKey(data, "pageUp") || matchesKey(data, "pageDown") ? 5 : 1;
        frame.scrollBy(up ? -step : step);
        this.tui.requestRender();
        return;
      }
      opts.onKey?.(data);
      opts.forwardTo?.handleInput(data);
    };
    return { ...handle, hide: close };
  }

  private showSelection(title: string, items: SelectItem[], select: (item: SelectItem) => void): void {
    const list = new SelectList(items, Math.min(items.length, 10), selectTheme);
    const body = new VStack([
      { component: new Text(sanitizeForDisplay(title), 0, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    const handle = this.openFloating({ widthRatio: 0.85, content: body, forwardTo: list, maxHeightRatio: 0.7 });
    list.onCancel = () => handle.hide();
    list.onSelect = (item) => { handle.hide(); select(item); };
  }

  /** /model 与 /thinking：三列面板（提供方 / 模型 / 思考强度）。 */
  private async openModelPicker(): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === this.state.currentSessionId);
    if (!session) { this.notify("尚未选择会话"); return; }
    const sessionId = session.id;
    const version = session.modelSelectionVersion;
    const current = session.modelSelection;
    try {
      const models: ModelChoice[] = [];
      let offset: number | null = 0;
      do {
        const page: { models: ModelChoice[]; nextOffset: number | null } = await this.connection.request("list_models", { offset, limit: 100 });
        models.push(...page.models);
        offset = page.nextOffset;
      } while (offset !== null);
      if (this.state.currentSessionId !== sessionId) return;
      if (models.length === 0) { this.notify("后台未配置模型"); return; }

      // 按提供方分组，保留后台返回的顺序
      const providers: string[] = [];
      const byProvider = new Map<string, ModelChoice[]>();
      for (const model of models) {
        if (!byProvider.has(model.provider)) { byProvider.set(model.provider, []); providers.push(model.provider); }
        byProvider.get(model.provider)!.push(model);
      }

      const close = () => { handle.hide(); this.tui.setFocus(this.editor); };
      const panel = new ModelPanel(
        providers,
        byProvider,
        (provider, model, level) => {
          close();
          if (!model.available) { this.notify("此模型认证材料不可用，请在后台配置后重试"); return; }
          void this.saveModelSelection(sessionId, version, {
            provider,
            modelId: model.modelId,
            thinkingLevel: level as ModelSelection["thinkingLevel"],
          });
        },
        close,
        // ✓ 标记：会话当前生效的选择（空串表示该列不参与比较）
        (provider, modelId, level) =>
          (!provider || current?.provider === provider) &&
          (!modelId || current?.modelId === modelId) &&
          (!level || current?.thinkingLevel === level),
        (model) => (model.available ? `上下文 ${model.contextWindow} · 输出上限 ${model.maxTokens}；远程连通性未验证` : "认证材料不可用，无法选择"),
      );
      const box = new OverlayBox([{ component: panel, grow: 1 }]);
      box.forwardTo = panel;
      // 锚在底部、占满宽度，浮在下方：高度取终端行数的 1/4，但至少留出
      // 面板自身需要的行数（否则思考强度等靠下的行会被裁掉、选不到）
      // 固定高度：终端行数的 1/4，最少 9 行（边框 + 表头 + 分隔 + 3 行内容 + 说明）。
      // 不随内容或光标变化，面板占位始终一致。
      const rows = this.terminal.rows || 24;
      const height = Math.max(9, Math.floor(rows / 4));
      panel.viewportRows = height;
      const handle = this.tui.showOverlay(box, { width: "100%", anchor: "bottom-left", maxHeight: height, margin: 0 });
    } catch (err) { this.notify(`模型目录读取失败：${(err as Error).message}`); }
  }

  private async saveModelSelection(sessionId: string, version: number, selection: ModelSelection): Promise<void> {
    // this.state.note(sessionId, "模型选择保存中，等待后台确认…");
    this.refreshAll();
    try {
      const saved = await this.connection.request<Session>("set_session_model", { session_id: sessionId, expected_version: version, model_selection: selection });
      this.state.applySessionModel(sessionId, saved.modelSelection, saved.modelSelectionVersion);
      this.state.note(sessionId, `Switched to: ${this.selectionText(saved.modelSelection)}`);
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
    const body = new VStack([
      { component: new Text(bold("选择会话（项目 · 会话 · 工作目录 · 状态）"), 0, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    const handle = this.openFloating({ widthRatio: 0.85, content: body, forwardTo: list, maxHeightRatio: 0.7 });
    list.onSelect = (item) => {
      handle.hide();
      this.switchSession(item.value);
    };
    list.onCancel = () => handle.hide();
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
      "",
      dim("  ↑↓ / PageUp·PageDown 滚动本页 · Esc 关闭"),
    ];
    // 帮助页：长文本按可用宽度换行，超出部分由覆盖层高度裁切
    this.openFloating({ widthRatio: 0.85, content: new Text(lines.join("\n"), 0, 0), maxHeightRatio: 0.85 });
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
    if (!view) {
      this.footer.set(dim(""), dim(this.modelInfoText()));
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
    const modeText = modeTask ? formatAccessMode(modeTask.accessMode, modeTask.pendingAccessMode) : null;
    const defaultText = `${session?.defaultAccessMode === "full_access" ? "完全访问" : "Ask for approval"}`;
    const modeDisplay = modeText ? `${modeText} · ${defaultText}` : defaultText;
    // 左下角：当前模式与工作区；右上角已有连接/执行信息，这里不重复
    this.footer.set(dim(`${modeDisplay} · ${sanitizeForDisplay(view.cwd)}`), dim(this.modelInfoText()));
    this.header.setText(
      `${bold(this.state.projectName(view.projectId))} · 会话 ${view.sessionId.slice(0, 14)}… · ${sanitizeForDisplay(view.cwd)}\n` +
        `连接：${connText} · 模式：${modeDisplay} · 执行：${this.state.execution.backend}${this.state.execution.backend === "local" ? yellow("（无隔离，仅开发用）") : ""}`,
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
