/**
 * 通用 SubAgent 委派工具（agent-direction issue 11）：subagent_delegate /
 * subagent_result。对拥有者的普通开发会话与 main 角色会话装配；其余身份
 * （群、固定 coding/chat、动态 SubAgent、调度与回报唤醒）一律不装配也不放行。
 *
 * - 模型只给正文、幂等键、可选既有 workId 与选定资料（dev: read_paths /
 *   main: materials）；目标身份、独立目录、confirm 模式、只读工具与截止时间
 *   由宿主固定（见 src/runtime/subagents.ts）；
 * - 只有拥有者发起的任务可委派（直接提交，或已核实身份的 Telegram/QQ 私聊
 *   入站）；定时唤醒、子任务回报与 SubAgent 任务不能委派下级；
 * - 工具在子任务入队后立即返回，不等待子模型结束；结果经持久事件与
 *   subagent_result 查询，dev 会话再经下一次模型调用的宿主资料注入送达；
 * - subagent_result 按（所属父用户会话, workId）开窄口：只能读本会话登记
 *   的工作；最终回答与产物沿用 UTF-8/字节分页。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "../core/store.ts";
import type { Task } from "../core/types.ts";
import type { HistoryEntryView } from "../core/history.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { TELEGRAM_SOURCE } from "../telegram/adapter.ts";
import { QQ_PRIVATE_SOURCE } from "../qq/adapter.ts";
import type { HostToolContext } from "./host-tools.ts";
import type { SourceResolver } from "./scheduler-tools.ts";
import { canonicalParamsDigest } from "./mcp/tools.ts";
import type { SubAgentDelegation, SubAgentDelegateInput } from "../runtime/subagents.ts";

export const SUBAGENT_TOOL_NAMES = ["subagent_delegate", "subagent_result"] as const;

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** subagent_result 单次读取上限（字节）。 */
const READ_LIMITS = { replyBytes: 16 * 1024, artifactBytes: 64 * 1024 };

