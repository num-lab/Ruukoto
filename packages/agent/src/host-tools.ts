/**
 * 资料与记忆宿主工具（issue 05 §2/§5）：history_search / history_read /
 * memory_list / memory_read / memory_save / memory_revoke。
 *
 * - 身份由宿主注入（当前任务 → 会话 → 项目）；工具参数不接受 project_id、
 *   角色或文件路径，模型不能自行扩大范围；
 * - 每次调用经 AccessScope 判定：本项目默认可读，跨项目需有效授权；
 * - 结果有界：搜索命中数/扫描量/返回字节均有上限，未扫完如实返回；
 * - 记忆写入关联宿主操作 id（toolOpId），执行结果查询可核实是否已提交；
 * - 记忆不能改变执行身份、权限模式或审批规则（工具说明中明确）。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "@ruukoto/core/store.ts";
import type { AccessScope, Accessor } from "@ruukoto/core/access.ts";
import { AccessDeniedError } from "@ruukoto/core/access.ts";
import type { HistoryIndex } from "@ruukoto/core/history-index.ts";
import { readRawEntryAt, searchHistory, type HistorySearchHit } from "@ruukoto/core/history-index.ts";
import { MemoryConflictError, MemoryNotFoundError, MemoryStore, MemoryValidationError } from "@ruukoto/core/memory.ts";
import type { MemorySourceRef } from "@ruukoto/core/types.ts";
import { sliceTextByBytes } from "@ruukoto/core/history.ts";
import { hostCallFor } from "./host-tool-families.ts";
import type { HostCallBinder, HostToolContext, HostToolFamily, HostToolLedger, HostToolRuntime } from "./host-tool-families.ts";
export type { HostCallBinder, HostToolContext } from "./host-tool-families.ts";
export { hostCallFor } from "./host-tool-families.ts";

export interface HostDataToolsDeps {
  store: Store;
  access: AccessScope;
  historyIndex: HistoryIndex;
  memories: MemoryStore;
  /** 当前任务上下文（宿主注入；工具执行时读取）。 */
  taskContext(): HostToolContext | null;
  /** 绑定一次工具调用的独立句柄；execute 在 finally 中释放。 */
  bindCall?: HostCallBinder;
  data?: HostToolRuntime["data"];
  /** 会话文件解析（sessionId → 文件路径；宿主侧映射，不接受模型路径）。 */
  sessionFileFor(sessionId: string): string | null;
  /** 会话所属项目（宿主侧映射）。 */
  projectOfSession(sessionId: string): string | null;
  /** 同步会话索引（读取前确保索引新鲜；损坏抛错）。 */
  syncSession(sessionId: string): { unindexed: boolean };
}

const SEARCH_RESULT_CAP = 20;
const READ_TEXT_CAP = 64 * 1024;

/**
 * 工具结果。pi 的 AgentToolResult 没有 isError 字段：错误结果必须抛异常
 * （pi 捕获后生成 isError=true 的 toolResult），否则 isError 会被静默吞掉。
 */
function okText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text }] };
}

/** 错误结果：抛异常由 pi 转成 isError=true 的 toolResult（见 okText 说明）。 */
function failText(text: string): never {
  throw new Error(text);
}

function errorText(err: unknown): string {
  if (err instanceof AccessDeniedError) return `拒绝：${err.message}`;
  if (err instanceof MemoryConflictError || err instanceof MemoryNotFoundError || err instanceof MemoryValidationError) {
    return err.message;
  }
  return `操作失败：${(err as Error).message}`;
}

