import { posix as path } from "node:path";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { renderMermaidASCII } from "beautiful-mermaid";
import type { FlowEntry } from "./event-flow.ts";
import { sanitizeForDisplay } from "./sanitize.ts";
import { snapUtf8End } from "@ruukoto/core/history.ts";
import { contextDisplayRow } from "./context-format.ts";
import { latestTodos } from "./todo-panel.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const userBackground = "\x1b[48;5;236m";
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const animationMs = 80;
export interface ToolExpansion {
  text: string;
  lang?: string;
  diff?: boolean;
  totalLines?: number;
  loading?: boolean;
  error?: boolean;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function mermaidCode(code: string, lang: string | undefined, width: number, streaming: boolean): string[] | null {
  if (lang?.toLowerCase() === "mermaid" && !streaming && code.length <= 8192 && code.split("\n").length <= 100 && !/\b(?:graph|flowchart|direction)\s+RL\b/.test(code)) {
    try {
      // 渲染库按 UTF-16 长度布局；零宽占位使宽字符的长度等于终端列宽。
      let source = "";
      for (const { segment } of graphemes.segment(code)) {
        if (segment === "\n") { source += segment; continue; }
        const padding = visibleWidth(segment) - segment.length;
        if (padding < 0 || segment.includes("\u200b")) throw new Error("Unsupported grapheme width");
        source += segment + "\u200b".repeat(padding);
      }
      const lines = renderMermaidASCII(source, { colorMode: "none", paddingY: 2 }).replaceAll("\u200b", "").split("\n");
      if (lines.some((line) => line.trim()) && lines.every((line) => visibleWidth(line) <= width)) return lines;
    } catch {
      // 不支持的语法或字符仍显示原始代码，不影响其余 Markdown。
    }
  }
  return null;
}

const markdownTheme = {
  heading: bold,
  link: (text: string) => `\x1b[38;5;75m${text}\x1b[0m`,
  linkUrl: dim,
  code: (text: string) => `\x1b[38;5;79m${text}\x1b[0m`,
  codeBlock: (text: string) => `\x1b[38;5;252m${text}\x1b[0m`,
  codeBlockBorder: dim,
  codeBlockIndent: "  ",
  highlightCode,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: (text: string) => text,
  bold,
  italic: (text: string) => `\x1b[3m${text}\x1b[0m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[0m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[0m`,
};

const safe = (text: string) => sanitizeForDisplay(text).replace(/\t/g, "   ");
const singleLine = (text: string) => safe(text).replace(/\s*\n\s*/g, " ");
function formatDuration(start: string, end: number): string {
  let remaining = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    const value = Math.floor(remaining / size);
    if (value > 0) parts.push(`${value}${unit}`);
    remaining %= size;
  }
  return parts.join(" ") || "0s";
}
const active = (entry: FlowEntry) => entry.kind === "task" && (entry.task.status === "running" || entry.task.status === "awaiting_confirmation");

/** /context 的可信排版保留 SGR 颜色；其他终端控制序列仍按普通内容净化。 */
function contextColors(text: string): string {
  const sgr = /\x1b\[(?:0|1|2|38;5;(?:75|79|114|179|209|168|141|109|131))m/g;
  let result = "";
  let offset = 0;
  for (const match of text.matchAll(sgr)) {
    result += safe(text.slice(offset, match.index));
    result += match[0];
    offset = match.index + match[0].length;
  }
  return result + safe(text.slice(offset));
}

/** 投影会原地更新条目；缓存保存排版依赖的基本字段，不能只比较对象引用。 */
function renderInputs(entry: FlowEntry): unknown[] {
  switch (entry.kind) {
    case "message": return [entry.kind, entry.role, entry.text, entry.entryId, entry.totalBytes, entry.truncated, entry.streaming];
    case "thinking": return [entry.kind, entry.text, entry.startedAt, entry.endedAt];
    case "tool": return [entry.kind, entry.name, entry.target, entry.status, entry.summary, entry.editStats?.added, entry.editStats?.removed, entry.paramsTruncated, entry.entryId, entry.toolOpId];
    case "command": return [entry.kind, entry.line, entry.result, entry.isError];
    case "note": return [entry.kind, entry.text];
    case "task": {
      const task = entry.task;
      return [entry.kind, task.status, task.startedAt, task.endedAt, task.errorMessage, task.interruptReason, task.effectUnknown, task.wait, task.resourcePhase];
    }
  }
}

function endTime(value: string): string {
  const date = new Date(value);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const hours = date.getHours();
  return `${day} ${String(hours % 12 || 12).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** 保留语法前景色，diff 只着背景；行号取实际 hunk 的旧/新文件位置。 */
function renderToolCode(expansion: ToolExpansion, width: number): string[] {
  const source = safe(expansion.text.replace(/\r\n/g, "\n"));
  const raw = source ? source.replace(/\n$/, "").split("\n") : [];
  const rows: Array<{ number: number; marker: string; text: string }> = [];
  let oldLine = 1;
  let newLine = 1;
  let inHunk = !raw.some((line) => line.startsWith("@@ "));
  for (const line of raw) {
    if (!expansion.diff) { rows.push({ number: rows.length + 1, marker: "", text: line }); continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
    if (line.startsWith("diff ") || line.startsWith("Index: ")) { inHunk = false; continue; }
    if (!inHunk || !/^[+ -]/.test(line)) continue;
    const marker = line[0]!;
    const number = marker === "-" ? oldLine : newLine;
    if (marker !== "+") oldLine++;
    if (marker !== "-") newLine++;
    rows.push({ number, marker, text: line.slice(1) });
  }
  let bytes = 0;
  const shown = rows.slice(0, 80).filter((row) => {
    bytes += Buffer.byteLength(row.text) + 1;
    return bytes <= 8192;
  });
  // 单行极长时仍显示这一行的开头，横向截断交给终端列宽处理。
  if (!shown.length && rows.length) {
    const buffer = Buffer.from(rows[0]!.text);
    shown.push({ ...rows[0]!, text: buffer.subarray(0, snapUtf8End(buffer, Math.min(buffer.length, 8192))).toString("utf8") });
  }
  const highlighted = highlightCode(shown.map((row) => row.text).join("\n"), expansion.lang);
  const digits = String(Math.max(1, ...shown.map((row) => row.number))).length;
  const result = shown.map((row, index) => {
    const prefix = dim(`${String(row.number).padStart(digits)} ${expansion.diff ? row.marker + " " : ""}`);
    const line = truncateToWidth(prefix + (highlighted[index] ?? row.text), Math.max(1, width - 4), "…", true);
    const background = row.marker === "+" ? "\x1b[48;2;0;55;0m" : row.marker === "-" ? "\x1b[48;5;52m" : "";
    return "    " + (background ? background + line.replaceAll("\x1b[0m", "\x1b[0m" + background) + "\x1b[0m" : line);
  });
  const more = Math.max(0, (expansion.totalLines ?? rows.length) - shown.length);
  if (more > 0) result.push(`    ${dim(`...${more} more lines`)}`);
  return result;
}

/** 一个事件对应一个块；布局仅取决于当前条目和终端宽度。 */
export class EventFlowView implements Component {
  onToggleTool?: (entry: Extract<FlowEntry, { kind: "tool" }>) => void;
  onChange?: () => void;
  private expandedThinking = new Set<string>();
  private expansions = new Map<string, ToolExpansion>();
  private entries: readonly FlowEntry[] = [];
  private blocks = new Map<string, { inputs: unknown[]; lines: string[] }>();
  private ranges: Array<{ start: number; end: number; entry: FlowEntry }> = [];
  private width = 0;
  private cwd = "";

  constructor(private readonly clock: () => number = () => Date.now()) {}

  setEntries(entries: readonly FlowEntry[], cwd = ""): void {
    if (cwd !== this.cwd) {
      this.cwd = cwd;
      this.invalidate();
    }
    this.entries = entries;
    const keys = new Set(entries.map((entry) => entry.key));
    for (const key of this.blocks.keys()) if (!keys.has(key)) this.blocks.delete(key);
    for (const key of this.expansions.keys()) if (!keys.has(key)) this.expansions.delete(key);
    for (const key of this.expandedThinking) if (!keys.has(key)) this.expandedThinking.delete(key);
  }

  setToolExpansion(key: string, expansion: ToolExpansion | null): void {
    if (expansion) this.expansions.set(key, expansion);
    else this.expansions.delete(key);
    this.blocks.delete(key);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!["press", "release", "click"].includes(event.type) || event.button !== "left") return;
    const thinking = this.ranges.find((range) => range.entry.kind === "thinking" && event.y >= range.start && event.y < range.end);
    if (thinking) {
      if (event.type === "click") {
        if (!this.expandedThinking.delete(thinking.entry.key)) this.expandedThinking.add(thinking.entry.key);
        this.blocks.delete(thinking.entry.key);
        this.onChange?.();
      }
      return { handled: true };
    }
    const range = this.ranges.find((range) => {
      if (range.entry.kind !== "tool" || event.y >= range.end) return false;
      const resultLine = this.blocks.get(range.entry.key)?.lines.findIndex((line) => safe(line).startsWith("  ⎿ ")) ?? -1;
      return resultLine >= 0 && event.y >= range.start + resultLine;
    });
    if (!range || range.entry.kind !== "tool") return;
    if (event.type === "click") this.onToggleTool?.(range.entry);
    return { handled: true };
  }

  invalidate(): void {
    this.blocks.clear();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width !== this.width) {
      this.width = width;
      this.invalidate();
    }
    const lines: string[] = [];
    this.ranges = [];
    // 运行计时永远位于最后，后来的命令和流式正文也不会落到它下面。
    const entries = [...this.entries.filter((entry) => !active(entry)), ...this.entries.filter(active)];
    for (const entry of entries) {
      const inputs = renderInputs(entry);
      let cached = this.blocks.get(entry.key);
      // 运行状态与未结束的思考随动画帧变化；其余块只在内容或宽度变化时重新排版。
      if (active(entry) || (entry.kind === "thinking" && !entry.endedAt) || !cached || inputs.length !== cached.inputs.length || inputs.some((value, index) => value !== cached!.inputs[index])) {
        const block = this.renderEntry(entry, width);
        while (block.length && visibleWidth(block[0]!.trim()) === 0) block.shift();
        while (block.length && visibleWidth(block.at(-1)!.trim()) === 0) block.pop();
        const userMessage = entry.kind === "message" && entry.role === "user";
        cached = { inputs, lines: block.map((line) => {
          return userMessage ? this.userLine(line, width) : truncateToWidth(line, width, "");
        }) };
        this.blocks.set(entry.key, cached);
      }
      if (!cached.lines.length) continue;
      if (lines.length) lines.push("");
      const start = lines.length;
      lines.push(...cached.lines);
      this.ranges.push({ start, end: lines.length, entry });
    }
    return lines;
  }

  /** 为历史前插保存事件与行内偏移。 */
  scrollAnchor(top: number, width: number): { key: string; offset: number } | undefined {
    this.render(width);
    const range = this.ranges.find((range) => range.end > top);
    return range ? { key: range.entry.key, offset: top - range.start } : undefined;
  }

  entryTop(key: string, width: number): number | undefined {
    this.render(width);
    return this.ranges.find((range) => range.entry.key === key)?.start;
  }

  /** 按原始事件流的行号找任务，复用用户消息的排版与灰底。 */
  stickyPrompt(scrollTop: number, width: number, maxLines = 3): string[] {
    if (scrollTop <= 0 || width <= 0 || maxLines <= 0) return [];
    this.render(width);
    const current = this.ranges.findLast((range) => range.start <= scrollTop);
    if (!current?.entry.taskId) return [];
    const prompt = this.ranges.findLast((range) => range.entry.taskId === current.entry.taskId && range.entry.kind === "message" && range.entry.role === "user" && range.end <= scrollTop);
    if (!prompt) return [];
    const lines = this.blocks.get(prompt.entry.key)!.lines;
    if (lines.length <= maxLines) return [...lines];
    const shown = lines.slice(0, maxLines);
    shown[maxLines - 1] = this.userLine(`${truncateToWidth(safe(shown[maxLines - 1]!), Math.max(0, width - 1), "")}…`, width);
    return shown;
  }

  private marked(marker: string, text: string, width: number): string[] {
    const lines = wrapTextWithAnsi(text, Math.max(1, width - 2));
    return lines.map((line, index) => `${index === 0 ? `${marker} ` : "  "}${line}`);
  }

  private userLine(line: string, width: number): string {
    const text = truncateToWidth(line, width, "", true);
    return `${userBackground}${text.replaceAll("\x1b[0m", `\x1b[0m${userBackground}`)}\x1b[49m`;
  }

  private detail(text: string, width: number): string[] {
    return wrapTextWithAnsi(text, Math.max(1, width - 4)).map((line, index) => `${index === 0 ? dim("  ⎿ ") : "    "}${line}`);
  }

  private renderEntry(entry: FlowEntry, width: number): string[] {
    switch (entry.kind) {
      case "message": {
        const text = safe(entry.text);
        if (!text.trim() && !entry.truncated) return [];
        let lines: string[];
        if (entry.role === "assistant") {
          const diagrams: string[][] = [];
          let body = new Markdown(text, 0, 0, {
            ...markdownTheme,
            highlightCode: (code, lang) => {
              const diagram = mermaidCode(code, lang, Math.max(0, width - 4), entry.streaming);
              if (diagram) diagrams.push(diagram);
              return diagram ?? highlightCode(code, lang);
            },
          }).render(Math.max(1, width - 2));
          // 列表或引用还会增加缩进；图形被 Markdown 换行时回退源码。
          const plainBody = body.map(safe);
          if (diagrams.flat().some((line) => line.trim() && !plainBody.some((row) => row.includes(line.trimEnd())))) {
            body = new Markdown(text, 0, 0, markdownTheme).render(Math.max(1, width - 2));
          }
          while (body.length && visibleWidth(body[0]!.trim()) === 0) body.shift();
          while (body.length && visibleWidth(body.at(-1)!.trim()) === 0) body.pop();
          lines = body.map((line, index) => `${index === 0 ? "● " : "  "}${line}`);
        } else {
          lines = this.marked(entry.role === "user" ? dim("❯") : "·", text, width);
        }
        if (entry.truncated) {
          lines.push(...wrapTextWithAnsi(dim(`[正文 ${entry.totalBytes} 字节]`), Math.max(1, width - 2)).map((line) => `  ${line}`));
        }
        return lines;
      }
      case "thinking": {
        const frame = spinnerFrames[Math.floor(Math.max(0, this.clock() - Date.parse(entry.startedAt)) / animationMs) % spinnerFrames.length]!;
        const header = entry.endedAt
          ? `  Thought for ${formatDuration(entry.startedAt, Date.parse(entry.endedAt))}`
          : `${frame} Thinking...`;
        const body = entry.text.trim() ? wrapTextWithAnsi(safe(entry.text), Math.max(1, width - 4)) : [];
        const shown = this.expandedThinking.has(entry.key) ? body : body.slice(-4);
        return [header, ...shown.map((line, index) => `${index === 0 ? "  ⎿ " : "    "}${line}`)].map(dim);
      }
      case "tool": {
        const name = ["read", "edit", "write", "bash"].includes(entry.name.toLowerCase())
          ? entry.name[0]!.toUpperCase() + entry.name.slice(1).toLowerCase()
          : entry.name;
        const icon = entry.status === "done" ? green("●") : entry.status === "error" ? red("●") : "●";
        const lines = this.marked(icon, safe(name), width);
        const target = this.cwd && ["read", "write", "edit"].includes(entry.name.toLowerCase()) && path.isAbsolute(entry.target)
          ? path.relative(this.cwd, entry.target) || "."
          : entry.target;
        let detail = dim(entry.name.toLowerCase() === "bash"
          ? truncateToWidth(singleLine(entry.target), Math.max(0, width - 4), "...")
          : safe(target));
        if (entry.editStats) detail += ` ${green(`+${entry.editStats.added}`)} ${red(`-${entry.editStats.removed}`)}`;
        if (entry.status === "error") detail += ` · ${red(singleLine(entry.summary ?? "失败"))}`;
        if (entry.status === "effect_unknown") detail += ` · ${yellow("效果未知")}`;
        lines.push(...this.detail(detail, width));
        const expansion = this.expansions.get(entry.key);
        if (expansion?.loading) lines.push(...this.detail(dim("加载中…"), width));
        else if (expansion?.error) lines.push(...this.detail(red(singleLine(expansion.text)), width));
        else if (expansion) {
          const preview = ["bash", "read"].includes(entry.name.toLowerCase())
            ? { ...expansion, text: expansion.text.replace(/\n?\[完整正文已捕获：artifact art_[^\r\n]*(?:\r?\n)?$/, "") }
            : expansion;
          lines.push(...renderToolCode(preview, width));
          if (entry.artifactIds.length && !["bash", "read"].includes(entry.name.toLowerCase())) {
            lines.push(...this.detail(dim(`产物：${entry.artifactIds.join(", ")} · /artifact 查看`), width));
          }
        }
        return lines;
      }
      case "command": {
        const lines = this.marked(dim("❯"), safe(entry.line), width).map((line) => this.userLine(line, width));
        if (entry.result !== null) {
          const result = safe(entry.result);
          if (entry.line === "/context" && !entry.isError && result.startsWith("Context Usage\n")) {
            const [title, ...body] = contextColors(entry.result).split("\n");
            lines.push(...this.detail(title!, width));
            for (const row of body) lines.push(...wrapTextWithAnsi(contextDisplayRow(row, width), Math.max(1, width)));
          } else {
            lines.push(...this.detail((entry.isError ? red : dim)(result), width));
          }
        }
        return lines;
      }
      case "note":
        return entry.text.trim() ? this.marked("·", dim(safe(entry.text)), width) : [];
      case "task": {
        const task = entry.task;
        if (task.status === "queued") return [];
        if (active(entry)) {
          const elapsed = task.startedAt ? ` · Elapsed ${formatDuration(task.startedAt, this.clock())}` : "";
          const todos = latestTodos(this.entries.filter((entry) => entry.kind === "tool"));
          const progress = todos?.length ? ` [${todos.filter((todo) => todo.status === "completed").length}/${todos.length}]` : "";
          const waiting = task.status === "awaiting_confirmation" ? " · waiting for approval"
            : task.wait?.phase === "waiting" ? ` · 等待后台：${task.wait.targets.map(target => `${target.label}（${target.status}）`).join("、")}`
            : task.resourcePhase === "conversation" ? " · 等待执行资源，可继续对话" : "";
          const word = "Sweeping";
          const head = Math.floor(Math.max(0, this.clock() - Date.parse(task.startedAt ?? task.createdAt)) / animationMs) % (word.length + 30) - 3;
          const shine = [...word].map((letter, index) => {
            const distance = Math.abs(index - head);
            const color = distance < 1 ? "\x1b[97m" : distance <= 3 ? "\x1b[38;5;157m" : "\x1b[32m";
            return `${color}${letter}`;
          }).join("") + "\x1b[0m";
          return this.marked(green("●"), `${shine}${elapsed}${progress}${waiting}`, width);
        }
        const duration = task.startedAt && task.endedAt ? ` in ${formatDuration(task.startedAt, Date.parse(task.endedAt))}` : "";
        const at = task.endedAt ? ` · At ${endTime(task.endedAt)}` : "";
        const style = task.status === "completed" ? dim : task.status === "failed" ? red : yellow;
        const label = task.status === "completed" ? "Done" : task.status === "failed" ? "Failed" : task.status === "canceled" ? "Canceled" : "Interrupted";
        const reason = task.wait?.reason === "owner_input" ? "新输入打断等待，后台工作继续" : task.errorMessage ?? task.interruptReason;
        const message = `${label}${duration}${at}${reason ? ` · ${singleLine(reason)}` : ""}${task.effectUnknown ? " · 效果未知" : ""}`;
        return this.marked(style(task.status === "completed" ? " " : task.status === "failed" ? "✗" : "■"), style(message), width);
      }
    }
  }
}
