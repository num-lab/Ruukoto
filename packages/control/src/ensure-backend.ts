/**
 * TUI 启动时按需拉起本机后台（agent-direction issue 02）。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
 * Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
 *
 * - 只属 ruukoto-code：Coding Agent 打开 TUI 即进入任务界面，后台按需拉起；
 *   ruukoto（个人 Agent）沿用显式 server/systemd 启动，TUI 不越权拉起；
 * - 探测优先：控制面可认证握手即视为在运行，绝不启动第二个实例；探测令牌
 *   与客户端同一来源（RUUKOTO_OWNER_TOKEN → RUUKOTO_OWNER_TOKEN_FILE →
 *   控制目录 owner.token），都取不到（后台未启动、令牌未生成）视为不在运行；
 * - 并发收敛：多个终端同时拉起时由后台实例锁（<dataDir>/runtime.lock）仲裁
 *   为单个实例——败者进程退出，本函数在窗口内继续探测，连到胜者即成功；
 * - 拉起的后台 detached + unref：关闭 TUI 不停止后台或取消任务；
 * - 失败分类明确：socket 可连但探测被明确拒绝=后台在运行，按原始拒绝原因给指引
 *   （令牌核对 / 协议版本升级），绝不拉起；传输中断或无凭据可试时重判当前 socket，
 *   不可达即按后台不在进入拉起；子进程提前退出=启动失败（附日志尾部；锁竞争与否
 *   按本进程退出码归属判定——spawn.log 是共享追加日志，其他终端的输出不能用来
 *   解释当前子进程为何退出）；等待超时另行标注；失败路径不杀子进程——败者退出
 *   后胜者可能仍在就绪途中，误杀会破坏仲裁。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient, ControlClientError } from "./client.ts";
import { controlDirFor, defaultAgentDir, defaultDataDir, socketPathFor, tryResolveOwnerToken } from "./connect.ts";
import { INSTANCE_LOCK_EXIT_CODE } from "@ruukoto/core/instance-lock.ts";
import { type ProductType } from "@ruukoto/core/product.ts";

/** 控制面探测：socket 可连且拥有者令牌认证 + 握手通过才算在运行。 */
export async function probeControlPlane(socketPath: string, token: string | null, timeoutMs = 1500): Promise<boolean> {
  return (await probeWithReason(socketPath, token, timeoutMs)).state === "running";
}

type ProbeResult =
  | { state: "running" }
  | { state: "rejected"; definitive: boolean; error: Error | null }
  | { state: "unreachable" };

/**
 * 带原因的探测：definitive=true 的 rejected 表示连上后被服务端明确拒绝（回了拒绝
 * 应答，如 unauthorized / protocol_version，error 为原始原因）；definitive=false 表示
 * 无凭据可试或传输中断/超时——曾连上不代表后台仍在，须重判当前 socket。
 * unreachable 表示 socket 不可连（后台确实不在）。
 */
async function probeWithReason(socketPath: string, token: string | null, timeoutMs = 1500): Promise<ProbeResult> {
  if (!token) return { state: "rejected", definitive: false, error: null };
  let client: ControlClient | null = null;
  try {
    client = await ControlClient.connect(socketPath, timeoutMs);
    await client.authenticate(token, timeoutMs);
    await client.handshake(undefined, timeoutMs);
    return { state: "running" };
  } catch (err) {
    if (!client) return { state: "unreachable" };
    const definitive = err instanceof ControlClientError && err.outcome === "rejected";
    return { state: "rejected", definitive, error: err as Error };
  } finally {
    client?.close();
  }
}

/** socket 可连性补判：非明确拒绝（传输中断、超时、无凭据、首次连不上）时区分「后台在运行」与「尚未启动」——曾连上过不代表后台仍在。 */
async function socketConnectable(socketPath: string): Promise<boolean> {
  try {
    const peek = await ControlClient.connect(socketPath, 800);
    peek.close();
    return true;
  } catch {
    return false;
  }
}

/** TUI 按需拉起门控：只属 ruukoto-code。 */
export function tuiSpawnsBackendOnDemand(product: ProductType): boolean {
  return product === "ruukoto-code";
}