export function createHostDataTools(deps: HostDataToolsDeps): ToolDefinition[] {
  const requireCtx = (ctx: HostToolContext | null) => {
    if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
    return ctx;
  };
  const accessorOf = (ctx: HostToolContext): Accessor => deps.data?.accessor(ctx) ?? { kind: "agent", projectId: ctx.projectId };
  const sessionReadable = (ctx: HostToolContext, sessionId: string) => deps.data?.sessionReadable(ctx, sessionId, "history") ?? true;
  const sourceReadable = (ctx: HostToolContext, ref: MemorySourceRef) => deps.access.sourceRefAccessible(accessorOf(ctx), ref) && (deps.data?.sourceReadable(ctx, ref) ?? true);
  const assertSession = (ctx: HostToolContext, sessionId: string) => {
    if (!sessionReadable(ctx, sessionId)) throw new AccessDeniedError("该会话不在本步骤的资料范围");
  };
  /** 包装 execute：按 sdkCallId 绑定宿主上下文，结束后解除（finally 保证）。 */
  const bindExecute = <P extends Record<string, unknown>>(
    fn: (params: P, ctx: HostToolContext) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) => {
    return async (sdkCallId: string, params: P) => {
      const call = hostCallFor(deps.bindCall, deps.taskContext, sdkCallId);
      try {
        return await fn(params, requireCtx(call.context));
      } finally {
        call.release();
      }
    };
  };

  const historySearch = defineTool({
    name: "history_search",
    label: "history_search",
    description:
      "在当前项目（及拥有者明确开放的项目）的会话历史中做字面关键词搜索。返回命中片段与来源条目 id；" +
      "结果不完整时 complete=false 且带继续游标。不覆盖尚未建立索引的会话（会列出）。",
    parameters: Type.Object({
      query: Type.String({ description: "字面关键词（区分大小写，按原文匹配）" }),
      session_id: Type.Optional(Type.String({ description: "限定会话 id（须属于可读取范围）" })),
      task_id: Type.Optional(Type.String({ description: "限定任务 id（只搜该任务的标记范围；须属于可读取范围）" })),
      role: Type.Optional(Type.String({ description: "角色过滤：user / assistant / toolResult" })),
      since: Type.Optional(Type.String({ description: "起始时间（ISO，含）" })),
      until: Type.Optional(Type.String({ description: "结束时间（ISO，含）" })),
      limit: Type.Optional(Type.Number({ description: `命中数上限（默认 ${SEARCH_RESULT_CAP}）` })),
      cursor: Type.Optional(
        Type.Object({ session_id: Type.String(), byte_offset: Type.Number() }, { description: "上一页的继续游标" }),
      ),
    }),
    execute: bindExecute(async (params, ctx) => {
      try {
        const query = String(params.query ?? "");
        if (!query) return failText("query 不能为空");
        const accessor = accessorOf(ctx);

        // 范围：可读取的项目 → 其下全部会话（或指定会话/任务，须先校验归属与授权）
        let sessionIds: string[];
        let taskId: string | undefined;
        if (typeof params.task_id === "string" && params.task_id) {
          const task = deps.store.getTask(params.task_id);
          if (!task) return failText(`任务不存在：${params.task_id}`);
          const projectId = deps.projectOfSession(task.sessionId);
          if (!projectId) return failText(`任务所属会话不存在：${task.sessionId}`);
          assertSession(ctx, task.sessionId);
          deps.access.assertAccess(accessor, projectId, "history", "任务历史");
          sessionIds = [task.sessionId];
          taskId = task.id;
        } else if (typeof params.session_id === "string" && params.session_id) {
          const projectId = deps.projectOfSession(params.session_id);
          if (!projectId) return failText(`会话不存在：${params.session_id}`);
          assertSession(ctx, params.session_id);
          deps.access.assertAccess(accessor, projectId, "history", "会话历史");
          sessionIds = [params.session_id];
        } else {
          const projects = deps.access.accessibleProjects(accessor, "history");
          sessionIds = deps.store
            .listSessions()
            .filter((s) => projects.includes(s.projectId) && sessionReadable(ctx, s.id))
            .map((s) => s.id);
        }

        // 读取前同步索引；未落盘/未索引的会话如实列出
        const ready: Array<{ sessionId: string; filePath: string }> = [];
        const unindexed: string[] = [];
        for (const sessionId of sessionIds) {
          const file = deps.sessionFileFor(sessionId);
          if (!file) {
            unindexed.push(sessionId);
            continue;
          }
          deps.syncSession(sessionId);
          if (!deps.historyIndex.isIndexed(sessionId)) {
            unindexed.push(sessionId);
            continue;
          }
          ready.push({ sessionId, filePath: file });
        }

        const result = searchHistory(
          deps.store.db,
          ready,
          {
            query,
            taskId,
            role: typeof params.role === "string" ? params.role : undefined,
            since: typeof params.since === "string" ? params.since : undefined,
            until: typeof params.until === "string" ? params.until : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
            cursor:
              params.cursor && typeof params.cursor === "object"
                ? {
                    sessionId: String((params.cursor as any).session_id ?? ""),
                    byteOffset: Number((params.cursor as any).byte_offset ?? -1),
                  }
                : undefined,
          },
        );

        const lines: string[] = [];
        lines.push(
          `命中 ${result.hits.length} 条（扫描 ${result.scanned} 条，${result.complete ? "已覆盖范围内全部已索引历史" : "结果不完整：达到扫描/命中上限"}）`,
        );
        for (const hit of result.hits) {
          lines.push(formatHit(hit));
        }
        if (result.cursor) {
          lines.push(`继续游标：session_id=${result.cursor.sessionId} byte_offset=${result.cursor.byteOffset}`);
        }
        if (unindexed.length > 0) {
          lines.push(`未建立索引的会话（不在本次覆盖内）：${unindexed.join(", ")}`);
        }
        return okText(lines.join("\n"));
      } catch (err) {
        return failText(errorText(err));
      }
    }),
  } as any);

  const historyRead = defineTool({
    name: "history_read",
    label: "history_read",
    description:
      "按条目 id 读取会话历史原文（结构化消息，含工具调用参数与结果）。条目须属于可读取范围；" +
      "超长正文按 offset/length 分段（字节偏移，UTF-8 边界对齐）。",
    parameters: Type.Object({
      session_id: Type.String({ description: "会话 id" }),
      entry_id: Type.String({ description: "条目 id（来自 history_search 或工具结果引用）" }),
      offset: Type.Optional(Type.Number({ description: "正文字节偏移（默认 0）" })),
      length: Type.Optional(Type.Number({ description: `正文读取字节数（默认/上限 ${READ_TEXT_CAP}）` })),
    }),
    execute: bindExecute(async (params, ctx) => {
      try {
        const sessionId = String(params.session_id ?? "");
        const entryId = String(params.entry_id ?? "");
        const projectId = deps.projectOfSession(sessionId);
        if (!projectId) return failText(`会话不存在：${sessionId}`);
        assertSession(ctx, sessionId);
        deps.access.assertAccess(accessorOf(ctx), projectId, "history", "会话历史");
        const file = deps.sessionFileFor(sessionId);
        if (!file) return failText("会话历史尚未落盘，条目不可读");
        deps.syncSession(sessionId);
        const indexed = deps.historyIndex.getEntry(sessionId, entryId);
        if (!indexed) return failText(`历史条目不存在（或尚未入索引）：${entryId}`);
        const raw = readRawEntryAt(file, indexed.byteOffset, indexed.byteLength);
        const message = raw.message as Record<string, unknown> | undefined;
        const header = {
          entryId: raw.id,
          parentId: typeof raw.parentId === "string" ? raw.parentId : null,
          type: raw.type,
          role: message?.role ?? null,
          timestamp: raw.timestamp ?? null,
        };
        // 正文分段：序列化消息体按字节切片（结构完整时一次性返回）
        const full = JSON.stringify(message ?? raw, null, 2);
        const offset = Math.max(0, Number(params.offset ?? 0));
        const length = Math.min(Math.max(256, Number(params.length ?? READ_TEXT_CAP)), READ_TEXT_CAP);
        const slice = sliceTextByBytes(full, offset, length);
        const lines = [
          `条目 ${raw.id}（role=${header.role ?? raw.type}，parent=${header.parentId ?? "无"}，${header.timestamp ?? "无时间"}）`,
          slice.truncated
            ? `正文片段 [${slice.offset}, ${slice.offset + Buffer.byteLength(slice.text, "utf8")}) / 共 ${slice.totalBytes} 字节；下一段 offset=${slice.offset + Buffer.byteLength(slice.text, "utf8")}`
            : `正文完整（${slice.totalBytes} 字节）`,
          slice.text,
        ];
        return okText(lines.join("\n"));
      } catch (err) {
        return failText(errorText(err));
      }
    }),
  } as any);

  const memoryList = defineTool({
    name: "memory_list",
    label: "memory_list",
    description: "列出当前项目生效的长期记忆（含个人共享）。返回 id、类别、版本与正文预览。",
    parameters: Type.Object({
      include_revoked: Type.Optional(Type.Boolean({ description: "同时列出已撤销的记忆（默认 false）" })),
    }),
    execute: bindExecute(async (params, ctx) => {
      try {
        const active = deps.memories.listActiveFor(ctx.projectId)
          .filter((m) => m.sourceRefs.every((ref) => sourceReadable(ctx, ref)));
        for (const memory of active) deps.data?.recordMemory?.(ctx, memory.id);
        const lines: string[] = [`生效记忆 ${active.length} 条：`];
        for (const m of active) {
          const preview = m.content.length > 120 ? `${m.content.slice(0, 120)}…` : m.content;
          lines.push(`- ${m.id} v${m.currentVersion} [${m.category}]（${m.scope === "personal" ? "个人共享" : "本项目"}）${preview}`);
        }
        if (params.include_revoked === true) {
          const revoked = deps.memories.listByProject(ctx.projectId).filter((m) => m.status === "revoked");
          if (revoked.length > 0) {
            lines.push(`已撤销 ${revoked.length} 条：`);
            for (const m of revoked) lines.push(`- ${m.id} v${m.currentVersion} [${m.category}]（已停用，不再自动注入）`);
          }
        }
        return okText(lines.join("\n"));
      } catch (err) {
        return failText(errorText(err));
      }
    }),
  } as any);

  const memoryRead = defineTool({
    name: "memory_read",
    label: "memory_read",
    description: "读取一条记忆的完整正文、来源与修订历史（按版本）。",
    parameters: Type.Object({
      memory_id: Type.String({ description: "记忆 id" }),
      version: Type.Optional(Type.Number({ description: "指定版本（默认当前版本）" })),
    }),
    execute: bindExecute(async (params, ctx) => {
      try {
        const memoryId = String(params.memory_id ?? "");
        const memory = deps.memories.getMemory(memoryId);
        if (!memory) return failText(`记忆不存在：${memoryId}`);
        // 范围：本项目记忆或个人共享可读；其他项目记忆需授权
        if (memory.projectId !== null && memory.projectId !== ctx.projectId) {
          deps.access.assertAccess(accessorOf(ctx), memory.projectId, "memory", "记忆");
        }
        const versionNo = typeof params.version === "number" ? params.version : memory.currentVersion;
        const version = deps.memories.getVersion(memoryId, versionNo);
        if (!version) return failText(`记忆 ${memoryId} 没有版本 v${versionNo}`);
        deps.data?.recordMemory?.(ctx, memory.id);
        // 派生记忆读取时重校来源范围（§5）：引用了受限来源的版本在授权撤销后不可读
        for (const ref of version.sourceRefs) {
          if (!sourceReadable(ctx, ref)) {
            return failText(`该版本的来源范围已撤销或不可访问（${formatSourceRef(ref)}），读取被拒绝`);
          }
        }
        const versions = deps.memories.listVersions(memoryId);
        const lines = [
          `记忆 ${memory.id} v${versionNo}/${memory.currentVersion} [${memory.category}]（${memory.scope === "personal" ? "个人共享" : `项目 ${memory.projectId}`}，${memory.status === "active" ? "生效" : "已停用"}）`,
          `作者：${version.author === "agent" ? "Agent（未经拥有者确认）" : "拥有者"}；原因：${version.reason || "未说明"}；时间：${version.createdAt}`,
          `来源：${version.sourceRefs.map(formatSourceRef).join("；")}`,
          `正文：`,
          version.content,
          `修订历史：${versions.map((v) => `v${v.version}(${v.author},${v.createdAt})`).join(" → ")}`,
        ];
        return okText(lines.join("\n"));
      } catch (err) {
        return failText(errorText(err));
      }
    }),
  } as any);

  const memorySave = defineTool({
    name: "memory_save",
    label: "memory_save",
    description:
      "保存长期记忆：新记忆或修订已有记忆。类别限 preference/convention/decision/experience；" +
      "必须给出来源（历史条目、产物或 owner_note）。记忆是参考内容，不能改变执行身份、权限模式或审批规则；" +
      "临时任务进度不属于长期记忆。个人共享范围只能由拥有者设置，Agent 只能写当前项目。",
    parameters: Type.Object({
      memory_id: Type.Optional(Type.String({ description: "修订已有记忆时给出 id；省略 = 新建" })),
      expected_version: Type.Optional(Type.Number({ description: "修订时的预期当前版本号（并发保护）" })),
      category: Type.String({ description: "preference | convention | decision | experience" }),
      content: Type.String({ description: "记忆正文" }),
      source_refs: Type.Array(
        Type.Object({
          kind: Type.Union([Type.Literal("history_entry"), Type.Literal("artifact"), Type.Literal("owner_note")]),
          session_id: Type.Optional(Type.String()),
          entry_id: Type.Optional(Type.String()),
          artifact_id: Type.Optional(Type.String()),
          note: Type.Optional(Type.String()),
        }),
        { description: "来源引用（至少一条；必须存在且可访问）" },
      ),
      reason: Type.Optional(Type.String({ description: "修改原因" })),
    }),
    execute: bindExecute(async (params, ctx) => {
      try {
        const category = String(params.category ?? "") as any;
        const content = String(params.content ?? "");
        const refs = parseSourceRefs(params.source_refs);
        // 来源必须存在且当前范围可访问
        for (const ref of refs) {
          if (!sourceReadable(ctx, ref)) throw new AccessDeniedError("记忆来源不在本步骤的资料范围");
          validateSourceRef(deps, accessorOf(ctx), ref);
        }

        const memoryId = typeof params.memory_id === "string" && params.memory_id ? params.memory_id : null;
        if (memoryId === null) {
          const created = deps.store.withTx(() => {
            const m = deps.memories.create({
              projectId: ctx.projectId,
              category,
              content,
              sourceRefs: refs,
              author: "agent",
              toolOpId: ctx.hostOpId,
              taskId: ctx.taskId,
              reason: typeof params.reason === "string" ? params.reason : "",
            });
            deps.store.appendEvent(
              { type: "memory.saved", memoryId: m.id, projectId: m.projectId, version: 1, author: "agent", taskId: ctx.taskId },
              { taskId: ctx.taskId, sessionId: ctx.sessionId },
            );
            return m;
          });
          return okText(`已创建记忆 ${created.id} v1（项目 ${ctx.projectId}）`);
        }
        const existing = deps.memories.getMemory(memoryId);
        if (!existing) return failText(`记忆不存在：${memoryId}`);
        if (existing.projectId !== ctx.projectId) {
          return failText("不能修改其他项目或个人共享的记忆（需拥有者在可信入口操作）");
        }
        const expected = Number(params.expected_version ?? -1);
        if (expected < 1) return failText("修订必须给出 expected_version（先 memory_read 获取当前版本）");
        const revised = deps.store.withTx(() => {
          const m = deps.memories.revise({
            memoryId,
            expectedVersion: expected,
            content,
            sourceRefs: refs,
            author: "agent",
            toolOpId: ctx.hostOpId,
            taskId: ctx.taskId,
            reason: typeof params.reason === "string" ? params.reason : "",
          });
          deps.store.appendEvent(
            { type: "memory.saved", memoryId: m.id, projectId: m.projectId, version: m.currentVersion, author: "agent", taskId: ctx.taskId },
            { taskId: ctx.taskId, sessionId: ctx.sessionId },
          );
          return m;
        });
        return okText(`已修订记忆 ${revised.id} → v${revised.currentVersion}`);
      } catch (err) {
        return failText(errorText(err));
      }
    }),
  } as any);

  const memoryRevoke = defineTool({
    name: "memory_revoke",
    label: "memory_revoke",
    description: "撤销当前项目的一条记忆（标为停用，不再自动注入；旧版本保留可查，可经拥有者恢复）。",
    parameters: Type.Object({
      memory_id: Type.String({ description: "记忆 id" }),
      expected_version: Type.Number({ description: "预期当前版本号（并发保护）" }),
      reason: Type.Optional(Type.String({ description: "撤销原因" })),
    }),
    execute: bindExecute(async (params, ctx) => {
      try {
        const memoryId = String(params.memory_id ?? "");
        const existing = deps.memories.getMemory(memoryId);
        if (!existing) return failText(`记忆不存在：${memoryId}`);
        if (existing.projectId !== ctx.projectId) {
          return failText("不能撤销其他项目或个人共享的记忆（需拥有者在可信入口操作）");
        }
        const revoked = deps.store.withTx(() => {
          const m = deps.memories.revoke({
            memoryId,
            expectedVersion: Number(params.expected_version),
            author: "agent",
            toolOpId: ctx.hostOpId,
            taskId: ctx.taskId,
            reason: typeof params.reason === "string" ? params.reason : "",
          });
          deps.store.appendEvent(
            { type: "memory.revoked", memoryId: m.id, projectId: m.projectId, version: m.currentVersion, author: "agent", taskId: ctx.taskId },
            { taskId: ctx.taskId, sessionId: ctx.sessionId },
          );
          return m;
        });
        return okText(`已撤销记忆 ${revoked.id}（v${revoked.currentVersion} 停用；历史版本保留）`);
      } catch (err) {
        return failText(errorText(err));
      }
    }),
  } as any);

  return [historySearch, historyRead, memoryList, memoryRead, memorySave, memoryRevoke] as ToolDefinition[];
}

