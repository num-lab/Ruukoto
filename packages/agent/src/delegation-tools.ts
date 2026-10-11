/**
 * 旧 coding 子任务结果的只读兼容（issue 05 → agent-direction issue 23）：固定
 * coding 角色已退役，`coding_delegate` 删除，只保留 `coding_result`。
 * 仅宿主引导的 main 角色会话装配。
 *
 * - coding_result 只读父任务在 main 会话中的旧 coding 子任务，以及 main 委派的
 *   SubAgent 执行任务（按父子关系/工作归属开的窄口，不扩大跨项目资料授权），
 *   最终回答与产物分页读取。
 * - `delegationOpCheck`：升级前在途的 `coding_delegate` 操作在恢复时按子任务
 *   是否存在核实（账本只读兼容）。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "@ruukoto/core/store.ts";
import type { FamilyCheck } from "./tool-op-ledger.ts";
import type { Task } from "@ruukoto/core/types.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { hostCallFor } from "./host-tools.ts";
import type { HostCallBinder, HostToolContext } from "./host-tools.ts";
import type { HostToolFamily, HostToolLedger } from "./host-tool-families.ts";

export const DELEGATION_TOOL_NAMES = ["coding_result"] as const;
export const DELEGATION_LEDGER: HostToolLedger = { names: DELEGATION_TOOL_NAMES, ruleFor: () => "no_effect" };

export function createDelegationFamily(config: Omit<DelegationToolsDeps, "taskContext" | "bindCall" | "verifyMain">): HostToolFamily {
  return {
    category: "delegation",
    names: DELEGATION_TOOL_NAMES,
    build: (runtime) => createDelegationTools({ ...config, ...runtime.call, verifyMain: runtime.identity.verifyMain }),
    ledger: { ...DELEGATION_LEDGER, familyCheck: delegationOpCheck(config.coreStore) },
  };
}

/** 旧 coding 委派写入 result_ref 的结构化结果（只读解析，issue 05 格式）。 */
interface LegacyCodingResult {
  mode: string;
  outcome: string;
  tests: string;
  needsOwner: boolean;
  needsOwnerReason: string | null;
  effect: string;
  failure: string | null;
  artifactIds: string[];
  retriedBy?: string;
}
/** coding_result 单次读取上限（字节）。 */
const READ_LIMITS = { replyBytes: 16 * 1024, artifactBytes: 64 * 1024 };

/** 工具操作账本的族核实：`coding_delegate` 按子任务是否存在核实（同库，恒可核实）。 */
export function delegationOpCheck(coreStore: Store): FamilyCheck {
  return {
    verify: (op) =>
      coreStore.findChildTask(op.taskId, `deleg:${op.taskId}:${String(op.params.key ?? "")}`) !== null ? "committed" : "not_committed",
    committed: (when) => `已提交：子任务已创建（${when}已委派）`,
    notCommitted: (when) => `已知未提交：不存在对应子任务（${when}未委派）`,
  };
}

export interface DelegationToolsDeps {
  coreStore: Store;
  /** 指定任务的最终 assistant 文本（按任务历史条目）。 */
  readReply(taskId: string, offset: number, length: number): HistoryEntryView | null;
  resultNotice?(task: Task): string | null;
  artifacts: ArtifactStore;
  taskContext(): HostToolContext | null;
  bindCall?: HostCallBinder;
  verifyMain(ctx: HostToolContext): string | null;
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function createDelegationTools(deps: DelegationToolsDeps): ToolDefinition[] {
  const store = deps.coreStore;
  const bindExecute = <P extends Record<string, unknown>>(fn: (ctx: HostToolContext, params: P) => Promise<{ content: Array<{ type: "text"; text: string }> }>) =>
    async (sdkCallId: string, params: P) => {
      const call = hostCallFor(deps.bindCall, deps.taskContext, sdkCallId);
      try {
        const ctx = call.context;
        if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
        const problem = deps.verifyMain(ctx);
        if (problem) throw new Error(`身份校验失败：${problem}`);
        return await fn(ctx, params);
      } finally {
        call.release();
      }
    };

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
      "读取本会话旧 coding 子任务（固定 coding 已退役，只读历史）与 SubAgent 执行任务的结果；新工作用 subagent_result。" +
      "part=result（默认）看状态与结构化结果；" +
      "part=reply 按 UTF-8 字节分页读最终回答（length 为 256–16384）；" +
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
      // 窄口：① 旧 coding 子任务（父子关系 + 本会话的父任务）；② 新分析链路的
      // SubAgent 执行任务（所属工作登记在本会话）。其余任务/产物 ID 一律拒绝。
      const legacyCoding = child?.agentId === "coding" && parent && parent.sessionId === ctx.sessionId;
      const subWork = child?.subAgentId && child.workId ? store.getWorkDelegation(child.workId) : null;
      if (!child || (!legacyCoding && (!subWork || subWork.parentSessionId !== ctx.sessionId))) {
        throw new Error("只能读取本会话委派的 coding/SubAgent 子任务");
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
      const lines = [
        child.subAgentId
          ? `子任务 ${child.id} · ${child.status} · SubAgent ${child.subAgentId} · 工作 ${child.workId} · 截止 ${child.deadline ?? "无"}`
          : `子任务 ${child.id} · ${child.status} · 截止 ${child.deadline ?? "无"}`,
      ];
      if (child.resultRef && child.subAgentId) {
        // 新分析链路（issue 11）：通用只读执行的结果引用
        const r = JSON.parse(child.resultRef) as { outcome?: string; artifactIds?: string[]; failure?: string | null };
        lines.push(
          `结果：${r.outcome ?? "?"}`,
          ...(r.failure ? [`失败原因：${r.failure}`] : []),
          `产物：${r.artifactIds?.length ? r.artifactIds.join(", ") : "无"}`,
          `摘要：${child.resultSummary ?? ""}`,
        );
      } else if (child.resultRef && !JSON.parse(child.resultRef).mode) {
        // 退役收尾补记的旧 coding 子任务（issue 23）：未执行完成，没有自报结果
        const r = JSON.parse(child.resultRef) as { outcome?: string };
        lines.push(
          `结果：${r.outcome ?? "?"} · 固定 coding 退役收尾补记（未执行完成，无测试自报；结果未知时需要拥有者核实）`,
          ...(child.errorMessage ? [`原因：${child.errorMessage}`] : []),
          `摘要：${child.resultSummary ?? ""}`,
        );
      } else if (child.resultRef) {
        const r = JSON.parse(child.resultRef) as Partial<LegacyCodingResult>;
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

  return [codingResult];
}
