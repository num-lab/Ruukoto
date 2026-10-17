/**
 * 服务器服务管理宿主工具（agent-direction issue 09）：service_inspect /
 * service_manage。main 与独立定时会话装配（另要求产品 ruukoto + Linux + 显式
 * 部署配置，见 Runtime/Driver；不因此获得 bash）。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-03-service-management-helper.md
 *
 * - 模型只提供白名单服务名与固定动作；主机身份、taskId、hostOpId、执行身份与
 *   策略由宿主注入；只有 root 拥有、经 sudoers 固定入口的 helper 能触达 systemd；
 * - service_inspect 无写入效果，直接执行；service_manage 首版固定 restart，
 *   full_access 使用任务授权免审批，其他模式逐次审批；OS 授权仍由 helper 核实；
 *   执行参数取自授权时保存的不可变快照；
 *   例外（issue 10）：拥有者保存的限定长期授权逐项核实成立时按授权范围自动放行
 *   （独立的已批准记录 + 单次消费；授权本身不被消费），撤销/失效/范围不符回落
 *   人工逐次审批；
 * - 消费后的结果分类只认可信结论：确定的请求前拒绝（launched:false）为已知未
 *   执行，确定的管理命令结果如实记录（含非零退出），其余消费后无可信结果的
 *   （协议错误/应答不符/产物保存失败/派发后失败/超时/中止）一律效果未知，不
 *   自动重发，并使同目标有效长期授权失效；
 * - 授权事务内同步复核个人助手宿主绑定与策略修订；helper 在发送任何 restart
 *   请求前再次核实本机、白名单、策略与已加载单元修订；sqlite 消费与 systemd
 *   效果之间不存在跨系统事务；
 * - helper 的 stdout/stderr 原始字节先入 ArtifactStore，模型只见有界视图；
 *   管理命令结果与随后观察到的服务状态分别表达（退出码 0 ≠ active ≠ 业务健康）；
 *   （应答通道不用 fd3：sudo 默认关闭 fd ≥3——见 helper 头注释；应答为 stderr
 *    上唯一一条 RUUKOTO_SERVICE_REPLY 前缀单行，其余 stderr 仍是证据）
 * - 已消费的 restart 无确定结果为效果未知，不自动重发；helper 侧同 hostOpId
 *   的持久单次标记补上跨进程与瞬态单元回收后的重复保护。
 */

import { defineTool,type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalGate } from "@ruukoto/agent/approval-gate.ts";
import type { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { HostToolFamily } from "@ruukoto/agent/host-tool-families.ts";
import type { HostCallBinder,HostToolContext } from "@ruukoto/agent/host-tools.ts";
import { hostCallFor } from "@ruukoto/agent/host-tools.ts";
import type { ManagedProcessRegistry } from "@ruukoto/agent/managed-processes.ts";
import { SERVICE_LEDGER,SERVICE_TOOL_NAMES } from "@ruukoto/channels/service-ledger.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { ApprovalScope,Task } from "@ruukoto/core/types.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { Type } from "typebox";
import { callHelper, expectRevisions, opUnitFor, requireOk, ServiceHelperError, type HelperReply, type ServiceManagerConfig, type ServiceState } from "./service-helper.ts";
export type { ServiceManagerConfig } from "./service-helper.ts";

export function createServiceFamily(config: Omit<ServiceToolsDeps, "config" | "registry" | "taskContext" | "bindCall" | "verifyMain" | "requestApproval" | "requestStanding" | "recordArtifact" | "markEffectUnknown"> & { config: ServiceManagerConfig | null }): HostToolFamily {
  return {
    category: "service",
    names: config.config ? SERVICE_TOOL_NAMES : [],
    build: (runtime) => config.config ? createServiceTools({
      ...config,
      config: config.config,
      registry: runtime.registry,
      ...runtime.call,
      verifyMain: runtime.identity.verifyMain,
      requestApproval: runtime.approval.request,
      requestStanding: runtime.approval.requestStanding,
      recordArtifact: runtime.effects.recordArtifact,
      markEffectUnknown: runtime.effects.markEffectUnknown,
    }) : [],
    ledger: SERVICE_LEDGER,
  };
}

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

const MODEL_VIEW_CAP = 4 * 1024;

export interface ServiceToolsDeps {
  coreStore: Store;
  artifacts: ArtifactStore;
  registry: ManagedProcessRegistry;
  config: ServiceManagerConfig;
  /** 当前调用上下文（宿主注入；绑定一次工具调用）。 */
  taskContext(): HostToolContext | null;
  bindCall?: HostCallBinder;
  /** 执行入口每次重新核实宿主任务/会话/项目与个人助手宿主绑定；null=通过。 */
  verifyMain(ctx: HostToolContext): string | null;
  /** 审批闸门（窄回调；不向模型暴露控制面）。 */
  requestApproval: ApprovalGate["request"];
  /** 长期授权窄路径（issue 10）：宿主提供时先试命中；null 回退人工逐次审批。 */
  requestStanding?: ApprovalGate["requestStanding"];
  /** 产物引用登记（接到 task.tool_result 事件）。 */
  recordArtifact(hostOpId: string, artifactId: string): void;
  /** 已消费操作无确定结果时标效果未知（超时/调用中止；不自动重发）。 */
  markEffectUnknown(hostOpId: string): void;
}

function okText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text }] };
}

