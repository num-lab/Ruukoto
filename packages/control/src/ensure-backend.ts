/**
 * Starts the local backend only after authenticated probing and current lock inspection.
 * A verified live owner may be restoring a lost endpoint; wait without spawning or signaling it.
 * Concurrent starters converge through the runtime lock and retry authenticated readiness.
 * Detached children outlive clients; startup failure never kills a possible concurrent winner.
 * Note: See .agents/notes/implemented/bug-fix/2026-10-17-desktop-connection-startup.md
 * Note: See .agents/notes/implemented/architecture/2026-11-10-single-product-profile.md
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ControlClient, ControlClientError, type ProtocolVersions } from "./client.ts";
import { tryResolveOwnerToken } from "./connect.ts";
import { INSTANCE_LOCK_EXIT_CODE, probeLockHolder } from "@ruukoto/core/instance-lock.ts";
import { profileChildEnv, verifyProfile, type ProfilePaths } from "@ruukoto/core/profile.ts";

/** 控制面就绪探测：拥有者认证后 ping 确认未停止，不取快照或订阅事件。 */
export async function probeControlPlane(profile: ProfilePaths, token: string | null, timeoutMs = 1500): Promise<boolean> {
  return (await probeWithReason(profile, token, timeoutMs)).state === "running";
}

type ProbeResult =
  | { state: "running" }
  | { state: "rejected"; definitive: boolean; error: Error | null }
  | { state: "unreachable" };

/** A definitive rejection proves a responding backend; transport failure requires lock inspection. */
async function probeWithReason(profile: ProfilePaths, token: string | null, timeoutMs = 1500): Promise<ProbeResult> {
  verifyProfile(profile);
  if (!token) return { state: "rejected", definitive: false, error: null };
  let client: ControlClient | null = null;
  try {
    client = await ControlClient.connect(profile.socketPath, timeoutMs);
    await client.authenticate(token, profile, timeoutMs);
    const result = await client.request<{ pong?: unknown; stopping?: unknown } | null>("ping", {}, timeoutMs);
    if (!result || result.pong !== true || typeof result.stopping !== "boolean") throw new ControlClientError("invalid_response", "后台就绪响应无效；请确认后台版本并重新连接。", "rejected");
    if (result.stopping) throw new ControlClientError("backend_stopping", "后台正在退出；请等待退出完成后重新连接，不重复拉起。", "rejected");
    return { state: "running" };
  } catch (err) {
    if (!client) return { state: "unreachable" };
    const definitive = err instanceof ControlClientError && err.outcome === "rejected";
    return { state: "rejected", definitive, error: err as Error };
  } finally {
    client?.close();
  }
}

/** 只判断 socket 是否可连；既有实例的存在性门控与探测失败补判不能据此声称已认证或就绪。 */
export async function socketConnectable(socketPath: string): Promise<boolean> {
  try {
    const peek = await ControlClient.connect(socketPath, 800);
    peek.close();
    return true;
  } catch {
    return false;
  }
}


export interface EnsureBackendOptions {
  profile: ProfilePaths;
  /** 服务可执行文件（默认 process.execPath）；外部 Node 与 spawnArgv 中的 bin 分别传入。 */
  spawnExecPath?: string;
  /** 服务参数，不含可执行文件（默认：当前入口脚本，TS 入口换固定 bin 服务入口 + server --data-dir … --agent-dir …）。 */
  spawnArgv?: string[];
  /** 子进程环境（默认继承当前进程）；不影响调用方的路径与令牌解析。 */
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
  pollMs?: number;
  /** 子进程退出后的胜者收敛窗口：期间探测成功仍算拉起成功。 */
  exitGraceMs?: number;
}

export type EnsureBackendResult = { ok: true; spawned: boolean } | { ok: false; error: string; code?: string; versions?: ProtocolVersions };

/**
 * 读日志尾部；from（字节偏移）之后的内容才算（spawn.log 共享追加，from 用于限定
 * 本次启动的输出）。必须按字节切分：多字节历史（中文锁错误行）不会让起点错位。
 */
function logTail(logPath: string, from = 0, maxChars = 1200): string {
  try {
    const text = fs.readFileSync(logPath).subarray(from).toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return lines.join("\n").slice(-maxChars);
  } catch {
    return "";
  }
}

/** Fixed source entry shared by terminal and desktop hosts. */
const FIXED_SERVER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/ruukoto/bin/ruukoto.mjs");


