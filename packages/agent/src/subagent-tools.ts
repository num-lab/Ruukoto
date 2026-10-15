/**
 * Note: 见 .agents/notes/implemented/architecture/2026-10-15-workflow-role-interface.md
 * 通用 SubAgent 委派工具（agent-direction issue 11；issue 12 继续/复用/关闭；
 * issue 13 工作内协作消息与协作加入；issue 14 整项取消；issue 17 改动汇总与
 * main 修改委派）：subagent_delegate / subagent_result / subagent_close /
 * subagent_cancel / subagent_message / subagent_integrate。前五个对拥有者的普通
 * 开发会话与 main 角色会话装配（subagent_message 另行对 SubAgent 子会话装配）；
 * 其余身份一律不装配也不放行（subagent_close / subagent_cancel / subagent_integrate
 * 例外：回报唤醒轮次也允许——关闭与取消只收窄能力，汇总只作用于本会话自己
 * 登记的成果）。
 *
 * - 模型只给正文、幂等键、可选既有 workId / subAgentId 与选定资料
 *   （dev: read_paths / main: materials）；目标身份、独立目录、发起任务的访问模式、
 *   只读工具与截止时间由宿主固定（见 packages/runtime/src/subagents.ts）；
 * - 只有拥有者发起的任务可委派（直接提交，或已核实身份的 Telegram/QQ 私聊
 *   入站）、独立调度运行及宿主保存来源授权的工作唤醒；SubAgent 不能委派下级；
 * - 工具在子任务入队后立即返回，不等待子模型结束；结果经持久事件与
 *   subagent_result 查询，dev 会话再经下一次模型调用的宿主资料注入送达；
 * - subagent_result 省略 work_id 时列出本会话的 SubAgent 总览（供挑选复用
 *   对象）；按 work_id 读取时开窄口：只能读本会话登记的工作，并标明该工作
 *   是否已取消、该 SubAgent 是否已关闭；part=messages 列出工作内协作消息
 *   （issue 13：来源、投递状态与正文预览）；最终回答与产物沿用 UTF-8/字节分页；
 * - subagent_close 显式关闭：有活动任务拒绝（给出任务 id），已关闭幂等；
 *   关闭后拒绝新委派，历史与产物保留可查；
 * - subagent_cancel 整项取消（issue 14）：停止本工作的活动与排队任务，其他
 *   工作不受影响；已取消幂等；取消后不能沿该工作继续委派；SubAgent 身份、
 *   历史与产物保留，迟到结果仍可按工作读取；
 * - subagent_message（issue 13）：同项工作的参与者互发有来源的消息——
 *   发送方身份完全由发起任务核实（工作父会话任务 = 主 Agent，回报唤醒
 *   轮次同样允许——作用范围仍是本会话名下工作；本工作的 SubAgent
 *   任务 = 该 SubAgent），不接受模型参数指定身份；接收方是当前承接
 *   本工作的 SubAgent（复用转做其他工作后资格即失）或主 Agent
 *   （省略 to_sub_agent_id）；资格核实、幂等与投递见 SubAgentManager.message。
 * - subagent_integrate 改动汇总（issue 17）：把本会话登记的 worktree 副本相对
 *   基线的完整差异套用到父工作区待提交区（不代提交、不强制覆盖）；冲突时
 *   零写入并点名冲突文件；幂等命中如实返回；直接写入工作如实告知没有副本；
 *   取消过的工作与已关闭的 SubAgent 不拦汇总（成果可找回）。
 */

