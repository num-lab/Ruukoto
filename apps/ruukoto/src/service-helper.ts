/** 服务管理 helper 的进程传输与应答校验；不持有任务或审批状态。 */

import * as childProcess from "node:child_process";

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

export interface ServiceState {
  id: string;
  loadState: string;
  activeState: string;
  subState: string;
  mainPid: number;
  invocationId: string;
  result: string;
  activeEnterTimestamp: string;
}

export type HelperReply =
  | { v: 1; verb: "inspect"; ok: true; machineId: string; policyRevision: string; unitRevision: string; unit: string; state: ServiceState; execIdentity?: { uid: number; gid: number }; observedAt: string }
  | { v: 1; verb: "restart"; ok: true; machineId: string; hostOpId: string; opUnit: string; launched: true; execIdentity?: string; exitCode: number; observedAt: string }
  | { v: 1; verb: "stop-op"; ok: true; machineId: string; hostOpId: string; opUnit: string; launcherExited?: boolean; exited: boolean; detail?: string }
  | { v: 1; verb: string; ok: false; launched?: boolean; reasonCode?: string; error?: string };

export class ServiceHelperError extends Error {
  readonly code: string;
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly capture?: { stdout: Buffer; stderr: Buffer; truncated: boolean },
  ) {
    super(message);
    this.code = reasonCode;
  }
}

/** helper 操作单元的固定派生（停止协议只接受由同一操作 ID 派生的单元）。 */
export function opUnitFor(hostOpId: string): string {
  return `ruukoto-service-op-${hostOpId}.service`;
}

/** 应答行的唯一前缀（helper 在 stderr 写唯一一条该前缀的单行 JSON；其余行是噪声证据）。 */
const REPLY_PREFIX = "RUUKOTO_SERVICE_REPLY ";

/**
 * helper 调用：固定 argv、绝对路径、清空环境；应答 = stderr 上唯一一条
 * REPLY_PREFIX 前缀单行 JSON（不用 fd3：sudo 默认关闭 fd ≥3），fd1/fd2 全部原始
 * 字节透传（由调用方入产物；restart 路径的 systemd-run --pipe 会把命令单元的
 * stderr 混入 fd2，按前缀逐行提取）。拒绝 shell 字符串与自由参数。
 * 中断后等待本次调用进程及 stdio 关闭；这不证明 systemd 操作单元已停止。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-service-helper-exit.md
 */
export async function callHelper(
  cfg: ServiceManagerConfig,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal; maxOutputBytes?: number },
): Promise<{ stdout: Buffer; stderr: Buffer; reply: HelperReply }> {
  if (opts.signal?.aborted) throw new ServiceHelperError("任务已停止，helper 尚未启动", "aborted");
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
    let bytes = 0;
    let truncated = false;
    let failureReason: { message: string; code: string } | undefined;
    const failure = (message: string, code: string) => new ServiceHelperError(message, code, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated });
    const collect = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, (opts.maxOutputBytes ?? Infinity) - bytes);
      const kept = chunk.subarray(0, remaining);
      if (kept.length) target.push(kept);
      bytes += kept.length;
      if (kept.length < chunk.length) {
        truncated = true;
        stop("服务管理 helper 输出超过上限，已停止检查；已保留有界输出。", "output_limit");
      }
    };
    (child.stdio[1] as NodeJS.ReadableStream).on("data", (c: Buffer) => collect(stdout, c));
    (child.stdio[2] as NodeJS.ReadableStream).on("data", (c: Buffer) => collect(stderr, c));
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
    const stop = (message: string, code: string) => {
      if (failureReason) return;
      failureReason = { message, code };
      killGroup();
    };
    const timer = setTimeout(() => stop(`服务管理 helper 调用超时（${opts.timeoutMs}ms）`, "timeout"), opts.timeoutMs);
    const onAbort = () => {
      stop("任务已停止，helper 调用已中止", "aborted");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      failureReason ??= { message: `服务管理 helper 启动失败：${err.message}`, code: "spawn_failed" };
    });
    child.on("close", () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (failureReason) { reject(failure(failureReason.message, failureReason.code)); return; }
      const out = Buffer.concat(stderr).toString("utf8");
      const lines = out.split("\n").filter((l) => l.startsWith(REPLY_PREFIX));
      const line = lines[0];
      if (lines.length !== 1) {
        reject(
          failure(
            `服务管理 helper 未返回结构化结果（应答须唯一）：${out.trim().slice(0, 200) || "（无输出）"}`,
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
          failure(`服务管理 helper 应答不是合法 JSON（拒绝当作成功）：${line.slice(0, 200)}`, "protocol_error"),
        );
        return;
      }
      if (!reply || typeof reply !== "object" || reply.v !== 1 || typeof reply.verb !== "string" || typeof reply.ok !== "boolean"
        || (!reply.ok && ((reply.reasonCode !== undefined && (typeof reply.reasonCode !== "string" || !/^[a-z_]{1,64}$/.test(reply.reasonCode))) || (reply.error !== undefined && typeof reply.error !== "string")))) {
        reject(failure("服务管理 helper 协议字段不完整或版本不符", "protocol_error"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), reply });
    });
    if (opts.signal?.aborted) onAbort();
  });
}

export function requireOk(reply: HelperReply, verb: string): Extract<HelperReply, { ok: true }> {
  if (!reply.ok) {
    throw new ServiceHelperError(`服务管理 helper 拒绝（${reply.reasonCode ?? "unknown"}）：${reply.error ?? "未给出原因"}`, reply.reasonCode ?? "refused");
  }
  if (reply.verb !== verb) throw new ServiceHelperError("服务管理 helper 应答与请求不符", "protocol_error");
  return reply;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function expectRevisions(reply: Extract<HelperReply, { ok: true }>): { machineId: string; policyRevision: string; unitRevision: string } {
  if (!("policyRevision" in reply) || typeof reply.policyRevision !== "string" || typeof reply.unitRevision !== "string" || !HEX64.test(reply.policyRevision) || !HEX64.test(reply.unitRevision) || typeof reply.machineId !== "string" || !reply.machineId || reply.machineId.length > 256) {
    throw new ServiceHelperError("服务管理 helper 返回的修订指纹不完整", "protocol_error");
  }
  return { machineId: reply.machineId, policyRevision: reply.policyRevision, unitRevision: reply.unitRevision };
}
