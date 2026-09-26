/**
 * 工具进程启动器：把工具工作进程放进对应的执行边界。
 *
 * - local：直接以当前账户 spawn（开发/验证专用，无隔离；生产禁止用于
 *   请求确认/自动审查模式的边界声明）；
 * - container：按任务建立 Linux 容器（固定镜像、非 root、cap-drop ALL、
 *   no-new-privileges、只读基础文件系统、独立可写 /tmp、默认无网络、
 *   只挂授权工作区与拥有者显式授予的路径）；confirm 与 auto-review 共用
 *   该受限边界（ADR 0005）；
 * - systemd：完全访问任务的执行账户启动入口（systemd-run --pipe，固定
 *   UID，KillMode=control-group）。
 *
 * 停止语义：stop() 必须停掉整个执行单元（容器/systemd 单元/进程组）并
 * 核实已退出，调用方据此决定是否释放目录占用。
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import type { AccessMode, GrantedPath } from "../../core/types.ts";
import { killProcessGroup, type ManagedEntry } from "../managed-processes.ts";

export class ExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
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
}

export interface WorkerLauncher {
  readonly kind: "local" | "container" | "systemd";
  launch(spec: LaunchSpec): Promise<LaunchedUnit>;
}

// ---------- 公共 ----------

/** 本仓库内工作进程入口（local 启动器使用；容器内为镜像中的打包产物）。 */
export function workerEntryPath(): string {
  return fileURLToPath(new URL("../tool-worker/worker.ts", import.meta.url));
}

/** 容器内工作进程入口（固定路径，镜像打包）。 */
export const CONTAINER_WORKER_PATH = "/opt/ruukoto/worker/worker.mjs";
export const CONTAINER_WORKSPACE = "/workspace";

function filteredEnv(): NodeJS.ProcessEnv {
  // 开发环境最小环境：不传凭据、SSH agent、代理配置与 RUUKOTO_* 控制面变量
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function toExitPromise(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal: signal ?? null }));
  });
}

// ---------- local（开发/验证专用） ----------

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
        env: filteredEnv(),
        detached: true, // 独立进程组，pgid == pid：整组回收的依据
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pid = child.pid!;
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
        exit: toExitPromise(child),
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
        // 完全访问不进容器：由 systemd/执行账户路径负责
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
        `${spec.workspace}:${CONTAINER_WORKSPACE}`,
        "-w",
        CONTAINER_WORKSPACE,
        "--env",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ];
      for (const [i, granted] of spec.grantedPaths.entries()) {
        const target = `/granted/${i}`;
        args.push("-v", `${granted.path}:${target}${granted.access === "read" ? ":ro" : ""}`);
      }
      args.push(config.image, "node", CONTAINER_WORKER_PATH);

      const child = spawn(config.dockerPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      const unit: ManagedEntry = {
        kind: "container",
        id: name,
        label: `tool-worker container=${name} task=${spec.taskId}`,
        stop: async () => {
          // 停止整个容器（cgroup 兜底 setsid/忽略信号的子进程），并核实已移除
          await execDocker(["kill", name]).catch(() => ({ code: 0, stdout: "", stderr: "" }));
          await execDocker(["rm", "-f", name]).catch(() => ({ code: 0, stdout: "", stderr: "" }));
          const inspect = await execDocker(["inspect", name]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
          return inspect.code !== 0; // inspect 失败 = 容器已不存在 = 确认退出
        },
      };
      return {
        entry: unit,
        stdin: child.stdin!,
        stdout: child.stdout!,
        stderr: child.stderr!,
        exit: toExitPromise(child),
      };
    },
  };
}

// ---------- systemd（完全访问的执行账户入口） ----------

export interface SystemdLauncherConfig {
  /** 专用执行账户（与后台、拥有者不同的系统身份）。 */
  uid: number;
  gid: number;
  /** 宿主上工作进程打包产物路径。 */
  workerPath: string;
  /** 直连 systemd-run（后台自身有权限时；开发/单机用）。 */
  systemdRunPath: string;
  systemctlPath: string;
  /**
   * 受保护提权入口（生产）：经 sudo 调用 root 拥有、仅允许固定参数的包装
   * 脚本（deploy/systemd/ruukoto-exec-*.sh）；执行账户不能调用它。
   */
  protectedEntry?: { sudoPath: string; launchScript: string; stopScript: string };
}

