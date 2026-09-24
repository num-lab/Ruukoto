import {
  Markdown,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { FlowEntry } from "./event-flow.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const userBackground = "\x1b[48;5;236m";

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
const seconds = (start: string, end: number) => `${Math.max(0, Math.floor((end - Date.parse(start)) / 1000))}s`;
const active = (entry: FlowEntry) => entry.kind === "task" && (entry.task.status === "running" || entry.task.status === "awaiting_confirmation");

function endTime(value: string): string {
  const date = new Date(value);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const hours = date.getHours();
  return `${day} ${String(hours % 12 || 12).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** 一个事件对应一个块；布局仅取决于当前条目和终端宽度。 */
export class EventFlowView implements Component {
  private entries: readonly FlowEntry[] = [];
  private markdown = new Map<string, { text: string; component: Markdown }>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  setEntries(entries: readonly FlowEntry[]): void {
    this.entries = entries;
    const keys = new Set(entries.map((entry) => entry.key));
    for (const key of this.markdown.keys()) if (!keys.has(key)) this.markdown.delete(key);
  }

  invalidate(): void {
    for (const value of this.markdown.values()) value.component.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const lines: string[] = [];
    // 运行计时永远位于最后，后来的命令和流式正文也不会落到它下面。
    const entries = [...this.entries.filter((entry) => !active(entry)), ...this.entries.filter(active)];
    for (const entry of entries) {
      const block = this.renderEntry(entry, width);
      while (block.length && visibleWidth(block[0]!.trim()) === 0) block.shift();
      while (block.length && visibleWidth(block.at(-1)!.trim()) === 0) block.pop();
      if (!block.length) continue;
      if (lines.length) lines.push("");
      const userMessage = entry.kind === "message" && entry.role === "user";
      lines.push(...block.map((line) => {
        const text = truncateToWidth(line, width, "", userMessage);
        return userMessage ? `${userBackground}${text.replaceAll("\x1b[0m", `\x1b[0m${userBackground}`)}\x1b[49m` : text;
      }));
    }
    return lines;
  }

  private marked(marker: string, text: string, width: number): string[] {
    const lines = wrapTextWithAnsi(text, Math.max(1, width - 2));
    return lines.map((line, index) => `${index === 0 ? `${marker} ` : "  "}${line}`);
  }

  private detail(text: string, width: number): string[] {
    return wrapTextWithAnsi(text, Math.max(1, width - 4)).map((line, index) => `${index === 0 ? "  ⎿ " : "    "}${line}`);
  }

  private renderEntry(entry: FlowEntry, width: number): string[] {
    switch (entry.kind) {
      case "message": {
        const text = safe(entry.text);
        if (!text.trim() && !entry.truncated) return [];
        let lines: string[];
        if (entry.role === "assistant") {
          let cached = this.markdown.get(entry.key);
          if (!cached || cached.text !== text) {
            cached = { text, component: new Markdown(text, 0, 0, markdownTheme) };
            this.markdown.set(entry.key, cached);
          }
          const body = [...cached.component.render(Math.max(1, width - 2))];
          while (body.length && visibleWidth(body[0]!.trim()) === 0) body.shift();
          while (body.length && visibleWidth(body.at(-1)!.trim()) === 0) body.pop();
          lines = body.map((line, index) => `${index === 0 ? "● " : "  "}${line}`);
        } else {
          lines = this.marked(entry.role === "user" ? "❯" : "·", text, width);
        }
        if (entry.truncated) {
          const expand = entry.entryId ? ` · /expand ${entry.entryId.slice(0, 8)} 展开` : "";
          lines.push(...wrapTextWithAnsi(dim(`[正文 ${entry.totalBytes} 字节${expand}]`), Math.max(1, width - 2)).map((line) => `  ${line}`));
        }
        return lines;
      }
      case "thinking": {
        if (entry.endedAt) return this.marked("⨳", `Thought for ${seconds(entry.startedAt, Date.parse(entry.endedAt))}`, width);
        const prefix = "⨳ Thinking...";
        const room = width - visibleWidth(prefix) - 1;
        const text = singleLine(entry.text);
        if (!text || room <= 0) return [truncateToWidth(prefix, width, "")];
        const tail = sliceByColumn(text, Math.max(0, visibleWidth(text) - room), room, true);
        return [`${prefix} ${dim(tail)}`];
      }
      case "tool": {
        const name = ["read", "edit", "bash"].includes(entry.name.toLowerCase())
          ? entry.name[0]!.toUpperCase() + entry.name.slice(1).toLowerCase()
          : entry.name;
        const lines = this.marked("⚙︎", safe(name), width);
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
        const lines = this.marked("❯", safe(entry.line), width);
        if (entry.result !== null) lines.push(...this.detail((entry.isError ? red : dim)(safe(entry.result)), width));
        return lines;
      }
      case "note":
        return entry.text.trim() ? this.marked("·", dim(safe(entry.text)), width) : [];
      case "task": {
        const task = entry.task;
        if (task.status === "queued") return [];
        if (active(entry)) {
          const elapsed = task.startedAt ? ` · Elapsed ${seconds(task.startedAt, this.clock())}` : "";
          const waiting = task.status === "awaiting_confirmation" ? " · waiting for approval" : "";
          return this.marked(green("⦿"), `Sweeping${elapsed}${waiting}`, width);
        }
        const duration = task.startedAt && task.endedAt ? ` in ${seconds(task.startedAt, Date.parse(task.endedAt))}` : "";
        const at = task.endedAt ? ` · At ${endTime(task.endedAt)}` : "";
        const style = task.status === "completed" ? green : task.status === "failed" ? red : yellow;
        const label = task.status === "completed" ? "Done" : task.status === "failed" ? "Failed" : task.status === "canceled" ? "Canceled" : "Interrupted";
        const reason = task.errorMessage ?? task.interruptReason;
        const message = `${label}${duration}${at}${reason ? ` · ${singleLine(reason)}` : ""}${task.effectUnknown ? " · 效果未知" : ""}`;
        return this.marked(style(task.status === "completed" ? "✓" : task.status === "failed" ? "✗" : "■"), style(message), width);
      }
    }
  }
}
