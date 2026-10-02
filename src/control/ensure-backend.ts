/**
 * TUI 启动时按需拉起本机后台（agent-direction issue 02，ADR 0017）。
 *
 * - 只属 ruukoto-dev：Coding Agent 打开 TUI 即进入任务界面，后台按需拉起；
 *   ruukoto（个人 Agent）沿用显式 server/systemd 启动，TUI 不越权拉起；
 * - 探测优先：控制面可认证握手即视为在运行，绝不启动第二个实例；探测令牌
 *   与客户端同一来源（RUUKOTO_OWNER_TOKEN → RUUKOTO_OWNER_TOKEN_FILE →
 *   控制目录 owner.token），都取不到（后台未启动、令牌未生成）视为不在运行；
 * - 并发收敛：多个终端同时拉起时由后台实例锁（<dataDir>/runtime.lock）仲裁
 *   为单个实例——败者进程退出，本函数在窗口内继续探测，连到胜者即成功；
 * - 拉起的后台 detached + unref：关闭 TUI 不停止后台或取消任务；
 * - 失败分类明确：子进程提前退出=启动失败（附日志尾部）；等待超时另行标注；
 *   失败路径不杀子进程——败者退出后胜者可能仍在就绪途中，误杀会破坏仲裁。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "./client.ts";
import { controlDirFor, defaultAgentDir, defaultDataDir, socketPathFor, tryResolveOwnerToken } from "./connect.ts";
import { type ProductType } from "../core/product.ts";

/** 控制面探测：socket 可连且拥有者令牌认证 + 握手通过才算在运行。 */
export async function probeControlPlane(socketPath: string, token: string | null, timeoutMs = 1500): Promise<boolean> {
  if (!token) return false;
  let client: ControlClient | null = null;
  try {
    client = await ControlClient.connect(socketPath, timeoutMs);
    await client.authenticate(token, timeoutMs);
    await client.handshake(undefined, timeoutMs);
    return true;
  } catch {
    return false;
  } finally {
    client?.close();
  }
}

/** TUI 按需拉起门控：只属 ruukoto-dev。 */
export function tuiSpawnsBackendOnDemand(product: ProductType): boolean {
  return product === "ruukoto-dev";
}

export interface EnsureBackendOptions {
  dataDir: string;
  agentDir: string;
  controlDir: string;
  /** 完整服务进程参数（默认：当前入口脚本，TS 入口换固定 bin 服务入口 + server --data-dir … --agent-dir …）。测试注入。 */
  spawnArgv?: string[];
  /** 子进程环境（默认继承当前进程）。测试注入干净环境。 */
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
  pollMs?: number;
  /** 子进程退出后的胜者收敛窗口：期间探测成功仍算拉起成功。 */
  exitGraceMs?: number;
}

export type EnsureBackendResult = { ok: true; spawned: boolean } | { ok: false; error: string };

function logTail(logPath: string, maxChars = 1200): string {
  try {
    const text = fs.readFileSync(logPath, "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return lines.join("\n").slice(-maxChars);
  } catch {
    return "";
  }
}

/** 固定服务入口：bin/ruukoto-dev.mjs（纯 JS，内部注册 tsx loader 后加载 src/cli.ts）。 */
const FIXED_SERVER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/ruukoto-dev.mjs");

/**
 * 默认服务进程参数：JS 入口（bin）原样复用；TypeScript 入口（npm start 经 tsx 执行
 * src/cli.ts，argv[1] 指向 .ts 文件）换用固定服务入口——裸 node 派生 .ts 入口会因
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
  if (await probeControlPlane(socketPath, tryResolveOwnerToken(opts.controlDir))) {
    return { ok: true, spawned: false };
  }
  // socket 可连但探测失败：后台在运行、问题在令牌而非「后台不在」——不要再拉起，直接给出令牌核对指引
  try {
    const peek = await ControlClient.connect(socketPath, 800);
    peek.close();
    return {
      ok: false,
      error:
        "后台在运行（socket 可连）但认证或握手失败：核对 RUUKOTO_OWNER_TOKEN / " +
        `RUUKOTO_OWNER_TOKEN_FILE 与 ${opts.controlDir}/owner.token 是否一致；确认后重开入口`,
    };
  } catch {
    // socket 不可连：后台确实不在运行，按需拉起
  }

  const argv = opts.spawnArgv ?? defaultServerArgv(opts);
  if (!argv) return { ok: false, error: "无法确定本产品的服务启动入口（process.argv[1] 缺失），请改用 ruukoto-dev server 显式启动" };

  fs.mkdirSync(opts.controlDir, { recursive: true, mode: 0o770 });
  const logPath = path.join(opts.controlDir, "spawn.log");
  const logFd = fs.openSync(logPath, "a");
  let child: childProcess.ChildProcess;
  try {
    child = childProcess.spawn(process.execPath, argv, {
      env: opts.env ?? process.env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref(); // 后台必须比 TUI 活得久
  child.on("error", () => {}); // spawn 级错误由轮询的提前退出分支归类

  const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
  const pollMs = opts.pollMs ?? 200;
  const exitGraceMs = opts.exitGraceMs ?? 8_000;
  let exitedAt: number | null = null;
  let lostLockRace = false;
  for (;;) {
    if (await probeControlPlane(socketPath, tryResolveOwnerToken(opts.controlDir), 1000)) {
      // 锁竞败者连到的是别的终端拉起的胜者：是复用，不是本进程拉起
      return { ok: true, spawned: !lostLockRace };
    }
    if (exitedAt === null && (child.exitCode !== null || child.signalCode !== null)) {
      exitedAt = Date.now();
      // 败于实例锁竞争不算启动失败：另一个终端拉起的胜者可能仍在就绪途中，
      // 继续探测到总截止（故 startup failure 判定只针对非锁冲突的提前退出）
      lostLockRace = /实例锁冲突|另一个进程正在运行/.test(logTail(logPath));
    }
    const now = Date.now();
    if (!lostLockRace && exitedAt !== null && now - exitedAt >= exitGraceMs) {
      const tail = logTail(logPath);
      const hint = /no_model|未找到可用模型/.test(tail) ? "\n提示：未配置可用模型，先运行「ruukoto-dev config」；修复后重开 TUI 会重新拉起。" : "";
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
        error: `等待后台就绪超时（${Math.round((opts.deadlineMs ?? 60_000) / 1000)}s；日志 ${logPath}）。进程未被杀，可能就绪较慢或有并发启动在途；也可 ruukoto-dev status 查看`,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** ruukoto-dev 产品默认目录的按需拉起（TUI 入口调用）。 */
export async function ensureRuukotoDevBackend(opts: Partial<EnsureBackendOptions> = {}): Promise<EnsureBackendResult> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const agentDir = opts.agentDir ?? defaultAgentDir();
  return ensureBackend({ ...opts, dataDir, agentDir, controlDir: opts.controlDir ?? controlDirFor(dataDir) });
}
