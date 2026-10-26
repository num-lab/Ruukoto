import type { TaskView as Task } from "@ruukoto/core/views.ts";
/**
 * TUI 应用：pi-tui 布局、输入路由、命令与覆盖层。
 *
 * 布局（全屏页面；工作流宽屏侧栏，窄屏独立窗口）：
 *   顶部 header：项目 / 会话 / 工作目录 / 连接状态 / 任务权限模式 / 执行后端；
 *   中间 ScrollView：历史消息与工具记录（折叠）+ 当前活动（预览/工具/提示）；
 *   底部：多行 Editor、模式与模型信息；工作清单经 /todo 悬浮层查看。
 *
 * 输入：Enter 提交，Alt+Enter（或 Shift+Enter / Ctrl+J）换行；/ 开头为命令；
 * Ctrl+C 清空草稿（空草稿时退出客户端）；/quit 退出。退出只关闭客户端，
 * 不停止后台任务。
 */

import {
  Editor,
  HStack,
  KeybindingsManager,
  ProcessTerminal,
  ScrollView,
  SelectList,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
  matchesKey,
  isKeyRelease,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type SelectItem,
  type Terminal,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { ControlClientError, requestOutcome } from "@ruukoto/control/client.ts";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import type { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { loadReloadState, saveReloadState } from "./reload-state.ts";
import {
  ensureWorkspaceSession,
  findWorkspaceByRoot,
  findWorkspaceProjects,
  resolveWorkspaceDir,
  sessionDisplayAttribution,
  workspacePickerProjects,
} from "@ruukoto/control/workspace.ts";
import { productFromEnv } from "@ruukoto/core/product.ts";
import type { DirIdentity } from "@ruukoto/core/dir-identity.ts";
import type { ConfirmationRequestView } from "@ruukoto/core/views.ts";
import type { SessionDefaultMode, SessionCompactionRequest, ContextCheckpoint, ModelSelection, Project, SelectionRecord, PersistentEvent, Session } from "@ruukoto/core/types.ts";
import type { ModelOption } from "@ruukoto/agent/model-selection.ts";
import { SESSION_DEFAULT_MODES } from "@ruukoto/core/types.ts";
import type { ContextBreakdown } from "@ruukoto/agent/context-selector.ts";
import { sanitizeForDisplay } from "./sanitize.ts";
import { snapUtf8End, snapUtf8Start } from "@ruukoto/core/history.ts";
import {
  ViewState,
  accessModeLabel,
  accessModeStyle,
  formatAccessMode,
  formatTaskStatus,
  isActiveStatus,
  sessionTitleAttribution,
  type SessionView,
} from "./state.ts";

import { HistoryRecovery } from "@ruukoto/view/history-recovery.ts";
import { EventFlowView } from "./event-flow-view.ts";
import { activityAgo, TwoLineSelectList } from "./session-list.ts";
import { WorkflowSidebar } from "./workflows.ts";
import { BackgroundProcesses } from "./background-processes.ts";
import { OwnerQuestions } from "./owner-questions.ts";
import { formatPromptSnapshot } from "./prompt-format.ts";
import { formatContextTokens } from "./context-format.ts";
import type { FlowEntry } from "./event-flow.ts";
import { latestTodos, TodoPanel, type Todo } from "./todo-panel.ts";
import {
  commandHelpLines,
  dispatchInput,
  writeFailure,
  LEGACY_PROJECT_WRITE_HINT,
  SlashCommandAutocomplete,
  VISIBLE_COMMANDS,
  type CommandEnv,
  type CommandHost,
  type CommandResult,
} from "./commands.ts";

/** /context 展示的压缩点字段（issue 30；后台不回传摘要正文与条目引用）。 */
type ContextCheckpointView = Pick<ContextCheckpoint, "summarizedCount" | "summaryUntil" | "clearedResults" | "taskId" | "callIndex" | "manualRequestId" | "summaryModel" | "summaryStatus" | "summaryError">;

interface PendingCompaction {
  sessionId: string;
  requestId: string;
  instanceId: string;
  prompt?: string;
  commandKey: string | null;
  line: string;
  result: CommandResult;
  inFlight: boolean;
}

function manualCompactionText(request: SessionCompactionRequest): string {
  const id = `请求 ${request.requestId}`;
  switch (request.status) {
    case "running": return `已接收，正在压缩上下文（${id}）；/interrupt 可取消`;
    case "succeeded":
      return `上下文已压缩：摘要覆盖 ${request.summarizedCount} 条消息，历史上下文估算 ${request.estimateBefore ?? "未知"} → ${request.estimateAfter ?? "未知"} token；摘要模型 ${request.summaryModel.provider}/${request.summaryModel.modelId}（${id}）。/context 仍显示最近一次主模型调用，下一次调用才反映本次压缩`;
    case "noop": return `无需压缩：没有新的可压缩内容（${id}）；有旧摘要时可用 /compact <prompt> 重新聚焦`;
    case "failed": return `压缩失败（${request.errorCode ?? "unknown_error"}）：${request.errorMessage ?? "请核实后台状态"}（${id}）；请修正原因后再执行 /compact`;
    case "cancelled": return `手动压缩已取消，未替换压缩点（${id}）；可继续输入或重新执行 /compact`;
    case "interrupted": return `手动压缩已中断，未自动重调摘要模型（${id}）；核实后台后可继续输入或重新执行 /compact`;
  }
}

const HISTORY_PAGE_SIZE = 50;
const ARTIFACT_PAGE_BYTES = 32 * 1024;
const ENTRY_PAGE_BYTES = 48 * 1024;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** 给滚动条留出右侧空间。 */
const RIGHT_GUTTER = 2;

const selectTheme = {
  selectedPrefix: (s: string) => cyan(s),
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: (s: string) => yellow(s),
};

const editorTheme = { borderColor: dim, selectList: selectTheme };

/**
 * 窗口边框与内边距，包住任意组件（列表、文本、自定义面板）。
 *
 * 边框在容器层绘制，内容按（宽度 − 边框与留白）渲染后逐行补齐，所以内容
 * 多宽都能对齐；中文按显示宽度算，不会被当成两倍宽。不强制撑满宽度。
 * 高度由覆盖层给定（maxHeight）：内容超出时开窗滚动，上下边框始终保留。
 */
class WindowFrame implements Component {
  onKey: ((data: string) => void) | null = null;
  /** 内边距：左右各 1 列，上下各 1 行。 */
  private static readonly PAD_X = 1;
  private static readonly PAD_Y = 1;
  /** 边框占宽：左右竖线 + 两侧内边距。 */
  private static readonly CHROME_X = 2 * (WindowFrame.PAD_X + 1);
  /** 内容区可见行数上限（0 = 不限制，按内容全展开）。 */
  private maxRows = 0;
  /** 内容区滚动起点：内容超出时由 setScroll 调整。 */
  private scrollTop = 0;
  /** 内容区总行数（最近一次渲染记录），用于判断是否需要滚动提示。 */
  private contentRows = 0;

  constructor(private readonly content: Component, private readonly textKeys = false) {}

  handleInput(data: string): void {
    if (!this.textKeys && (matchesKey(data, "q") || matchesKey(data, "escape"))) data = "\x1b";
    if (this.onKey) this.onKey(data);
    else this.content.handleInput?.(data);
  }

  invalidate(): void {
    this.content.invalidate?.();
  }

  /** 内容区可用行数 = 总高 − 上下边框与内边距。 */
  private bodyRows(height: number): number {
    return Math.max(1, height - 2 * (WindowFrame.PAD_Y + 1));
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
    const inner = Math.max(1, width - WindowFrame.CHROME_X);
    return this.content.render(inner).length + 2 * WindowFrame.PAD_Y + 2;
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
    const inner = Math.max(1, width - WindowFrame.CHROME_X);
    const pad = " ".repeat(WindowFrame.PAD_X);
    const all = this.content.render(inner);
    this.contentRows = all.length;
    // 内容超出可见区时开窗；边框永远保留，不随内容被裁掉
    const visible = this.maxRows > 0 ? Math.min(all.length, this.maxRows) : all.length;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, all.length - visible)));
    const body = all.slice(this.scrollTop, this.scrollTop + visible).map((line) => {
      const padded = line + " ".repeat(Math.max(0, inner - visibleWidth(line)));
      return `${dim("│")}${pad}${padded}${pad}${dim("│")}`;
    });
    const innerWidth = inner + 2 * WindowFrame.PAD_X;
    const blank = `${dim("│")}${" ".repeat(innerWidth)}${dim("│")}`;
    const edge = (left: string, right: string) => dim(`${left}${"─".repeat(innerWidth)}${right}`);
    return [
      edge("╭", "╮"),
      ...Array.from({ length: WindowFrame.PAD_Y }, () => blank),
      ...body,
      ...Array.from({ length: WindowFrame.PAD_Y }, () => blank),
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
  workspaceName = "";
  /** 最近一次渲染出的候选行；由宿主取走画到覆盖层。 */
  overlayLines: string[] = [];
  /** 编辑器在布局中的高度，用于把覆盖层定位到它正上方。 */
  lastHeight = 0;
  /** 候选行变化时通知宿主重画覆盖层。 */
  onOverlayChange: (() => void) | null = null;

  render(width: number): string[] {
    const lines = super.render(width);
    if (this.workspaceName && width > 4) {
      const name = truncateToWidth(sanitizeForDisplay(this.workspaceName).replace(/[\n\t]/g, " "), width - 4, "…");
      const label = ` ${name} `;
      const borderWidth = width - visibleWidth(label) - 1;
      lines[0] = `${truncateToWidth(lines[0]!, borderWidth, "")}${dim(label)}${this.borderColor("─")}`;
    }
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

/**
 * 模型切换面板：三列（提供方 / 模型 / 思考强度），左右键切列，上下键列内切换。
 *
 * 三列互相约束：模型列表随所选提供方过滤，思考强度随所选模型变化。列宽按各列
 * 最长项计算（中文按显示宽度），不足时截断并加省略号。回车确认，Esc/q 取消。
 */
class ModelPanel implements Component {
  /** 各列的当前光标位置（列内索引）。 */
  private cursor = [0, 0, 0];
  private activeCol = 0;
  private rows: string[][] = [[], [], []];

  constructor(
    private readonly providers: string[],
    private readonly modelsByProvider: Map<string, ModelOption[]>,
    private readonly onPick: (provider: string, model: ModelOption, thinkingLevel: string) => void,
    private readonly onCancel: () => void,
    /** 会话当前生效的选择，用于打 ✓ 标记。 */
    private readonly isCurrent: (provider: string, modelId: string, level: string) => boolean,
    /** 当前光标所指模型的状态说明（可用性或预算）。 */
    private readonly note: (model: ModelOption) => string,
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
  private selected(): { provider: string; model: ModelOption; level: string } | undefined {
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
    lines.push(dim(truncateToWidth(curModel ? this.note(curModel) : "←→ 切列 · ↑↓ 列内切换 · Enter 确认 · Esc/q 取消", width, "…")));
    return lines;
  }
}

function formatTokenCount(count: number): string {
  const units = ["", "K", "M", "B"];
  let value = count;
  let unit = 0;
  while (Math.round(value * 10) / 10 >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : Number(value.toFixed(1))}${units[unit]}`;
}

/** 底栏两端对齐；空间不足时先隐藏 token 用量，再截断模型信息。 */
class FooterLine implements Component {
  private left = "";
  private right = "";
  private usage = "";
  lastHeight = 0;

  set(left: string, right: string, usage = ""): void {
    this.left = left;
    this.right = right;
    this.usage = usage;
  }

  invalidate(): void {}

  render(width: number): string[] {
    // 左侧模式优先保留：超宽时先截左侧，再截右侧。
    // 右侧被截空时不补间隔空格，否则总宽会超出。
    const left = visibleWidth(this.left) > width ? truncateToWidth(this.left, width, "…") : this.left;
    const leftWidth = visibleWidth(left);
    const room = Math.max(0, width - leftWidth - 1);
    const fullRight = this.usage ? `${dim(`${this.usage} · `)}${this.right}` : this.right;
    const preferredRight = visibleWidth(fullRight) <= room ? fullRight : this.right;
    const right = visibleWidth(preferredRight) > room ? truncateToWidth(preferredRight, room, "…") : preferredRight;
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
 * 上下文窗口分解条：一条长条表示总窗口，各段按占比着色，
 * 下方一行图例说明每种颜色代表什么。
 *
 * 段与总窗口等长：分类估算 + 预留（输出/思考/工具结果/安全余量）+ 尚余输入。
 * 预留与余量按同一口径计入，所以各段之和 = 总窗口，长条正好铺满。
 */
interface WindowSegment {
  label: string;
  tokens: number;
  style: (s: string) => string;
  /** 图例里的补充说明（如百分比、绝对值）。 */
  note: string;
}

class ContextBar implements Component {
  constructor(
    private readonly title: string,
    private readonly total: number,
    private readonly segments: WindowSegment[],
    private readonly footer: string[],
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [bold(truncateToWidth(this.title, width, "…"))];
    // 长条：按 token 占比分配列数，至少 1 列（否则小段完全看不见）
    const barWidth = Math.max(1, width);
    const minimum = barWidth >= this.segments.length ? 1 : 0;
    const counts = this.segments.map((s) => Math.max(s.tokens > 0 ? minimum : 0, Math.round((s.tokens / this.total) * barWidth)));
    // 取整误差：从最长的段上增减，保证长条正好等于可用宽度
    let diff = barWidth - counts.reduce((a, b) => a + b, 0);
    while (diff !== 0 && counts.length > 0) {
      const idx = counts.indexOf(Math.max(...counts));
      if (diff > 0) { counts[idx]! += 1; diff -= 1; }
      else if (counts[idx]! > minimum) { counts[idx]! -= 1; diff += 1; }
      else break;
    }
    lines.push(this.segments.map((s, i) => s.style("█".repeat(counts[i]!))).join(""));

    // 图例：每段「色块 名称 值」，按宽度折行
    const legend = this.segments
      .filter((s) => s.tokens > 0)
      .map((s) => `${s.style("■")} ${s.label} ${s.note}`);
    let current = "";
    for (const item of legend) {
      const candidate = current ? `${current}  ${item}` : item;
      if (visibleWidth(candidate) > width && current) {
        lines.push(current);
        current = item;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    for (const line of this.footer) lines.push(dim(truncateToWidth(line, width, "…")));
    return lines;
  }
}

/**
 * 单次调用的窗口分解：一条长条 + 图例。
 *
 * 各段与总窗口等长：分类估算 + 预留（输出/思考/工具结果/安全余量）+ 尚余输入。
 * 无窗口快照（旧记录）时退化为按输入预算画条，不假装有总窗口数据。
 */
export function contextBarLines(record: SelectionRecord, b: ContextBreakdown, width: number, checkpoint: ContextCheckpointView | null = null): string[] {
  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
  const w = b.window;
  const total = w ? w.contextWindow : b.budget;
  const categories = [...b.categories, ...(b.other ? [b.other] : [])];

  // 每段一个颜色；分类用同一族的深浅，预留与余量用区分度高的色
  const CATEGORY_STYLES = [
    (s: string) => `\x1b[38;5;75m${s}\x1b[0m`, // 蓝
    (s: string) => `\x1b[38;5;79m${s}\x1b[0m`, // 青绿
    (s: string) => `\x1b[38;5;114m${s}\x1b[0m`, // 绿
    (s: string) => `\x1b[38;5;179m${s}\x1b[0m`, // 黄
    (s: string) => `\x1b[38;5;209m${s}\x1b[0m`, // 橙
    (s: string) => `\x1b[38;5;168m${s}\x1b[0m`, // 粉
    (s: string) => `\x1b[38;5;141m${s}\x1b[0m`, // 紫
    (s: string) => `\x1b[38;5;109m${s}\x1b[0m`, // 灰蓝
  ];
  const segments: WindowSegment[] = categories
    .filter((c) => c.tokens > 0)
    .map((c, i) => ({
      label: c.label,
      tokens: c.tokens,
      style: CATEGORY_STYLES[i % CATEGORY_STYLES.length]!,
      note: `${formatContextTokens(c.tokens)} (${w ? pct(c.pctOfWindow) : pct(c.pctOfBudget)})`,
    }));
  if (w) {
    // 预留合并为一段：输出上限/思考/工具结果/安全余量同属「留给后续」，
    // 分三段同色会在长条上无法区分，分开上色又占满色板。明细写在页脚。
    const reserves = w.maxTokens + w.thinkingBudget + w.toolResultReserve + w.safetyMargin;
    if (reserves > 0) {
      segments.push({
        label: "预留",
        tokens: reserves,
        style: (s) => `\x1b[38;5;131m${s}\x1b[0m`,
        note: formatContextTokens(reserves),
      });
    }
    if (b.remainingInput > 0) {
      segments.push({ label: "尚余输入", tokens: b.remainingInput, style: dim, note: formatContextTokens(b.remainingInput) });
    }
  }

  const title = "Context Usage";
  const footer: string[] = [];
  const experiment = record.experiment;
  if (experiment) {
    const status = { applied: "已采用", fallback: "已回退", skipped: "已跳过", canceled: "已取消" }[experiment.status];
    footer.push(`策略 ${sanitizeForDisplay(record.strategy)} · Jev ${status} · ${Math.round(experiment.elapsedMs)} ms`);
    footer.push(`Jev 模型 ${sanitizeForDisplay(experiment.model ?? experiment.requestedModel)} · 阈值 ${experiment.threshold} · 配置 v${experiment.configVersion}`);
    footer.push(`候选 ${experiment.candidates.length} · 消息：基础选入 ${experiment.baselineIncludedIndices.length}，实际选入 ${record.includedIndices.length}`);
    const usage = experiment.usage
      ? `输入 ${formatContextTokens(experiment.usage.inputTokens)} · 输出 ${formatContextTokens(experiment.usage.outputTokens)}`
      : experiment.requestSent ? "已发送，用量未知" : "未发送请求";
    const cost = experiment.estimatedCost;
    footer.push(`Jev 用量：${usage}；${cost ? `费用估算 US$${cost.usd.toFixed(9)}（${cost.priceDate} 单价）` : "费用未估算"}`);
    if (experiment.fallbackReason) footer.push(`原因：${sanitizeForDisplay(experiment.fallbackReason)}`);
  }
  // 只展示这次实际调用关联的压缩点及其真实来源。
  if (checkpoint) {
    const summarized = checkpoint.summarizedCount > 0
      ? `摘要替代 ${checkpoint.summarizedCount} 条（至 ${sanitizeForDisplay(checkpoint.summaryUntil ?? "未知时间")}）`
      : "无摘要";
    const source = checkpoint.taskId
      ? `建于任务 ${checkpoint.taskId.slice(0, 13)} 第 ${checkpoint.callIndex} 次调用`
      : `建于手动请求 ${sanitizeForDisplay(checkpoint.manualRequestId ?? "未知请求")}`;
    footer.push(`压缩点：${summarized} · 清理 ${checkpoint.clearedResults} 条 · ${source}`);
    if (checkpoint.summaryStatus === "failed") footer.push(`摘要失败，只做了清理：${sanitizeForDisplay(checkpoint.summaryError ?? "未知原因")}`);
    else if (checkpoint.summaryModel) footer.push(`摘要模型：${sanitizeForDisplay(checkpoint.summaryModel)}`);
    else if (checkpoint.summarizedCount > 0) footer.push("摘要沿用上一压缩点");
  }
  return new ContextBar(title, total, segments, footer).render(width);
}

/**
 * 裸列表：与 `/` 候选命令列表同款观感——无边框、占满宽度，
 * 上方一行标题，下面是 SelectList 自己渲染的行。
 *
 * SelectList 仍负责按键（↑↓/Enter/Tab）与选中态，这里只把它的渲染结果
 * 取出来按可用宽度重排，所以外观与候选列表一致而交互不变。
 */
class BareList implements Component {
  private readonly list: SelectList;
  private readonly title: string;

  constructor(title: string, items: SelectItem[]) {
    this.title = title;
    this.list = new SelectList(items, Math.min(items.length, 10), selectTheme);
  }

  /** 内部列表：调用方接 onSelect/onCancel 或直接转发按键。 */
  get inputTarget(): SelectList {
    return this.list;
  }

  get onSelect(): ((item: SelectItem) => void) | undefined {
    return this.list.onSelect;
  }

  set onSelect(handler: ((item: SelectItem) => void) | undefined) {
    this.list.onSelect = handler;
  }

  set onCancel(handler: (() => void) | undefined) {
    this.list.onCancel = handler;
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    // 标题与列表都按整宽渲染：与候选列表一样顶到两侧，不额外留边
    const lines = [dim(truncateToWidth(sanitizeForDisplay(this.title), width, "…"))];
    for (const line of this.list.render(width)) {
      lines.push(line + " ".repeat(Math.max(0, width - visibleWidth(line))));
    }
    return lines;
  }
}

/** 用户滚动到历史顶部时请求前一页。 */
class HistoryScrollView extends ScrollView {
  onReachStart?: () => void;

  override scrollBy(lines: number): number {
    const remainder = super.scrollBy(lines);
    if (lines < 0 && this.scrollTop === 0) {
      super.scrollTo(0, { disableFollow: true });
      this.onReachStart?.();
    }
    return remainder;
  }

  override scrollToStart(): void {
    super.scrollToStart();
    super.scrollTo(0, { disableFollow: true });
    this.onReachStart?.();
  }

  override scrollTo(top: number, options?: Parameters<ScrollView["scrollTo"]>[1]): void {
    super.scrollTo(top, options);
    if (top <= 0 && !this.isFollowingEnd) this.onReachStart?.();
  }
}

/** 转录区右侧留白；pi-tui 负责清除可见行的行尾。 */
class GutterContainer implements Component {
  constructor(
    private readonly content: Component,
    private readonly sticky: (width: number) => { top: number; lines: string[] },
  ) {}

  invalidate(): void { this.content.invalidate(); }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const inner = Math.max(1, event.width - RIGHT_GUTTER);
    if (event.x >= inner) return;
    const sticky = this.sticky(inner);
    if (event.y >= sticky.top && event.y < sticky.top + sticky.lines.length && event.type !== "wheel") return { handled: true };
    return this.content.handleMouse?.({ ...event, width: inner });
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - RIGHT_GUTTER);
    const lines = [...this.content.render(inner), ""];
    // 在视口顶部覆盖显示，切换置顶内容不改变滚动区域的高度或行号。
    const sticky = this.sticky(inner);
    for (let index = 0; index < sticky.lines.length && sticky.top + index < lines.length; index++) {
      lines[sticky.top + index] = sticky.lines[index]!;
    }
    return lines;
  }
}

/** 覆盖层容器：TUI 把焦点给覆盖层根组件，这里把按键转发给目标（列表或自定义键处理）。 */
class OverlayBox extends VStack {
  focused = false;
  onKey: ((data: string) => void) | null = null;
  forwardTo: { handleInput(data: string): void } | null = null;

  handleInput(data: string): void {
    if (matchesKey(data, "q") || matchesKey(data, "escape")) data = "\x1b";
    if (this.onKey) {
      this.onKey(data);
      return;
    }
    this.forwardTo?.handleInput(data);
  }
}

/** 窗口尺寸：按可用宽度取比例，并按内容定高（不超过终端）。 */
interface WindowOptions {
  /** 占终端宽度的比例（0–1）。 */
  widthRatio: number;
  /** 内容组件；会被包进边框。 */
  content: Component;
  /** 按键转发目标（如 SelectList）；给了它就不再用 onKey。 */
  forwardTo?: { handleInput(data: string): void };
  /** 自定义按键处理（Esc/q 关闭之外）。 */
  onKey?: (data: string) => void;
  /** 关闭时的额外回调（如取消请求）。 */
  onClose?: () => void;
  /** 高度上限占终端行数的比例（默认 0.85）。 */
  maxHeightRatio?: number;
}

export interface TuiAppOptions {
  connection: ControlConnection;
  guard: SubmissionGuard;
  pendingStore: PendingRequestStore;
  state: ViewState;
  terminal?: Terminal;
  initialSessionId?: string;
  /** 工作区入口（issue 21）：以该目录为工作区创建/复用项目并新建会话进入。 */
  workspace?: { path: string };
  /** dev 重载状态文件（issue 21 §5）：注入后启用界面状态持久化与启动恢复。 */
  reloadStateFile?: string;
  onExit: (code: number, message?: string) => void;
}

export class TuiApp {
  private readonly connection: ControlConnection;
  private readonly guard: SubmissionGuard;
  private readonly pendingStore: PendingRequestStore;
  private readonly branchPendingStore: PendingRequestStore;
  private readonly compactionPendingStore: PendingRequestStore;
  private readonly pendingCompactions = new Map<string, PendingCompaction>();
  private readonly compactionResults = new Map<string, SessionCompactionRequest>();
  private readonly compactionQueries = new Set<string>();
  private compactionTimer: NodeJS.Timeout | null = null;
  private readonly state: ViewState;
  private readonly terminal: Terminal;
  private readonly tui: TuiAltScreen;
  private readonly onExit: (code: number, message?: string) => void;
  private readonly initialSessionId?: string;

  private readonly autocompleteOverlayComponent = new LinesComponent();
  private autocompleteOverlay: OverlayHandle | null = null;
  private readonly windows: OverlayHandle[] = [];
  private overlaySyncPending = false;
  /** 已补种过输入历史的会话（每个会话只补一次）。 */
  private readonly seededHistorySessions = new Set<string>();
  /** 运行中任务的走表定时器（无活动任务时为 null）。 */
  private timingTimer: NodeJS.Timeout | null = null;
  private readonly eventFlowView = new EventFlowView();
  private readonly expandedTools = new Map<string, object>();
  private readonly todoPanel = new TodoPanel();
  private readonly workflowSidebar: WorkflowSidebar;
  private readonly ownerQuestions: OwnerQuestions;
  private readonly backgroundProcesses: BackgroundProcesses;
  private todoOverlay: OverlayHandle | null = null;
  private readonly sessionTodos = new Map<string, Todo[] | null>();
  private pendingBranch: { sessionId: string; name?: string; requestId: string; instanceId: string; autoSwitch: boolean; result: CommandResult } | null = null;
  private branchInFlight = false;
  private readonly history: HistoryRecovery;
  private header: Text;
  private transcriptContainer: GutterContainer;
  private scroll: ScrollView;
  private footer: FooterLine;
  private editor: AboveEditor;

  /** 连接批次：每次快照安装递增；异步查询结果按 会话+批次 匹配后更新。 */
  private generation = 0;
  private started = false;
  private exiting = false;
  private submitting = false;
  private modeCycle: Promise<void> = Promise.resolve();
  private sessionSettingsSync: Promise<void> = Promise.resolve();
  private carriedSettings: { mode: SessionDefaultMode; model: ModelSelection | null } | null = null;
  private selectedProjectId: string | null = null;
  private readonly sessionUsage = new Map<string, { input: number; output: number }>();
  private readonly usageRequests = new Map<string, number>();
  private continueForTaskId: string | null = null;
  /** dev 重载状态文件（issue 21 §5）：null = 非 dev 启动，不持久化也不恢复。 */
  private readonly reloadStateFile: string | null;
  /** 重载状态防抖定时器（~300ms 合并连续变更）。 */
  private reloadPersistTimer: NodeJS.Timeout | null = null;
  // ---------- 工作区入口（issue 21） ----------
  private readonly workspacePath: string | null = null;
  /**
   * 工作区入口阶段：pending（待首次握手处理）→ picking（多项目选择中）/
   * awaiting-reconnect（应答丢失，待重连核实）→ done（完成或已回落正常启动）。
   */
  private workspacePhase: "pending" | "picking" | "awaiting-reconnect" | "done" = "done";
  private workspaceIdentity: DirIdentity | null = null;
  /** 启动请求标识：每次进程启动只生成一次，重试沿用同一标识（不生成第二个）。 */
  private startupRequestId: string | null = null;
  /** 进行中的 ensure 所属项目（null = 自动创建路径；应答丢失重试时沿用）。 */
  private workspaceProjectId: string | null = null;
  /** ensure 在途标记：重同步叠加快照时不重入工作区流程（服务端去重兜底仍在）。 */
  private workspaceBusy = false;

  constructor(opts: TuiAppOptions) {
    this.connection = opts.connection;
    this.guard = opts.guard;
    this.pendingStore = opts.pendingStore;
    this.branchPendingStore = new PendingRequestStore(join(opts.pendingStore.dir, "branches"));
    this.compactionPendingStore = new PendingRequestStore(join(opts.pendingStore.dir, "compactions"));
    this.state = opts.state;
    this.history = new HistoryRecovery({
      state: this.state, request: (op, params) => this.connection.request(op, params), entryPageBytes: ENTRY_PAGE_BYTES,
      completeEntry: entry => entry.role === "assistant", isMissingEntry: error => error instanceof ControlClientError && error.code === "entry_not_found",
      changed: () => this.refreshTranscript(), entryFailed: error => this.notify(`历史条目读取失败：${error instanceof Error ? error.message : String(error)}`),
    });
    this.initialSessionId = opts.initialSessionId;
    this.onExit = opts.onExit;
    this.reloadStateFile = opts.reloadStateFile ?? null;
    this.terminal = opts.terminal ?? new ProcessTerminal();
    if (opts.workspace) {
      this.workspacePath = opts.workspace.path;
      this.workspacePhase = "pending";
    }

    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.top": "home", "tui.altScreen.bottom": "end" });
    const match = keybindings.matches.bind(keybindings);
    // 只在侧栏获焦时让出视口键；聊天、搜索和覆盖层仍沿终端库的原路由。
    keybindings.matches = (data, key) => !(this.workflowSidebar?.focused && ["tui.altScreen.pageUp", "tui.altScreen.pageDown", "tui.altScreen.top", "tui.altScreen.bottom"].includes(key)) && match(data, key);
    setKeybindings(keybindings);
    this.tui = new TuiAltScreen(this.terminal, true);

    this.header = new Text("", 1, 0);
    this.transcriptContainer = new GutterContainer(this.eventFlowView, (width) => ({
      top: this.scroll.scrollTop,
      lines: this.scroll.isFollowingEnd ? [] : this.eventFlowView.stickyPrompt(
        this.scroll.scrollTop, width, Math.min(3, Math.max(0, this.scroll.viewportHeight - 1)),
      ),
    }));
    this.eventFlowView.onToggleTool = (entry) => void this.toggleToolExpansion(entry);
    this.eventFlowView.onChange = () => this.tui.requestRender();
    const scroll = new HistoryScrollView(this.transcriptContainer, { follow: "end", primary: true, scrollbar: "auto" });
    scroll.onReachStart = () => void this.loadOlderHistory();
    this.scroll = scroll;
    // 底栏：左侧模式，右侧 token 用量与模型选择（按键提示由 /help 提供）
    this.footer = new FooterLine();
    this.editor = new AboveEditor(this.tui, editorTheme, {});
    this.editor.setAutocompleteProvider(new SlashCommandAutocomplete(VISIBLE_COMMANDS));
    this.editor.onSubmit = (text) => void this.handleSubmit(text);
    this.editor.onChange = () => {
      const view = this.currentView();
      // 草稿保留展开后的原文（大段粘贴的折叠标记只用于展示）
      if (view) view.draft = this.editor.getExpandedText();
      this.scheduleReloadPersist();
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

    this.workflowSidebar = new WorkflowSidebar({
      request: (op, params) => this.connection.request(op, params),
      pending: new PendingRequestStore(join(opts.pendingStore.dir, "workflows")),
      sessionId: () => this.state.currentSessionId,
      instanceId: () => this.state.instanceId,
      online: () => this.connection.state === "online",
      rows: () => this.terminal.rows || 24,
      render: () => this.tui.requestRender(),
      close: () => { this.tui.setFocus(this.editor); this.tui.requestRender(); },
      approvals: () => this.openApprovals(),
      wait: () => this.state.currentSessionId ? this.state.activeTaskFor(this.state.currentSessionId)?.wait : undefined,
    });

    this.ownerQuestions = new OwnerQuestions({
      request: (op, params) => this.connection.request(op, params),
      pending: new PendingRequestStore(join(opts.pendingStore.dir, "owner-questions")),
      known: () => this.state.ownerQuestions,
      install: (sessionId, questions) => { this.state.ownerQuestions = [...this.state.ownerQuestions.filter(question => question.sessionId !== sessionId), ...questions]; this.refreshChrome(); },
      beforeSend: () => this.sessionSettingsSync,
      session: () => this.state.sessions.find(session => session.id === this.state.currentSessionId),
      instanceId: () => this.state.instanceId,
      online: () => this.connection.state === "online",
      render: () => this.tui.requestRender(),
      close: () => { this.windows.at(-1)?.hide(); this.tui.setFocus(this.editor); },
    });

    this.backgroundProcesses = new BackgroundProcesses({
      request: (op, params) => this.connection.request(op, params),
      pending: new PendingRequestStore(join(opts.pendingStore.dir, "background-processes")),
      sessionId: () => this.state.currentSessionId,
      instanceId: () => this.state.instanceId,
      online: () => this.connection.state === "online",
      render: () => this.tui.requestRender(),
      close: () => { this.windows.at(-1)?.hide(); this.tui.setFocus(this.editor); },
    });

    const mainVisible = () => this.windows.length === 0;
    const chat = new VStack([
      { component: this.header, grow: 0, shrink: 1, visible: mainVisible },
      { component: this.scroll, grow: 1, shrink: 1, minSize: 1, visible: mainVisible },
      { component: this.editor, grow: 0, shrink: 0, minSize: 3, visible: mainVisible },
      { component: this.footer, grow: 0, shrink: 0, visible: mainVisible },
    ]);
    const root = new HStack([
      { component: chat, grow: 1, shrink: 1, minSize: 1, visible: viewport => mainVisible() && (viewport.width >= 120 || !this.workflowSidebar.opened || !this.workflowSidebar.focused) },
      { component: this.workflowSidebar, basis: 46, grow: 0, shrink: 0, visible: viewport => mainVisible() && this.workflowSidebar.opened && viewport.width >= 120 },
      { component: this.workflowSidebar, grow: 1, minSize: 1, visible: viewport => mainVisible() && this.workflowSidebar.opened && this.workflowSidebar.focused && viewport.width < 120 },
    ]);
    this.tui.addChild(root);
    this.tui.setLayoutRoot(root);
    this.tui.setFocus(this.editor);

    // Ctrl+C：有草稿先清草稿，空草稿退出客户端（不停止后台任务）
    this.tui.addInputListener((data) => {
      if (this.workflowSidebar.focused && this.windows.length === 0 && (["pageUp", "pageDown", "home", "end"] as const).some(key => matchesKey(data, key))) {
        if (!isKeyRelease(data)) this.workflowSidebar.handleInput(data);
        this.tui.requestRender();
        return { consume: true };
      }
      if (data === "\t" && this.workflowSidebar.opened && this.windows.length === 0 && this.editor.overlayLines.length === 0) {
        this.tui.setFocus(this.workflowSidebar.focused ? this.editor : this.workflowSidebar);
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "escape") && this.todoOverlay && this.editor.overlayLines.length === 0 && this.tui.getFocusedComponent() === this.editor) {
        this.todoOverlay.hide();
        this.todoOverlay = null;
        return { consume: true };
      }
      if (matchesKey(data, "shift+tab") && this.tui.getFocusedComponent() === this.editor) {
        const sessionId = this.state.currentSessionId;
        this.modeCycle = this.modeCycle.then(() => this.cycleMode(sessionId));
        return { consume: true };
      }
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

  /** 运行中刷新动画与计时：没有活动任务时不保留定时器。 */
  private tickTiming(): void {
    // Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-tui-exit-late-response.md
    if (this.exiting) return;
    const sessionId = this.state.currentSessionId;
    const needsTick = sessionId ? this.state.activeTaskFor(sessionId) !== null : false;
    if (needsTick && !this.timingTimer) {
      this.timingTimer = setInterval(() => {
        if (!this.state.currentSessionId || !this.state.activeTaskFor(this.state.currentSessionId)) {
          this.stopTimingTick();
          return;
        }
        if (!this.windows.length) this.tui.requestRender();
      }, 80);
    } else if (!needsTick) {
      this.stopTimingTick();
    }
  }

  private stopTimingTick(): void {
    if (this.timingTimer) clearInterval(this.timingTimer);
    this.timingTimer = null;
  }


  private syncAutocompleteOverlay(): void {
    if (this.windows.length) {
      this.autocompleteOverlay?.hide();
      this.autocompleteOverlay = null;
      return;
    }
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
      this.notify(`初始连接失败：${(err as Error).message}${this.connection.state === "failed" ? "" : "；自动重连中"}`);
    });
  }

  /** 连接层回调：状态变化。 */
  onConnectionState(state: "connecting" | "online" | "reconnecting" | "failed" | "closed", detail?: string): void {
    this.state.connection = { state, detail: detail ?? null, lastSyncAt: this.connection.lastSyncAt };
    if (state === "online") {
      void this.workflowSidebar.reconnect();
      void this.ownerQuestions.reconnect();
      void this.backgroundProcesses.refresh();
      void this.reconcilePendingInputs();
      for (const pending of this.pendingCompactions.values()) void this.reconcileCompaction(pending.sessionId, true);
      if (this.state.currentSessionId) void this.reconcileCompaction(this.state.currentSessionId);
      if (this.state.currentSessionId) void this.refreshSessionUsage(this.state.currentSessionId);
    }
    this.refreshChrome();
  }

  /** 连接层回调：安装快照。 */
  onSnapshot(result: ConnectResult, ctx: { resync: boolean; instanceChanged: boolean }): void {
    this.generation++;
    this.clearToolExpansions();
    if (ctx.instanceChanged) this.sessionUsage.clear();
    this.history.reset();
    this.state.applySnapshot(result, ctx.instanceChanged);
    this.workflowSidebar.refresh();
    void this.ownerQuestions.refresh();
    void this.backgroundProcesses.refresh();
    if (ctx.instanceChanged) this.sessionTodos.clear();
    if (!this.pendingBranch && this.generation === 1) {
      const saved = this.branchPendingStore.list();
      for (const name of saved.corrupt) this.notify(`分支待核实记录损坏：${name}，请核实原后台结果`);
      const record = saved.records[0];
      if (record?.op === "branch_session") {
        const sessionId = String(record.params.session_id);
        this.pendingBranch = { sessionId, name: record.params.name as string | undefined, requestId: record.requestId, instanceId: record.instanceId, autoSwitch: false,
          result: text => { this.state.note(sessionId, text); this.refreshAll(); } };
      }
    }
    if (this.generation === 1) {
      const saved = this.compactionPendingStore.list();
      for (const name of saved.corrupt) this.notify(`压缩待核实记录损坏：${name}，请核实原后台结果`);
      for (const record of saved.records) {
        if (record.op !== "compact_session" || typeof record.params.session_id !== "string") continue;
        const sessionId = record.params.session_id;
        const commandKey = typeof record.params.command_key === "string" ? record.params.command_key : null;
        this.pendingCompactions.set(sessionId, { sessionId, requestId: record.requestId, instanceId: record.instanceId,
          prompt: typeof record.params.prompt === "string" ? record.params.prompt : undefined, commandKey,
          line: typeof record.params.line === "string" ? record.params.line : "/compact", inFlight: false,
          result: (text, isError) => this.state.setCommandResult(sessionId, commandKey, text, isError) });
      }
      this.tickCompactions();
    }
    if (this.workspacePhase !== "done") {
      // 工作区入口（issue 21）：首次握手与应答丢失后的重连核实都经这里；
      // 完成、取消或明确失败后回落到正常启动流程
      void this.runWorkspaceEntry();
      return;
    }
    // dev 重载恢复（issue 21 §5）：仅进程内首次快照（非重连）尝试一次，
    // 在正常启动流程之前；失效时由其自行回落正常入口
    if (!ctx.resync && this.reloadStateFile && this.generation === 1) {
      void this.restoreReloadState(result);
      return;
    }
    this.normalStartupFlow(ctx);
    if (this.pendingBranch) void this.reconcileBranch();
  }

  // ---------- dev 重载状态（issue 21 §5） ----------

  /**
   * 防抖落盘界面状态（当前会话 / 草稿 / 继续意图，~300ms 合并突发变更）；
   * 仅 dev 注入重载状态文件时启用，秘密从不写入（类型上就没有这些字段）。
   */
  private scheduleReloadPersist(): void {
    if (!this.reloadStateFile) return;
    if (this.reloadPersistTimer) clearTimeout(this.reloadPersistTimer);
    this.reloadPersistTimer = setTimeout(() => this.persistReloadState(), 300);
  }

  /** 立即落盘（防抖到期与退出前共用；未握手成功过则没有 instanceId，跳过）。 */
  private persistReloadState(): void {
    if (this.reloadPersistTimer) {
      clearTimeout(this.reloadPersistTimer);
      this.reloadPersistTimer = null;
    }
    const file = this.reloadStateFile;
    const instanceId = this.state.instanceId;
    if (!file || !instanceId) return;
    saveReloadState(file, {
      kind: "task-tui",
      instanceId,
      sessionId: this.state.currentSessionId,
      draft: this.currentView()?.draft ?? "",
      continueForTaskId: this.continueForTaskId,
      updatedAt: "", // 落盘时由 saveReloadState 写入当前时间
    });
  }

  /**
   * dev 重载恢复（仅进程内首次快照尝试一次）：instanceId 必须与本次握手一致，
   * 否则记录失效按正常入口启动；会话仍在快照中才恢复会话与草稿；继续意图
   * 要求目标任务仍存在且处于中断态——不满足则丢弃意图（草稿保留为普通草稿，
   * 提交时按新任务处理），绝不静默变成提交。
   */
  private async restoreReloadState(result: ConnectResult): Promise<void> {
    const file = this.reloadStateFile!;
    if (!fs.existsSync(file)) {
      // 新一轮 dev 已清除记录：正常入口
      this.normalStartupFlow({ resync: false });
      return;
    }
    const saved = loadReloadState(file);
    if (!saved || saved.kind !== "task-tui" || saved.instanceId !== result.snapshot.instanceId) {
      this.notify(yellow("重载恢复记录已失效，按正常入口启动"));
      this.normalStartupFlow({ resync: false });
      return;
    }
    const sessionId =
      saved.sessionId && result.snapshot.sessions.some((s) => s.id === saved.sessionId) ? saved.sessionId : null;
    if (sessionId === null) {
      // 无会话或会话已不在快照中：草稿/继续意图无从归属，按正常入口启动
      this.normalStartupFlow({ resync: false });
      return;
    }
    // 草稿先放回会话视图，switchSession 会顺带装入编辑器
    this.state.openSession(sessionId).draft = saved.draft;
    this.switchSession(sessionId);
    if (saved.continueForTaskId) {
      let task = this.state.getTask(saved.continueForTaskId);
      if (!task) {
        // 快照未覆盖的旧任务：向后台核实一次
        try {
          const detail = await this.connection.request("get_task", { task_id: saved.continueForTaskId });
          task = detail.task ?? null;
        } catch {
          task = null;
        }
      }
      if (task && task.sessionId === sessionId && task.status === "interrupted") {
        this.continueForTaskId = task.id;
        this.notify(
          `已恢复继续模式：下一条输入将继续任务 ${task.id}（中断原因 ${task.interruptReason ?? "未知"}；输入 /continue 取消）`,
        );
      } else {
        this.notify(yellow("继续目标任务已不存在或已结束；草稿保留为普通输入，提交将作为新任务"));
      }
    }
    // 结果回写：丢弃的意图/恢复的草稿立即同步，避免下次重载读到过期记录
    this.persistReloadState();
    this.refreshAll();
  }

  /** 正常启动流程：--session 精确/前缀匹配 → 项目与会话选择 → 欢迎页；重连时重载历史。 */
  private normalStartupFlow(ctx: { resync: boolean }): void {
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
      // 默认先选择项目，再选择项目中的会话
      this.openProjectPicker();
    }
    const current = this.state.currentSessionId;
    if (current) {
      // 重同步/重连：重新加载历史与最新预览（不依赖上次内存）
      void this.loadHistory(current, "replace");
      void this.refreshTaskDetails();
      if (ctx.resync) void this.refreshSessionUsage(current);
    }
    this.refreshAll();
  }

  // ---------- 工作区入口（issue 21） ----------

  /** 工作区入口：解析目录身份 → 按目录找候选项目 → 复用/选择/自动创建后进入新会话。 */
  private async runWorkspaceEntry(): Promise<void> {
    // 选择面板打开中（等用户决定）或上一次 ensure 仍在途（重同步可能叠加快照）时不重入
    if (this.workspacePhase === "picking" || this.workspaceBusy) return;
    this.workspaceBusy = true;
    try {
      await this.runWorkspaceEntryInner();
    } finally {
      this.workspaceBusy = false;
    }
  }

  private async runWorkspaceEntryInner(): Promise<void> {
    if (this.workspacePhase === "awaiting-reconnect") return this.verifyWorkspaceEntry();
    // pending：首次握手
    if (!this.workspaceIdentity) {
      try {
        this.workspaceIdentity = await resolveWorkspaceDir(this.workspacePath!, process.cwd());
      } catch (err) {
        this.workspacePhase = "done";
        this.quit(1, (err as Error).message);
        return;
      }
      this.startupRequestId = `boot-${randomUUID()}`;
    }
    // 已确认归属（根目录身份）优先：命中即唯一工作区，直接进入；否则只在
    // 尚无归属的旧项目里找候选（issue 05，保留旧项目兼容关系）
    const rootMatch = findWorkspaceByRoot({ projects: this.state.projects }, this.workspaceIdentity);
    if (rootMatch) {
      await this.ensureWorkspaceEntry(rootMatch.id);
      return;
    }
    const candidates = findWorkspaceProjects(
      { projects: this.state.projects, sessions: this.state.sessions, roleSessionIds: this.state.roleSessionIds },
      this.workspaceIdentity,
    );
    if (candidates.length === 0) {
      await this.ensureWorkspaceEntry(null);
    } else if (candidates.length === 1) {
      await this.ensureWorkspaceEntry(candidates[0]!.id);
    } else {
      this.openWorkspaceProjectPicker(candidates);
    }
  }

  /**
   * 应答丢失核实：当前状态里按启动请求标识找会话；找到即进入，找不到才用同一
   * 标识重试（先找再发：已建项目会改变自动项目名，重发参数不同会被判冲突）。
   * retried：连接仍在时的当场核实只做一次，重试仍应答丢失就不再循环。
   */
  private async verifyWorkspaceEntry(retried = false): Promise<void> {
    const found = this.state.sessions.find((s) => s.createRequestId === this.startupRequestId);
    if (found) {
      this.workspacePhase = "done";
      this.switchSession(found.id);
      return;
    }
    await this.ensureWorkspaceEntry(this.workspaceProjectId, retried);
  }

  /** 幂等创建/复用工作区会话并进入；断线或未发送等重连核实，连接仍在的应答丢失当场核实，明确拒绝回落正常启动。 */
  private async ensureWorkspaceEntry(projectId: string | null, retried = false): Promise<void> {
    this.workspaceProjectId = projectId;
    try {
      const { session, projectName, createdProject } = await ensureWorkspaceSession(
        this.connection,
        { projects: this.state.projects, sessions: this.state.sessions },
        this.workspaceIdentity!,
        { projectId, startupRequestId: this.startupRequestId! },
      );
      this.workspacePhase = "done";
      this.switchSession(session.id);
      if (createdProject) this.notify(`项目已自动创建：${projectName}`);
    } catch (err) {
      const outcome = requestOutcome(err);
      const message = (err as Error).message;
      if (outcome === "unknown" && !retried) {
        // 连接仍在、不会有重连快照触发核实：当场核实（已建的会话经事件已在状态里）
        this.notify(yellow(`后台应答丢失（${message}），按启动请求标识核实后重试…`));
        return this.verifyWorkspaceEntry(true);
      }
      if (outcome === "disconnected" || outcome === "not_sent") {
        // 不盲目重发：等重连后的新快照按启动请求标识核实（未发送的也在那时按同一标识重发）
        this.workspacePhase = "awaiting-reconnect";
        return;
      }
      // 后台明确拒绝（如保护根），或当场核实后仍应答丢失：不留下半选中状态，回落正常启动流程
      this.workspacePhase = "done";
      this.notify(
        red(
          outcome === "unknown"
            ? `工作区会话创建结果未知：${message}；已核实一次仍未确认，回到正常启动（用 /project 查看是否已创建）`
            : `工作区会话创建失败：${message}`,
        ),
      );
      this.normalStartupFlow({ resync: false });
    }
  }

  /** 多候选项目选择：取消不创建任何项目/会话，回落正常启动流程。 */
  private openWorkspaceProjectPicker(candidates: Project[]): void {
    this.workspacePhase = "picking";
    const items: SelectItem[] = candidates.map((p) => ({ value: p.id, label: p.name, description: p.id }));
    const list = new SelectList(items, Math.min(items.length, 10), selectTheme);
    const body = new VStack([
      { component: new Text(bold(`工作区 ${this.workspaceIdentity!.cwdReal} 对应多个项目，选择要进入的项目（Esc/q 取消，不创建会话）`), 0, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    let picked = false;
    const handle = this.openWindow({
      widthRatio: 0.85,
      content: body,
      forwardTo: list,
      maxHeightRatio: 0.7,
      onClose: () => {
        if (picked) return;
        this.workspacePhase = "done";
        this.normalStartupFlow({ resync: false });
      },
    });
    list.onSelect = (item) => {
      picked = true;
      handle.hide();
      void this.ensureWorkspaceEntry(item.value);
    };
  }

  /** 连接层回调：事件应用后刷新界面；落盘条目增量补齐正文。 */
  onEvent(event: PersistentEvent, kind: "live" | "replay"): void {
    this.state.applyEvent(event, kind);
    const body = event.body;
    if (body.type === "background_process.changed" && body.process.sessionId === this.state.currentSessionId) void this.backgroundProcesses.refresh();
    if (body.type === "owner_question.changed") void this.ownerQuestions.refresh();
    if (body.type === "workflow.changed" || body.type === "workflow.step" || body.type === "workflow.execution" || body.type === "agent_wait.changed") this.workflowSidebar.refresh();
    if (body.type === "session.usage_updated" && body.sessionId === this.state.currentSessionId) {
      void this.refreshSessionUsage(body.sessionId);
    }
    if (body.type === "session.context_compaction") void this.reconcileCompaction(body.sessionId);
    if (body.type === "task.output_entry") {
      void this.loadEntry(body.sessionId, body.entryId);
      if (body.role === "toolResult") void this.refreshSessionTodos(body.sessionId);
    }
    this.refreshAll();
  }

  /**
   * 待确认输入按 session_id+request_id 核实：上线（首连与重连）时核实全部；
   * 连接仍在的应答丢失之后只核实那一条（onlyRequestId）。
   */
  private async reconcilePendingInputs(onlyRequestId?: string): Promise<void> {
    const pending = this.pendingStore.list();
    this.state.pendingInputs = pending.records;
    this.state.corruptPendingFiles = pending.corrupt;
    const only = onlyRequestId === undefined ? null : pending.records.find((r) => r.requestId === onlyRequestId);
    if (only === undefined) return;
    if (only || pending.records.length > 0 || pending.corrupt.length > 0) {
      if (!only) this.notify(`发现 ${pending.records.length} 条待核实输入${pending.corrupt.length > 0 ? `（另有 ${pending.corrupt.length} 条损坏记录待人工处理）` : ""}，正在核实…`);
      const outcomes = only ? [await this.guard.reconcile(only)] : await this.guard.reconcileAll();
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
            this.showSelection("旧请求明确未接收且缺少模型：恢复原文后通过 /model 选择并提交（Esc/q 保留记录）", [{ value: "restore", label: "恢复原文到所属会话并清除旧待确认记录" }], () => {
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
    this.stopTimingTick();
    if (this.compactionTimer) clearInterval(this.compactionTimer);
    this.compactionTimer = null;
    // dev 重载（issue 21 §5）：退出前把最终界面状态同步落盘（防抖可能还在等）
    this.persistReloadState();
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

  private switchSession(sessionId: string, preserveSettings = false): void {
    this.clearToolExpansions();
    const prev = this.currentView();
    const source = this.state.sessions.find((session) => session.id === prev?.sessionId);
    const settings = preserveSettings ? null : this.carriedSettings ?? (source ? { mode: source.defaultAccessMode, model: source.modelSelection ? { ...source.modelSelection } : null } : null);
    if (preserveSettings) this.carriedSettings = null;
    if (prev) {
      // 草稿与滚动位置随会话保留（草稿用展开后的原文）
      prev.draft = this.editor.getExpandedText();
      prev.scrollTop = this.scroll.isFollowingEnd ? null : this.scroll.scrollTop;
    }
    this.state.currentSessionId = sessionId;
    this.workflowSidebar.sessionChanged();
    void this.ownerQuestions.refresh();
    void this.backgroundProcesses.refresh();
    if (settings && source?.id !== sessionId) {
      this.carriedSettings = settings;
      const sync = this.sessionSettingsSync.catch(() => {}).then(async () => {
        const target = this.state.sessions.find((session) => session.id === sessionId);
        if (!target) return;
        let failure: string | null = null;
        const result: CommandResult = (text, isError) => {
          if (isError) {
            failure = text;
            this.state.note(sessionId, red(`沿用会话设置：${text}`));
          }
        };
        if (target.defaultAccessMode !== settings.mode && this.sessionModes(target).includes(settings.mode)) {
          await this.sendSessionMode(sessionId, target.defaultAccessModeVersion, settings.mode, result);
        }
        if (settings.model && (target.modelSelection?.provider !== settings.model.provider || target.modelSelection?.modelId !== settings.model.modelId || target.modelSelection?.thinkingLevel !== settings.model.thinkingLevel)) {
          await this.saveModelSelection(sessionId, target.modelSelectionVersion, settings.model, result);
        }
        if (failure) throw new Error(failure);
      });
      this.sessionSettingsSync = sync;
      const complete = () => {
        if (this.sessionSettingsSync === sync) {
          this.carriedSettings = null;
          this.sessionSettingsSync = Promise.resolve();
        }
      };
      void sync.then(complete, complete);
    }
    const view = this.state.openSession(sessionId);
    // issue 07 步骤 4：恢复已映射旧会话后选择状态继续指向目标工作区（ruukoto 产品用原身份）
    this.selectedProjectId = this.displayProjectIdOf(this.state.sessions.find((s) => s.id === sessionId)) ?? view.projectId;
    void this.refreshSessionUsage(sessionId);
    void this.refreshSessionTodos(sessionId);
    void this.reconcileCompaction(sessionId);
    this.continueForTaskId = null;
    this.editor.setText(view.draft);
    if (!view.historyLoaded) {
      void this.loadHistory(sessionId, "replace");
    }
    this.refreshAll();
    if (view.scrollTop !== null) this.scroll.scrollTo(view.scrollTop, { disableFollow: true });
    this.scheduleReloadPersist();
  }

  private async refreshSessionUsage(sessionId: string): Promise<void> {
    if (this.connection.state !== "online") return;
    const generation = this.generation;
    const request = (this.usageRequests.get(sessionId) ?? 0) + 1;
    this.usageRequests.set(sessionId, request);
    try {
      const usage = await this.connection.request("get_session_usage", { session_id: sessionId });
      if (generation !== this.generation || this.usageRequests.get(sessionId) !== request) return;
      this.sessionUsage.set(sessionId, usage);
    } catch {
      if (generation !== this.generation || this.usageRequests.get(sessionId) !== request) return;
      this.sessionUsage.delete(sessionId);
    }
    if (sessionId === this.state.currentSessionId) this.refreshChrome();
  }

  /**
   * 用会话已落盘的历史消息补种输入框的上下键历史。
   *
   * Editor 的历史只在内存里（提交时 addToHistory），重开 TUI 就空了，其他
   * 客户端（CLI）提交的消息也进不来。这里按会话把用户消息和命令补进去：编辑器按
   * 时间倒序保存（unshift），所以从最早一条开始喂，最新一条才会落在最前。
   * 补种只在每个会话首次加载历史时做一次，避免翻页重复灌入。
   */
  private seedInputHistory(sessionId: string): void {
    if (this.seededHistorySessions.has(sessionId)) return;
    this.seededHistorySessions.add(sessionId);
    for (const entry of this.state.openSession(sessionId).flow.items) {
      if (entry.kind === "command") this.editor.addToHistory(entry.line);
      else if (entry.kind === "message" && entry.role === "user") this.editor.addToHistory(entry.text);
    }
  }

  private async loadHistory(sessionId: string, mode: "replace" | "prepend"): Promise<void> {
    const generation = this.generation;
    const recoveryGeneration = this.history.generation;
    const view = this.state.openSession(sessionId);
    try {
      const page = await this.connection.request("read_history", {
        session_id: sessionId,
        before: mode === "prepend" ? (view.historyCursor ?? undefined) : undefined,
        limit: HISTORY_PAGE_SIZE,
      });
      // 异步结果按 会话+连接批次 匹配：过期结果不得覆盖新页面
      if (generation !== this.generation) return;
      this.state.installHistoryPage(sessionId, page, mode);
      void this.refreshSessionTodos(sessionId);
      this.seedInputHistory(sessionId);
      this.refreshTranscript();
      const tasks = await this.history.readTasks(sessionId, view.flow.historyEntries, recoveryGeneration);
      if (!tasks || generation !== this.generation) return;
      await Promise.all([...tasks].map(taskId => this.history.restoreTask(taskId, recoveryGeneration)));
      if (generation === this.generation) this.refreshAll();
    } catch (err) {
      if (generation !== this.generation) return;
      this.notify(`历史读取失败：${(err as Error).message}`);
    }
  }

  private olderRequests = new Set<string>();

  private async loadOlderHistory(): Promise<void> {
    const view = this.currentView();
    if (!view?.historyCursor || this.olderRequests.has(`${this.generation}:${view.sessionId}`)) return;
    const generation = this.generation;
    const width = () => Math.max(1, this.scroll.getContentWidth(this.terminal.columns || 80) - RIGHT_GUTTER);
    const originalTop = this.scroll.scrollTop;
    const anchor = this.eventFlowView.scrollAnchor(originalTop, width());
    const key = `${generation}:${view.sessionId}`;
    this.olderRequests.add(key);
    try {
      await this.loadHistory(view.sessionId, "prepend");
      if (generation !== this.generation || this.currentView() !== view || !anchor || this.scroll.isFollowingEnd) return;
      const top = this.eventFlowView.entryTop(anchor.key, width());
      if (top === undefined) return;
      const moved = this.scroll.scrollTop - originalTop;
      // 更新布局尺寸后恢复原事件的位置，新增历史不会把当前内容推走。
      this.scroll.updateLayout(this.transcriptContainer.render(this.scroll.getContentWidth(this.terminal.columns || 80)).length, this.scroll.viewportHeight, () => this.tui.requestRender());
      this.scroll.scrollTo(top + anchor.offset + moved, { disableFollow: true });
      this.tui.requestRender();
    } finally {
      this.olderRequests.delete(key);
    }
  }

  /** output_entry 的错误与就绪事实随恢复代次处理。 */
  loadEntry(sessionId: string, entryId: string): Promise<void> {
    return this.history.loadEntry(sessionId, entryId, this.history.generation);
  }

  /** 刷新当前活动任务详情；返回 false 表示当前会话没有活动任务。 */
  private async refreshTaskDetails(): Promise<boolean> {
    const current = this.state.currentSessionId;
    const active = current ? this.state.activeTaskFor(current) : null;
    if (!active) return false;
    const generation = this.generation;
    try {
      await this.history.restoreTask(active.id, this.history.generation);
      if (generation === this.generation) this.refreshAll();
    } catch (err) {
      if (generation === this.generation) this.notify(`任务事件读取失败：${(err as Error).message}`);
    }
    return true;
  }

  // ---------- 输入提交 ----------

  private async handleSubmit(text: string): Promise<void> {
    this.editor.addToHistory(text);
    await dispatchInput(text, this.commandEnv());
  }

  /** 以当前会话提交任务（沿用 request_id 去重；/skill 以 /skill:<名称> 输入复用）。 */
  private async submitText(text: string): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话：/project 选择，或 /new-project、/new-session 创建");
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
    try {
      await this.sessionSettingsSync;
      if (this.currentView() !== view) {
        view.draft = text;
        return;
      }
      const continueTaskId = this.continueForTaskId;
      const modelSelection = this.state.sessions.find((s) => s.id === view.sessionId)?.modelSelection;
      if (!modelSelection) throw new Error("请先通过 /model 选择模型");
      const outcome = continueTaskId
        ? await this.guard.submit("continue", { task_id: continueTaskId, session_id: view.sessionId, input: text, model_selection: modelSelection })
        : await this.guard.submit("submit", { session_id: view.sessionId, input: text, model_selection: modelSelection });
      switch (outcome.kind) {
        case "accepted": {
          this.state.upsertTask(outcome.task);
          // 立即显示刚发出的输入：不等后台落盘、经历史回传才出现
          this.state.addPendingInput(outcome.task);
          const wasContinue = this.continueForTaskId !== null;
          this.continueForTaskId = null;
          this.scheduleReloadPersist();
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
          if (outcome.outcome === "unknown") {
            // 连接仍在：不会有重连触发核实，当场按原键核实
            this.notify(yellow(`应答丢失：输入 ${outcome.requestId} 接收结果待核实（${outcome.reason}），正在按原键核实`));
            void this.reconcilePendingInputs(outcome.requestId);
          } else {
            this.notify(yellow(`应答丢失：输入 ${outcome.requestId} 接收结果待核实，重连后按原键核实（不会换新键重发）`));
          }
          break;
        case "rejected":
        case "not_sent":
          view.draft = text;
          if (this.state.currentSessionId === view.sessionId) this.editor.setText(text);
          this.state.note(view.sessionId, `${outcome.kind === "rejected" ? "提交被拒绝" : "提交未发送"}：${outcome.message}`);
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

  /** 派发器的能力：view、回显与结果行按发起时的会话；注记与面板照旧跟随当前会话。 */
  private commandEnv(): CommandEnv {
    const view = this.currentView();
    const sessionId = this.state.currentSessionId;
    return {
      view: view && { sessionId: view.sessionId, projectId: view.projectId },
      request: (op, params) => this.connection.request(op, params),
      notify: (text) => this.notify(text),
      showText: (text) => this.showText(text),
      echo: (line) => {
        const key = this.state.echoCommand(sessionId, line);
        this.refreshAll();
        return key;
      },
      setResult: (key, text, isError) => (sessionId ? this.state.setCommandResult(sessionId, key, text, isError) : this.notify(text)),
      host: this.commandHost,
    };
  }

  /** 面板类命令的处理逻辑（commands.ts 经此调用）。 */
  private readonly commandHost: CommandHost = {
    quit: () => this.quit(0),
    openHelp: () => this.openHelp(),
    openResume: () => this.openSessionPicker(),
    openProjects: () => this.openProjectPicker(),
    newSession: (cwd) => this.cmdNewSession(cwd),
    newSessionHere: () => this.cmdNew(),
    branchSession: (name, result) => this.cmdBranch(name, result),
    compactSession: (prompt, result, key, line) => this.cmdCompact(prompt, result, key, line),
    reloadHistory: async () => {
      const view = this.currentView();
      if (view) await this.loadHistory(view.sessionId, "replace");
    },
    artifact: (prefix) => this.cmdArtifact(prefix),
    openApprovals: () => this.openApprovals(),
    interrupt: (taskId) => this.cmdInterrupt(taskId),
    cancel: (taskId) => this.cmdCancel(taskId),
    continueTask: (taskId) => this.cmdContinue(taskId),
    resumeQueue: () => this.cmdResumeQueue(),
    openModelPicker: (result) => this.openModelPicker(result),
    openModeList: (rest, result) => this.cmdMode(rest, result),
    refreshTask: () => this.refreshTaskDetails(),
    openContext: (result) => this.cmdContext(result),
    openPrompts: () => this.cmdPrompt(),
    toggleTodo: () => this.toggleTodo(),
    openProcesses: () => {
      if (productFromEnv() !== "ruukoto-code") { this.notify("本会话后台入口仅向 Coding 开放。"); return; }
      void this.backgroundProcesses.refresh();
      const frame = new WindowFrame(this.backgroundProcesses, true);
      frame.onKey = data => {
        if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) frame.scrollBy(matchesKey(data, "pageUp") ? -5 : 5);
        else this.backgroundProcesses.handleInput(data);
        this.tui.requestRender();
      };
      this.showWindow(frame, { width: "85%", anchor: "center", maxHeight: "85%" });
    },
    openQuestions: () => {
      void this.ownerQuestions.refresh();
      const frame = new WindowFrame(this.ownerQuestions, true);
      frame.onKey = data => {
        if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) frame.scrollBy(matchesKey(data, "pageUp") ? -5 : 5);
        else { this.ownerQuestions.handleInput(data); if (matchesKey(data, "enter") || matchesKey(data, "escape")) frame.scrollBy(-10000); }
        this.tui.requestRender();
      };
      this.showWindow(frame, { width: "85%", anchor: "center", maxHeight: "85%" });
    },
    openWorkflow: () => { this.workflowSidebar.open(); this.tui.setFocus(this.workflowSidebar); this.tui.requestRender(); },
    submit: (text) => this.submitText(text),
  };

  private async cmdNewSession(cwd: string): Promise<void> {
    if (!cwd) {
      this.notify("用法：/new-session <工作目录>（目录属于后台工作区，不做本地路径补全）");
      return;
    }
    // issue 07 步骤 4：从已映射旧会话新建会话到当前目标工作区（ruukoto 沿用原身份）
    const projectId = this.currentDisplayProjectId() ?? this.selectedProjectId ?? this.state.projects[0]?.id;
    if (!projectId) {
      this.notify(this.devProductPicker() ? LEGACY_PROJECT_WRITE_HINT : "尚无项目：先 /new-project <名称>");
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
    const projectId = this.currentDisplayProjectId();
    if (!projectId) {
      this.notify(this.devProductPicker() ? LEGACY_PROJECT_WRITE_HINT : "尚无项目：先 /new-project <名称>");
      return;
    }
    await this.createAndSwitch(projectId, view.cwd);
  }

  /** 保存原请求键，安装完整设置后仅切换发起客户端。
   * Note: 见 .agents/notes/implemented/feature/2026-10-11-branch-session-snapshot.md
   */
  private async cmdBranch(name: string, result: CommandResult): Promise<void> {
    const sessionId = this.state.currentSessionId;
    if (!sessionId) { result("尚未选择普通开发会话", true); return; }
    if (this.pendingBranch) {
      result("此前分支请求仍待核实，正在按原请求键查询", true);
      await this.reconcileBranch();
      return;
    }
    try { await this.sessionSettingsSync; }
    catch { result("会话设置尚未核实，请刷新设置后再分支", true); return; }
    if (this.pendingBranch) { result("此前分支请求仍待核实，请先核实原请求", true); return; }
    this.pendingBranch = { sessionId, ...(name ? { name } : {}), requestId: randomUUID(), instanceId: this.state.instanceId!, autoSwitch: true, result };
    try {
      const pending = this.pendingBranch;
      this.branchPendingStore.save({ requestId: pending.requestId, op: "branch_session", instanceId: pending.instanceId,
        params: { session_id: sessionId, name: pending.name }, createdAt: new Date().toISOString() });
    } catch {
      this.pendingBranch = null;
      result("无法保存分支请求键，未发送创建请求；请核实客户端存储", true);
      return;
    }
    await this.sendBranch();
  }

  private finishBranch(session: Session): void {
    const pending = this.pendingBranch;
    if (!pending) return;
    this.branchPendingStore.clear(pending.requestId);
    this.pendingBranch = null;
    const index = this.state.sessions.findIndex(s => s.id === session.id);
    if (index < 0) this.state.sessions.push(session);
    else this.state.sessions[index] = session;
    const source = session.branchSource!;
    const text = `已建立 ${session.name}；来源 ${source.sessionId}，分支点 ${source.entryId}，${source.messageCount} 条消息` +
      (source.excluded.length ? `；未纳入：${source.excluded.join("、")}` : "");
    pending.result(text);
    if (pending.autoSwitch && this.state.currentSessionId === pending.sessionId) this.switchSession(session.id, true);
    this.refreshAll();
  }

  private async sendBranch(): Promise<void> {
    const pending = this.pendingBranch;
    if (!pending || this.branchInFlight) return;
    this.branchInFlight = true;
    try {
      const session = await this.connection.request("branch_session", { session_id: pending.sessionId, name: pending.name, request_id: pending.requestId });
      if (this.pendingBranch === pending) this.finishBranch(session);
    } catch (error) {
      pending.result(writeFailure("建立会话分支", error, `/branch（请求 ${pending.requestId}，按原键核实）`), true);
      if (requestOutcome(error) === "rejected") {
        try {
          const found = await this.connection.request("find_branch_session", { request_id: pending.requestId });
          if (found.session) this.finishBranch(found.session);
          else if (found.status === "not_found") { this.branchPendingStore.clear(pending.requestId); this.pendingBranch = null; }
        } catch { /* 查询失败保留原请求键，重连后核实。 */ }
      }
    } finally { this.branchInFlight = false; this.refreshAll(); }
    if (this.pendingBranch && this.connection.state === "online") await this.reconcileBranch(false);
  }

  private async reconcileBranch(retry = true): Promise<void> {
    const pending = this.pendingBranch;
    if (!pending || this.branchInFlight || this.connection.state !== "online") return;
    if (pending.instanceId !== this.state.instanceId) {
      pending.result(`后台数据实例已改变，原分支请求 ${pending.requestId} 需在原实例核实`, true);
      this.pendingBranch = null;
      return;
    }
    try {
      const found = await this.connection.request("find_branch_session", { request_id: pending.requestId });
      if (this.pendingBranch !== pending) return;
      if (found.session) this.finishBranch(found.session);
      else if (retry) await this.sendBranch();
      else pending.result(`分支请求 ${pending.requestId} 尚未发布${found.error ? `：${found.error}` : ""}；重连或再次 /branch 按原键核实`, true);
    } catch { /* 断线查询不能证明未创建，继续保留原请求键。 */ }
  }

  /** 原键与命令关联保留到终态；切换会话和退出不取消后台摘要。
   * Note: 见 .agents/notes/implemented/feature/2026-10-11-manual-context-compaction.md
   */
  private async cmdCompact(prompt: string, result: CommandResult, commandKey: string | null, line: string): Promise<void> {
    const sessionId = this.state.currentSessionId;
    if (!sessionId) { result("尚未选择普通开发会话", true); this.editor.setText(line); return; }
    if (this.pendingCompactions.has(sessionId)) {
      result("此前压缩请求仍在进行或待核实，正在按原请求键查询", true);
      this.restoreCompactionDraft(sessionId, line);
      await this.reconcileCompaction(sessionId, true);
      return;
    }
    if (this.connection.state !== "online" || !this.state.instanceId) {
      result("当前离线：压缩命令已保留，恢复在线后请重新提交", true);
      this.restoreCompactionDraft(sessionId, line);
      return;
    }
    const instanceId = this.state.instanceId;
    try { await this.sessionSettingsSync; }
    catch {
      result("会话设置尚未核实，请刷新设置后再压缩", true);
      this.restoreCompactionDraft(sessionId, line);
      return;
    }
    if (this.pendingCompactions.has(sessionId)) {
      result("此前压缩请求仍在进行或待核实，请先等待原请求", true);
      this.restoreCompactionDraft(sessionId, line);
      return;
    }
    if (instanceId !== this.state.instanceId || this.connection.state !== "online") {
      result("后台连接或数据实例已改变，压缩命令已保留；核实后台后请重新提交", true);
      this.restoreCompactionDraft(sessionId, line);
      return;
    }
    const pending: PendingCompaction = { sessionId, requestId: randomUUID(), instanceId,
      ...(prompt ? { prompt } : {}), commandKey, line, result, inFlight: false };
    try {
      this.compactionPendingStore.save({ requestId: pending.requestId, op: "compact_session", instanceId: pending.instanceId,
        params: { session_id: sessionId, prompt: pending.prompt, command_key: pending.commandKey, line: pending.line }, createdAt: new Date().toISOString() });
    } catch {
      result("无法保存压缩请求键，未发送请求；请核实客户端存储", true);
      this.restoreCompactionDraft(sessionId, pending.line);
      return;
    }
    this.pendingCompactions.set(sessionId, pending);
    this.tickCompactions();
    await this.sendCompaction(pending);
  }

  private restoreCompactionDraft(sessionId: string, line: string): void {
    const view = this.state.openSession(sessionId);
    const draft = this.state.currentSessionId === sessionId ? this.editor.getExpandedText() : view.draft;
    view.draft = draft && draft !== line ? `${draft}\n${line}` : line;
    if (this.state.currentSessionId === sessionId) this.editor.setText(view.draft);
  }

  private tickCompactions(): void {
    if (this.pendingCompactions.size && !this.compactionTimer) {
      this.compactionTimer = setInterval(() => {
        for (const pending of this.pendingCompactions.values()) {
          if (pending.instanceId === this.state.instanceId) void this.reconcileCompaction(pending.sessionId);
        }
      }, 2000);
      this.compactionTimer.unref();
    } else if (!this.pendingCompactions.size && this.compactionTimer) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = null;
    }
  }

  private showCompaction(request: SessionCompactionRequest): void {
    const prior = this.compactionResults.get(request.requestId);
    if (prior && prior.status !== "running" && request.status === "running") return;
    this.compactionResults.set(request.requestId, request);
    const pending = this.pendingCompactions.get(request.sessionId);
    const text = manualCompactionText(request);
    const isError = request.status === "failed" || request.status === "interrupted";
    const saved = pending?.commandKey ? null : this.compactionPendingStore.list().records.find(record =>
      record.op === "compact_session" && record.requestId === request.requestId && record.instanceId === this.state.instanceId && record.params.session_id === request.sessionId);
    const commandKey = typeof saved?.params.command_key === "string" ? saved.params.command_key : null;
    if (pending?.requestId === request.requestId) {
      if (commandKey) this.state.setCommandResult(request.sessionId, commandKey, text, isError);
      else pending.result(text, isError);
      if (request.status !== "running") {
        this.compactionPendingStore.clear(request.requestId);
        this.pendingCompactions.delete(request.sessionId);
      }
    } else {
      const view = this.state.openSession(request.sessionId);
      if (commandKey) this.state.setCommandResult(request.sessionId, commandKey, text, isError);
      else view.flow.note(`compaction:${request.requestId}`, text, request.createdAt);
      if (saved && request.status !== "running") this.compactionPendingStore.clear(request.requestId);
      if (request.status === "running" && !pending) {
        this.pendingCompactions.set(request.sessionId, { sessionId: request.sessionId, requestId: request.requestId,
          instanceId: this.state.instanceId!, prompt: request.prompt ?? undefined, commandKey, line: "/compact", inFlight: false,
          result: (value, error) => commandKey ? this.state.setCommandResult(request.sessionId, commandKey, value, error) :
            this.state.openSession(request.sessionId).flow.note(`compaction:${request.requestId}`, value, request.createdAt) });
      }
    }
    this.tickCompactions();
    this.refreshAll();
  }

  private async sendCompaction(pending: PendingCompaction, verify = true): Promise<void> {
    if (pending.inFlight || this.pendingCompactions.get(pending.sessionId) !== pending) return;
    if (pending.instanceId !== this.state.instanceId) {
      pending.result(`后台数据实例已改变，原压缩请求 ${pending.requestId} 需在原实例核实；保留原键，未重发`, true);
      return;
    }
    pending.inFlight = true;
    let unknown = false;
    try {
      const request = await this.connection.request("compact_session", { session_id: pending.sessionId, request_id: pending.requestId, prompt: pending.prompt });
      if (this.pendingCompactions.get(pending.sessionId) === pending) this.showCompaction(request);
    } catch (error) {
      if (this.pendingCompactions.get(pending.sessionId) !== pending) return;
      pending.result(writeFailure("手动压缩", error, `/compact（请求 ${pending.requestId}，按原键核实）`), true);
      const outcome = requestOutcome(error);
      if (outcome === "rejected" || outcome === "not_sent") {
        this.compactionPendingStore.clear(pending.requestId);
        this.pendingCompactions.delete(pending.sessionId);
        this.restoreCompactionDraft(pending.sessionId, pending.line);
      } else unknown = true;
    } finally {
      pending.inFlight = false;
      this.tickCompactions();
      this.refreshAll();
    }
    if (unknown && verify) await this.reconcileCompaction(pending.sessionId, true);
  }

  private async reconcileCompaction(sessionId: string, retry = false): Promise<void> {
    if (this.connection.state !== "online" || this.compactionQueries.has(sessionId)) return;
    const pending = this.pendingCompactions.get(sessionId);
    if (pending?.instanceId !== undefined && pending.instanceId !== this.state.instanceId) {
      pending.result(`后台数据实例已改变，原压缩请求 ${pending.requestId} 需在原实例核实；保留原键，未重发`, true);
      return;
    }
    this.compactionQueries.add(sessionId);
    try {
      const request = await this.connection.request("get_session_compaction", { session_id: sessionId, request_id: pending?.requestId });
      if (pending && this.pendingCompactions.get(sessionId) !== pending) return;
      if (request) this.showCompaction(request);
      else if (pending && retry && !pending.inFlight) await this.sendCompaction(pending, false);
    } catch {
      // 查询失败不能证明未接收，原键继续保留；重连或轮询再核实。
    } finally { this.compactionQueries.delete(sessionId); }
  }

  private async refreshSessionTodos(sessionId: string): Promise<void> {
    if (!this.state.sessions.find(session => session.id === sessionId)?.branchSource) return;
    const generation = this.generation;
    try {
      const result = await this.connection.request("get_session_todos", { session_id: sessionId });
      if (generation !== this.generation) return;
      this.sessionTodos.set(sessionId, result.todos);
      this.refreshAll();
    } catch { /* 历史尚不可读时保留已加载清单，重连或下一次历史更新再核实。 */ }
  }

  private async createAndSwitch(projectId: string, cwd: string): Promise<void> {
    // ruukoto-code（agent-direction issue 23）：旧项目（无根目录）不再新建会话，新会话走工作区
    if (this.devProductPicker() && !this.state.projects.find((p) => p.id === projectId)?.rootDir) {
      this.notify(LEGACY_PROJECT_WRITE_HINT);
      return;
    }
    try {
      const session = await this.connection.request("create_session", { project_id: projectId, cwd });
      this.switchSession(session.id);
    } catch (err) {
      this.notify(red(writeFailure("创建会话", err, "/project")));
    }
  }

  private async cmdInterrupt(arg: string): Promise<void> {
    const view = this.currentView();
    const task = arg ? this.state.getTask(this.resolveTaskId(arg) ?? "") : view ? this.state.activeTaskFor(view.sessionId) : null;
    if (!arg && view && (!task || this.pendingCompactions.has(view.sessionId))) {
      try {
        const request = await this.connection.request("get_session_compaction", { session_id: view.sessionId });
        if (request?.status === "running") {
          const result = await this.connection.request("interrupt_session_compaction", { session_id: view.sessionId, request_id: request.requestId });
          this.showCompaction(result);
          return;
        }
      } catch (error) {
        if (this.pendingCompactions.has(view.sessionId)) {
          this.state.note(view.sessionId, writeFailure("中断手动压缩", error, "/compact"));
          this.refreshAll();
          return;
        }
        // 无已知压缩时继续按既有任务入口处理；查询失败不构成取消成功。
      }
    }
    if (!task) {
      this.notify("没有运行中的任务（/interrupt [taskId]）");
      return;
    }
    try {
      await this.connection.request("interrupt", { task_id: task.id });
    } catch (err) {
      this.notify(red(writeFailure("中断", err, "/status")));
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
    } catch (err) {
      this.notify(red(writeFailure("取消", err, "/status")));
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
      this.refreshAll();
      this.scheduleReloadPersist();
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
    this.scheduleReloadPersist();
    if (task.effectUnknown) {
      this.notify(yellow(`继续任务 ${task.id}：存在效果未知的工具操作，不能当作可安全重试；请先核实原任务的实际结果。`));
    }
    this.refreshAll();
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
        if (!selection) {
          this.notify("请先通过 /model 选择模型");
          return;
        }
        this.showSelection(`为 ${legacy.length} 个旧排队任务补配置：${this.selectionText(selection)}`, [{ value: "yes", label: "确认补齐并恢复队列" }], () => {
          void this.connection.request("resume_queue", { session_id: view.sessionId, model_selection: selection })
            .then(() => this.refreshAll())
            .catch((err) => { this.state.note(view.sessionId, writeFailure("恢复队列", err, "/status")); this.refreshAll(); });
        });
        return;
      }
      await this.connection.request("resume_queue", { session_id: view.sessionId });
    } catch (err) {
      this.notify(red(writeFailure("恢复队列", err, "/status")));
    }
  }

  private toggleTodo(): void {
    if (this.todoOverlay) {
      this.todoOverlay.hide();
      this.todoOverlay = null;
      return;
    }
    const body = new VStack([
      { component: this.todoPanel, grow: 0 },
    ]);
    const frame = new WindowFrame(body);
    const popup: Component = {
      render: (width) => {
        frame.setHeight(Math.max(5, Math.floor(this.terminal.rows * 0.6)));
        return frame.render(width);
      },
      invalidate: () => frame.invalidate(),
      handleMouse: (event) => {
        if (event.type !== "wheel") return;
        frame.scrollBy(event.wheelDelta ?? 0);
        return { handled: true };
      },
    };
    this.todoOverlay = this.tui.showOverlay(popup, {
      anchor: "top-left", width: "35%", minWidth: 24, maxHeight: "60%", margin: 1,
      nonCapturing: true, visible: () => this.windows.length === 0 && (this.terminal.columns >= 120 || !this.workflowSidebar.focused),
    });
  }

  private sessionModes(session: Session): readonly SessionDefaultMode[] {
    return SESSION_DEFAULT_MODES.filter((mode) => mode !== "plan" || (session.kind === "dev" && !this.state.excludedPickerSessionIds().has(session.id)));
  }

  private async cycleMode(sessionId: string | null): Promise<void> {
    await this.sessionSettingsSync.catch(() => {});
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session) {
      this.notify("尚未选择会话");
      return;
    }
    const modes = this.sessionModes(session);
    const index = modes.indexOf(session.defaultAccessMode);
    const mode = modes[(index + 1) % modes.length]!;
    await this.sendSessionMode(session.id, session.defaultAccessModeVersion, mode, (text, isError) => {
      if (isError) this.state.note(session.id, red(text));
    });
  }

  private async cmdMode(rest: string[], result: CommandResult): Promise<void> {
    await this.sessionSettingsSync.catch(() => {});
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
    const items: SelectItem[] = this.sessionModes(session).map((mode) => ({
      value: mode,
      label: `${accessModeLabel(mode)}`,
      description:
        mode === "confirm"
          ? "编辑外部文件和访问网络时始终询问"
          : mode === "auto-review"
            ? "自动审查操作"
            : mode === "plan"
              ? "持续调研和完善计划，固定自动审查；执行前手动切换模式"
              : "完全访问",
    }));
    this.showBareList(`会话默认模式`, items, (item) => {
      void this.sendSessionMode(sessionId, version, item.value as SessionDefaultMode, result);
    });
  }

  private async sendSessionMode(sessionId: string, version: number, mode: SessionDefaultMode, result: CommandResult): Promise<void> {
    const label = accessModeLabel(mode);
    try {
      const saved = await this.connection.request("set_session_mode", { session_id: sessionId, mode, expected_version: version });
      this.state.applySessionDefaultMode(sessionId, saved.defaultAccessMode, saved.defaultAccessModeVersion);
      result(`Switched to ${label}`);
    } catch (err) {
      const outcome = requestOutcome(err);
      const code = (err as { code?: string }).code;
      if (outcome === "not_sent") {
        result(`默认模式设置未发送：${(err as Error).message}`, true);
      } else if (outcome === "disconnected") {
        // 断线：此刻查询必然失败；重连快照带回后台实际值
        result("设置结果未知：连接已断开，重连后按后台状态显示（未自动重发）", true);
      } else if (outcome === "unknown") {
        // 应答丢失、连接仍在：先查询后台实际状态，不盲目重放
        result("设置应答丢失；正在查询后台状态（未自动重发）", true);
        try {
          const saved = await this.connection.request("get_session", { session_id: sessionId });
          this.state.applySessionDefaultMode(sessionId, saved.defaultAccessMode, saved.defaultAccessModeVersion);
        } catch {
          result("状态查询失败，重连后恢复", true);
        }
      } else if (code === "default_mode_conflict") {
        // 版本冲突：刷新后台真实值，不覆盖其他客户端的新选择
        result(`默认模式已被其他客户端修改：${(err as Error).message}`, true);
        try {
          const saved = await this.connection.request("get_session", { session_id: sessionId });
          this.state.applySessionDefaultMode(sessionId, saved.defaultAccessMode, saved.defaultAccessModeVersion);
        } catch { /* 重连后由快照恢复 */ }
      } else {
        result(`默认模式设置失败：${(err as Error).message}`, true);
      }
    }
    this.refreshAll();
  }

  // ---------- /context：上下文窗口预算分解（issue 14） ----------

  /** 最近一次模型调用的上下文窗口分解，显示在本条命令下。 */
  private async cmdContext(result: CommandResult): Promise<void> {
    const view = this.currentView();
    if (!view) {
      this.notify("尚未选择会话");
      return;
    }
    const sessionId = view.sessionId;
    const generation = this.generation;
    const stale = () => generation !== this.generation || this.state.currentSessionId !== sessionId;

    try {
      // 最近一次调用即当前窗口状态：只取一条，不做列表与分页
      const list = await this.connection.request("list_selection_records", {
        session_id: sessionId,
        limit: 1,
      });
      if (stale()) return;
      const recordId = list.records[0]?.id;
      if (!recordId) {
        result("暂无记录");
        this.refreshTranscript();
        return;
      }
      const breakdown = await this.connection.request(
        "get_context_breakdown",
        { session_id: sessionId, record_id: recordId },
      );
      if (stale()) return;
      const lines = contextBarLines(breakdown.record, breakdown.breakdown, Math.max(1, (this.terminal.columns || 80) - RIGHT_GUTTER), breakdown.checkpoint ?? null);
      result(lines.join("\n"));
      this.refreshTranscript();
    } catch (err) {
      if (stale()) return;
      result(`读取失败：${(err as Error).message}`, true);
      this.refreshTranscript();
    }
  }

  // ---------- /prompt：模型请求列表与 prompt 详情（issue 13） ----------

  /**
   * 打开当前会话的模型请求列表窗口。列表按时间从新到旧分页加载；
   * Enter 进入该次调用的 prompt 详情（解析为文本），Esc/q 返回列表并保留位置，
   * 再 Esc/q 关闭并恢复编辑器焦点。所有读取经拥有者认证通道；查看不触发
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

    const PAGE = 30;
    let closed = false;
    let records: SelectionRecord[] = [];
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
    };

    const rowLabel = (r: SelectionRecord): SelectItem => ({
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
        handle = this.showWindow(box, { width: "85%", anchor: "center", maxHeight: "70%" });
      } else {
        // SelectList 不支持动态增项：换实例后替换栈中子组件
        box.removeChild(oldList!);
        box.addChild(list, { grow: 1 });
      }
      box.forwardTo = list;
      title.setText(bold(`模型请求（${records.length} 条${hasMore ? "，还有更多" : ""}）`));
      hint.setText(dim("Enter 查看 prompt 详情 · Esc/q 关闭"));
      this.tui.requestRender();
    };

    const loadPage = async () => {
      if (loadingMore) return;
      loadingMore = true;
      try {
        const last = records[records.length - 1];
        const page = await this.connection.request(
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
      this.showText("暂无记录");
    }
  }

  /**
   * 单次调用的 prompt 详情：完整读取快照后解析为文本，长正文在窗口内滚动。
   * 快照在发送前捕获；usage 为空表示发送结果未回填。
   * Esc/q 返回列表，保留列表的位置。
   */
  private async openPromptDetail(
    sessionId: string,
    record: { id: string; taskId: string; callIndex: number; model: string; usage: { input: number; output: number } | null; promptArtifactId: string | null; createdAt: string },
    generation: number,
    isStale: () => boolean,
  ): Promise<void> {
    const headerLines = [
      `任务 ${record.taskId} · 第 ${record.callIndex} 次调用 · ${record.model}`,
      `模型发送前捕获的系统提示、消息与工具定义`,
      record.usage
        ? `发送结果：usage 已回填（输入 ${record.usage.input} · 输出 ${record.usage.output}）`
        : yellow("发送结果未回填：请求失败、被中断或结果未知；以下为发送前捕获的输入"),
    ];
    if (!record.promptArtifactId) {
      this.showText(`该次 prompt 正文未记录（记录创建于快照捕获上线之前）；任务 ${record.taskId.slice(0, 12)} 第 ${record.callIndex} 次调用`);
      return;
    }
    let closed = false;
    const stale = () => closed || isStale() || generation !== this.generation;
    const header = `${bold("Prompt 详情")}\n${headerLines.join("\n")}\n\n`;
    const content = new Text(`${header}加载中…`, 0, 0);
    const frame = new WindowFrame(content);
    const handle = this.showWindow(frame, { width: "90%", anchor: "center", maxHeight: "85%" });
    frame.onKey = (data) => {
      if (data === "\x1b") {
        closed = true;
        handle.hide();
      } else if ((["up", "down", "pageUp", "pageDown"] as const).some((key) => matchesKey(data, key))) {
        const step = matchesKey(data, "pageUp") || matchesKey(data, "pageDown") ? 5 : 1;
        frame.scrollBy(matchesKey(data, "up") || matchesKey(data, "pageUp") ? -step : step);
        this.tui.requestRender();
      }
    };
    try {
      const chunks: Buffer[] = [];
      let offset = 0;
      let total = 0;
      do {
        if (stale()) return;
        const result = await this.connection.request("read_prompt_snapshot", { record_id: record.id, session_id: sessionId, offset, length: ENTRY_PAGE_BYTES });
        if (stale()) return;
        const chunk = Buffer.from(result.data, "base64");
        total = result.artifact.byteCount;
        if (!chunk.length && offset < total) throw new Error("Prompt 快照读取不完整");
        chunks.push(chunk);
        offset += chunk.length;
      } while (offset < total);
      content.setText(`${header}${sanitizeForDisplay(formatPromptSnapshot(Buffer.concat(chunks).toString("utf8")))}\n\n${dim("↑↓ / PageUp·PageDown 滚动 · Esc/q 返回列表")}`);
    } catch (err) {
      if (stale()) return;
      content.setText(`${header}${red(`读取失败：${(err as Error).message}`)}`);
    }
    this.tui.requestRender();
  }

  private resolveTaskId(prefix: string): string | null {
    if (!prefix) return null;
    const matches = [...this.state.tasks.keys()].filter((id) => id === prefix || id.startsWith(prefix));
    return matches.length === 1 ? matches[0]! : null;
  }

  // ---------- 展开查看 ----------

  private clearToolExpansions(): void {
    for (const key of this.expandedTools.keys()) this.eventFlowView.setToolExpansion(key, null);
    this.expandedTools.clear();
  }

  private async toggleToolExpansion(tool: Extract<FlowEntry, { kind: "tool" }>): Promise<void> {
    if (tool.status === "running") return;
    if (this.expandedTools.has(tool.key)) {
      this.expandedTools.delete(tool.key);
      this.eventFlowView.setToolExpansion(tool.key, null);
      this.tui.requestRender();
      return;
    }
    const sessionId = this.state.currentSessionId;
    if (!sessionId) return;
    const generation = this.generation;
    const load = {};
    this.expandedTools.set(tool.key, load);
    this.eventFlowView.setToolExpansion(tool.key, { text: "", loading: true });
    this.tui.requestRender();
    try {
      const result = tool.entryId
        ? await this.connection.request("read_tool_result", { session_id: sessionId, entry_id: tool.entryId, length: 16 * 1024 })
        : { text: tool.summary ?? "结果尚未落盘，请稍后重新展开", patch: null, writeContent: null, truncated: tool.paramsTruncated };
      if (generation !== this.generation || this.expandedTools.get(tool.key) !== load) return;
      let text = result.text;
      let diff = false;
      let totalLines: number | undefined;
      if (tool.status === "done" && tool.name.toLowerCase() === "write") {
        const content = result.writeContent ?? (typeof tool.params.content === "string" ? tool.params.content : null);
        if (content !== null) {
          text = content;
          totalLines = "writeTotalLines" in result ? result.writeTotalLines : undefined;
        }
      } else if (tool.status === "done" && tool.name.toLowerCase() === "edit" && result.patch !== null) {
        text = result.patch;
        diff = true;
      }
      this.eventFlowView.setToolExpansion(tool.key, { text, diff, totalLines, lang: getLanguageFromPath(tool.target) });
    } catch (err) {
      if (generation !== this.generation || this.expandedTools.get(tool.key) !== load) return;
      this.eventFlowView.setToolExpansion(tool.key, { text: `读取结果失败：${(err as Error).message}`, error: true });
    }
    this.tui.requestRender();
  }

  /** 产物正文查看：按字节分页；partial/complete 标识；二进制不直接输出。 */
  private async cmdArtifact(arg: string): Promise<void> {
    if (!arg) {
      this.notify("用法：/artifact <产物 id 前缀>");
      return;
    }
    const session = this.state.sessions.find(s => s.id === this.state.currentSessionId);
    const candidates = new Map([...this.state.artifacts.values(), ...(session?.branchSource?.artifacts ?? [])].map(a => [a.id, a]));
    const matches = [...candidates.values()].filter((a) => a.id.startsWith(arg));
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
        const result = await this.connection.request("read_artifact", { task_id: artifact.taskId, artifact_id: artifact.id, session_id: session?.branchSource?.artifacts.some(a => a.id === artifact.id) ? session.id : undefined, offset, length });
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

  /** 通用分页正文查看器：n/空格 下一页，p 上一页，Esc/q 关闭（关闭不等于任何确认）。 */
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
    let closed = false;
    const children: Array<{ component: Component; grow?: number }> = [];
    if (opts.header) children.push({ component: new Text(opts.header, 1, 0), grow: 0 });
    const content = new Text("加载中…", 1, 0);
    const footerText = new Text("", 1, 0);
    children.push({ component: content, grow: 1 }, { component: footerText, grow: 0 });
    const box = new OverlayBox(children);
    const handle = this.showWindow(box, { width: "90%", anchor: "center", maxHeight: "80%" });
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
        footerText.setText(dim(`${opts.title} · 偏移 ${slice.offset}/${slice.totalBytes} 字节 · n 下一页 · p 上一页 · Esc/q 关闭`));
        this.tui.requestRender();
      } catch (err) {
        content.setText(red(`读取失败：${(err as Error).message}`));
        this.tui.requestRender();
      }
    };
    box.onKey = (data: string) => {
      if (data === "\x1b" || data === "q") {
        closed = true;
        handle.hide();
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
      this.showText("没有待处理的审批");
      return;
    }
    const items: SelectItem[] = pending.map((c) => ({
      value: c.id,
      label: `${c.reviewStatus === "in_progress" ? "审查中 · " : ""}${c.toolName} · 任务 ${c.taskId.slice(0, 12)}…`,
      description: `会话 ${c.sessionId.slice(0, 12)}… · ${this.scopeSummary(c)}`,
    }));
    const list = new SelectList(items, Math.min(items.length, 10), selectTheme);
    const box = new OverlayBox([
      { component: new Text(bold("待处理审批（打开详情后才有批准/拒绝操作）"), 1, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    box.forwardTo = list;
    const handle = this.showWindow(box, { width: "80%", anchor: "center", maxHeight: "60%" });
    list.onSelect = (item) => {
      handle.hide();
      const confirmation = this.state.pendingApprovals().find((c) => c.id === item.value);
      if (confirmation) void this.openApprovalDetail(confirmation);
    };
    list.onCancel = () => {
      handle.hide();
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
      case "mcp_tool":
        return `MCP ${c.scope.operationCategory === "write" ? "写" : "副作用不明"}工具：${c.scope.serviceName}/${c.scope.remoteName}（配置 v${c.scope.configVersion}）`;
      case "browser_operation":
        return `浏览器：${c.scope.action}（会话 ${c.scope.sessionId} · 代次 ${c.scope.generation ?? "未启动"}）`;
      case "app_data_change": {
        const label: Record<string, string> = {
          drop_table: "删除表",
          drop_field: "删除字段",
          drop_unique_index: "删除唯一索引",
          multi_row_write: "多行写入",
          rewrite_rows: "批量重写",
        };
        return `应用数据${label[c.scope.change] ?? c.scope.change}：表 ${c.scope.table ?? "（多表）"} · schema v${c.scope.schemaVersion}/rev ${c.scope.revision} · 影响 ${c.scope.affected}`;
      }
      case "notification":
        return `通知外发（单次）：${c.scope.target.channel}/${c.scope.target.chatId}（配置 v${c.scope.target.configVersion}） · 正文 ${c.scope.textChars} 字符`;
      case "service_operation":
        return `服务器服务管理（root 提权）：${c.scope.action} ${c.scope.unit}（策略 ${c.scope.policyRevision.slice(0, 12)}… · 单元定义 ${c.scope.unitRevision.slice(0, 12)}…）`;
      // issue 17：github_publish 范围已退役，仅为历史审批记录的只读展示保留
      case "github_publish":
        return `GitHub 发布（已退役模块的历史记录）：${c.scope.owner}/${c.scope.repo} ${c.scope.publishKind === "pr_review_comment" ? `PR #${c.scope.target["prNumber"]} 评审评论` : `issue #${c.scope.target["issueNumber"]} 评论`}（草稿 ${c.scope.draftId} v${c.scope.draftVersion}，${c.scope.bodyBytes} 字节）`;
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
      if (c.scope.kind === "mcp_tool") {
        lines.push(`目标服务：${sanitizeForDisplay(c.scope.cua?.kind ?? c.scope.endpoint ?? "")} · 工具定义 ${c.scope.toolSignature}`);
        lines.push(`凭据：${c.scope.credential ?? "无"}（值不展示）`);
        lines.push(`参数摘要：sha256 ${c.scope.paramsSha256.slice(0, 16)}…（完整参数见下方，执行以批准的参数为准）`);
      }
      if (c.scope.kind === "file_operation" && c.scope.contentBytes !== null) {
        lines.push(`待写内容：${c.scope.contentBytes} 字节（sha256 ${c.scope.contentSha256?.slice(0, 16)}…）`);
      }
      if (c.scope.kind === "app_data_change") {
        // issue 02：范围、数量、版本与理由；完整参数经分页详情读取
        lines.push(`应用库：${c.scope.appDbInstanceId.slice(0, 18)}… · 操作 ${c.scope.operation} · 参数 sha256 ${c.scope.paramsSha256.slice(0, 16)}…`);
        if (c.scope.rowIds.length > 0) {
          lines.push(`固定行：${c.scope.rowIds.slice(0, 20).join(", ")}${c.scope.rowIds.length > 20 ? ` … 共 ${c.scope.rowIds.length} 行` : ""}（行版本见参数）`);
        }
        if (c.scope.definitionBefore || c.scope.definitionAfter) {
          lines.push(`定义变更：${c.scope.definitionBefore ? "含旧定义" : "无旧定义"} → ${c.scope.definitionAfter ? "含新定义" : "删除"}`);
        }
      }
      if (c.scope.kind === "service_operation") {
        // issue 09：准确目标、提权身份、动作影响与修订指纹；请求时状态见下方参数
        lines.push("提权身份：root（经后台固定 helper 与 sudoers；OS 权限仍须配置）");
        lines.push("影响：restart 会启动原本不活动的服务，并中断该服务正在处理的工作；执行中断或超时后效果可能无法确认，效果未知不自动重发。");
        lines.push(`本机：${c.scope.machineId.slice(0, 12)}… · 操作 ${c.scope.toolOpId}`);
      }
      if (c.scope.kind === "notification") {
        // 一次通知的固定目标与正文来源；正文见下方参数 text
        lines.push(`目标：${sanitizeForDisplay(`${c.scope.target.channel} 账号 ${c.scope.target.account} 会话 ${c.scope.target.chatId}`)} · 正文 sha256 ${c.scope.textSha256.slice(0, 16)}…`);
        if (c.scope.sourceRefs.length > 0) lines.push(`来源：${sanitizeForDisplay(c.scope.sourceRefs.join(", "))}`);
      }
      // 自动审查信息（issue 15）：无审查字段的旧记录按历史人工审批展示，不加审查行
      if (c.reviewStatus !== null) {
        const policy = `策略 ${c.reviewPolicyVersion ?? "未知"}`;
        const model = `模型 ${c.reviewModel ?? "未知"}`;
        if (c.reviewStatus === "in_progress") {
          lines.push(`审查：自动审查中（${model}，${policy}）`);
        } else if (c.reviewStatus === "asked_owner") {
          lines.push(`审查：待拥有者确认（自动审查无法确认：${c.reviewReason ?? "未说明"}）`);
        } else {
          const conclusion =
            c.reviewStatus === "superseded"
              ? "已被人工决定/取消取代"
              : c.reviewDecision === "approve"
                ? "自动批准"
                : c.reviewDecision === "reject"
                  ? "自动拒绝"
                  : "转人工";
          lines.push(`审查：${conclusion}${c.reviewReason ? `（${c.reviewReason}）` : ""} · ${model} · ${policy}`);
        }
      }
      if (c.decisionSource !== null) {
        lines.push(
          `决定来源：${
            c.decisionSource === "auto_review"
              ? "自动审查"
              : c.decisionSource === "standing_permission"
                ? `长期授权 ${c.standingPermissionId ?? "（未知）"} v${c.standingPermissionVersion ?? "?"}（本次使用该授权）`
                : "拥有者"
          }`,
        );
      }
      header.setText(lines.join("\n"));
    };
    renderHeader(c.permissionVersion, c.status);
    const paramsText = new Text("参数加载中…", 1, 0);
    const footerText = new Text(dim("a 批准 · r 拒绝 · n/p 参数翻页 · Esc/q 关闭（关闭不等于拒绝）"), 1, 0);
    const box = new OverlayBox([
      { component: header, grow: 0 },
      { component: paramsText, grow: 1 },
      { component: footerText, grow: 0 },
    ]);
    const handle = this.showWindow(box, { width: "90%", anchor: "center", maxHeight: "85%" });

    let offset = 0;
    let total = c.paramsTruncated ? c.paramsBytes : 0;
    let nextOffset = 0;
    // 详情展示以服务端最新记录为准（权限版本可能已变化）
    let currentVersion = c.permissionVersion;
    const loadParams = async (off: number) => {
      try {
        const slice = await this.connection.request("get_confirmation_params", { confirmation_id: c.id, offset: off, length: ENTRY_PAGE_BYTES });
        if (generation !== this.generation) return;
        offset = slice.params.offset;
        total = slice.params.totalBytes;
        // 前进按实际消费字节数（UTF-8 边界对齐），跨页字符不丢
        nextOffset = slice.params.offset + Buffer.byteLength(slice.params.text, "utf8");
        currentVersion = slice.confirmation.permissionVersion;
        renderHeader(currentVersion, slice.confirmation.status);
        if (slice.confirmation.status !== "pending") {
          footerText.setText(yellow(`该审批当前状态：${slice.confirmation.status}（已不可批准/拒绝） · Esc/q 关闭`));
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
        return;
      } catch (err) {
        const outcome = requestOutcome(err);
        const code = (err as { code?: string }).code;
        if (outcome === "rejected" && (code === "stale_confirmation" || code === "not_found")) {
          footerText.setText(yellow("审批已失效、已被其他客户端处理或任务已结束；请关闭后刷新"));
        } else if (outcome === "not_sent") {
          footerText.setText(red(`应答未发送：${(err as Error).message}`));
        } else if (outcome === "disconnected") {
          // 断线：此刻查询必然失败；重连快照带回待处理审批
          footerText.setText(yellow("应答结果未知：连接已断开；重连后以 /approvals 列表为准（不自动重放）"));
        } else if (outcome === "unknown") {
          // 应答丢失、连接仍在：先查询实际状态，不盲目重放
          footerText.setText(yellow("应答结果未知：正在查询实际状态…"));
          try {
            const detail = await this.connection.request("get_task", { task_id: c.taskId });
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

  private selectionText(selection: ModelSelection | null | undefined): string {
    return selection ? sanitizeForDisplay(`${selection.provider}/${selection.modelId} · ${selection.thinkingLevel}`) : "模型配置未记录";
  }

  /** 窗口显示时隐藏主界面，只保留最上层窗口。 */
  private showWindow(component: Component, options: OverlayOptions): OverlayHandle {
    const previous = this.windows.at(-1);
    previous?.setHidden(true);
    if (!previous) {
      this.autocompleteOverlay?.hide();
      this.autocompleteOverlay = null;
      this.editor.overlayLines = [];
    }
    const frame = component instanceof WindowFrame ? component : new WindowFrame(component);
    const rows = this.terminal.rows || 24;
    const height = typeof options.maxHeight === "string"
      ? Math.floor(rows * parseFloat(options.maxHeight) / 100)
      : options.maxHeight ?? rows;
    frame.setHeight(height);
    const base = this.tui.showOverlay(frame, options);
    let closed = false;
    const handle: OverlayHandle = { ...base, hide: () => {
      if (closed) return;
      closed = true;
      const index = this.windows.indexOf(handle);
      const wasTop = index === this.windows.length - 1;
      if (index >= 0) this.windows.splice(index, 1);
      base.hide();
      if (wasTop) this.windows.at(-1)?.setHidden(false);
      this.tui.requestRender();
    } };
    this.windows.push(handle);
    this.tui.requestRender();
    return handle;
  }

  /**
   * 打开窗口：内容包进圆角边框，居中显示，Esc/q 关闭后恢复焦点。
   *
   * 高度按内容算（含边框两行），并夹在终端行数的上限内；宽度按比例取。
   * 返回 handle 供调用方在选中后主动关闭。
   */
  private openWindow(opts: WindowOptions): OverlayHandle {
    const termWidth = this.terminal.columns || 80;
    const termRows = this.terminal.rows || 24;
    const width = Math.max(12, Math.floor(termWidth * opts.widthRatio));
    const frame = new WindowFrame(opts.content);
    const maxHeight = Math.max(3, Math.floor(termRows * (opts.maxHeightRatio ?? 0.85)));
    const height = Math.min(frame.heightFor(width), maxHeight);
    // 内容超出给定高度时开窗滚动：上下边框始终保留，不被裁掉
    frame.setHeight(height);

    const handle = this.showWindow(frame, { width, anchor: "center", maxHeight: height });

    const close = () => {
      handle.hide();
      opts.onClose?.();
    };
    // 按键先经这里：Esc/q 关闭，无转发目标时方向键滚动内容，
    // 其余一律交给内容组件（列表的 Enter/Tab/方向键不能在这里被吞掉）。
    frame.onKey = (data: string) => {
      if (data === "\x1b" || data === "q") {
        close();
        return;
      }
      // 内容超高时滚动；带 forwardTo 的面板由内容自己处理方向键
      if (frame && !opts.forwardTo && (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
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

  /**
   * 打开贴在输入框上沿的裸覆盖层（与 `/` 候选命令列表同款容器）：
   * 无边框、占满宽度、随输入框高度浮动。覆盖层拿焦点，按键交给 onKey。
   */
  private openAboveInput(content: Component, onKey: (data: string) => void, onClose: () => void): OverlayHandle {
    const box = new OverlayBox([{ component: content, grow: 1 }]);
    const handle = this.tui.showOverlay(box, {
      width: "100%",
      anchor: "bottom-left",
      offsetY: -(this.editor.lastHeight + this.footer.lastHeight),
      margin: 0,
    });
    const close = () => {
      handle.hide();
      onClose();
    };
    box.onKey = (data: string) => {
      if (data === "\x1b" || data === "q") {
        close();
        return;
      }
      onKey(data);
    };
    return { ...handle, hide: close };
  }

  /**
   * 裸列表选择（与 `/` 候选命令列表同款容器）：无边框、占满宽度、
   * 贴在输入框上沿。覆盖层拿焦点，按键经 box.onKey 转给列表。
   */
  private showBareList(title: string, items: SelectItem[], select: (item: SelectItem) => void): void {
    const bare = new BareList(title, items);
    const list = bare.inputTarget;
    const handle = this.openAboveInput(
      bare,
      (data) => {
        list.handleInput(data);
        this.tui.requestRender();
      },
      () => {},
    );
    bare.onSelect = (item) => { handle.hide(); select(item); };
    bare.onCancel = () => handle.hide();
  }

  private showSelection(title: string, items: SelectItem[], select: (item: SelectItem) => void): void {
    const list = new SelectList(items, Math.min(items.length, 10), selectTheme);
    const body = new VStack([
      { component: new Text(sanitizeForDisplay(title), 0, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    const handle = this.openWindow({ widthRatio: 0.85, content: body, forwardTo: list, maxHeightRatio: 0.7 });
    list.onCancel = () => handle.hide();
    list.onSelect = (item) => { handle.hide(); select(item); };
  }

  /** 普通命令结果留在可关闭、可滚动的面板中。 */
  private showText(text: string): void {
    this.openWindow({ widthRatio: 0.85, content: new Text(sanitizeForDisplay(text), 0, 0), maxHeightRatio: 0.85 });
  }

  /** /model：三列面板（提供方 / 模型 / 思考强度）。 */
  private async openModelPicker(result: CommandResult): Promise<void> {
    await this.sessionSettingsSync.catch(() => {});
    const session = this.state.sessions.find((s) => s.id === this.state.currentSessionId);
    if (!session) { this.notify("尚未选择会话"); return; }
    const sessionId = session.id;
    const version = session.modelSelectionVersion;
    const current = session.modelSelection;
    try {
      const models: ModelOption[] = [];
      let offset: number | null = 0;
      do {
        const page: OpResult<"list_models"> = await this.connection.request("list_models", { offset, limit: 100 });
        models.push(...page.models);
        offset = page.nextOffset;
      } while (offset !== null);
      if (this.state.currentSessionId !== sessionId) return;
      if (models.length === 0) { this.notify("后台未配置模型"); return; }

      // 按提供方分组，保留后台返回的顺序
      const providers: string[] = [];
      const byProvider = new Map<string, ModelOption[]>();
      for (const model of models) {
        if (!byProvider.has(model.provider)) { byProvider.set(model.provider, []); providers.push(model.provider); }
        byProvider.get(model.provider)!.push(model);
      }

      const close = () => handle.hide();
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
          }, result);
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

  private async saveModelSelection(sessionId: string, version: number, selection: ModelSelection, result: CommandResult): Promise<void> {
    this.refreshAll();
    try {
      const saved = await this.connection.request("set_session_model", { session_id: sessionId, expected_version: version, model_selection: selection });
      this.state.applySessionModel(sessionId, saved.modelSelection, saved.modelSelectionVersion);
      result(`Switched to ${this.selectionText(saved.modelSelection)}`);
    } catch (err) {
      const outcome = requestOutcome(err);
      const message = (err as Error).message;
      const conflict = (err as { code?: string }).code === "model_selection_conflict";
      if (outcome === "not_sent") {
        result(`模型设置未发送：${message}`, true);
      } else if (outcome === "disconnected") {
        // 断线：此刻查询必然失败；重连快照带回后台实际值
        result("模型设置结果未知：连接已断开，重连后按后台状态显示（未自动重发）", true);
      } else if (outcome === "unknown" || conflict) {
        // 应答丢失，或已被其他客户端修改：查询后台实际值，不盲目重放、不覆盖别人的选择
        result(conflict ? `模型已被其他客户端修改：${message}` : `模型设置未确认：${message}；正在查询后台状态`, true);
        try {
          const saved = await this.connection.request("get_session", { session_id: sessionId });
          this.state.applySessionModel(sessionId, saved.modelSelection, saved.modelSelectionVersion);
        } catch { result("状态查询失败，重连后恢复；未自动重发设置", true); }
      } else {
        result(`模型设置失败：${message}`, true);
      }
    }
    this.refreshAll();
  }

  // ---------- 会话选择 ----------

  /** ruukoto-code（issue 05）：普通列表只含 dev 且非逻辑角色的会话；ruukoto 不过滤。 */
  private devProductPicker(): boolean {
    return productFromEnv() === "ruukoto-code";
  }

  /**
   * 当前归属项目（issue 07 步骤 4）：ruukoto-code 按组织展示归属（已映射的旧
   * 会话归入目标工作区，选择状态不随会话的 projectId 回到源项目）；ruukoto
   * 产品与其他场景恒为会话的实际身份（原项目界面与旧 API 语义不变）。
   */
  private displayProjectIdOf(session: Session | null | undefined): string | null {
    if (!session) return null;
    if (this.devProductPicker()) return sessionDisplayAttribution(session, this.state.projects).projectId;
    return session.projectId;
  }

  private currentDisplayProjectId(): string | null {
    return this.displayProjectIdOf(this.state.sessions.find((s) => s.id === this.state.currentSessionId));
  }

  private isVisiblePickerSession(sessionId: string): boolean {
    if (!this.devProductPicker()) return true;
    const session = this.state.sessions.find((s) => s.id === sessionId);
    // issue 11：SubAgent 内部工作会话与逻辑角色会话一样不进入普通入口；未知会话如旧放行
    return !session || (session.kind === "dev" && !this.state.excludedPickerSessionIds().has(session.id));
  }

  private openProjectPicker(): void {
    // ruukoto-code（issue 05）：工作区（带根目录归属）在前、旧项目在后，角色与
    // 群聊项目不进入普通列表；ruukoto 沿用旧行为（主会话等原样列出）
    const devProduct = this.devProductPicker();
    const itemOf = (project: Project, tag: string | null) => {
      // issue 07 步骤 4：工作区计数按组织归属（已映射旧会话归入目标工作区）；ruukoto 用原身份
      const sessions = this.state.sessions.filter(
        (session) => this.displayProjectIdOf(session) === project.id && this.isVisiblePickerSession(session.id),
      );
      const prefix = tag ? `${tag} · ` : "";
      const cwdText = project.rootDir ? project.rootDir.cwd : [...new Set(sessions.map((session) => session.cwd))].join(" · ");
      return {
        value: project.id,
        label: `${prefix}${sanitizeForDisplay(project.name).replace(/\s+/g, " ")} · ${sessions.length} 个会话`,
        description: sanitizeForDisplay(cwdText || "尚无工作区").replace(/\n/g, "\\n").replace(/\t/g, "\\t"),
      };
    };
    const items = devProduct
      ? (() => {
          const { workspaces, legacy } = workspacePickerProjects({
            projects: this.state.projects,
            sessions: this.state.sessions,
            // SubAgent 内部工作会话并入排除集（issue 11）：只含内部会话的项目不进普通列表
            roleSessionIds: [...this.state.excludedPickerSessionIds()],
          });
          return [...workspaces.map((p) => itemOf(p, "工作区")), ...legacy.map((p) => itemOf(p, "旧项目"))];
        })()
      : this.state.projects.map((p) => itemOf(p, null));
    if (!items.length) {
      this.notify(devProduct ? "尚无工作区：ruukoto-code <目录> 打开目录创建工作区" : "尚无项目：/new-project <名称> 创建项目");
      return;
    }
    const list = new TwoLineSelectList(items, Math.min(items.length, Math.max(1, Math.floor(((this.terminal.rows || 24) * 0.7 - 3) / 3))), selectTheme);
    const body = new VStack([
      { component: new Text(bold(devProduct ? "选择工作区" : "选择项目"), 0, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    const handle = this.openWindow({ widthRatio: 0.85, content: body, forwardTo: list, maxHeightRatio: 0.7 });
    list.onCancel = () => handle.hide();
    list.onSelect = (item) => {
      handle.hide();
      if (this.state.sessions.some((session) => session.projectId === item.value && this.isVisiblePickerSession(session.id))) {
        void this.openSessionPicker(item.value);
        return;
      }
      const prev = this.currentView();
      const session = this.state.sessions.find((session) => session.id === prev?.sessionId);
      if (prev) {
        prev.draft = this.editor.getExpandedText();
        prev.scrollTop = this.scroll.isFollowingEnd ? null : this.scroll.scrollTop;
      }
      if (session && !this.carriedSettings) this.carriedSettings = { mode: session.defaultAccessMode, model: session.modelSelection ? { ...session.modelSelection } : null };
      this.selectedProjectId = item.value;
      this.state.currentSessionId = null;
      this.continueForTaskId = null;
      this.clearToolExpansions();
      this.editor.setText("");
      this.notify(`已切换到项目 ${this.state.projectName(item.value)}；暂无会话，用 /new-session <工作目录> 创建`);
    };
  }

  private async openSessionPicker(projectId = this.currentDisplayProjectId() ?? this.selectedProjectId): Promise<void> {
    if (!projectId) {
      this.notify("尚未选择项目：/project 选择项目");
      return;
    }
    const generation = this.generation;
    let summaries: OpResult<"list_session_summaries">;
    try {
      // issue 07 步骤 4：工作区会话列表按组织归属查询（workspace_id 与 project_id 互斥）；
      // 旧项目与 ruukoto 产品沿用 project_id 原身份查询
      const project = this.state.projects.find((p) => p.id === projectId);
      summaries = await this.connection.request(
        "list_session_summaries",
        this.devProductPicker() && project?.rootDir ? { workspace_id: projectId } : { project_id: projectId },
      );
    } catch (err) {
      this.notify(`会话列表读取失败：${(err as Error).message}`);
      return;
    }
    if (generation !== this.generation) return;
    // ruukoto-code（issue 05）：会话列表同样不混入角色与群聊会话
    const items = summaries.filter((session) => this.isVisiblePickerSession(session.sessionId)).map((session) => ({
      value: session.sessionId,
      label: sanitizeForDisplay(session.name ?? `未命名会话 · ${session.sessionId.slice(0, 14)}…`).replace(/\s+/g, " ").trim(),
      description: () => activityAgo(session.lastActiveAt),
    }));
    if (items.length === 0) {
      this.notify("当前项目尚无会话：/new-session <工作目录> 创建会话");
      return;
    }
    if (this.devProductPicker() && this.state.currentSessionId && items.some(item => item.value === this.state.currentSessionId)) items.push({ value: "$background", label: "本会话后台与日志", description: () => "查看当前会话后台，或选择结束本会话后台" });
    const list = new TwoLineSelectList(items, Math.min(items.length, Math.max(1, Math.floor(((this.terminal.rows || 24) * 0.7 - 3) / 3))), selectTheme);
    const body = new VStack([
      { component: new Text(bold(`选择会话 · ${this.state.projectName(projectId)}`), 0, 0), grow: 0 },
      { component: list, grow: 1 },
    ]);
    const handle = this.openWindow({ widthRatio: 0.85, content: body, forwardTo: list, maxHeightRatio: 0.7 });
    list.onSelect = (item) => {
      handle.hide();
      if (item.value === "$background") { this.commandHost.openProcesses(); return; }
      this.switchSession(item.value);
    };
    list.onCancel = () => handle.hide();
  }

  // ---------- 帮助 ----------

  private openHelp(): void {
    const lines = [
      bold("命令"),
      ...commandHelpLines(),
      "",
      bold("输入"),
      "  Enter 提交 · Alt+Enter / Shift+Enter / Ctrl+J 换行 · 大段粘贴自动折叠显示（提交保留原文）",
      "  Ctrl+C：有草稿先清空草稿，空草稿退出客户端；/quit 直接退出",
      "  Shift+Tab：循环切换后续任务的审批模式（Ask for approval → Full access → Auto review）",
      "  退出只关闭客户端：后台任务继续运行，重新打开 TUI 即可重连",
      "",
      bold("滚动"),
      "  PageUp/PageDown 或鼠标滚轮翻页；滚动后新输出不会把视口拉回底部；",
      "  End 返回最新位置（恢复跟随）；滚动到顶部自动加载更早历史",
      "",
      bold("终端限制"),
      "  部分终端不支持 Shift+Enter 修饰键上报，可用 Alt+Enter 或 Ctrl+J 换行；",
      "  中文输入法候选窗位置依赖终端的 Kitty 键盘协议支持；",
      "  链接不自动打开；状态不只靠颜色表达（均有文字标注）。",
      "",
      dim("  ↑↓ / PageUp·PageDown 滚动本页 · Esc/q 关闭"),
    ];
    // 帮助页：长文本按可用宽度换行，超出部分由覆盖层高度裁切
    this.openWindow({ widthRatio: 0.85, content: new Text(lines.join("\n"), 0, 0), maxHeightRatio: 0.85 });
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
    this.tickTiming();
  }

  /** 顶部连接信息与底栏的权限模式、工作区和模型选择。 */
  private refreshChrome(): void {
    const view = this.currentView();
    this.editor.workspaceName = view ? basename(view.cwd) || view.cwd : "";
    const conn = this.state.connection;
    const connText =
      conn.state === "online"
        ? "在线"
        : conn.state === "reconnecting"
          ? `重连中（${conn.detail ?? ""}）`
          : conn.state === "failed"
            ? `离线：${conn.detail ?? ""}`
            : "连接中…";
    if (!view) {
      this.footer.set(dim(""), dim(this.modelInfoText()));
      this.header.setText(
        `${bold("ruukoto")} · 未选择会话 · 连接：${connText}\n` +
          dim(`执行后端：${this.state.execution.backend || "未知"}（${this.state.execution.note || "握手后显示"}）`),
      );
      this.tui.requestRender();
      return;
    }
    const session = this.state.sessions.find((s) => s.id === view.sessionId);
    const active = this.state.activeTaskFor(view.sessionId);
    const modeTask = active ?? this.state.queuedTasksFor(view.sessionId).at(-1) ?? null;
    const mode: SessionDefaultMode = modeTask?.planMode ? "plan" : modeTask?.accessMode ?? session?.defaultAccessMode ?? "confirm";
    const modeText = modeTask ? formatAccessMode(mode, modeTask.pendingAccessMode) : null;
    const defaultText = session ? accessModeLabel(session.defaultAccessMode) : accessModeLabel("confirm");
    // 任务模式与会话默认相同时不重复显示（同一句话打两遍看不出差别）
    const sameAsDefault = !modeText || modeText === defaultText;
    const modeDisplay = sameAsDefault ? (modeText ?? defaultText) : `${modeText} · 会话默认 ${defaultText}`;
    // 左下角：当前模式。模式名不能包在 dim 里，否则颜色被压暗。
    const modeStyled = sameAsDefault
      ? accessModeStyle(mode)(modeDisplay)
      : `${accessModeStyle(mode)(modeText!)}${dim(` · 会话默认 ${defaultText}`)}`;
    const usage = this.sessionUsage.get(view.sessionId);
    const usageText = usage ? `↑ ${formatTokenCount(usage.input)} ↓ ${formatTokenCount(usage.output)}` : "";
    this.footer.set(modeStyled, dim(this.modelInfoText()), usageText);
    // issue 07 步骤 4：会话标题按组织展示归属显示「工作区」；已映射旧会话另标明
    // 「配置与资料来源」项目（来源身份不随组织映射改变）。ruukoto 产品沿用原标题。
    const title = session ? sessionTitleAttribution(session, this.state.projects, this.devProductPicker()) : null;
    const titleTag = title?.workspace ? "工作区 " : "";
    const titleName = this.state.projectName(title?.projectId ?? view.projectId);
    // 来源标注紧随工作区名（行尾是长 cwd，可能被截断）
    const sourceNote = title?.sourceProjectId ? dim(`（配置与资料来源：${this.state.projectName(title.sourceProjectId)}）`) : "";
    // issue 11：本会话的工作委托多出一行展示；没有委托不加行
    const worksText = this.state.worksSummaryForSession(view.sessionId);
    this.header.setText(
      `${titleTag}${bold(titleName)}${sourceNote} · 会话 ${view.sessionId.slice(0, 14)}… · ${sanitizeForDisplay(view.cwd)}\n` +
        `连接：${connText} · 模式：${modeDisplay} · 执行：${this.state.execution.backend}${this.state.execution.backend === "local" ? yellow("（无隔离，仅开发用）") : ""}` +
        (worksText ? `\n${dim(worksText)}` : "") +
        (this.state.ownerQuestions.some(question => question.sessionId === view.sessionId && question.status === "pending") ? "\n拥有者问题待回答：/questions 逐题回答或取消" : ""),
    );
    this.tui.requestRender();
  }

  /** 渲染只消费统一投影，不在视图层拼接、排序或替换历史与活动记录。 */
  private refreshTranscript(): void {
    const view = this.currentView();
    const entries: FlowEntry[] = view ? view.flow.items : this.state.globalNotes.map((note) => ({ ...note, kind: "note", seq: 0 }));
    if (entries.length === 0) {
      entries.push({ key: "$empty", kind: "note", text: view ? (view.historyLoaded ? "（暂无历史消息）" : "历史加载中…") : "ruukoto TUI\n使用 /project 选择会话，或 /new-project、/new-session 创建。\n/help 查看命令与终端操作。", at: "", seq: 0 });
    }
    this.eventFlowView.setEntries(entries, view?.cwd);
    this.todoPanel.set(view ? (this.sessionTodos.has(view.sessionId) ? this.sessionTodos.get(view.sessionId)! : latestTodos(view.flow.tools)) : null);
    this.tui.requestRender();
  }
}