export const HOST_DATA_TOOL_NAMES = ["history_search", "history_read", "memory_list", "memory_read", "memory_save", "memory_revoke"] as const;

export const HOST_DATA_LEDGER: HostToolLedger = {
  names: HOST_DATA_TOOL_NAMES,
  ruleFor: (name) => ["memory_save", "memory_revoke"].includes(name) ? "approval" : "no_effect",
};

export function createHostDataFamily(config: Omit<HostDataToolsDeps, "taskContext" | "bindCall">): HostToolFamily {
  return {
    category: "host_data",
    names: HOST_DATA_TOOL_NAMES,
    build: (runtime) => createHostDataTools({ ...config, ...runtime.call, data: runtime.data }),
    ledger: HOST_DATA_LEDGER,
  };
}

function formatHit(hit: HistorySearchHit): string {
  return `- [${hit.sessionId}/${hit.entryId}]（${hit.role ?? "?"}，${hit.timestamp ?? "无时间"}，命中 ${hit.matchCount} 次）${hit.snippet.replace(/\n/g, " ⏎ ")}`;
}

function formatSourceRef(ref: MemorySourceRef): string {
  switch (ref.kind) {
    case "history_entry":
      return `历史条目 ${ref.sessionId}/${ref.entryId}`;
    case "artifact":
      return `产物 ${ref.artifactId}`;
    case "owner_note":
      return `拥有者记录（${ref.note}）`;
  }
}

