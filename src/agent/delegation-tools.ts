/**
 * main 委派 coding 的宿主工具（issue 05）：coding_delegate / coding_result。
 * 仅宿主引导的 main 角色会话装配。
 *
 * - 模型只给正文、模式（analyze/draft）、幂等键与资料引用；目标角色、工作目录、
 *   confirm 模式与截止时间由宿主（编排器 delegateCoding）固定；
 * - 只有拥有者发起的 main 任务可委派（直接提交，或 Telegram/QQ owner 入站）；
 *   定时唤醒与子任务唤醒触发的任务不能委派，外部内容无法借此连环创建任务；
 * - 资料引用在委派时解析为文本快照写入子任务正文（复用通知的来源解析），
 *   coding 拿不到 main 的原始资料引用；
 * - coding_result 只读父任务在 main 会话中的 coding 子任务（按父子关系开的窄口，
 *   不扩大跨项目资料授权），最终回答与产物分页读取。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "../core/store.ts";
import type { Task } from "../core/types.ts";
import type { HistoryEntryView } from "../core/history.ts";
import { delegationRequestDigest, type DelegationMode, type DelegationResult } from "../runtime/orchestrator.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { TELEGRAM_SOURCE } from "../telegram/adapter.ts";
import { QQ_PRIVATE_SOURCE } from "../qq/adapter.ts";
import type { HostToolContext } from "./host-tools.ts";
import type { SourceResolver } from "./scheduler-tools.ts";
import { canonicalParamsDigest } from "./mcp/tools.ts";

export const DELEGATION_TOOL_NAMES = ["coding_delegate", "coding_result"] as const;

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** coding_result 单次读取上限（字节）。 */
const READ_LIMITS = { replyBytes: 16 * 1024, artifactBytes: 64 * 1024 };

/**
 * 恢复/停止路径共用：未落结果的委派工具操作按子任务是否存在核实（同库，恒可
 * 核实）——存在即已委派，不存在即已知未委派。调用方负责事务。
 */
export function settleDelegationOp(coreStore: Store, task: { id: string; sessionId: string }, op: { id: string; toolName: string; params: Record<string, unknown> }, when: string): void {
  if (op.toolName === "coding_result") {
    const summary = `已知未执行：只读查询在${when}未产生写入效果`;
    if (coreStore.recordToolResult(op.id, summary, true)) {
      coreStore.appendEvent(
        { type: "task.tool_result", taskId: task.id, toolOpId: op.id, summary, isError: true, artifactIds: [] },
        { taskId: task.id, sessionId: task.sessionId },
      );
    }
    return;
  }
  const committed = coreStore.findChildTask(task.id, `deleg:${task.id}:${String(op.params.key ?? "")}`) !== null;
  const summary = committed ? `已提交：子任务已创建（${when}已委派）` : `已知未提交：不存在对应子任务（${when}未委派）`;
  if (coreStore.recordToolResult(op.id, summary, !committed)) {
    coreStore.appendEvent(
      { type: "task.tool_result", taskId: task.id, toolOpId: op.id, summary, isError: !committed, artifactIds: [] },
      { taskId: task.id, sessionId: task.sessionId },
    );
  }
}