export interface EnsureBackendOptions {
  dataDir: string;
  agentDir: string;
  controlDir: string;
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

export type EnsureBackendResult = { ok: true; spawned: boolean } | { ok: false; error: string };

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

/** 固定服务入口：apps/ruukoto-code/bin/ruukoto-code.mjs（纯 JS，内部注册 tsx loader 后加载 packages/tui/src/cli.ts）。 */
const FIXED_SERVER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/ruukoto-code/bin/ruukoto-code.mjs");

/**
 * 默认服务进程参数：JS 入口（bin）原样复用；TypeScript 入口（npm start 经 tsx 执行
 * packages/tui/src/cli.ts，argv[1] 指向 .ts 文件）换用固定服务入口——裸 node 派生 .ts 入口会因
 * 参数属性等语法报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
 */
function defaultServerArgv(opts: EnsureBackendOptions): string[] | null {
  const entry = process.argv[1];
  if (!entry) return null;
  const serverEntry = /\.tsx?$/.test(entry) ? FIXED_SERVER_ENTRY : entry;
  return [serverEntry, "server", "--data-dir", opts.dataDir, "--agent-dir", opts.agentDir];
}

export async function ensureBackend(opts: EnsureBackendOptions): Promise<EnsureBackendResult> {
  const socketPath = socketPathFor(opts.controlDir);
  const firstProbe = await probeWithReason(socketPath, tryResolveOwnerToken(opts.controlDir));
  if (firstProbe.state === "running") {
    return { ok: true, spawned: false };
  }
  // socket 可连=后台在运行、问题在令牌或协议版本而非「后台不在」——按原始拒绝原因
  // 给指引、不再拉起。明确拒绝本身就是后台在运行的证据；传输中断、超时、无凭据或
  // 首次连不上都不足以证明后台仍在，重判当前 socket，不可达才是后台不在，按需拉起
  const connectable =
    firstProbe.state === "rejected" && firstProbe.definitive ? true : await socketConnectable(socketPath);
  if (connectable) {
    if (firstProbe.state === "rejected" && firstProbe.error instanceof ControlClientError && firstProbe.error.code === "protocol_version") {
      return {
        ok: false,
        error: `后台在运行但协议版本不兼容：${firstProbe.error.message}（升级后重开入口复用同一后台，无需改动令牌；不重复拉起）`,
      };
    }
    return {
      ok: false,
      error:
        "后台在运行（socket 可连）但认证或握手失败：核对 RUUKOTO_OWNER_TOKEN / " +
        `RUUKOTO_OWNER_TOKEN_FILE 与 ${opts.controlDir}/owner.token 是否一致；确认后重开入口`,
    };
  }

  const argv = opts.spawnArgv ?? defaultServerArgv(opts);
  if (!argv) return { ok: false, error: "无法确定本产品的服务启动入口（process.argv[1] 缺失），请改用 ruukoto-code server 显式启动" };
  const spawnExecPath = opts.spawnExecPath ?? process.execPath;

  fs.mkdirSync(opts.controlDir, { recursive: true, mode: 0o770 });
  const logPath = path.join(opts.controlDir, "spawn.log");
  // 失败消息附带的日志尾部只取本次启动写入的段落（字节偏移），历史内容不混入；
  // 拉起窗口内其他终端的并发输出仍在同一段——仅供人读，退出原因分类不依赖日志内容
  const logStart = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const logFd = fs.openSync(logPath, "a");
  let child: childProcess.ChildProcess;
  try {
    child = childProcess.spawn(spawnExecPath, argv, {
      env: opts.env ?? process.env,
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
    if (await probeControlPlane(socketPath, tryResolveOwnerToken(opts.controlDir), 1000)) {
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
      const hint = /no_model|未找到可用模型/.test(tail) ? "\n提示：未配置可用模型，先运行「ruukoto-code config」；修复后重开 TUI 会重新拉起。" : "";
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
        error: `等待后台就绪超时（${Math.round((opts.deadlineMs ?? 60_000) / 1000)}s；日志 ${logPath}）。进程未被杀，可能就绪较慢或有并发启动在途；也可 ruukoto-code status 查看`,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** ruukoto-code 产品默认目录的按需拉起（TUI 入口调用）。 */
export async function ensureRuukotoCodeBackend(opts: Partial<EnsureBackendOptions> = {}): Promise<EnsureBackendResult> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const agentDir = opts.agentDir ?? defaultAgentDir();
  return ensureBackend({ ...opts, dataDir, agentDir, controlDir: opts.controlDir ?? controlDirFor(dataDir) });
}
