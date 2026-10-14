import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentWaitTarget } from "@ruukoto/core/agent-wait.ts";
import { WorkflowError } from "@ruukoto/core/workflow.ts";
import { hostCallFor, type HostToolContext, type HostToolFamily } from "./host-tool-families.ts";

export type AgentWaitTargetState = AgentWaitTarget & {
  status: string;
  resultSummary?: string | null;
  terminalVersion?: number;
  attention?: string;
  stopVerified?: boolean | null;
  effectUnknown?: boolean;
  artifactIds?: string[];
  artifactCount?: number;
  reportOwnerTaskId?: string | null;
};

export interface AgentWaitResult {
  reason: "result" | "attention" | "timeout" | "interrupted";
  targets: AgentWaitTargetState[];
  /** 后续主轮接管最终报告时的整组事实；不扩展本次等待目标或改写原消费。 */
  reportTargets?: AgentWaitTargetState[];
}

export type AgentWaitCall = (ctx: HostToolContext, sdkCallId: string, targets: AgentWaitTarget[], timeoutMs: number, signal?: AbortSignal) => Promise<AgentWaitResult>;
export const AGENT_WAIT_TOOL_NAMES = ["agent_wait"] as const;

/** 等待本身不执行业务操作；后台工作及唯一结果归属由 Runtime 持有。 */
export function createAgentWaitFamily(): HostToolFamily {
  return {
    category: "workflow", names: AGENT_WAIT_TOOL_NAMES,
    ledger: { names: AGENT_WAIT_TOOL_NAMES, ruleFor: () => "no_effect" },
    build: runtime => [defineTool({
      name: "agent_wait", label: "agent_wait",
      description: "等待明确的后台任务或工作流。任务 ID 来自 subagent_delegate，运行 ID 来自 workflow_start；已保存定义须先启动，定义名称不能作为等待 ID。任一结果、需人工介入、超时或拥有者新输入到达时返回真实状态；默认等 60 秒，最多 300 秒。后台未完成时继续等待或明确说明需要介入，收到结果后继续处理并最终汇报。",
      executionMode: "sequential",
      parameters: Type.Object({
        targets: Type.Array(Type.Union([
          Type.Object({ kind: Type.Literal("task"), task_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
          Type.Object({ kind: Type.Literal("workflow"), run_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        ]), { minItems: 1, maxItems: 20 }),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
      }, { additionalProperties: false }),
      execute: async (sdkCallId, params, signal) => {
        const call = hostCallFor(runtime.call.bindCall, runtime.call.taskContext, sdkCallId);
        try {
          if (!call.context || runtime.identity.verifyHost(call.context) || !runtime.agentWait) throw new WorkflowError("source_forbidden");
          const targets: AgentWaitTarget[] = params.targets.map(target => target.kind === "task"
            ? { kind: "task", taskId: target.task_id } : { kind: "workflow", runId: target.run_id });
          const result = await runtime.agentWait(call.context, sdkCallId, targets, params.timeout_ms ?? 60_000, signal);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
        } finally { call.release(); }
      },
    })],
  };
}
