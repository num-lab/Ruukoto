/**
 * 工具进程启动器：把工具工作进程放进对应的执行边界。
 *
 * - local：直接以当前账户 spawn（开发/验证专用，无隔离；生产禁止用于
 *   请求确认/自动审查模式的边界声明）；
 * - native：macOS Seatbelt + 宿主监督器，Linux bubblewrap + user scope；
 *   同一 LaunchSpec 提供工作区、授权与只读根，使用宿主工具链与目录身份；
 * - container：按任务建立 Linux 容器（固定镜像、非 root、cap-drop ALL、
 *   no-new-privileges、只读基础文件系统、独立可写 /tmp、默认无网络、
 *   只挂授权工作区与拥有者显式授予的路径，均按宿主原路径挂载，使模型
 *   看到的路径在容器内外一致）；confirm 与 auto-review 共用
 *   该受限边界；
 * - full_access：直接以启动账户执行，继承用户环境，不施加任务沙箱。
 *
 * stop() 只有平台停止入口核实退出才返回 true；macOS 原生轮询无法核实
 * 后代时返回 false，调用方保留目录占用与单元临时资料。
 * Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md
 * Note: 见 .agents/notes/implemented/feature/2026-09-22-auto-review-mode.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
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
    readonly reason?: "binary_missing" | "policy_missing" | "sandbox_rejected" | "worker_failed") {
    super(message);
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
  /** 宿主钉定的额外只读根（SubAgent 限定资料范围）：原生按只读策略，容器按只读挂载；local 忽略。
   *  dev/ino 是宿主侧目录身份供 worker init 复核；macOS Docker Desktop 经 VM 重新编号
   *  inode，容器侧恒不一致，不下发身份（缺省 dev/ino = 仅按路径复核）。 */
  readRoots?: Array<{ path: string; dev?: number; ino?: number }>;
  /**
   * 宿主钉定的工作区目录身份；原生启动必须提供，并在 init 与每调用前复核。
   * 仅 macOS 容器经 VM 重新编号而省略；库层其他启动器缺省时不另复核。
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
  readonly kind: "local" | "container" | "native";
  /** 拒绝时尚未产生单元；已产生单元后的拒绝须由 ExecutionError.unit 交出停止身份。 */
  launch(spec: LaunchSpec): Promise<LaunchedUnit>;
}

// ---------- 公共 ----------

/** 本仓库内工作进程入口（local 启动器使用；容器内为镜像中的打包产物）。 */
export function workerEntryPath(): string {
  return fileURLToPath(new URL("../tool-worker/worker.ts", import.meta.url));
}

/** 容器内工作进程入口（固定路径，镜像打包）。 */
export const CONTAINER_WORKER_PATH = "/opt/ruukoto/worker/worker.mjs";

function workerEnv(spec: LaunchSpec): NodeJS.ProcessEnv {
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

// ---------- container（受限执行模式 confirm/auto-review 的执行边界） ----------

export interface ContainerLauncherConfig {
  /** 固定工具镜像（由可信身份构建与维护，见 deploy/worker-image）。 */
  image: string;
  /** 容器内运行 uid/gid（非 root）。 */
  uid: number;
  gid: number;
  /** docker CLI 路径。 */
  dockerPath: string;
}

export function createContainerLauncher(config: ContainerLauncherConfig): WorkerLauncher {
  const execDocker = (args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFile(config.dockerPath, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr: string) => {
        const code = (err as any)?.code;
        if (err && typeof code !== "number") {
          reject(new ExecutionError("execution_unavailable", `docker 调用失败：${err.message}`));
          return;
        }
        resolve({ code: typeof code === "number" ? code : 0, stdout, stderr });
      });
    });

  return {
    kind: "container",
    async launch(spec: LaunchSpec): Promise<LaunchedUnit> {
      if (spec.mode === "full_access") {
        // 完全访问直接由当前账户启动。
        throw new ExecutionError("invalid_state", "容器启动器只用于受限执行模式（confirm/auto-review）");
      }
      // 缺少容器后端时明确失败（不回退到其他执行方式）
      if (config.dockerPath.includes("/") && !fs.existsSync(config.dockerPath)) {
        throw new ExecutionError("execution_unavailable", `docker CLI 不存在：${config.dockerPath}（不回退到其他执行方式）`);
      }
      const name = `ruukoto-task-${spec.taskId}-${process.pid.toString(36)}`;
      // 清理同名遗留（后台崩溃后 --rm 不会自动移除已停止容器）
      await execDocker(["rm", "-f", name]).catch(() => ({ code: 0, stdout: "", stderr: "" }));

      const args = [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--user",
        `${config.uid}:${config.gid}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,size=64m",
        "--network",
        "none",
        "-v",
        `${spec.workspace}:${spec.workspace}`,
        "-w",
        spec.workspace,
        "--env",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ];
      for (const granted of spec.grantedPaths) {
        args.push("-v", `${granted.path}:${granted.path}${granted.access === "read" ? ":ro" : ""}`);
      }
      for (const root of spec.readRoots ?? []) {
        args.push("-v", `${root.path}:${root.path}:ro`);
      }
      // 宿主注入的环境聚合包（issue 16：worktree 创建/挂载时的 Git safe.directory；
      // 其余任务不传入，容器环境不变）
      if (spec.env) {
        for (const [key, value] of Object.entries(spec.env)) {
          args.push("--env", `${key}=${value}`);
        }
      }
      args.push(config.image, "node", CONTAINER_WORKER_PATH);

      const child = spawn(config.dockerPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      const exit = toExitPromise(child);
      if (child.pid === undefined) {
        await exit;
        throw new ExecutionError("execution_unavailable", "容器启动入口未创建");
      }
      const unit: ManagedEntry = {
        kind: "container",
        id: name,
        label: `tool-worker container=${name} task=${spec.taskId}`,
        stop: async () => {
          // kill/rm 失败仍继续查单元；只有成功查询后不存在才证明退出。
          await execDocker(["kill", name]).catch(() => null);
          await execDocker(["rm", "-f", name]).catch(() => null);
          const remaining = await execDocker(["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
          return remaining.code === 0 && !remaining.stdout.trim().split("\n").includes(name);
        },
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
  backend: "local" | "container" | "native";
  container?: Partial<ContainerLauncherConfig>;
  native?: NativeLauncherConfig;
}

export const DEFAULT_CONTAINER_CONFIG: ContainerLauncherConfig = {
  image: process.env.RUUKOTO_WORKER_IMAGE ?? "ruukoto-worker:latest",
  uid: Number(process.env.RUUKOTO_CONTAINER_UID ?? 1000),
  gid: Number(process.env.RUUKOTO_CONTAINER_GID ?? 1000),
  dockerPath: process.env.RUUKOTO_DOCKER_PATH ?? "docker",
};

export function createLauncherFor(
  config: ExecutionBackendConfig,
  mode: AccessMode,
): WorkerLauncher {
  if (mode === "full_access" || config.backend === "local") return createLocalLauncher();
  return config.backend === "native"
    ? createNativeLauncher(config.native ?? {})
    : createContainerLauncher({ ...DEFAULT_CONTAINER_CONFIG, ...config.container });
}
