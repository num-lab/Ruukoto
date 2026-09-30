import {
  Markdown,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { renderMermaidASCII } from "beautiful-mermaid";
import type { FlowEntry } from "./event-flow.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const userBackground = "\x1b[48;5;236m";
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const animationMs = 80;
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
      return [entry.kind, task.status, task.startedAt, task.endedAt, task.errorMessage, task.interruptReason, task.effectUnknown];
    }
  }
}

function endTime(value: string): string {
  const date = new Date(value);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const hours = date.getHours();
  return `${day} ${String(hours % 12 || 12).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** 一个事件对应一个块；布局仅取决于当前条目和终端宽度。 */
export class EventFlowView implements Component {
  private entries: readonly FlowEntry[] = [];
  private blocks = new Map<string, { inputs: unknown[]; lines: string[] }>();
  private ranges: Array<{ start: number; end: number; entry: FlowEntry }> = [];
  private width = 0;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  setEntries(entries: readonly FlowEntry[]): void {
    this.entries = entries;
    const keys = new Set(entries.map((entry) => entry.key));
    for (const key of this.blocks.keys()) if (!keys.has(key)) this.blocks.delete(key);
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
          const expand = entry.entryId ? ` · /expand ${entry.entryId.slice(0, 8)} 展开` : "";
          lines.push(...wrapTextWithAnsi(dim(`[正文 ${entry.totalBytes} 字节${expand}]`), Math.max(1, width - 2)).map((line) => `  ${line}`));
        }
        return lines;
      }
      case "thinking": {
        if (entry.endedAt) return this.marked(" ", `Thought for ${formatDuration(entry.startedAt, Date.parse(entry.endedAt))}`, width).map(dim);
        const frame = spinnerFrames[Math.floor(Math.max(0, this.clock() - Date.parse(entry.startedAt)) / animationMs) % spinnerFrames.length]!;
        const prefix = `${frame} Thinking...`;
        const room = width - visibleWidth(prefix) - 1;
        const text = singleLine(entry.text);
        if (!text || room <= 0) return [dim(truncateToWidth(prefix, width, ""))];
        const tail = sliceByColumn(text, Math.max(0, visibleWidth(text) - room), room, true);
        return [dim(`${prefix} ${tail}`)];
      }
      case "tool": {
        const name = ["read", "edit", "write", "bash"].includes(entry.name.toLowerCase())
          ? entry.name[0]!.toUpperCase() + entry.name.slice(1).toLowerCase()
          : entry.name;
        const icon = entry.status === "done" ? green("●") : entry.status === "error" ? red("●") : "●";
        const lines = this.marked(icon, safe(name), width);
        let detail = dim(entry.name.toLowerCase() === "bash"
          ? truncateToWidth(singleLine(entry.target), Math.max(0, width - 4), "...")
          : safe(entry.target));
        if (entry.editStats) detail += ` ${green(`+${entry.editStats.added}`)} ${red(`-${entry.editStats.removed}`)}`;
        if (entry.status === "error") detail += ` · ${red(singleLine(entry.summary ?? "失败"))}`;
        if (entry.status === "effect_unknown") detail += ` · ${yellow("效果未知")}`;
        lines.push(...this.detail(detail, width));
        if (entry.paramsTruncated) {
          const id = entry.entryId ?? entry.toolOpId;
          lines.push(...wrapTextWithAnsi(dim(`参数已截断${id ? ` · /expand ${id.slice(0, 8)} 展开` : ""}`), Math.max(1, width - 2)).map((line) => `  ${line}`));
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
            for (const row of body) lines.push(...wrapTextWithAnsi(row, Math.max(1, width)));
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
          const waiting = task.status === "awaiting_confirmation" ? " · waiting for approval" : "";
          const word = "Sweeping";
          const head = Math.floor(Math.max(0, this.clock() - Date.parse(task.startedAt ?? task.createdAt)) / animationMs) % (word.length + 30) - 3;
          const shine = [...word].map((letter, index) => {
            const distance = Math.abs(index - head);
            const color = distance < 1 ? "\x1b[97m" : distance <= 3 ? "\x1b[38;5;157m" : "\x1b[32m";
            return `${color}${letter}`;
          }).join("") + "\x1b[0m";
          return this.marked(green("●"), `${shine}${elapsed}${waiting}`, width);
        }
        const duration = task.startedAt && task.endedAt ? ` in ${formatDuration(task.startedAt, Date.parse(task.endedAt))}` : "";
        const at = task.endedAt ? ` · At ${endTime(task.endedAt)}` : "";
        const style = task.status === "completed" ? dim : task.status === "failed" ? red : yellow;
        const label = task.status === "completed" ? "Done" : task.status === "failed" ? "Failed" : task.status === "canceled" ? "Canceled" : "Interrupted";
        const reason = task.errorMessage ?? task.interruptReason;
        const message = `${label}${duration}${at}${reason ? ` · ${singleLine(reason)}` : ""}${task.effectUnknown ? " · 效果未知" : ""}`;
        return this.marked(style(task.status === "completed" ? " " : task.status === "failed" ? "✗" : "■"), style(message), width);
      }
    }
  }
}