import { defineTool,type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { subagentOpCheck } from "@ruukoto/agent/subagent-ledger.ts";
import { messageStateText } from "@ruukoto/agent/subagent-message.ts";
import type { SourceResolver } from "@ruukoto/channels/source-resolver.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import { QQ_PRIVATE_SOURCE,TELEGRAM_SOURCE } from "@ruukoto/core/notify-target.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { AccessScope } from "@ruukoto/core/access.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { sourceArtifact, sourceResultTasks } from "@ruukoto/core/branch.ts";
import type { SubAgent,Task } from "@ruukoto/core/types.ts";
import type { SubAgentDelegateInput,SubAgentDelegation,SubAgentMessageInput,SubAgentMessageResult,WorkCancellation,WorkIntegration } from "@ruukoto/runtime/subagents.ts";
import { Type } from "typebox";
import type { ArtifactStore } from "./artifacts.ts";
import type { HostToolFamily,HostToolLedger } from "./host-tool-families.ts";
import type { HostCallBinder,HostToolContext } from "./host-tools.ts";
import { hostCallFor } from "./host-tools.ts";
import { canonicalParamsDigest } from "./mcp/tools.ts";

export const SUBAGENT_TOOL_NAMES = ["subagent_delegate", "subagent_result", "subagent_close", "subagent_cancel", "subagent_message", "subagent_integrate"] as const;
export const SUBAGENT_LEDGER: HostToolLedger = {
  names: SUBAGENT_TOOL_NAMES,
  ruleFor: (name) => name === "subagent_result" ? "no_effect" : { family: "subagent" },
};

export function createSubAgentFamily(config: Omit<SubAgentToolsDeps, "taskContext" | "bindCall" | "verifyHost">): HostToolFamily {
  return {
    category: "subagent",
    names: (runtime) => runtime.toolClass === "subagent" ? ["subagent_message"] : SUBAGENT_TOOL_NAMES,
    build: (runtime) => runtime.toolClass === "subagent"
      ? [createSubAgentMessageTool({ store: config.coreStore, message: config.message, ...runtime.call })]
      : createSubAgentTools({ ...config, ...runtime.call, verifyHost: runtime.identity.verifyHost }),
    ledger: { ...SUBAGENT_LEDGER, familyCheck: subagentOpCheck(config.coreStore) },
  };
}

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** subagent_result 单次读取上限（字节）。 */
const READ_LIMITS = { replyBytes: 16 * 1024, artifactBytes: 64 * 1024 };

export interface SubAgentToolsDeps {
  coreStore: Store;
  sources: SourceResolver;
  delegate(input: SubAgentDelegateInput): Promise<SubAgentDelegation>;
  /** 显式关闭（issue 12）；by 由宿主按调用身份固定（agent:<任务ID>），模型参数不参与。 */
  close(input: { subAgentId: string; by: `agent:${string}`; parentSessionId: string }): { agent: SubAgent; alreadyClosed: boolean };
  /** 整项取消（issue 14）；by 由宿主按调用身份固定（agent:<任务ID>），模型参数不参与。 */
  cancelWork(input: { workId: string; by: `agent:${string}`; parentSessionId: string; reason?: string | null }): Promise<WorkCancellation>;
  /** 工作内协作消息（issue 13）；发送方身份由发起任务核实（见 SubAgentManager.message）。 */
  message(input: SubAgentMessageInput): Promise<SubAgentMessageResult>;
  /** 改动汇总（issue 17）；发起任务由宿主按调用身份固定（当前任务），模型参数只给 work_id。 */
  integrate(input: { workId: string; parentTaskId: string; parentSessionId: string }): Promise<WorkIntegration>;
  /** 指定任务的最终 assistant 文本（按任务历史条目）。 */
  readReply(taskId: string, offset: number, length: number): HistoryEntryView | null;
  /** 评审任务前置修订说明（agent-direction issue 19，与 coding_result 一致）。 */
  resultNotice?(task: Task): string | null;
  artifacts: ArtifactStore;
  taskContext(): HostToolContext | null;
  bindCall?: HostCallBinder;
  /** Driver 注入：会话/任务/绑定重核（普通开发会话或 main；SubAgent 拒绝）。 */
  verifyHost(ctx: HostToolContext): string | null;
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** subagent_message 的依赖子集（普通开发会话/main 与 SubAgent 子会话共用同一定义）。 */
export interface SubAgentMessageToolDeps {
  store: Store;
  message(input: SubAgentMessageInput): Promise<SubAgentMessageResult>;
  taskContext(): HostToolContext | null;
  bindCall?: HostCallBinder;
}

/**
 * 工作内协作消息工具（agent-direction issue 13）：发送方身份完全由发起任务
 * 核实——工作父会话的任务 = 主 Agent，本工作的 SubAgent 任务 = 该 SubAgent；
 * 模型参数不含身份，资格、幂等与投递由 SubAgentManager.message 执行。
 */
export function createSubAgentMessageTool(deps: SubAgentMessageToolDeps): ToolDefinition {
  return defineTool({
    name: "subagent_message",
    label: "subagent_message",
    description:
      "在同项工作内向主 Agent 或当前承接本工作的另一个 SubAgent 发送有来源的消息：消息与来源可追溯，" +
      "不扩大任何一方的工具或资料范围。省略 to_sub_agent_id 发给主 Agent；指定则发给该 SubAgent" +
      "（它必须当前正承接本工作且未关闭；主 Agent 发送时必填）。接收方正忙时消息登记为待投递，" +
      "由宿主机在其当前任务结束后投递为对方的一次执行任务；发给主 Agent 的经宿主注入或唤醒送达。" +
      "同 key 同参返回原记录，异参冲突。",
    parameters: Type.Object({
      work_id: Type.String({ description: "工作 id（subagent_delegate 返回的；发送方必须正在本工作内）" }),
      key: Type.String({ description: "幂等键（字母/数字/_/-，≤64；重试用同一个）" }),
      text: Type.String({ description: "消息正文（≤4096 字符；与来源一起送达）" }),
      to_sub_agent_id: Type.Optional(Type.String({ description: "接收的 SubAgent id；省略 = 发给主 Agent；发送方为主 Agent 时必填" })),
    }),
    execute: async (sdkCallId: string, params: any) => {
      const call = hostCallFor(deps.bindCall, deps.taskContext, sdkCallId);
      try {
        const ctx = call.context;
        if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
        if (typeof params.work_id !== "string" || !params.work_id.trim()) throw new Error("work_id 必须是非空字符串");
        if (typeof params.key !== "string" || !KEY_RE.test(params.key)) throw new Error("key 必须是 1–64 位字母、数字、_ 或 -");
        if (typeof params.text !== "string" || !params.text.trim()) throw new Error("text 不能为空");
        if (params.to_sub_agent_id !== undefined && (typeof params.to_sub_agent_id !== "string" || !params.to_sub_agent_id.trim())) {
          throw new Error("to_sub_agent_id 必须是既有 SubAgent id");
        }
        const paramsDigest = canonicalParamsDigest({
          work_id: params.work_id,
          to_sub_agent_id: params.to_sub_agent_id ?? null,
          key: params.key,
          text: params.text,
        });
        const result = await deps.message({
          senderTaskId: ctx.taskId,
          workId: params.work_id,
          key: params.key,
          text: params.text,
          toSubAgentId: params.to_sub_agent_id ?? null,
          paramsDigest,
        });
        const m = result.message;
        const to = m.toSubAgentId ? `SubAgent ${m.toSubAgentId}` : "主 Agent";
        return okText(
          result.created
            ? `已发送：消息 ${m.id}（工作 ${m.workId} → ${to}），${messageStateText(deps.store, m)}。`
            : `同键同参已发送过，返回原记录：消息 ${m.id}（${to}，${messageStateText(deps.store, m)}）。`,
        );
      } finally {
        call.release();
      }
    },
  } as any);
}

export function createSubAgentTools(deps: SubAgentToolsDeps): ToolDefinition[] {
  const store = deps.coreStore;
  const bindExecute = <P extends Record<string, unknown>>(fn: (ctx: HostToolContext, params: P) => Promise<{ content: Array<{ type: "text"; text: string }> }>) =>
    async (sdkCallId: string, params: P) => {
      const call = hostCallFor(deps.bindCall, deps.taskContext, sdkCallId);
      try {
        const ctx = call.context;
        if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
        const problem = deps.verifyHost(ctx);
        if (problem) throw new Error(`身份校验失败：${problem}`);
        return await fn(ctx, params);
      } finally {
        call.release();
      }
    };

  /**
   * 拥有者发起的任务：直接提交（agentId 为空、无来源事件、无 SubAgent 关联），
   * 或已核实身份的 owner 私聊入站，以及宿主保存来源授权的工作唤醒。外部评审仍拒绝。
   */
  const ownerOriginated = (task: Task): boolean => {
    if (task.subAgentId) return false;
    if (store.getSessionIdentity(task.sessionId)?.kind === "scheduled") return true;
    if (task.sourceEventId) {
      const source = store.getInboundEvent(task.sourceEventId)?.source;
      return source === TELEGRAM_SOURCE || source === QQ_PRIVATE_SOURCE;
    }
    return task.agentId === null || (task.agentId === "main" && task.parentTaskId !== null && task.sourcePermissionVersion !== null);
  };

  const subagentDelegate = defineTool({
    name: "subagent_delegate",
    label: "subagent_delegate",
    description:
      "为一项分析/读取或修改工作创建通用 SubAgent 并登记一次执行任务：拥有独立会话与宿主生成的独立工作目录或隔离副本，" +
      "role 从子代理角色目录选择，首次省略为 general，继续或复用沿固定角色；需要其他角色时新建 SubAgent。" +
      "角色省略 tools 时继承来源可委派工具（含 shell），显式工具缺少任一项即拒绝启动；权限继承来源或收紧，不能委派下级。无目标时在独立目录执行，可省略资料。" +
      "开发会话用 read_paths 指定资料路径（受限模式要求父工作区内或父任务已授予）；main 会话用 materials 指定资料（委派时解析为文本快照）；" +
      "代码修改和代码审查都明确给 target（父工作区内）：Git 目标从当前内容建立独立副本，包含暂存、未暂存和非忽略新文件；非 Git 目录原地串行，要求来源保护的角色须用 Git 目标；" +
      "副本改动由你用 subagent_integrate 按工作 id 汇回当前工作区（冲突时不覆盖、双方保留）。" +
      "首次省略两参数建立工作；补充原工作用 work_id（修改继续沿用首次钉定的写入目标）；把相关的另一项工作交给同一个空闲 SubAgent 用 sub_agent_id 复用（保留上下文，" +
      "读范围与资料按本次重新确定，要求该 SubAgent 空闲且未关闭）；work_id 与 sub_agent_id 同现 = 把该空闲 SubAgent 拉入既有工作协作" +
      "（无目标工作；协作者之间与主 Agent 可用 subagent_message 通信）。" +
      "返回 workId、subAgentId、taskId 与截止时间；同 key 同参返回原记录，异参冲突。子任务入队后立即返回，" +
      "用 agent_wait 按返回的 taskId 等待本次任务；收到结果后用 subagent_result 读取并继续处理，最后汇报。",
    parameters: Type.Object({
      request: Type.String({ description: "委派正文：要 SubAgent 做什么（目标、范围、验收要求）" }),
      key: Type.String({ description: "幂等键（字母/数字/_/-，≤64；重试用同一个）" }),
      role: Type.Optional(Type.String({ description: "子代理角色目录中的名称；首次省略为 general，继续或复用省略沿固定角色" })),
      work_id: Type.Optional(Type.String({ description: "既有工作 id（沿原工作追加任务，保留首次钉定的目标）；与 sub_agent_id 同现 = 把该空闲 SubAgent 拉入本工作协作" })),
      sub_agent_id: Type.Optional(Type.String({ description: "复用既有空闲 SubAgent（保留上下文）：单独用时承接新工作；与 work_id 同现时加入该既有工作作为协作方" })),
      target: Type.Optional(Type.String({ description: "代码修改或审查的目标（父工作区内，可用于任何角色）；Git 建当前内容副本，非 Git 原地串行，要求来源保护时须用 Git。继续原工作沿已登记目标，不重新指定" })),
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
      if ("mode" in params) throw new RuntimeApiError("interface_upgrade_required", "mode 委派接口已移除：用 role 选择职责、target 指定代码目标；冻结验证用工作流 agent 的 verify。请更新调用后以原 key 核实，勿换键重放旧工作");
      const task = store.getTask(ctx.taskId);
      if (!task || !ownerOriginated(task)) {
        throw new Error("只有拥有者任务、独立调度运行或宿主保存来源授权的工作唤醒可以委派 SubAgent");
      }
      if (typeof params.key !== "string" || !KEY_RE.test(params.key)) throw new Error("key 必须是 1–64 位字母、数字、_ 或 -");
      if (typeof params.request !== "string" || !params.request.trim()) throw new Error("request 不能为空");
      if (params.role !== undefined && (typeof params.role !== "string" || !params.role.trim())) throw new Error("role 须为角色目录中的名称");
      if (params.work_id !== undefined && (typeof params.work_id !== "string" || !params.work_id.trim())) {
        throw new Error("work_id 必须是既有工作 id");
      }
      if (params.sub_agent_id !== undefined && (typeof params.sub_agent_id !== "string" || !params.sub_agent_id.trim())) {
        throw new Error("sub_agent_id 必须是既有 SubAgent id");
      }
      const target = params.target === undefined ? null : params.target;
      if (target !== null && typeof target !== "string") throw new Error("target 必须是路径字符串");
      const kind = store.getSessionIdentity(ctx.sessionId)?.kind;
      const isMain = kind === "main" || kind === "scheduled";
      const readPaths = params.read_paths === undefined ? null : params.read_paths;
      const materials = params.materials === undefined ? null : params.materials;
      if (target !== null && (readPaths !== null || materials !== null)) {
        throw new Error("指定 target 时不指定 read_paths 或 materials（目标包含自己的资料路径）");
      }
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
      const paramsDigest = canonicalParamsDigest({
        request: params.request,
        key: params.key,
        role: params.role ?? (params.work_id || params.sub_agent_id ? null : "general"),
        work_id: params.work_id ?? null,
        ...(params.sub_agent_id !== undefined ? { sub_agent_id: params.sub_agent_id } : {}),
        ...(target !== null ? { target: target.trim() } : {}),
        read_paths: readPaths ? [...readPaths].sort() : null,
        materials: materials ?? null,
      });
      const delegation = await deps.delegate({
        parentTaskId: task.id,
        key: params.key,
        request: params.request,
        role: params.role,
        workId: params.work_id ?? null,
        subAgentId: params.sub_agent_id ?? null,
        target,
        materials,
        readPaths,
        paramsDigest,
      });
      const wt = delegation.work.writeTarget;
      const joined =
        delegation.created && params.work_id !== undefined && params.sub_agent_id !== undefined && delegation.agent.id !== delegation.work.subAgentId;
      const targetNote =
        delegation.created && wt?.kind === "worktree"
          ? `独立副本 ${wt.path} 包含委派时当前内容；忽略文件与依赖未复制，检查缺依赖时在获准副本内准备。子任务的新增改动由你汇总，父工作区原改动保留。`
          : delegation.created && wt?.kind === "direct"
            ? `直接写入 ${wt.path}（与父会话按目录占用串行）。`
            : "";
      return okText(
        (delegation.created ? "已委派 SubAgent" : "同键同参已委派过，返回原记录") +
          `：工作 ${delegation.work.id}，SubAgent ${delegation.agent.id}，任务 ${delegation.task.id}` +
          `（截止 ${delegation.task.deadline ?? "无"}）。` +
          (joined ? "该 SubAgent 已作为协作方加入本工作（彼此与主 Agent 可用 subagent_message 通信）。" : "") +
          (targetNote ? `${targetNote}` : "") +
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

  /** SubAgent 展示状态：已关闭优先于运行/空闲/待核实。 */
  const agentStateText = (agent: SubAgent): string => (agent.closedAt ? `已关闭（${agent.closedAt}，${agent.closedBy}）` : agent.state);

  const subagentResult = defineTool({
    name: "subagent_result",
    label: "subagent_result",
    description:
      "读取本会话登记的工作委托与 SubAgent 结果：省略 work_id 列出本会话的全部 SubAgent 总览" +
      "（状态/已关闭、当前工作、名下工作、最近任务状态，供挑选继续或复用对象）；指定 work_id 时 " +
      "part=result（默认）看工作状态、SubAgent（含是否已关闭）与任务摘要；" +
      "part=messages 看工作内协作消息（来源、投递状态与正文预览）；" +
      "part=reply 按 UTF-8 字节分页读指定/最新任务的最终回答（length 为 256–16384）；" +
      "part=artifact 按字节分页读该任务的产物（artifact_id 见结果中的产物列表）。",
    parameters: Type.Object({
      work_id: Type.Optional(Type.String({ description: "subagent_delegate 返回的工作 id；省略时列出本会话的 SubAgent 总览" })),
      part: Type.Optional(Type.Union([Type.Literal("result"), Type.Literal("reply"), Type.Literal("artifact"), Type.Literal("messages")])),
      task_id: Type.Optional(Type.String({ description: "工作内的某次执行任务 id；缺省取最近一次" })),
      artifact_id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      length: Type.Optional(Type.Number()),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const part = params.part ?? "result";
      if (params.work_id === undefined) {
        // 总览（issue 12）：本会话名下的 SubAgent，含当前/名下工作与最近任务
        if (part !== "result") throw new Error("省略 work_id 时只提供总览（part=result）");
        const agents = store.listSubAgentsBySession(ctx.sessionId);
        if (agents.length === 0) return okText("本会话还没有 SubAgent");
        const lines = agents.map((agent) => {
          const works = store.listWorkDelegationsBySession(ctx.sessionId).filter((w) => w.subAgentId === agent.id);
          const recent = works
            .flatMap((w) => store.listTasksByWork(w.id))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
            .at(-1);
          return (
            `- SubAgent ${agent.id} · ${agentStateText(agent)} · 当前工作 ${agent.activeWorkId ?? "无"}` +
            ` · 名下工作 ${works.map((w) => w.id).join("、") || "无"}` +
            (recent ? ` · 最近任务 ${recent.id}（${recent.status}）` : "")
          );
        });
        return okText(`本会话的 SubAgent：\n${lines.join("\n")}`);
      }
      const work = store.getWorkDelegation(params.work_id);
      const inherited = work && work.parentSessionId !== ctx.sessionId ? sourceResultTasks(store, new AccessScope(store.db), ctx.sessionId, work.id) : null;
      if (!work || (work.parentSessionId !== ctx.sessionId && !inherited)) {
        throw new Error("只能读取本会话登记的工作委托");
      }
      const agent = store.getSubAgent(work.subAgentId);
      if (!agent) throw new Error(`工作 ${work.id} 缺少 SubAgent 记录`);
      const tasks = store.listTasksByWork(work.id).filter(task => !inherited || inherited.includes(task.id));
      // 评审任务前置修订说明（issue 19，与 coding_result 一致）：按所读任务给出
      const noticed = (t: Task | null | undefined) => (t ? (deps.resultNotice?.(t) ?? null) : null);
      const withText = (t: Task | null | undefined, text: string) => {
        const notice = noticed(t);
        return okText(notice ? `${notice}\n${text}` : text);
      };
      if (part === "result") {
        const cancelText = work.canceledAt
          ? ` · 已取消（${work.canceledAt}，${work.canceledBy}${work.cancelReason ? `，${work.cancelReason}` : ""}）`
          : "";
        const lines = [`工作 ${work.id} · SubAgent ${agent.id}${inherited ? "（分支来源，只读快照）" : `（${agentStateText(agent)}）`} · 发起任务 ${work.originTaskId}${inherited ? "" : cancelText}`];
        for (const t of tasks) {
          lines.push(
            `- 任务 ${t.id} · ${t.status} · 直接父任务 ${t.parentTaskId ?? "?"} · 截止 ${t.deadline ?? "无"}` +
              (t.resultSummary ? `\n  摘要：${t.resultSummary}` : ""),
          );
        }
        if (tasks.length === 0) lines.push("尚无执行任务");
        // 父会话持目录时提示等待工具安全让出，不把父轮终态当作必要步骤。
        const wt = work.writeTarget;
        if (wt?.kind === "direct") {
          for (const t of tasks) {
            if (t.status !== "queued") continue;
            const occ = store.findBlockingOccupancy(wt.path, wt.dev, wt.ino);
            if (occ && occ.sessionId === ctx.sessionId) {
              lines.push(
                `等待本会话释放目录；用 agent_wait 等待任务 ${t.id}，安全让出目录后子任务继续，结果返回后继续处理。`,
              );
              break;
            }
          }
        }
        return withText(tasks.at(-1), lines.join("\n"));
      }
      if (part === "messages") {
        if (inherited) throw new Error("分支来源只提供快照内的已完成结果，不开放原工作消息");
        // 工作内协作消息（issue 13）：来源、投递状态与正文预览，按创建序
        const msgs = store.listSubAgentMessagesByWork(work.id);
        if (msgs.length === 0) return okText(`工作 ${work.id} 尚无协作消息`);
        return okText(
          msgs
            .map(
              (m) =>
                `- ${m.id} · ${m.createdAt} · ${m.fromSubAgentId ? `SubAgent ${m.fromSubAgentId}` : "主 Agent"} → ` +
                `${m.toSubAgentId ? `SubAgent ${m.toSubAgentId}` : "主 Agent"} · ${messageStateText(store, m)}\n` +
                `  ${m.body.length > 200 ? `${m.body.slice(0, 200)}…` : m.body.replaceAll("\n", "\n  ")}`,
            )
            .join("\n"),
        );
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
        if (page === null) return withText(target, `任务 ${target.id}（${target.status}）暂无最终回答`);
        const end = page.offset + Buffer.byteLength(page.text);
        return withText(target, `[最终回答 第 ${page.offset}–${end} 字节，共 ${page.totalBytes}${end < page.totalBytes ? `；继续用 offset=${end}` : ""}]\n${page.text}`);
      }
      const artifact = typeof params.artifact_id === "string" ? (inherited ? sourceArtifact(store, new AccessScope(store.db), ctx.sessionId, params.artifact_id) : store.getArtifact(params.artifact_id)) : null;
      if (!artifact || artifact.taskId !== target.id) throw new Error("产物不存在或不属于该任务的执行");
      if (artifact.name.startsWith("prompt-snapshot:")) throw new Error("模型上下文快照不属于交付产物");
      const offset = intParam(params.offset, 0, artifact.byteCount, "offset");
      const length = intParam(params.length, READ_LIMITS.artifactBytes, READ_LIMITS.artifactBytes, "length");
      if (length < 4) throw new Error("artifact length 必须至少为 4 字节");
      const buf = deps.artifacts.read(artifact.id, offset, Math.min(length, artifact.byteCount - offset));
      let text: string;
      try {
        // 非末页保留尾部未完成的 UTF-8 字符给下一页，不替换成损坏字符。
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf, { stream: offset + buf.length < artifact.byteCount });
      } catch {
        throw new Error("产物片段不是合法 UTF-8 文本，或 offset 未对齐字符边界");
      }
      const end = offset + Buffer.byteLength(text);
      return withText(target,
        `[产物 ${artifact.id}（${artifact.name}，${artifact.status}）第 ${offset}–${end} 字节，共 ${artifact.byteCount}` +
          `${end < artifact.byteCount ? `；继续用 offset=${end}` : ""}]\n${text}`,
      );
    }),
  } as any);

  const subagentClose = defineTool({
    name: "subagent_close",
    label: "subagent_close",
    description:
      "显式关闭本会话名下的一个 SubAgent：不再需要后续协作时调用。关闭只收窄能力——" +
      "历史、产物与工作目录保留可查（subagent_result 仍可读取）；有活动任务时拒绝（等任务结束或由拥有者取消）；" +
      "重复关闭幂等返回；关闭后新委派被拒绝。任务终态与空闲不会自动关闭。",
    parameters: Type.Object({
      sub_agent_id: Type.String({ description: "要关闭的 SubAgent id（subagent_result 总览可查看）" }),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      // 回报唤醒轮次也允许关闭（只收窄能力）；身份与归属由 verifyHost 与归属核实拒绝
      if (typeof params.sub_agent_id !== "string" || !params.sub_agent_id.trim()) throw new Error("sub_agent_id 必须是非空字符串");
      const result = deps.close({ subAgentId: params.sub_agent_id, by: `agent:${ctx.taskId}`, parentSessionId: ctx.sessionId });
      return okText(
        result.alreadyClosed
          ? `SubAgent ${result.agent.id} 此前已关闭（${result.agent.closedAt}）：幂等返回，历史与产物仍可用 subagent_result 读取。`
          : `SubAgent ${result.agent.id} 已关闭：不再接受新委派；历史、产物与工作目录保留可查。`,
      );
    }),
  } as any);

  const subagentCancel = defineTool({
    name: "subagent_cancel",
    label: "subagent_cancel",
    description:
      "取消本会话名下的一项工作委托：不再需要这项工作时调用。取消停止它的活动与排队任务（效果未知的已有操作只标记、" +
      "不重放），其他工作不受影响；重复取消幂等返回；取消后不能沿该工作继续委派；SubAgent 不随之关闭，历史、产物与" +
      "工作目录保留（可经 subagent_result 读取；空闲未关闭的 SubAgent 可复用于其他工作），迟到结果保存为事实但不再主动送达。",
    parameters: Type.Object({
      work_id: Type.String({ description: "要取消的工作 id（subagent_result 总览可查看）" }),
      reason: Type.Optional(Type.String({ description: "取消原因（可选，随记录保存）" })),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      // 回报唤醒轮次也允许取消（只收窄能力）；身份与归属由 verifyHost 与归属核实拒绝
      if (typeof params.work_id !== "string" || !params.work_id.trim()) throw new Error("work_id 必须是非空字符串");
      if (params.reason !== undefined && typeof params.reason !== "string") throw new Error("reason 必须是字符串");
      const result = await deps.cancelWork({
        workId: params.work_id,
        by: `agent:${ctx.taskId}`,
        parentSessionId: ctx.sessionId,
        reason: params.reason ?? null,
      });
      const active = ["queued", "running", "awaiting_confirmation"];
      const settled = result.tasks.filter((t) => t.status === "canceled").length;
      const running = result.tasks.filter((t) => active.includes(t.status)).length;
      const stateText = running > 0 ? `${running} 个任务仍在停止中` : `${settled} 个任务已取消`;
      return okText(
        result.alreadyCanceled
          ? `工作 ${result.work.id} 此前已取消（${result.work.canceledAt}）：幂等返回，历史与产物仍可用 subagent_result 读取。`
          : `工作 ${result.work.id} 已取消：${stateText}；不能沿该工作继续委派；SubAgent 未关闭，历史、产物与工作目录保留可查，迟到结果保存但不再主动送达。`,
      );
    }),
  } as any);

  const subagentMessage = createSubAgentMessageTool({
    store,
    message: deps.message,
    taskContext: deps.taskContext,
    bindCall: deps.bindCall,
  });


  const subagentIntegrate = defineTool({
    name: "subagent_integrate",
    label: "subagent_integrate",
    description:
      "把本会话登记的一项 worktree 修改工作的副本改动汇回当前工作区：宿主经工具工作进程取副本相对基线的完整差异，" +
      "能干净套用才写入你的待提交改动区（不代提交、不强制覆盖）；同文件已有本地改动或此前已部分汇总时拒绝并点名冲突文件，" +
      "双方成果都保留供处理；完整差异已在工作区时按幂等返回不重复写入；取消过的工作与已关闭的 SubAgent 也可以汇总（成果可找回）。" +
      "非 Git 直接写入的工作没有副本，调用只会如实告知。" +
      "无 target 的工作没有回写目标、不能汇总。汇总后用你自己的检查（类型、测试等）验证改动，验证不过的待处理内容如实告诉拥有者。",
    parameters: Type.Object({
      work_id: Type.String({ description: "要汇总的工作 id（subagent_delegate 返回；subagent_result 总览可查看）" }),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      // 回报唤醒轮次也允许汇总（只作用于本会话登记的成果）；身份与归属由 verifyHost 与归属核实拒绝
      if (typeof params.work_id !== "string" || !params.work_id.trim()) throw new Error("work_id 必须是非空字符串");
      const r = await deps.integrate({ workId: params.work_id, parentTaskId: ctx.taskId, parentSessionId: ctx.sessionId });
      if (r.state === "direct") {
        return okText(
          `工作 ${r.work.id} 是非 Git 直接写入：改动在子任务执行时已就地落在父工作区（${(r.work.writeTarget as any)?.path ?? "写入根"}），没有副本需要汇总。` +
            "改动未经副本隔离，请自行检查并验证。",
        );
      }
      if (r.state === "empty") {
        return okText(`工作 ${r.work.id} 的副本与基线 ${r.baseCommit?.slice(0, 12)} 之间没有差异：无可汇总的改动。`);
      }
      if (r.state === "already") {
        return okText(
          `工作 ${r.work.id} 的完整差异已在当前工作区（此前已套用）：幂等返回，未重复写入、未重复登记。` +
            "如需重新核对，可比较副本与当前工作区；副本原样保留。",
        );
      }
      return okText(
        `已汇总工作 ${r.work.id} 的改动：${r.filesChanged} 个文件（+${r.insertions}/-${r.deletions}）` +
          `${r.files.length ? `：${r.files.join("、")}` : ""}。` +
          `来源为分支副本（基线 ${r.baseCommit?.slice(0, 12)}，汇总时父 HEAD ${r.parentHead ? r.parentHead.slice(0, 12) : "读取失败"}）；` +
          "差异落在待提交区，未代提交。副本原样保留（取消/关闭都不删除），冲突或验证失败都能找回。请接着用自己的检查验证改动；验证不过的待处理内容如实告诉拥有者。",
      );
    }),
  } as any);


  return [subagentDelegate, subagentResult, subagentClose, subagentCancel, subagentMessage, subagentIntegrate];
}