export async function ensureBackend(opts: EnsureBackendOptions): Promise<EnsureBackendResult> {
  verifyProfile(opts.profile);
  const { socketPath, controlDir } = opts.profile;
  const firstProbe = await probeWithReason(opts.profile, tryResolveOwnerToken(controlDir));
  if (firstProbe.state === "running") {
    return { ok: true, spawned: false };
  }
  // A definitive rejection or a currently connectable address forbids another starter.
  // An absent address alone does not prove exit: the runtime lock may name a live owner.
  const connectable =
    firstProbe.state === "rejected" && firstProbe.definitive ? true : await socketConnectable(socketPath);
  if (connectable) {
    if (firstProbe.state === "rejected" && firstProbe.error instanceof ControlClientError && ["backend_stopping", "invalid_response"].includes(firstProbe.error.code)) return { ok: false, error: firstProbe.error.message, code: firstProbe.error.code };
    if (firstProbe.state === "rejected" && firstProbe.error instanceof ControlClientError && firstProbe.error.code === "protocol_version") {
      return {
        ok: false,
        error: `后台在运行但协议版本不兼容：${firstProbe.error.message}（无需改动令牌；不重复拉起）`,
        code: firstProbe.error.code,
        versions: firstProbe.error.versions,
      };
    }
    return {
      ok: false,
      error:
        "后台在运行（socket 可连）但认证或就绪探测失败：核对 RUUKOTO_OWNER_TOKEN / " +
        `RUUKOTO_OWNER_TOKEN_FILE 与 ${controlDir}/owner.token 是否一致；确认后重开入口`,
      code: firstProbe.state === "rejected" && firstProbe.error instanceof ControlClientError ? firstProbe.error.code : undefined,
    };
  }

  const lockPath = path.join(opts.profile.dataDir, "runtime.lock");
  const repairDeadline = Date.now() + (opts.deadlineMs ?? 60_000);
  for (;;) {
    const owner = probeLockHolder(lockPath);
    if (!owner.held) break;
    if (owner.unverifiable) return {
      ok: false, code: "instance_lock_unverifiable",
      error: `无法核实后台持锁身份；未启动另一个后台。请检查 ${lockPath}`,
    };
    const remaining = repairDeadline - Date.now();
    if (remaining <= 0) return {
      ok: false, code: "control_endpoint_unavailable",
      error: `现有后台仍持有实例锁，但控制端点尚未恢复；未重启或停止后台。请检查 ${socketPath} 及后台日志。`,
    };
    const probe = await probeWithReason(opts.profile, tryResolveOwnerToken(controlDir), Math.min(1000, remaining));
    if (probe.state === "running") return { ok: true, spawned: false };
    if (probe.state === "rejected" && probe.definitive) return {
      ok: false, error: probe.error?.message ?? "后台拒绝就绪探测",
      code: probe.error instanceof ControlClientError ? probe.error.code : undefined,
      versions: probe.error instanceof ControlClientError ? probe.error.versions : undefined,
    };
    await delay(Math.min(opts.pollMs ?? 200, Math.max(1, repairDeadline - Date.now())));
  }

  const argv = opts.spawnArgv ?? [FIXED_SERVER_ENTRY, "server"];
  const spawnExecPath = opts.spawnExecPath ?? process.execPath;

  fs.mkdirSync(opts.profile.logsDir, { recursive: true, mode: 0o700 });
  const logPath = opts.profile.spawnLogPath;
  // 失败消息附带的日志尾部只取本次启动写入的段落（字节偏移），历史内容不混入；
  // 拉起窗口内其他终端的并发输出仍在同一段——仅供人读，退出原因分类不依赖日志内容
  const logStart = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const logFd = fs.openSync(logPath, "a");
  let child: childProcess.ChildProcess;
  try {
    child = childProcess.spawn(spawnExecPath, argv, {
      env: profileChildEnv(opts.profile.selection, opts.env ?? process.env),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref(); // 后台必须比 TUI 活得久
  let spawnErrorCode: string | null = null;
  child.on("error", (err: NodeJS.ErrnoException) => { spawnErrorCode = err.code ?? "UNKNOWN"; });

  const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
  const pollMs = opts.pollMs ?? 200;
  const exitGraceMs = opts.exitGraceMs ?? 8_000;
  let exitedAt: number | null = null;
  let lostLockRace = false;
  for (;;) {
    const probe = await probeWithReason(opts.profile, tryResolveOwnerToken(controlDir), 1000);
    if (probe.state === "rejected" && probe.definitive) return { ok: false, error: probe.error?.message ?? "后台拒绝就绪探测", code: probe.error instanceof ControlClientError ? probe.error.code : undefined };
    if (probe.state === "running") {
      // 锁竞争败者或 spawn 失败时，连到的是其他调用方拉起的后台。
      return { ok: true, spawned: !lostLockRace && spawnErrorCode === null };
    }
    if (spawnErrorCode !== null) {
      const hint = spawnErrorCode === "ENOENT" ? "找不到 node，请确认路径存在，修正 node 路径后重试"
        : spawnErrorCode === "EACCES" ? "node 不可执行，请检查执行权限或选择可执行的 node 后重试"
        : `无法执行 node（${spawnErrorCode}），请检查 node 路径与执行环境后重试`;
      return { ok: false, error: `后台启动失败：${spawnExecPath}：${hint}` };
    }
    if (exitedAt === null && (child.exitCode !== null || child.signalCode !== null)) {
      exitedAt = Date.now();
      // 败于实例锁竞争不算启动失败：继续探测到总截止等胜者就绪（故 startup failure
      // 判定只针对非锁冲突的提前退出）。锁竞争按本进程退出码归属判定——共享
      // spawn.log 会混入其他终端的输出，日志文本不能解释当前子进程为何退出
      lostLockRace = child.exitCode === INSTANCE_LOCK_EXIT_CODE;
    }
    const now = Date.now();
    if (!lostLockRace && exitedAt !== null && now - exitedAt >= exitGraceMs) {
      const tail = logTail(logPath, logStart);
      const hint = /no_model|未找到可用模型/.test(tail) ? "\n提示：未配置可用模型，先运行「ruukoto config」；修复后重开 TUI 会重新拉起。" : "";
      return {
        ok: false,
        error:
          `后台启动失败：服务进程已退出且控制面未就绪（日志 ${logPath}）。` +
          (tail ? `\n${tail}` : "") +
          hint,
      };
    }
    if (now >= deadline) {
      return {
        ok: false,
        error: `等待后台就绪超时（${Math.round((opts.deadlineMs ?? 60_000) / 1000)}s；日志 ${logPath}）。进程未被杀，可能就绪较慢或有并发启动在途；也可 ruukoto status 查看`,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
