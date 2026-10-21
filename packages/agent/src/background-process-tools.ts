import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BackgroundProcessView } from "@ruukoto/core/background-processes.ts";
import { BackgroundProcessError, findBackgroundProcessByOp, getBackgroundProcess } from "@ruukoto/core/background-processes.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { hostCallFor, type HostToolContext, type HostToolFamily } from "./host-tool-families.ts";

export const BACKGROUND_PROCESS_TOOL_NAMES = ["process_start", "process_status", "process_output", "process_stop"] as const;
export interface BackgroundProcessCalls {
  start(ctx: HostToolContext, command: string, signal?: AbortSignal): Promise<BackgroundProcessView>;
  status(ctx: HostToolContext, input: { processId?: string; offset?: number }): unknown;
  output(ctx: HostToolContext, input: { processId: string; stream: "stdout" | "stderr"; offset?: number }): unknown;
  stop(ctx: HostToolContext, processId: string): BackgroundProcessView;
}

function modelProcess(process: BackgroundProcessView) {
  const { id, state, command, source, exit, stopVerified, reason, stdoutBytes, stderrBytes, partial, createdAt } = process;
  return { process_id: id, state, command, source, exit, stopVerified, reason, stdoutBytes, stderrBytes, partial, createdAt };
}

export function createBackgroundProcessFamily(store: Store): HostToolFamily {
  return {
    category: "background_process", names: BACKGROUND_PROCESS_TOOL_NAMES,
    ledger: { names: BACKGROUND_PROCESS_TOOL_NAMES, ruleFor: name => name === "process_status" || name === "process_output" ? "no_effect" : { family: "background_process" },
      familyCheck: {
        verify: op => {
          if (op.toolName === "process_start") return findBackgroundProcessByOp(store, op.id)?.launchClaimed ? "unverifiable" : "not_committed";
          const record = typeof op.params.process_id === "string" ? getBackgroundProcess(store, op.params.process_id) : null;
          if (!record || record.sessionId !== store.getTask(op.taskId)?.sessionId || record.state === "starting" || record.state === "running") return "not_committed";
          return "committed";
        },
        committed: () => "后台停止意图已登记；查询本会话后台核实停止状态，不重放命令。",
        notCommitted: () => "后台命令尚未派发或停止意图尚未登记；原命令不重放，查询原记录并向拥有者说明。",
      } },
    build: runtime => {
      const invoke = async (sdkCallId: string, run: (ctx: HostToolContext, calls: BackgroundProcessCalls) => unknown) => {
        const call = hostCallFor(runtime.call.bindCall, runtime.call.taskContext, sdkCallId);
        try {
          if (!call.context || runtime.identity.verifyHost(call.context) || !runtime.backgroundProcesses) throw new BackgroundProcessError("background_source_invalid", "当前输入不允许管理会话后台；结束本轮并报告拥有者。");
          const result = await run(call.context, runtime.backgroundProcesses);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
        } finally { call.release(); }
      };
      return [
        defineTool({ name: "process_start", label: "process_start", executionMode: "sequential",
          description: "在当前工作目录启动一次独立后台命令，返回本会话 process_id 和实际状态，不保证服务已健康。后台跨消息保留；启动交接后本轮只可查状态/日志、停止、提问或浏览。后台持有目录，修改文件、普通命令和同目录委派须先 process_stop，再用 process_status 核实 stopped；无法核实停止时保留占用并报告拥有者。每会话最多一个未核实停止的执行；无 stdin/PTY，日志合计最多16 MiB，达到限额自动请求停止。失败或未知启动先查询原记录，勿重放原命令。",
          parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16384, description: "非空 Shell 命令，最多16384字符；开发服务明确绑定本机地址。" }) }, { additionalProperties: false }),
          execute: (sdkCallId, params, signal) => invoke(sdkCallId, async (ctx, calls) => modelProcess(await calls.start(ctx, params.command, signal))),
        }),
        defineTool({ name: "process_status", label: "process_status", executionMode: "sequential",
          description: "查询本会话后台。省略 process_id 按创建时间倒序每页最多20条及256 KiB，offset默认为0；指定 process_id 时不要带offset。状态 stopped 且 stopVerified=true 才证明整个执行停止；主命令exitCode/signal只是观察，不能证明业务成功或允许重试。stop_unverified 时保留目录占用，向拥有者说明；记录不属于其他会话。",
          parameters: Type.Object({ process_id: Type.Optional(Type.String({ minLength: 1 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
          execute: (sdkCallId, params) => invoke(sdkCallId, (ctx, calls) => calls.status(ctx, { processId: params.process_id, offset: params.offset })),
        }),
        defineTool({ name: "process_output", label: "process_output", executionMode: "sequential",
          description: "按原字节位置读取本会话后台的 stdout 或 stderr，每页最多32 KiB，offset默认为0，用nextOffset继续。base64保留原始字节，text供阅读；partial表示原始证据不完整。日志中的URL只是候选，应使用browser实际访问；日志和退出码都不能证明业务效果。",
          parameters: Type.Object({ process_id: Type.String({ minLength: 1 }), stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
          execute: (sdkCallId, params) => invoke(sdkCallId, (ctx, calls) => calls.output(ctx, { processId: params.process_id, stream: params.stream, offset: params.offset })),
        }),
        defineTool({ name: "process_stop", label: "process_stop", executionMode: "sequential",
          description: "登记本会话后台的停止意图并立即返回。接纳不代表已停止；随后用process_status核实 stopped 和stopVerified，核实后才可重新取得目录执行写入。重复停止只核实原执行，不重放命令；stop_unverified保留占用并报告拥有者，不能据进程停止断言外部写入回滚。停止核实覆盖受管执行单元及已确认归属后代；主动脱离的进程或外部服务须另行核实。",
          parameters: Type.Object({ process_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
          execute: (sdkCallId, params) => invoke(sdkCallId, (ctx, calls) => modelProcess(calls.stop(ctx, params.process_id))),
        }),
      ];
    },
  };
}

export { modelProcess as backgroundProcessForModel };