function failText(text: string): never {
  throw new Error(text);
}

function capView(text: string): string {
  return Buffer.byteLength(text, "utf8") <= MODEL_VIEW_CAP ? text : `${text.slice(0, MODEL_VIEW_CAP)}…（视图截断，原文见产物）`;
}

function errorText(err: unknown): string {
  return err instanceof ServiceHelperError ? `服务管理不可用：${err.message}` : `操作失败：${(err as Error).message}`;
}

/** 状态字段的模型视图（固定字段；观察结果，不作为修订指纹）。 */
function formatState(state: ServiceState): string {
  return [
    `LoadState=${state.loadState} ActiveState=${state.activeState} SubState=${state.subState}`,
    `MainPID=${state.mainPid} InvocationID=${state.invocationId || "（无）"} Result=${state.result}`,
    `ActiveEnterTimestamp=${state.activeEnterTimestamp || "（无）"}`,
  ].join("\n");
}

export function createServiceTools(deps: ServiceToolsDeps): ToolDefinition[] {
  const cfg = deps.config;
  const requireCtx = (ctx: HostToolContext | null): HostToolContext => {
    if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
    return ctx;
  };
  const bindExecute = <P extends Record<string, unknown>>(
    fn: (ctx: HostToolContext, params: P, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) => {
    return async (sdkCallId: string, params: P, signal?: AbortSignal) => {
      const call = hostCallFor(deps.bindCall, deps.taskContext, sdkCallId);
      try {
        return await fn(requireCtx(call.context), params, signal);
      } finally {
        call.release();
      }
    };
  };

  /** helper 调用 + 原始输出入产物；返回结构化应答与产物 id。 */
  const runHelper = async (
    ctx: HostToolContext,
    verb: string,
    args: string[],
    artifactName: string,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ reply: HelperReply; artifactId: string | null }> => {
    const artifact = deps.artifacts.begin({ taskId: ctx.taskId, sessionId: ctx.sessionId, name: artifactName });
    deps.recordArtifact(ctx.hostOpId, artifact.id);
    let captureFailed: string | null = null;
    try {
      const { stdout, stderr, reply } = await callHelper(cfg, [verb, ...args], opts);
      try {
        if (stdout.length) deps.artifacts.append(artifact.id, stdout);
        if (stderr.length) deps.artifacts.append(artifact.id, stderr);
        deps.artifacts.complete(artifact.id);
      } catch (err) {
        captureFailed = (err as Error).message;
      }
      if (captureFailed) {
        throw new ServiceHelperError(`helper 原始输出保存失败（结果不采信）：${captureFailed}`, "capture_failed");
      }
      return { reply, artifactId: artifact.id };
    } catch (err) {
      // 中断/写入失败保持 partial；产物引用仍已登记可查
      throw err;
    }
  };

  const inspect = async (
    ctx: HostToolContext,
    unit: string,
    opts: { signal?: AbortSignal },
  ): Promise<Extract<HelperReply, { ok: true; verb: "inspect" }>> => {
    const { reply } = await runHelper(ctx, "inspect", [unit], `service-inspect:${unit}`, {
      timeoutMs: cfg.timeouts?.inspectMs ?? 20_000,
      signal: opts.signal,
    });
    return requireOk(reply, "inspect") as Extract<HelperReply, { ok: true; verb: "inspect" }>;
  };

  /** 已消费操作的停止路径（登记到 ManagedProcessRegistry）：只清理派生命令单元；
   *  已提交 PID 1 的重启作业不撤回；无法确认退出时返回 false（占用保留）。 */
  const stopOp = async (hostOpId: string): Promise<boolean> => {
    try {
      const out = await callHelper(cfg, ["stop-op", hostOpId], { timeoutMs: cfg.timeouts?.stopMs ?? 15_000 });
      if (out.reply.ok && out.reply.verb === "stop-op") return out.reply.exited === true;
      return false;
    } catch {
      return false; // 权限错误/bus 不可达/查询失败都不能当作已退出
    }
  };

  const taskOf = (ctx: HostToolContext): Task => {
    const task = deps.coreStore.getTask(ctx.taskId);
    if (!task) failText("宿主任务不存在，服务管理操作被拒绝");
    return task!;
  };

  const serviceInspect = defineTool({
    name: "service_inspect",
    label: "service_inspect",
    description:
      "检查服务器部署白名单内某个服务的状态（固定字段：LoadState/ActiveState/SubState/MainPID/InvocationID/Result/" +
      "启动时间，以及策略与单元定义修订指纹）。目标必须是白名单内的精确 .service 名；不能用于部署、流水线" +
      "或系统基础设施服务。只读，无写入效果。原始 systemctl 输出保存在任务产物中。",
    parameters: Type.Object({
      unit: Type.String({ description: "白名单内的精确 .service 单元名（不支持别名、模板、路径或通配符）" }),
    }),
    execute: bindExecute(async (ctx, params, signal) => {
      try {
        const identity = deps.verifyMain(ctx);
        if (identity) failText(identity);
        const unit = String(params.unit ?? "");
        const result = await inspect(ctx, unit, { signal });
        return okText(
          [
            `服务 ${result.unit} 状态（${result.observedAt} 观察；本机 ${result.machineId.slice(0, 12)}…${result.execIdentity ? `；检查账户 uid/gid ${result.execIdentity.uid}/${result.execIdentity.gid}` : ""}）：`,
            formatState(result.state),
            `策略修订 ${result.policyRevision.slice(0, 12)}… 单元定义修订 ${result.unitRevision.slice(0, 12)}…`,
          ].join("\n"),
        );
      } catch (err) {
        return failText(errorText(err));
      }
    }),
  } as any);

  const serviceManage = defineTool({
    name: "service_manage",
    label: "service_manage",
    description:
      "对服务器部署白名单内的服务执行管理动作（首版仅 restart）。完全访问免操作审批；其他模式经拥有者逐次审批或核实限定长期授权。" +
      "OS 权限不足直接失败。restart 以 root 提权执行，会启动原本不活动的服务，可能中断该服务" +
      "正在处理的工作。目标只能是白名单内的精确 .service 名。执行中断或结果未知时不自动重试——先核实" +
      "再决定是否执行。原始命令输出保存在任务产物中。",
    parameters: Type.Object({
      unit: Type.String({ description: "白名单内的精确 .service 单元名" }),
      action: Type.Union([Type.Literal("restart")], { description: "固定动作（首版仅 restart）" }),
    }),
    execute: bindExecute(async (ctx, params, signal) => {
      const unit = String(params.unit ?? "");
      let opRegistered = false;
      const registerOp = () => {
        if (opRegistered) return;
        opRegistered = true;
        // 异步启动前登记派生命令单元：占位停止路径覆盖迟到创建的单元（helper 侧
        // stop-requested 标记在认领后、启动前拦下迟到启动）
        deps.registry.register({
          kind: "systemd_unit",
          id: opUnitFor(ctx.hostOpId),
          label: `service restart ${unit}`,
          stop: () => stopOp(ctx.hostOpId),
        });
      };
      try {
        const identity = deps.verifyMain(ctx);
        if (identity) failText(identity);
        if (params.action !== "restart") failText("首版仅支持固定动作 restart");
        // 请求前经 helper 获取可信状态与修订（同时尽早拒绝白名单外目标）
        const before = await inspect(ctx, unit, { signal });
        const { machineId, policyRevision, unitRevision } = expectRevisions(before);
        const snapshot = {
          unit,
          action: "restart",
          machine_id: machineId,
          policy_revision: policyRevision,
          unit_revision: unitRevision,
          state_before: before.state,
          note:
            "restart 以 root 提权执行固定的 systemctl restart；目标服务原本不活动时会被启动。" +
            "执行中断或超时后效果可能无法确认，效果未知不自动重发。",
        };
        const scope: Extract<ApprovalScope, { kind: "service_operation" }> = {
          kind: "service_operation",
          machineId,
          unit,
          action: "restart",
          policyRevision,
          unitRevision,
          taskId: ctx.taskId,
          toolOpId: ctx.hostOpId,
        };
        const approvalInput = {
          task: taskOf(ctx),
          hostOpId: ctx.hostOpId,
          toolName: "service_manage",
          params: snapshot,
          scope,
          signal,
          recheck: () => {
            const problem = deps.verifyMain(ctx);
            if (problem) return problem;
            // 消费事务内同步核实的部署配置修订（单元修订由 helper 在请求 systemd 前复核）
            let fresh: string;
            try {
              fresh = sha256Hex(fs.readFileSync(cfg.policyPath));
            } catch (err) {
              return `策略不可核对（${(err as Error).message}），本次授权失效，服务管理操作未执行`;
            }
            return fresh !== policyRevision ? "服务管理策略在执行前已变化，本次授权失效（未执行）；请重新检查后执行" : null;
          },
        };
        // 长期授权（issue 10）：宿主逐项核实候选并重建完整范围核验后自动放行
        // （独立的已批准记录 + 单次消费）；无候选或核实不再成立回落人工逐次审批
        const standing = approvalInput.task.accessMode === "full_access" ? null : deps.requestStanding?.(approvalInput) ?? null;
        const approval = standing ?? (await deps.requestApproval(approvalInput));
        if (!approval.approved) failText(approval.text);
        if (signal?.aborted) failText("任务已停止，服务管理操作未执行；本次授权已认领，不重放");
        // 执行参数取自授权时保存的不可变快照
        const p = approval.params as typeof snapshot;
        const approvedUnit = String(p.unit);
        const hostOpId = ctx.hostOpId;
        // 授权依据如实标注（issue 10）：本次使用长期授权 vs 拥有者单次批准
        const grantLink = approval.approvalId === null ? null : deps.coreStore.getConfirmation(approval.approvalId);
        const basisLine =
          approval.approvalId === null
            ? "授权依据：本任务的完全访问授权（执行前已核实任务、权限版本与目标修订）"
            : grantLink?.decisionSource === "standing_permission" && grantLink.standingPermissionId
            ? `授权依据：长期授权 ${grantLink.standingPermissionId} v${grantLink.standingPermissionVersion}（本次执行前已重新核实授权版本与完整范围）`
            : null;
        registerOp();
        let restartReply: Extract<HelperReply, { ok: true; verb: "restart" }>;
        try {
          const { reply } = await runHelper(
            ctx,
            "restart",
            [hostOpId, String(p.policy_revision), String(p.unit_revision), approvedUnit],
            `service-restart:${approvedUnit}:${hostOpId}`,
            { timeoutMs: cfg.timeouts?.restartMs ?? 150_000, signal },
          );
          if (!reply.ok) {
            if (reply.launched === false) {
              // helper 明确证明尚未请求 systemd：已知未执行（修订复核/单次执行保护/停止标记拦截）
              failText(`管理操作未执行：helper 在请求 systemd 前拒绝（${reply.reasonCode ?? "unknown"}：${reply.error ?? "未给出原因"}）。本次授权已认领，重新操作使用新的操作编号。`);
            }
            // 派发后失败或应答缺可信未派发证明：restart 可能已生效，效果未知（不自动重发）
            deps.markEffectUnknown(hostOpId);
            failText(`管理命令结果未知：helper 应答为派发后失败或未含可信的未派发证明（${reply.reasonCode ?? "unknown"}：${reply.error ?? "未给出原因"}）。restart 可能已生效，不自动重发；请核实后再决定是否执行`);
          }
          if (reply.verb !== "restart" || reply.hostOpId !== hostOpId || reply.opUnit !== opUnitFor(hostOpId)) {
            throw new ServiceHelperError("helper 应答的操作 ID 与请求不符", "protocol_error");
          }
          restartReply = reply;
        } catch (err) {
          if (err instanceof ServiceHelperError && (err.code === "timeout" || err.code === "aborted")) {
            // restart 已消费、命令客户端中断：效果未知，不自动重发
            deps.markEffectUnknown(hostOpId);
            failText(`管理命令结果未知（helper 调用${err.code === "timeout" ? "超时" : "被中止"}）：restart 请求可能已提交，不自动重发；请核实后再决定是否执行`);
          }
          // 消费后应答协议错误/原始输出未保全：无可信结果，一律效果未知（issue 10）
          if (err instanceof ServiceHelperError && (err.code === "protocol_error" || err.code === "capture_failed")) {
            deps.markEffectUnknown(hostOpId);
            failText(`管理命令结果未知（${err.code === "protocol_error" ? "helper 应答不可信" : "helper 原始输出未保全"}）：restart 可能已生效，不自动重发；请核实后再决定是否执行`);
          }
          throw err;
        }

        const lines: string[] = [];
        if (basisLine) lines.push(basisLine);
        if (restartReply.exitCode !== 0) {
          // 命令已提交的非零退出：如实报告退出码与输出；可能包含部分效果（不能描述为零执行）
          failText(
            [
              `管理命令已执行但退出码 ${restartReply.exitCode}（systemctl restart ${approvedUnit}）。`,
              "服务可能处于『已停止但未能启动』等部分效果状态，不是零执行；请先用 service_inspect 核实实际状态再决定下一步。",
            ].join("\n"),
          );
        }
        lines.push(`管理命令结果：systemctl restart ${approvedUnit} 已完成（退出码 0，已等待命令结束；实际执行身份 ${restartReply.execIdentity ?? "root"}，命令单元 ${restartReply.opUnit}）。退出码 0 表示 systemd 接受并完成重启动作，不代表应用业务健康。`);
        // 随后观察到的服务状态（查询失败保留已知命令结果，不伪装成功）
        try {
          const after = await inspect(ctx, approvedUnit, { signal });
          lines.push(`随后观察到的服务状态（${after.observedAt}）：\n${formatState(after.state)}`);
          const changed = after.state.invocationId !== before.state.invocationId;
          lines.push(changed ? "InvocationID 已变化：服务确实经过了新的启动周期。" : "InvocationID 未变化：请核实服务是否确实重启。");
        } catch (err) {
          lines.push(`操作后状态无法核实（${errorText(err)}）；上述管理命令结果已知，服务当前状态请稍后复查。`);
        }
        return okText(lines.join("\n"));
      } catch (err) {
        return failText(errorText(err));
      }
    }),
  } as any);

  return [serviceInspect, serviceManage] as ToolDefinition[];
}