export interface SubAgentToolsDeps {
  coreStore: Store;
  sources: SourceResolver;
  delegate(input: SubAgentDelegateInput): Promise<SubAgentDelegation>;
  /** 指定任务的最终 assistant 文本（按任务历史条目）。 */
  readReply(taskId: string, offset: number, length: number): HistoryEntryView | null;
  artifacts: ArtifactStore;
  taskContext(): HostToolContext | null;
  bindCall?(sdkCallId: string): () => void;
  /** Driver 注入：会话/任务/绑定重核（普通开发会话或 main；SubAgent 拒绝）。 */
  verifyHost(ctx: HostToolContext): string | null;
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function createSubAgentTools(deps: SubAgentToolsDeps): ToolDefinition[] {
  const store = deps.coreStore;
  const bindExecute = <P extends Record<string, unknown>>(fn: (ctx: HostToolContext, params: P) => Promise<{ content: Array<{ type: "text"; text: string }> }>) =>
    async (sdkCallId: string, params: P) => {
      const unbind = deps.bindCall?.(sdkCallId) ?? (() => {});
      try {
        const ctx = deps.taskContext();
        if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
        const problem = deps.verifyHost(ctx);
        if (problem) throw new Error(`身份校验失败：${problem}`);
        return await fn(ctx, params);
      } finally {
        unbind();
      }
    };

  /**
   * 拥有者发起的任务：直接提交（agentId 为空、无来源事件、无 SubAgent 关联），
   * 或已核实身份的 owner 私聊入站。调度唤醒、子任务回报与其他来源不能委派。
   */
  const ownerOriginated = (task: Task): boolean => {
    if (task.subAgentId) return false;
    if (task.sourceEventId) {
      const source = store.getInboundEvent(task.sourceEventId)?.source;
      return source === TELEGRAM_SOURCE || source === QQ_PRIVATE_SOURCE;
    }
    return task.agentId === null;
  };

  const subagentDelegate = defineTool({
    name: "subagent_delegate",
    label: "subagent_delegate",
    description:
      "为一项分析/读取工作创建通用 SubAgent 并登记一次执行任务：拥有独立会话与宿主生成的独立工作目录，" +
      "工具只有 read / read_artifact（只读），权限固定请求确认，不能委派下级。开发会话用 read_paths 指定父工作区内" +
      "或父任务已授予的只读路径；main 会话用 materials 指定资料（委派时解析为文本快照）。首次省略 work_id 建立工作，" +
      "返回 workId、subAgentId、taskId 与截止时间；同 key 同参返回原记录，异参冲突。子任务入队后立即返回，" +
      "结果完成后经宿主通知，用 subagent_result 读取。",
    parameters: Type.Object({
      request: Type.String({ description: "委派正文：要 SubAgent 做什么（目标、范围、验收要求）" }),
      key: Type.String({ description: "幂等键（字母/数字/_/-，≤64；重试用同一个）" }),
      work_id: Type.Optional(Type.String({ description: "既有工作 id（沿原工作增加新的分析执行）；省略即首次委派" })),
      read_paths: Type.Optional(
        Type.Array(Type.String(), { description: "仅限开发会话：父工作区内或父任务已授予的待读路径（最多 16 个，只读）" }),
      ),
      materials: Type.Optional(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description:
            "仅限 main 会话：随委派传入的资料（≤8 个，委派时解析为文本快照）：{kind:'text',text} | {kind:'task_result',task_id} | " +
            "{kind:'artifact',artifact_id,offset?,length?} | {kind:'app_data',table,row_id,field}",
        }),
      ),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const task = store.getTask(ctx.taskId);
      if (!task || !ownerOriginated(task)) {
        throw new Error("只有拥有者直接提出的请求可以委派 SubAgent（调度唤醒、子任务回报与其他来源的任务不能委派）");
      }
      if (typeof params.key !== "string" || !KEY_RE.test(params.key)) throw new Error("key 必须是 1–64 位字母、数字、_ 或 -");
      if (typeof params.request !== "string" || !params.request.trim()) throw new Error("request 不能为空");
      if (params.work_id !== undefined && (typeof params.work_id !== "string" || !params.work_id.trim())) {
        throw new Error("work_id 必须是既有工作 id");
      }
      const role = store.getAgentRoleBySession(ctx.sessionId);
      const isMain = role?.id === "main";
      const readPaths = params.read_paths === undefined ? null : params.read_paths;
      const materials = params.materials === undefined ? null : params.materials;
      if (readPaths !== null) {
        if (isMain) throw new Error("main 会话不能指定 read_paths（请用 materials 引用资料）");
        if (!Array.isArray(readPaths) || readPaths.length === 0 || readPaths.length > 16 || readPaths.some((p) => typeof p !== "string")) {
          throw new Error("read_paths 必须是 1–16 个路径字符串");
        }
      }
      if (materials !== null) {
        if (!isMain) throw new Error("开发会话不能指定 materials（请用 read_paths 指定只读路径）");
        if (!Array.isArray(materials) || materials.length === 0 || materials.length > 8) throw new Error("materials 必须是 1–8 个资料对象");
        if (materials.some((source: any) => source?.kind === "chat_result")) {
          throw new Error("已接收群摘要仅供 main 与通知使用，不能作为委派资料");
        }
      }
      if (readPaths === null && materials === null) {
        throw new Error("必须指定分析对象：开发会话用 read_paths，main 会话用 materials");
      }
      const paramsDigest = canonicalParamsDigest({
        request: params.request,
        key: params.key,
        work_id: params.work_id ?? null,
        read_paths: readPaths ? [...readPaths].sort() : null,
        materials: materials ?? null,
      });
      const delegation = await deps.delegate({
        parentTaskId: task.id,
        key: params.key,
        request: params.request,
        workId: params.work_id ?? null,
        materials,
        readPaths,
        paramsDigest,
      });
      return okText(
        (delegation.created ? "已委派 SubAgent" : "同键同参已委派过，返回原记录") +
          `：工作 ${delegation.work.id}，SubAgent ${delegation.agent.id}，任务 ${delegation.task.id}` +
          `（截止 ${delegation.task.deadline ?? "无"}）。` +
          "子任务已在后台执行；完成后宿主会通知，完整结果用 subagent_result 按 work_id 读取。",
      );
    }),
  } as any);

  /** 非负整数参数（缺省取 fallback，超上限拒绝）。 */
  const intParam = (raw: unknown, fallback: number, max: number, what: string): number => {
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`${what} 必须是 0–${max} 的整数`);
    return n;
  };

  const subagentResult = defineTool({
    name: "subagent_result",
    label: "subagent_result",
    description:
      "读取本会话登记的工作委托与 SubAgent 结果：part=result（默认）看工作状态、SubAgent 与任务摘要；" +
      "part=reply 按 UTF-8 字节分页读指定/最新任务的最终回答（length 为 256–16384）；" +
      "part=artifact 按字节分页读该任务的产物（artifact_id 见结果中的产物列表）。",
    parameters: Type.Object({
      work_id: Type.String({ description: "subagent_delegate 返回的工作 id" }),
      part: Type.Optional(Type.Union([Type.Literal("result"), Type.Literal("reply"), Type.Literal("artifact")])),
      task_id: Type.Optional(Type.String({ description: "工作内的某次执行任务 id；缺省取最近一次" })),
      artifact_id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      length: Type.Optional(Type.Number()),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const work = typeof params.work_id === "string" ? store.getWorkDelegation(params.work_id) : null;
      if (!work || work.parentSessionId !== ctx.sessionId) {
        throw new Error("只能读取本会话登记的工作委托");
      }
      const agent = store.getSubAgent(work.subAgentId);
      if (!agent) throw new Error(`工作 ${work.id} 缺少 SubAgent 记录`);
      const tasks = store.listTasksByWork(work.id);
      const part = params.part ?? "result";
      if (part === "result") {
        const lines = [`工作 ${work.id} · SubAgent ${agent.id}（${agent.state}）· 发起任务 ${work.originTaskId}`];
        for (const t of tasks) {
          lines.push(
            `- 任务 ${t.id} · ${t.status} · 直接父任务 ${t.parentTaskId ?? "?"} · 截止 ${t.deadline ?? "无"}` +
              (t.resultSummary ? `\n  摘要：${t.resultSummary}` : ""),
          );
        }
        if (tasks.length === 0) lines.push("尚无执行任务");
        return okText(lines.join("\n"));
      }
      const target = params.task_id
        ? tasks.find((t) => t.id === params.task_id) ?? null
        : (tasks.filter((t) => t.resultSummary !== null).at(-1) ?? tasks.at(-1) ?? null);
      if (!target) throw new Error(`任务不属于工作 ${work.id} 或不提供 task_id 时尚无执行`);
      if (part === "reply") {
        const offset = intParam(params.offset, 0, Number.MAX_SAFE_INTEGER, "offset");
        const length = intParam(params.length, READ_LIMITS.replyBytes, READ_LIMITS.replyBytes, "length");
        if (length < 256) throw new Error("reply length 必须至少为 256 字节");
        const page = deps.readReply(target.id, offset, length);
        if (page === null) return okText(`任务 ${target.id}（${target.status}）暂无最终回答`);
        const end = page.offset + Buffer.byteLength(page.text);
        return okText(`[最终回答 第 ${page.offset}–${end} 字节，共 ${page.totalBytes}${end < page.totalBytes ? `；继续用 offset=${end}` : ""}]\n${page.text}`);
      }
      const artifact = typeof params.artifact_id === "string" ? store.getArtifact(params.artifact_id) : null;
      if (!artifact || artifact.taskId !== target.id) throw new Error("产物不存在或不属于该任务的执行");
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
      return okText(
        `[产物 ${artifact.id}（${artifact.name}，${artifact.status}）第 ${offset}–${end} 字节，共 ${artifact.byteCount}` +
          `${end < artifact.byteCount ? `；继续用 offset=${end}` : ""}]\n${text}`,
      );
    }),
  } as any);

  return [subagentDelegate, subagentResult];
}