export interface DelegationToolsDeps {
  coreStore: Store;
  sources: SourceResolver;
  delegate(input: { parentTaskId: string; mode: DelegationMode; request: string; idempotencyKey: string; requestDigest: string }): Promise<Task>;
  /** 指定任务的最终 assistant 文本（按任务历史条目）。 */
  readReply(taskId: string, offset: number, length: number): HistoryEntryView | null;
  resultNotice?(task: Task): string | null;
  artifacts: ArtifactStore;
  taskContext(): HostToolContext | null;
  bindCall?(sdkCallId: string): () => void;
  verifyMain(ctx: HostToolContext): string | null;
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function createDelegationTools(deps: DelegationToolsDeps): ToolDefinition[] {
  const store = deps.coreStore;
  const bindExecute = <P extends Record<string, unknown>>(fn: (ctx: HostToolContext, params: P) => Promise<{ content: Array<{ type: "text"; text: string }> }>) =>
    async (sdkCallId: string, params: P) => {
      const unbind = deps.bindCall?.(sdkCallId) ?? (() => {});
      try {
        const ctx = deps.taskContext();
        if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
        const problem = deps.verifyMain(ctx);
        if (problem) throw new Error(`身份校验失败：${problem}`);
        return await fn(ctx, params);
      } finally {
        unbind();
      }
    };

  /** 拥有者发起的任务：直接提交（无角色来源），或已核实身份的 owner 私聊入站。 */
  const ownerOriginated = (task: Task): boolean => {
    if (task.sourceEventId) {
      const source = store.getInboundEvent(task.sourceEventId)?.source;
      return source === TELEGRAM_SOURCE || source === QQ_PRIVATE_SOURCE;
    }
    return task.agentId === null;
  };

  const codingDelegate = defineTool({
    name: "coding_delegate",
    label: "coding_delegate",
    description:
      "拥有者明确提出编码、仓库、PR、测试或修改请求时，委派给 coding 角色执行。coding 在宿主固定的独立工作目录中工作" +
      "（需要仓库时自行 git clone），权限模式固定为请求确认，外部发布仍需拥有者审批。mode=analyze 只做读取与分析" +
      "（仅可证明只读且无批准审批、无未知效果的失败任务自动重试一次；bash/MCP 不自动重试），" +
      "mode=draft 可生成修改草稿（不重试）。完成、失败、超时或结果未知时编排器会唤醒 main。同 key 同参返回原子任务，异参冲突。",
    parameters: Type.Object({
      request: Type.String({ description: "委派正文：要 coding 做什么（仓库地址、目标、验收要求）" }),
      mode: Type.Union([Type.Literal("analyze"), Type.Literal("draft")]),
      key: Type.String({ description: "幂等键（字母/数字/_/-，≤64；重试用同一个）" }),
      materials: Type.Optional(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description:
            "随委派传入的资料（≤8 个，委派时解析为文本快照）：{kind:'text',text} | {kind:'task_result',task_id} | " +
            "{kind:'artifact',artifact_id,offset?,length?} | {kind:'app_data',table,row_id,field}",
        }),
      ),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const task = store.getTask(ctx.taskId);
      if (!task || !ownerOriginated(task)) {
        throw new Error("只有拥有者直接提出的请求可以委派 coding（定时唤醒、子任务结果触发的任务不能委派）");
      }
      if (params.mode !== "analyze" && params.mode !== "draft") throw new Error("mode 只能是 analyze 或 draft");
      if (typeof params.key !== "string" || !KEY_RE.test(params.key)) throw new Error("key 必须是 1–64 位字母、数字、_ 或 -");
      if (typeof params.request !== "string" || !params.request.trim()) throw new Error("request 不能为空");
      const requestDigest = canonicalParamsDigest({ request: params.request, mode: params.mode, materials: params.materials ?? null });
      let child = store.findChildTask(task.id, `deleg:${task.id}:${params.key}`);
      if (child) {
        // 比较原始参数，重复提交复用首次解析的快照，不受来源后续变更影响。
        if (delegationRequestDigest(child) !== requestDigest) throw new Error(`委派幂等键冲突：${params.key} 已绑定参数不同的子任务 ${child.id}`);
      } else {
        let request = params.request as string;
        if (params.materials !== undefined) {
          if (Array.isArray(params.materials) && params.materials.some((source: any) => source?.kind === "chat_result")) {
            throw new Error("已接收群摘要仅供 main 与通知使用，不能作为 coding 委派资料");
          }
          const { text } = deps.sources.resolve(ctx.projectId, params.materials);
          request += `\n[资料快照]\n${text}`;
        }
        child = await deps.delegate({ parentTaskId: task.id, mode: params.mode, request, idempotencyKey: params.key, requestDigest });
      }
      return okText(
        `已委派 coding：子任务 ${child.id}（模式 ${params.mode}，截止 ${child.deadline ?? "无"}）。` +
          "完成、失败、超时或结果未知时编排器会唤醒 main。",
      );
    }),
  } as any);

  /** 非负整数参数（缺省取 fallback，超上限拒绝）。 */
  const intParam = (raw: unknown, fallback: number, max: number, what: string): number => {
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`${what} 必须是 0–${max} 的整数`);
    return n;
  };

  const codingResult = defineTool({
    name: "coding_result",
    label: "coding_result",
    description:
      "读取 main 委派的 coding 子任务结果：part=result（默认）看状态与结构化结果；part=reply 按 UTF-8 字节分页读最终回答（length 为 256–16384）；" +
      "part=artifact 按字节分页读该子任务的产物（artifact_id 见结果中的产物列表）。",
    parameters: Type.Object({
      task_id: Type.String(),
      part: Type.Optional(Type.Union([Type.Literal("result"), Type.Literal("reply"), Type.Literal("artifact")])),
      artifact_id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      length: Type.Optional(Type.Number()),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const child = typeof params.task_id === "string" ? store.getTask(params.task_id) : null;
      const parent = child?.parentTaskId ? store.getTask(child.parentTaskId) : null;
      if (!child || child.agentId !== "coding" || !parent || parent.sessionId !== ctx.sessionId) {
        throw new Error("只能读取 main 委派的 coding 子任务");
      }
      const notice = deps.resultNotice?.(child);
      const resultText = (text: string) => okText(notice ? `${notice}\n${text}` : text);
      const part = params.part ?? "result";
      if (part === "reply") {
        const offset = intParam(params.offset, 0, Number.MAX_SAFE_INTEGER, "offset");
        const length = intParam(params.length, READ_LIMITS.replyBytes, READ_LIMITS.replyBytes, "length");
        if (length < 256) throw new Error("reply length 必须至少为 256 字节");
        const page = deps.readReply(child.id, offset, length);
        if (page === null) return resultText(`子任务 ${child.id}（${child.status}）暂无最终回答`);
        const end = page.offset + Buffer.byteLength(page.text);
        return resultText(`[最终回答 第 ${page.offset}–${end} 字节，共 ${page.totalBytes}${end < page.totalBytes ? `；继续用 offset=${end}` : ""}]\n${page.text}`);
      }
      if (part === "artifact") {
        const artifact = typeof params.artifact_id === "string" ? store.getArtifact(params.artifact_id) : null;
        if (!artifact || artifact.taskId !== child.id) throw new Error("产物不存在或不属于该子任务");
        if (artifact.name.startsWith("prompt-snapshot:")) throw new Error("模型上下文快照不属于交付产物");
        const offset = intParam(params.offset, 0, artifact.byteCount, "offset");
        const length = intParam(params.length, READ_LIMITS.artifactBytes, READ_LIMITS.artifactBytes, "length");
        if (length < 4) throw new Error("artifact length 必须至少为 4 字节");
        const buf = deps.artifacts.read(artifact.id, offset, length);
        let text: string;
        try {
          // 非末页保留尾部未完成的 UTF-8 字符给下一页，不替换成损坏字符。
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf, { stream: offset + buf.length < artifact.byteCount });
        } catch {
          throw new Error("产物片段不是合法 UTF-8 文本，或 offset 未对齐字符边界");
        }
        const end = offset + Buffer.byteLength(text);
        return resultText(
          `[产物 ${artifact.id}（${artifact.name}，${artifact.status}）第 ${offset}–${end} 字节，共 ${artifact.byteCount}` +
            `${end < artifact.byteCount ? `；继续用 offset=${end}` : ""}]\n${text}`,
        );
      }
      const lines = [`子任务 ${child.id} · ${child.status} · 截止 ${child.deadline ?? "无"}`];
      if (child.resultRef) {
        const r = JSON.parse(child.resultRef) as Partial<DelegationResult>;
        lines.push(
          `结果：${r.outcome ?? "?"} · 模式 ${r.mode ?? "?"} · 测试 ${r.tests ?? "?"}（coding 自报） · 需要拥有者 ${r.needsOwner ? `是（${r.needsOwnerReason}）` : "否"} · 效果 ${r.effect ?? "?"}`,
          ...(r.failure ? [`失败原因：${r.failure}`] : []),
          ...(r.retriedBy ? [`已自动重试：子任务 ${r.retriedBy}`] : []),
          `产物：${r.artifactIds?.length ? r.artifactIds.join(", ") : "无"}`,
          `摘要：${child.resultSummary ?? ""}`,
        );
      } else {
        lines.push("尚未结束或结果尚未记录");
      }
      return resultText(lines.join("\n"));
    }),
  } as any);

  return [codingDelegate, codingResult];
}
