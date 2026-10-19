import type { AttachmentMetadata } from "@ruukoto/core/attachments.ts";
import { utf8ByteLength } from "./utf8.ts";
import type { TaskView as Task } from "@ruukoto/core/views.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { OutputPreview, ToolOpView } from "@ruukoto/core/views.ts";
import { workflowStatus } from "./workflow-status.ts";

interface FlowPosition {
  key: string;
  at: string;
  seq: number;
  taskId?: string;
}

export type FlowEntry = FlowPosition & (
  | { kind: "message"; role: string; text: string; entryId: string | null; totalBytes: number; truncated: boolean; streaming: boolean; attachments?: AttachmentMetadata[] }
  | { kind: "thinking"; text: string; startedAt: string; endedAt: string | null }
  | { kind: "tool"; toolOpId: string | null; toolCallId: string | null; name: string; params: Record<string, unknown>; target: string; status: "running" | "done" | "error" | "effect_unknown"; summary: string | null; editStats?: { added: number; removed: number }; entryId: string | null; paramsTruncated: boolean; artifactIds: string[] }
  | { kind: "command"; line: string; result: string | null; isError: boolean }
  | { kind: "note"; text: string }
  | { kind: "task"; task: Task }
);

export type CommandEntry = Extract<FlowEntry, { kind: "command" }>;

