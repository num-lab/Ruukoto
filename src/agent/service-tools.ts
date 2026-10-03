/**
 * 服务器服务管理宿主工具（agent-direction issue 09，ADR 0019）：service_inspect /
 * service_manage。仅 main 装配（装配另要求产品 ruukoto + Linux + 显式部署配置，
 * 见 Runtime/Driver；main 不因此获得 bash）。
 *
 * - 模型只提供白名单服务名与固定动作；主机身份、taskId、hostOpId、执行身份与
 *   策略由宿主注入；只有 root 拥有、经 sudoers 固定入口的 helper 能触达 systemd；
 * - service_inspect 无写入效果，直接执行；service_manage 首版固定 restart，
 *   任何访问模式（含 full_access）都逐次审批——root 分支是后台的提权能力，
 *   不属于执行账户已有权限；执行参数取自审批记录保存的不可变快照；
 *   例外（issue 10）：拥有者保存的限定长期授权逐项核实成立时按授权范围自动放行
 *   （独立的已批准记录 + 单次消费；授权本身不被消费），撤销/失效/范围不符回落
 *   人工逐次审批；
 * - 消费后的结果分类只认可信结论：确定的请求前拒绝（launched:false）为已知未
 *   执行，确定的管理命令结果如实记录（含非零退出），其余消费后无可信结果的
 *   （协议错误/应答不符/产物保存失败/派发后失败/超时/中止）一律效果未知，不
 *   自动重发，并使同目标有效长期授权失效；
 * - 审批消费事务内同步复核 main 身份与策略修订；helper 在发送任何 restart
 *   请求前再次核实本机、白名单、策略与已加载单元修订；sqlite 消费与 systemd
 *   效果之间不存在跨系统事务；
 * - helper 的 stdout/stderr 原始字节先入 ArtifactStore，模型只见有界视图；
 *   管理命令结果与随后观察到的服务状态分别表达（退出码 0 ≠ active ≠ 业务健康）；
 *   （应答通道不用 fd3：sudo 默认关闭 fd ≥3——见 helper 头注释；应答为 stderr
 *    上唯一一条 RUUKOTO_SERVICE_REPLY 前缀单行，其余 stderr 仍是证据）
 * - 已消费的 restart 无确定结果为效果未知，不自动重发；helper 侧同 hostOpId
 *   的持久单次标记补上跨进程与瞬态单元回收后的重复保护。
 */

import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "../core/store.ts";
import type { ApprovalScope, Task } from "../core/types.ts";
import type { ApprovalGate } from "./approval-gate.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { ManagedProcessRegistry } from "./managed-processes.ts";
import type { HostToolContext } from "./host-tools.ts";

export const SERVICE_TOOL_NAMES = ["service_inspect", "service_manage"] as const;

/** 服务管理部署配置（宿主注入；模型与任务参数不提供任何路径或身份）。 */
export interface ServiceManagerConfig {
  /** 受保护 helper 的绝对路径（root 拥有 0700，sudoers 固定入口）。 */
  helperPath: string;
  /** 策略文件绝对路径（root 拥有 0644；消费事务内同步重读核对修订）。 */
  policyPath: string;
  /** 生产 true（后台无 root，经 sudoers 提权调用）；受控替身测试为 false。 */
  useSudo: boolean;
  /** sudo 绝对路径（useSudo 时）。 */
  sudoPath: string;
  /** 各动词调用上限（仅测试注入覆盖；生产取默认）。 */
  timeouts?: { inspectMs?: number; restartMs?: number; stopMs?: number };
}

interface ServiceState {
  id: string;
  loadState: string;
  activeState: string;
  subState: string;
  mainPid: number;
  invocationId: string;
  result: string;
  activeEnterTimestamp: string;
}

type HelperReply =
  | { v: 1; verb: "inspect"; ok: true; machineId: string; policyRevision: string; unitRevision: string; unit: string; state: ServiceState; execIdentity?: { uid: number; gid: number }; observedAt: string }
  | { v: 1; verb: "restart"; ok: true; machineId: string; hostOpId: string; opUnit: string; launched: true; execIdentity?: string; exitCode: number; observedAt: string }
  | { v: 1; verb: "stop-op"; ok: true; machineId: string; hostOpId: string; opUnit: string; exited: boolean; detail?: string }
  | { v: 1; verb: string; ok: false; launched?: boolean; reasonCode?: string; error?: string };

class ServiceHelperError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
  }
}