function parseSourceRefs(raw: unknown): MemorySourceRef[] {
  if (!Array.isArray(raw)) throw new MemoryValidationError("source_refs 必须是数组");
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    switch (o.kind) {
      case "history_entry":
        return { kind: "history_entry", sessionId: String(o.session_id ?? ""), entryId: String(o.entry_id ?? "") };
      case "artifact":
        return { kind: "artifact", artifactId: String(o.artifact_id ?? "") };
      case "owner_note":
        return { kind: "owner_note", note: String(o.note ?? "") };
      default:
        throw new MemoryValidationError(`未知来源类型：${String(o.kind)}`);
    }
  });
}

/** 来源存在且当前范围可访问（history_entry 需已入索引；artifact 需归属可访问项目）。 */
function validateSourceRef(deps: HostDataToolsDeps, accessor: Accessor, ref: MemorySourceRef): void {
  if (ref.kind === "history_entry") {
    const projectId = deps.projectOfSession(ref.sessionId);
    if (!projectId) throw new MemoryValidationError(`来源会话不存在：${ref.sessionId}`);
    deps.access.assertAccess(accessor, projectId, "history", "来源历史");
    deps.syncSession(ref.sessionId);
    if (!deps.historyIndex.getEntry(ref.sessionId, ref.entryId)) {
      throw new MemoryValidationError(`来源历史条目不存在（或尚未入索引）：${ref.entryId}`);
    }
    return;
  }
  if (ref.kind === "artifact") {
    const artifact = deps.store.getArtifact(ref.artifactId);
    if (!artifact) throw new MemoryValidationError(`来源产物不存在：${ref.artifactId}`);
    const projectId = deps.projectOfSession(artifact.sessionId);
    if (!projectId) throw new MemoryValidationError(`来源产物所属会话不存在：${artifact.sessionId}`);
    deps.access.assertAccess(accessor, projectId, "artifact", "来源产物");
    return;
  }
  // owner_note：Agent 不能伪造拥有者确认
  throw new MemoryValidationError("owner_note 来源只能由拥有者操作产生，Agent 请引用历史条目或产物");
}