/** 主要操作对象。未知工具沿用首个字符串参数，无需为每个插件增加渲染分支。 */
export function toolTargetFromParams(name: string, params: Record<string, unknown>): string {
  // todo_write（issue 25）：只显示完成数/总数，不展开清单
  if (name === "todo_write" && Array.isArray(params.todos)) return `${params.todos.filter((t) => t?.status === "completed").length}/${params.todos.length}`;
  for (const value of [params.path, params.command, params.url, params.pattern, params.query, params.name, ...Object.values(params)]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 估算 token 的简短写法：一万以上按「万」保留一位小数。 */
function tokensText(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : String(n);
}

const COMPACTION_STARTED = "正在压缩上下文…";

/** 上下文压缩事件的一行说明（issue 30 §9）。 */
export function compactionText(body: Extract<PersistentEvent["body"], { type: "task.context_compaction" }>): string {
  if (body.phase === "started") return COMPACTION_STARTED;
  if (body.checkpointId === null) return `上下文未压缩：摘要失败（${body.summaryError ?? "未知原因"}），只做清理收益不足`;
  const parts = [`清理 ${body.clearedResults ?? 0} 条结果`];
  if (body.summaryStatus === "ok") parts.push(`摘要 ${body.summarizedCount ?? 0} 条消息`);
  const estimate = `估算 ${tokensText(body.estimateBefore)} → ${tokensText(body.estimateAfter ?? 0)}`;
  return body.summaryStatus === "failed"
    ? `上下文已压缩，摘要失败只做了清理（${body.summaryError ?? "未知原因"}）：${parts.join("、")}，${estimate}`
    : `上下文已压缩：${parts.join("、")}，${estimate}`;
}

/**
 * 一个会话只有一份事件展示投影。历史、实时事件与补读都按相同身份更新同一条目；
 * 身份不依赖正文，结果到达不会把工具移到完成时间。JSONL 仍是最终正文的权威来源。
 */
export class EventFlow {
  private readonly entries = new Map<string, FlowEntry>();
  private readonly versions = new Map<string, number>();
  private readonly refs = new Map<string, { taskId: string; messageId: string | null; at: string; seq: number }>();
  private readonly history = new Map<string, HistoryEntryView>();
  private readonly tasks = new Map<string, Task>();
  private readonly streams = new Map<string, { text: string; bytes: number; pending: Map<number, string> }>();
  private readonly hidden = new Set<string>();

  get items(): FlowEntry[] {
    return [...this.entries.values()].filter((entry) => !this.hidden.has(entry.key)).sort((a, b) => {
      const aRunning = a.kind === "task" && !a.task.endedAt;
      const bRunning = b.kind === "task" && !b.task.endedAt;
      if (aRunning !== bRunning) return aRunning ? 1 : -1;
      return a.at.localeCompare(b.at) || Number(a.kind === "task") - Number(b.kind === "task") || a.seq - b.seq || a.key.localeCompare(b.key);
    });
  }

  get historyEntries(): HistoryEntryView[] { return [...this.history.values()]; }
  get tools(): Extract<FlowEntry, { kind: "tool" }>[] {
    return this.items.filter((entry): entry is Extract<FlowEntry, { kind: "tool" }> => entry.kind === "tool");
  }

  /** 重连重新获取权威远端状态，保留当前客户端的命令和提示。 */
  resetRemote(): void {
    for (const [key, entry] of this.entries) {
      if (entry.kind !== "command" && entry.kind !== "note") this.entries.delete(key);
    }
    this.versions.clear();
    for (const [key, entry] of this.entries) if (key.startsWith("workflow:")) this.versions.set(key, entry.seq);
    this.refs.clear();
    this.history.clear();
    this.tasks.clear();
    this.streams.clear();
    this.hidden.clear();
  }

  task(task: Task): void {
    this.tasks.set(task.id, task);
    const key = `task:${task.id}`;
    if (task.status !== "queued") {
      this.entries.set(key, { key, taskId: task.id, kind: "task", task, at: task.endedAt ?? task.startedAt ?? task.createdAt, seq: Number.MAX_SAFE_INTEGER });
    }
    const inputKey = `input:${task.id}`;
    const pendingInput = this.entries.get(inputKey);
    if (task.input.trim() && pendingInput?.kind === "message" && pendingInput.entryId === null && pendingInput.text === "") { pendingInput.text = task.input; pendingInput.totalBytes = utf8ByteLength(task.input); }
    if (task.inputPurpose === "internal_report") this.entries.delete(inputKey);
    else if (task.input.trim() && !this.entries.has(inputKey)) {
      this.entries.set(inputKey, { key: inputKey, taskId: task.id, kind: "message", role: "user", text: task.input, at: task.createdAt, seq: -1,
        entryId: null, totalBytes: utf8ByteLength(task.input), truncated: false, streaming: false });
    }
    if (task.endedAt) {
      for (const entry of this.entries.values()) {
        if (entry.taskId === task.id && entry.kind === "thinking" && !entry.endedAt) entry.endedAt = task.endedAt;
        // 摘要等待中停止任务：不会有完成事件，进行中的压缩提示收尾
        if (entry.taskId === task.id && entry.kind === "note" && entry.key.startsWith("compaction:") && entry.text === COMPACTION_STARTED) {
          entry.text = "上下文压缩未完成：任务已结束";
        }
      }
    }
  }

  preview(taskId: string, preview: OutputPreview): void {
    const key = `output:${taskId}:${preview.messageId}`;
    if (this.entries.has(key) || [...this.entries.keys()].some((entryKey) => entryKey.startsWith(`${key}:`))) return;
    // 旧后台/旧记录只有尾部预览，明确保留 truncated；新数据由事件补读补全。
    this.entries.set(key, { key, taskId, kind: "message", role: "assistant", text: preview.text,
      entryId: null, at: this.tasks.get(taskId)?.startedAt ?? "", seq: preview.seq,
      totalBytes: preview.totalBytes, truncated: preview.truncated, streaming: true });
  }

  tool(op: ToolOpView, seq = 0): void {
    const key = `tool:${op.id}`;
    if ((this.versions.get(key) ?? -1) > seq) return;
    const current = this.entries.get(key);
    const entry: Extract<FlowEntry, { kind: "tool" }> = {
      key, taskId: op.taskId, at: op.intentRecordedAt, seq: current?.seq ?? 0, kind: "tool", toolOpId: op.id,
      toolCallId: op.sdkCallId, name: op.toolName, params: op.params, paramsTruncated: op.paramsTruncated,
      target: toolTargetFromParams(op.toolName, op.params), status: op.effectUnknown ? "effect_unknown" : op.recordedResultAt ? op.isError ? "error" : "done" : "running",
      summary: op.resultSummary, entryId: current?.kind === "tool" ? current.entryId : null,
      artifactIds: current?.kind === "tool" ? current.artifactIds : [],
      editStats: current?.kind === "tool" ? current.editStats : undefined,
    };
    this.entries.set(key, entry);
    this.versions.set(key, seq);
    for (const history of this.history.values()) {
      if (history.toolCallId === op.sdkCallId && this.refs.get(history.entryId)?.taskId === op.taskId) this.addHistory(history);
    }
  }

  apply(event: PersistentEvent): void {
    const body = event.body;
    switch (body.type) {
      case "task.attachments": {
        const key = `input:${body.taskId}`;
        const old = this.entries.get(key);
        const task = this.tasks.get(body.taskId);
        const attachments = body.attachments.map(ref => ({ id: ref.id, name: ref.name, size: ref.size }));
        if (old?.kind === "message") old.attachments = attachments;
        else this.entries.set(key, { key, taskId: body.taskId, kind: "message", role: "user", text: task?.input ?? "", at: task?.createdAt ?? event.createdAt, seq: -1, entryId: null, totalBytes: utf8ByteLength(task?.input ?? ""), truncated: false, streaming: false, attachments });
        return;
      }
      case "workflow.changed":
      case "workflow.step":
      case "workflow.execution": {
        const key = "workflow:" + body.runId + ":" + (body.type === "workflow.changed" ? "state" : body.type === "workflow.step" ? "step:" + body.key : "execution:" + body.taskId);
        if (event.seq <= (this.versions.get(key) ?? -1)) return;
        this.versions.set(key, event.seq);
        const text = body.type === "workflow.changed"
          ? "工作流 · " + workflowStatus(body.status) + (body.reason ? " · " + body.reason : "") + "；/workflow 选择运行查看详情"
          : body.type === "workflow.step"
            ? "工作流步骤 " + body.key + " · " + body.status + "；/workflow 选择运行查看阶段"
            : "工作流执行 · " + body.status + (body.stopVerified === false ? " · 停止待核实，保留占用与成果" : "") + "；/workflow 选择运行查看详情";
        this.note(key, text, this.entries.get(key)?.at ?? event.createdAt, event.seq);
        return;
      }
      case "task.thinking": {
        const key = `thinking:${body.thinkingId}`;
        const latest = event.seq > (this.versions.get(key) ?? -1);
        const current = this.entries.get(key);
        let text = body.text;
        if (body.offset !== undefined) {
          let stream = this.streams.get(key);
          if (!stream) {
            stream = { text: "", bytes: 0, pending: new Map() };
            this.streams.set(key, stream);
          }
          if (body.offset >= stream.bytes && (body.text || !stream.pending.has(body.offset))) stream.pending.set(body.offset, body.text);
          while (stream.pending.has(stream.bytes)) {
            const chunk = stream.pending.get(stream.bytes)!;
            stream.pending.delete(stream.bytes);
            stream.text += chunk;
            stream.bytes += utf8ByteLength(chunk);
            if (!chunk) break;
          }
          text = stream.text;
        } else {
          if (!latest) return;
          this.streams.delete(key);
        }
        if (latest) this.versions.set(key, event.seq);
        const stage = !latest && current?.kind === "thinking" ? current : body;
        this.entries.set(key, { key, kind: "thinking", taskId: body.taskId, at: stage.startedAt, seq: Math.min(current?.seq ?? event.seq, event.seq),
          text, startedAt: stage.startedAt, endedAt: stage.endedAt ?? this.tasks.get(body.taskId)?.endedAt ?? null });
        return;
      }
      case "task.output_fragment": {
        const base = `output:${body.taskId}:${body.messageId}`;
        const key = body.contentIndex === undefined ? base : `${base}:${body.contentIndex}`;
        const unsegmented = this.entries.get(base);
        if (key !== base) this.entries.delete(base);
        const current = this.entries.get(key);
        const historyId = (current?.kind === "message" ? current.entryId : null)
          ?? (unsegmented?.kind === "message" ? unsegmented.entryId : null)
          ?? [...this.refs].find(([, ref]) => ref.taskId === body.taskId && ref.messageId === body.messageId)?.[0]
          ?? null;
        let text = body.text;
        let truncated = body.truncated;
        if (body.offset !== undefined) {
          let stream = this.streams.get(key);
          if (!stream) {
            stream = { text: "", bytes: 0, pending: new Map() };
            this.streams.set(key, stream);
          }
          if (body.offset >= stream.bytes) stream.pending.set(body.offset, body.text);
          while (stream.pending.has(stream.bytes)) {
            const chunk = stream.pending.get(stream.bytes)!;
            stream.pending.delete(stream.bytes);
            stream.text += chunk;
            stream.bytes += utf8ByteLength(chunk);
            if (!chunk) break;
          }
          text = stream.text;
          truncated = stream.pending.size > 0;
          // 已读取的完整权威正文不能被迟到的局部补读覆盖。
          if (current?.kind === "message" && current.entryId && !current.truncated && current.totalBytes > stream.bytes) return;
        } else {
          if (event.seq <= (this.versions.get(key) ?? -1)) return;
          this.versions.set(key, event.seq);
          if (current?.kind === "message" && current.entryId && !current.streaming) return;
        }
        this.entries.set(key, {
          key, kind: "message", taskId: body.taskId, role: "assistant", text,
          at: body.startedAt ?? current?.at ?? event.createdAt, seq: Math.min(current?.seq ?? event.seq, event.seq),
          entryId: historyId,
          streaming: current?.kind === "message" ? current.streaming : !historyId || !this.history.has(historyId),
          totalBytes: Math.max(body.totalBytes, current?.kind === "message" ? current.totalBytes : 0, utf8ByteLength(text)), truncated,
        });
        const history = historyId ? this.history.get(historyId) : null;
        if (history) this.reconcileMessage(base, history);
        return;
      }
      case "task.context_compaction": {
        // 同一次压缩的开始与完成共用一条：进行中显示「正在压缩」，完成后换成结果
        const key = `compaction:${body.compactionId}`;
        if (event.seq <= (this.versions.get(key) ?? -1)) return;
        this.versions.set(key, event.seq);
        const at = this.entries.get(key)?.at ?? event.createdAt;
        this.entries.set(key, { key, kind: "note", taskId: body.taskId, at, seq: event.seq, text: compactionText(body) });
        return;
      }
      case "task.output_entry": {
        this.refs.set(body.entryId, { taskId: body.taskId, messageId: body.messageId, at: event.createdAt, seq: event.seq });
        const history = this.history.get(body.entryId);
        if (history) this.addHistory(history);
        return;
      }
      case "task.tool_intent": {
        const key = `tool:${body.toolOpId}`;
        const old = this.entries.get(key);
        if (old?.kind === "tool") {
          // 详情可能先于补读到达；开始事件只补身份/原始顺序，不回滚结果。
          old.seq = event.seq;
          old.params = body.params;
          old.paramsTruncated = body.paramsTruncated ?? false;
          old.target = toolTargetFromParams(old.name, body.params);
          return;
        }
        this.entries.set(key, { key, kind: "tool", taskId: body.taskId, at: event.createdAt, seq: event.seq,
          toolOpId: body.toolOpId, toolCallId: body.sdkCallId, name: body.toolName, params: body.params,
          target: toolTargetFromParams(body.toolName, body.params), status: "running", summary: null, entryId: null,
          paramsTruncated: body.paramsTruncated ?? false, artifactIds: [] });
        for (const entry of this.history.values()) {
          if (entry.toolCallId === body.sdkCallId && this.refs.get(entry.entryId)?.taskId === body.taskId) this.addHistory(entry);
        }
        return;
      }
      case "task.tool_result":
      case "task.tool_effect_unknown": {
        const key = `tool:${body.toolOpId}`;
        const tool = this.entries.get(key);
        if (tool?.kind !== "tool") return;
        if (event.seq <= (this.versions.get(key) ?? -1)) {
          if (body.type === "task.tool_result") {
            tool.editStats ??= body.editStats;
            if (!tool.artifactIds.length) tool.artifactIds = body.artifactIds;
          }
          return;
        }
        this.versions.set(key, event.seq);
        if (body.type === "task.tool_effect_unknown") tool.status = "effect_unknown";
        else {
          tool.status = body.isError ? "error" : "done";
          tool.summary = body.summary;
          tool.artifactIds = body.artifactIds;
          tool.editStats = body.editStats;
        }
        return;
      }
    }
  }

  addHistory(history: HistoryEntryView): void {
    this.history.set(history.entryId, history);
    const ref = history.taskAssociationError ? undefined : this.refs.get(history.entryId);
    const fallback = `history:${history.entryId}`;
    const taskId = history.taskAssociationError ? undefined : history.taskId ?? ref?.taskId;
    if (history.taskAssociationError) {
      const reason = { task_missing: "关联任务不存在", task_outside_session: "关联任务不属于本会话或分支来源", task_marker_missing: "内部回报缺少宿主任务标记" }[history.taskAssociationError];
      this.note(`history-association:${history.entryId}`, `历史条目 ${history.entryId}：${reason}，保留普通展示；请核实会话记录`, history.timestamp);
    }
    if (history.role === "user" && history.inputPurpose === "internal_report") {
      this.entries.delete(fallback);
      if (taskId) this.entries.delete(`input:${taskId}`);
      return;
    }
    if (history.role === "toolResult") {
      // SDK 调用 id 只在单个任务内有意义；引用未到时保留独立历史行，绝不猜任务。
      const tool = ref ? this.tools.find((entry) => entry.toolCallId === history.toolCallId && entry.taskId === ref.taskId) : undefined;
      if (tool) {
        this.entries.delete(fallback);
        tool.entryId = history.entryId;
        if (history.isError) tool.status = "error";
        else if (tool.status === "running") tool.status = "done";
        tool.summary ??= history.text.split("\n")[0] ?? null;
        tool.editStats ??= history.editStats;
        return;
      }
      this.entries.set(fallback, { key: fallback, kind: "tool", at: history.timestamp, seq: ref?.seq ?? 0, taskId: ref?.taskId,
        name: history.toolName ?? "unknown", toolOpId: null, toolCallId: history.toolCallId, params: {}, target: "",
        status: history.isError ? "error" : "done", summary: history.isError ? history.text : null,
        editStats: history.editStats, entryId: history.entryId, paramsTruncated: false, artifactIds: [] });
      return;
    }
    const key = ref?.messageId ? `output:${ref.taskId}:${ref.messageId}` : taskId && history.role === "user" ? `input:${taskId}` : fallback;
    if (ref?.messageId && this.reconcileMessage(key, history)) return;
    const old = this.entries.get(key);
    if (key !== fallback) this.entries.delete(fallback);
    const keepFull = history.truncated && old?.kind === "message" && !old.truncated && utf8ByteLength(old.text) >= history.totalBytes;
    this.entries.set(key, { key, kind: "message", role: history.role, taskId,
      at: old?.at || history.timestamp, seq: old?.seq ?? ref?.seq ?? 0,
      text: keepFull && old.kind === "message" ? old.text : history.text,
      entryId: history.entryId, totalBytes: history.totalBytes, truncated: keepFull ? false : history.truncated, streaming: false, ...(history.attachments ? { attachments: history.attachments } : old?.kind === "message" && old.attachments ? { attachments: old.attachments } : {}) });
  }

  /** 正常分段保持原顺序；缺失或异常 delta 时以完整 JSONL 正文纠正显示。 */
  private reconcileMessage(key: string, history: HistoryEntryView): boolean {
    const segments = [...this.entries.values()]
      .filter((entry): entry is Extract<FlowEntry, { kind: "message" }> => entry.kind === "message" && entry.key.startsWith(`${key}:`))
      .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
    if (!segments.length) return false;
    this.entries.delete(`history:${history.entryId}`);
    for (const segment of segments) {
      segment.entryId = history.entryId;
      segment.streaming = false;
    }
    const texts = segments.map((entry) => entry.text);
    const matches = history.truncated || texts.join("") === history.text;
    if (matches) {
      this.entries.delete(key);
      for (const segment of segments) this.hidden.delete(segment.key);
    } else {
      for (const segment of segments) this.hidden.add(segment.key);
      const first = segments[0]!;
      this.entries.set(key, { ...first, key, text: history.text, totalBytes: history.totalBytes, truncated: false, streaming: false });
    }
    return true;
  }

  installHistory(entries: HistoryEntryView[], replace: boolean, limit: number): { trimmed: boolean; firstId: string | null } {
    if (replace) {
      const wanted = new Set(entries.map((entry) => entry.entryId));
      for (const id of this.history.keys()) if (!wanted.has(id)) this.removeHistory(id);
    }
    for (const entry of entries) this.addHistory(entry);
    const ordered = this.historyEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const remove = Math.max(0, ordered.length - limit);
    for (const entry of ordered.slice(0, remove)) this.removeHistory(entry.entryId);
    return { trimmed: remove > 0, firstId: ordered[remove]?.entryId ?? null };
  }

  private removeHistory(id: string): void {
    this.history.delete(id);
    for (const [key, entry] of this.entries) {
      if ((entry.kind === "message" || entry.kind === "tool") && entry.entryId === id) {
        this.entries.delete(key);
        this.hidden.delete(key);
        this.streams.delete(key);
      }
    }
  }

  note(key: string, text: string, at: string, seq = Number.MAX_SAFE_INTEGER - 1): void {
    this.entries.set(key, { key, kind: "note", text, at, seq });
    const notes = [...this.entries.values()].filter((entry) => entry.kind === "note");
    for (const entry of notes.slice(0, -100)) this.entries.delete(entry.key);
  }

  installCommands(commands: readonly CommandEntry[]): void {
    for (const command of commands) this.entries.set(command.key, command);
  }

  command(key: string, line: string, seq = Number.MAX_SAFE_INTEGER - 1): CommandEntry {
    const command: CommandEntry = { key, kind: "command", line, result: null, isError: false, at: new Date().toISOString(), seq };
    this.entries.set(key, command);
    return command;
  }

  commandResult(key: string, text: string, isError: boolean): CommandEntry | null {
    const command = this.entries.get(key);
    if (command?.kind !== "command") return null;
    // 写不写由斜杠命令条目决定（commands.ts）
    command.result = text;
    command.isError = isError;
    return command;
  }
}