/** helper 操作单元的固定派生（停止协议只接受由同一操作 ID 派生的单元）。 */
function opUnitFor(hostOpId: string): string {
  return `ruukoto-service-op-${hostOpId}.service`;
}

/** 应答行的唯一前缀（helper 在 stderr 写唯一一条该前缀的单行 JSON；其余行是噪声证据）。 */
const REPLY_PREFIX = "RUUKOTO_SERVICE_REPLY ";

/**
 * helper 调用：固定 argv、绝对路径、清空环境；应答 = stderr 上唯一一条
 * REPLY_PREFIX 前缀单行 JSON（不用 fd3：sudo 默认关闭 fd ≥3），fd1/fd2 全部原始
 * 字节透传（由调用方入产物；restart 路径的 systemd-run --pipe 会把命令单元的
 * stderr 混入 fd2，按前缀逐行提取）。拒绝 shell 字符串与自由参数。
 */
async function callHelper(
  cfg: ServiceManagerConfig,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: Buffer; stderr: Buffer; reply: HelperReply }> {
  // 生产：sudo 固定入口（env 由 sudo 清理）；受控替身：以当前 node 直接执行脚本
  const argv = cfg.useSudo ? [cfg.sudoPath, "-n", cfg.helperPath, ...args] : [process.execPath, cfg.helperPath, ...args];
  return await new Promise((resolve, reject) => {
    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(argv[0]!, argv.slice(1), {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      reject(new ServiceHelperError(`服务管理 helper 启动失败：${(err as Error).message}`, "spawn_failed"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    (child.stdio[1] as NodeJS.ReadableStream).on("data", (c: Buffer) => stdout.push(c));
    (child.stdio[2] as NodeJS.ReadableStream).on("data", (c: Buffer) => stderr.push(c));
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      reject(new ServiceHelperError(`服务管理 helper 调用超时（${opts.timeoutMs}ms）`, "timeout"));
    }, opts.timeoutMs);
    const onAbort = () => {
      killGroup();
      reject(new ServiceHelperError("任务已停止，helper 调用已中止", "aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new ServiceHelperError(`服务管理 helper 启动失败：${(err as Error).message}`, "spawn_failed"));
    });
    child.on("close", () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const out = Buffer.concat(stderr).toString("utf8");
      const line = out.split("\n").find((l) => l.startsWith(REPLY_PREFIX));
      if (line === undefined) {
        reject(
          new ServiceHelperError(
            `服务管理 helper 未返回结构化结果（拒绝把无结果当作成功）：${out.trim().slice(0, 200) || "（无输出）"}`,
            "protocol_error",
          ),
        );
        return;
      }
      let reply: HelperReply;
      try {
        reply = JSON.parse(line.slice(REPLY_PREFIX.length).trim()) as HelperReply;
      } catch {
        reject(
          new ServiceHelperError(`服务管理 helper 应答不是合法 JSON（拒绝当作成功）：${line.slice(0, 200)}`, "protocol_error"),
        );
        return;
      }
      if (reply.v !== 1) {
        reject(new ServiceHelperError("服务管理 helper 协议版本不符", "protocol_error"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), reply });
    });
  });
}

function requireOk(reply: HelperReply, verb: string): Extract<HelperReply, { ok: true }> {
  if (!reply.ok) {
    throw new ServiceHelperError(`服务管理 helper 拒绝（${reply.reasonCode ?? "unknown"}）：${reply.error ?? "未给出原因"}`, reply.reasonCode ?? "refused");
  }
  if (reply.verb !== verb) throw new ServiceHelperError("服务管理 helper 应答与请求不符", "protocol_error");
  return reply;
}

const HEX64 = /^[0-9a-f]{64}$/;

function expectRevisions(reply: Extract<HelperReply, { ok: true }>): { machineId: string; policyRevision: string; unitRevision: string } {
  if (!("policyRevision" in reply) || !HEX64.test(reply.policyRevision) || !HEX64.test(reply.unitRevision) || !reply.machineId) {
    throw new ServiceHelperError("服务管理 helper 返回的修订指纹不完整", "protocol_error");
  }
  return { machineId: reply.machineId, policyRevision: reply.policyRevision, unitRevision: reply.unitRevision };
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
  bindCall?(sdkCallId: string): () => void;
  /** 执行入口每次重新核实宿主任务/会话/项目与 main 角色绑定；null=通过。 */
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
  const requireCtx = (): HostToolContext => {
    const ctx = deps.taskContext();
    if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
    return ctx;
  };
  const bindExecute = <P extends Record<string, unknown>>(
    fn: (params: P, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) => {
    return async (sdkCallId: string, params: P, signal?: AbortSignal) => {
      const unbind = deps.bindCall?.(sdkCallId) ?? (() => {});
      try {
        return await fn(params, signal);
      } finally {
        unbind();
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
    execute: bindExecute(async (params, signal) => {
      try {
        const ctx = requireCtx();
        const identity = deps.verifyMain(ctx);
        if (identity) failText(identity);
        const unit = String(params.unit ?? "");
        const result = await inspect(ctx, unit, { signal });
        return okText(
          [
            `服务 ${result.unit} 状态（${result.observedAt} 观察；本机 ${result.machineId.slice(0, 12)}…${result.execIdentity ? `；检查以执行账户 uid/gid ${result.execIdentity.uid}/${result.execIdentity.gid} 运行` : ""}）：`,
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
      "对服务器部署白名单内的服务执行管理动作（首版仅 restart）。任何访问模式都必须经拥有者逐次审批；" +
      "批准只对该次操作与目标有效。restart 以 root 提权执行，会启动原本不活动的服务，可能中断该服务" +
      "正在处理的工作。目标只能是白名单内的精确 .service 名。执行中断或结果未知时不自动重试——先核实" +
      "再重新申请。原始命令输出保存在任务产物中。",
    parameters: Type.Object({
      unit: Type.String({ description: "白名单内的精确 .service 单元名" }),
      action: Type.Union([Type.Literal("restart")], { description: "固定动作（首版仅 restart）" }),
    }),
    execute: bindExecute(async (params, signal) => {
      const ctx = requireCtx();
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
              return `策略不可核对（${(err as Error).message}），批准失效，服务管理操作未执行`;
            }
            return fresh !== policyRevision ? "服务管理策略在确认期间已变化，原批准失效（未执行）；请重新检查后申请" : null;
          },
        };
        // 长期授权（issue 10）：宿主逐项核实候选并重建完整范围核验后自动放行
        // （独立的已批准记录 + 单次消费）；无候选或核实不再成立回落人工逐次审批
        const standing = deps.requestStanding?.(approvalInput) ?? null;
        const approval = standing ?? (await deps.requestApproval(approvalInput));
        if (!approval.approved) failText(approval.text);
        // 执行参数取自审批保存的不可变快照
        const p = approval.params as typeof snapshot;
        const approvedUnit = String(p.unit);
        const hostOpId = ctx.hostOpId;
        // 授权依据如实标注（issue 10）：本次使用长期授权 vs 拥有者单次批准
        const grantLink = deps.coreStore.getConfirmation(approval.approvalId);
        const basisLine =
          grantLink?.decisionSource === "standing_permission" && grantLink.standingPermissionId
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
              failText(`管理操作未执行：helper 在请求 systemd 前拒绝（${reply.reasonCode ?? "unknown"}：${reply.error ?? "未给出原因"}）。本次批准已消费，再次操作需要新的审批。`);
            }
            // 派发后失败或应答缺可信未派发证明：restart 可能已生效，效果未知（不自动重发）
            deps.markEffectUnknown(hostOpId);
            failText(`管理命令结果未知：helper 应答为派发后失败或未含可信的未派发证明（${reply.reasonCode ?? "unknown"}：${reply.error ?? "未给出原因"}）。restart 可能已生效，不自动重发；请核实后重新申请`);
          }
          if (reply.verb !== "restart" || reply.hostOpId !== hostOpId || reply.opUnit !== opUnitFor(hostOpId)) {
            throw new ServiceHelperError("helper 应答的操作 ID 与请求不符", "protocol_error");
          }
          restartReply = reply;
        } catch (err) {
          if (err instanceof ServiceHelperError && (err.reasonCode === "timeout" || err.reasonCode === "aborted")) {
            // restart 已消费、命令客户端中断：效果未知，不自动重发
            deps.markEffectUnknown(hostOpId);
            failText(`管理命令结果未知（helper 调用${err.reasonCode === "timeout" ? "超时" : "被中止"}）：restart 请求可能已提交，不自动重发；请核实后重新申请`);
          }
          // 消费后应答协议错误/原始输出未保全：无可信结果，一律效果未知（issue 10）
          if (err instanceof ServiceHelperError && (err.reasonCode === "protocol_error" || err.reasonCode === "capture_failed")) {
            deps.markEffectUnknown(hostOpId);
            failText(`管理命令结果未知（${err.reasonCode === "protocol_error" ? "helper 应答不可信" : "helper 原始输出未保全"}）：restart 可能已生效，不自动重发；请核实后重新申请`);
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
