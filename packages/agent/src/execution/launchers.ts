/**
 * 工具进程启动器：把工具工作进程放进对应的执行边界。
 *
 * - local：直接以当前账户 spawn（开发/验证专用，无隔离；生产禁止用于
 *   请求确认/自动审查模式的边界声明）；
 * - native：macOS Seatbelt + 宿主监督器，Linux bubblewrap + user scope；
 *   同一 LaunchSpec 提供工作区、授权与只读根，使用宿主工具链与目录身份；
 * - full_access：直接以启动账户执行，继承用户环境，不施加任务沙箱。
 *
 * stop() 只有平台停止入口核实退出才返回 true；macOS 原生轮询无法核实
 * 后代时返回 false，调用方保留目录占用与单元临时资料。
 * Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md
 * Note: 见 .agents/notes/implemented/feature/2026-09-22-auto-review-mode.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-12-personal-native-sandbox.md
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import type { AccessMode, GrantedPath } from "@ruukoto/core/types.ts";
import { killProcessGroup, type ManagedEntry } from "../managed-processes.ts";
import { createNativeLauncher, type NativeLauncherConfig } from "./native.ts";

export class ExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string, readonly unit?: LaunchedUnit,
    readonly reason?: "binary_missing" | "policy_missing" | "sandbox_rejected" | "worker_failed", options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface LaunchedUnit {
  entry: ManagedEntry;
  stdin: Writable;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  /** 退出信息；exit 前一直 pending。 */
  exit: Promise<{ code: number | null; signal: string | null }>;
}

export interface LaunchSpec {
  taskId: string;
  mode: AccessMode;
  /** 授权工作区（realpath）。 */
  workspace: string;
  /** 拥有者为该任务显式授予的工作区外路径。 */
  grantedPaths: GrantedPath[];
  /** 宿主钉定的额外只读根（SubAgent 限定资料范围）；dev/ino 供 worker init 复核，库层省略时仅按路径复核。 */
  readRoots?: Array<{ path: string; dev?: number; ino?: number }>;
  /**
   * 宿主钉定的工作区目录身份；原生启动必须提供，并在 init 与每调用前复核。
   * 库层 local 缺省时不另复核。
   */
  workspaceIdentity?: { dev: number; ino: number };
  /**
   * 工作副本的固定环境聚合包：只在 worktree 副本创建与子任务使用副本时
   * 由宿主注入（Git safe.directory 等）；其余任务恒为 undefined，
   * env 键不进入 workerKey。
   */
  env?: Record<string, string>;
}

export interface WorkerLauncher {
  readonly kind: "local" | "native";
  /** 拒绝时尚未产生单元；已产生单元后的拒绝须由 ExecutionError.unit 交出停止身份。 */
  launch(spec: LaunchSpec): Promise<LaunchedUnit>;
}

// ---------- 公共 ----------

/** 本仓库内工作进程入口（local 启动器使用）。 */
export function workerEntryPath(): string {
  return fileURLToPath(new URL("../tool-worker/worker.ts", import.meta.url));
}

export function workerEnv(spec: LaunchSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = spec.mode === "full_access" ? { ...process.env } : {};
  if (spec.mode !== "full_access") {
    for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  Object.assign(env, spec.env);
  for (const key of ["RUUKOTO_OWNER_TOKEN", "RUUKOTO_OWNER_TOKEN_FILE", "RUUKOTO_CONTROL_DIR", "RUUKOTO_CODE_CONTROL_DIR"]) {
    delete env[key];
  }
  return env;
}

function toExitPromise(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("exit", (code, signal) => resolve({ code, signal: signal ?? null }));
    child.on("error", error => reject(new ExecutionError("execution_unavailable", `工具执行入口启动失败：${error.message}`)));
  });
  // 启动中的取消可能尚未安装 host 监听；原 Promise 仍由启动记录消费。
  void exit.catch(() => undefined);
  return exit;
}

// ---------- local（当前账户；受限模式仅供开发/验证） ----------

export interface LocalLauncherOptions {
  /** spawn 使用的 tsx 加载器；默认 node --import tsx。 */
  execArgv?: string[];
}

export function createLocalLauncher(opts: LocalLauncherOptions = {}): WorkerLauncher {
  return {
    kind: "local",
    async launch(spec: LaunchSpec): Promise<LaunchedUnit> {
      const entry = workerEntryPath();
      if (!fs.existsSync(entry)) {
        throw new ExecutionError("execution_unavailable", `工具工作进程入口不存在：${entry}`);
      }
      // spawn cwd 只影响 tsx 加载器的模块解析（必须从本仓库 node_modules 解析），
      // 与工具执行目录无关：工具 cwd 由 init 消息按任务工作区设定
      const child = spawn(process.execPath, opts.execArgv ?? ["--import", "tsx", entry], {
        cwd: path.dirname(entry),
        env: workerEnv(spec),
        detached: true, // 独立进程组，pgid == pid：整组回收的依据
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exit = toExitPromise(child);
      const pid = child.pid;
      if (pid === undefined) {
        await exit;
        throw new ExecutionError("execution_unavailable", "工具工作进程未创建");
      }
      const unit: ManagedEntry = {
        kind: "process_group",
        id: String(pid),
        label: `tool-worker local pid=${pid} task=${spec.taskId}`,
        stop: () => killProcessGroup(pid),
      };
      return {
        entry: unit,
        stdin: child.stdin!,
        stdout: child.stdout!,
        stderr: child.stderr!,
        exit,
      };
    },
  };
}

export interface ExecutionBackendConfig {
  backend: "local" | "native";
  native?: NativeLauncherConfig;
}

export function createLauncherFor(
  config: ExecutionBackendConfig,
  mode: AccessMode,
): WorkerLauncher {
  if (mode === "full_access" || config.backend === "local") return createLocalLauncher();
  return createNativeLauncher(config.native ?? {});
}