export function createSystemdLauncher(config: SystemdLauncherConfig): WorkerLauncher {
  return {
    kind: "systemd",
    async launch(spec: LaunchSpec): Promise<LaunchedUnit> {
      if (spec.mode !== "full_access") {
        throw new ExecutionError("invalid_state", "systemd 启动器只用于完全访问模式");
      }
      const entry = config.protectedEntry;
      // 缺少执行账户启动入口时明确失败（不回退到后台账户执行）
      if (!entry && !fs.existsSync(config.systemdRunPath)) {
        throw new ExecutionError(
          "execution_unavailable",
          `systemd-run 不可用：${config.systemdRunPath}（未配置执行账户入口，不回退）`,
        );
      }
      if (entry && (!fs.existsSync(entry.launchScript) || !fs.existsSync(entry.stopScript))) {
        throw new ExecutionError(
          "execution_unavailable",
          `受保护提权入口不存在：${entry.launchScript} / ${entry.stopScript}（不回退）`,
        );
      }
      const unit = `ruukoto-exec-${spec.taskId}`;
      // 参数经结构化 argv 传递，不拼 Shell；受保护入口内部固定 uid/gid/单元名
      const child = entry
        ? spawn(entry.sudoPath, [entry.launchScript, spec.taskId], { stdio: ["pipe", "pipe", "pipe"] })
        : spawn(
            config.systemdRunPath,
            [
              "--pipe",
              "--wait",
              "--quiet",
              "--uid",
              String(config.uid),
              "--gid",
              String(config.gid),
              "--unit",
              unit,
              "--property",
              "KillMode=control-group",
              config.workerPath,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
      const unitEntry: ManagedEntry = {
        kind: "systemd_unit",
        id: unit,
        label: `tool-worker systemd-unit=${unit} task=${spec.taskId}`,
        stop: async () => {
          if (entry) {
            // 包装脚本自己完成 stop 与 is-active 判定（退出码 0 = 已不在活动）
            const code = await new Promise<number>((resolve) => {
              execFile(entry.sudoPath, [entry.stopScript, unit], { timeout: 20_000 }, (err) =>
                resolve(err ? ((err as any).code ?? 1) : 0),
              );
            });
            return code === 0;
          }
          await new Promise((resolve) => {
            execFile(config.systemctlPath, ["stop", unit], { timeout: 15_000 }, () => resolve(null));
          });
          const check = await new Promise<string>((resolve) => {
            execFile(config.systemctlPath, ["is-active", unit], { timeout: 5_000 }, (err, stdout) =>
              resolve(err ? String(stdout ?? "") : String(stdout ?? "").trim()),
            );
          });
          return check.trim() !== "active";
        },
      };
      return {
        entry: unitEntry,
        stdin: child.stdin!,
        stdout: child.stdout!,
        stderr: child.stderr!,
        exit: toExitPromise(child),
      };
    },
  };
}

export interface ExecutionBackendConfig {
  backend: "local" | "container" | "systemd";
  container?: Partial<ContainerLauncherConfig>;
  systemd?: Partial<SystemdLauncherConfig>;
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
  switch (config.backend) {
    case "local":
      return createLocalLauncher();
    case "container":
      if (mode === "full_access") {
        // 容器后端下完全访问需要执行账户入口：显式配置，或部署环境配置的
        // 受保护提权入口；都没有时明确失败，不回退（直连 systemd-run 不经
        // 环境启用）。auto-review 与 confirm 共用受限容器边界
        const systemdConfig = { ...defaultSystemdConfig(), ...config.systemd };
        if (!config.systemd && !systemdConfig.protectedEntry) {
          throw new ExecutionError(
            "execution_unavailable",
            "完全访问模式需要执行账户启动入口：设置 RUUKOTO_EXEC_LAUNCH_SCRIPT 与 RUUKOTO_EXEC_STOP_SCRIPT（见 deploy/systemd），当前未配置；不回退到其他执行方式",
          );
        }
        return createSystemdLauncher(systemdConfig);
      }
      return createContainerLauncher({ ...DEFAULT_CONTAINER_CONFIG, ...config.container });
    case "systemd":
      if (mode !== "full_access") {
        throw new ExecutionError("invalid_state", "systemd 启动器只用于完全访问模式");
      }
      return createSystemdLauncher({ ...defaultSystemdConfig(), ...config.systemd });
  }
}

function defaultSystemdConfig(): SystemdLauncherConfig {
  const launchScript = process.env.RUUKOTO_EXEC_LAUNCH_SCRIPT;
  const stopScript = process.env.RUUKOTO_EXEC_STOP_SCRIPT;
  return {
    uid: Number(process.env.RUUKOTO_EXEC_UID ?? 0),
    gid: Number(process.env.RUUKOTO_EXEC_GID ?? 0),
    workerPath: process.env.RUUKOTO_WORKER_PATH ?? CONTAINER_WORKER_PATH,
    systemdRunPath: "/usr/bin/systemd-run",
    systemctlPath: "/usr/bin/systemctl",
    // 生产部署经环境启用受保护提权入口（root 拥有的包装脚本，仅后台可 sudo）
    protectedEntry:
      launchScript && stopScript
        ? {
            sudoPath: process.env.RUUKOTO_EXEC_SUDO ?? "/usr/bin/sudo",
            launchScript,
            stopScript,
          }
        : undefined,
  };
}
