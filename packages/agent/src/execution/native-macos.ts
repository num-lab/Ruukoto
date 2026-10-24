/**
 * Seatbelt 约束工具进程；宿主监督器核实后代身份与停止结果。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
 * Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-native-marker-atomic-publish.md
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { ExecutionError, type LaunchedUnit, type LaunchSpec } from "./launchers.ts";
import type { PreparedNativeLaunch } from "./native.ts";

export function macosNativeProfile(input: PreparedNativeLaunch): string {
  const reads = new Set([...input.runtimeReadRoots, ...input.toolAliases.flatMap(alias => [alias.path, alias.target]), ...input.mounts.map(mount => mount.path), input.tempDir, input.nodePath, input.workerPath]);
  const ancestors = new Set<string>(["/", "/dev", "/var"]);
  for (const root of reads) {
    for (let parent = path.dirname(root); parent !== "/"; parent = path.dirname(parent)) ancestors.add(parent);
  }
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork sysctl-read)",
    '(deny sysctl-read (sysctl-name-regex #"^kern\\.proc.*"))',
    "(allow signal (target self) (target same-sandbox))",
    "(deny process-info*)",
    "(allow process-info* (target self))",
    '(allow file-read* (literal "/"))',
    '(allow file-read* file-write* (literal "/dev/null"))',
    "(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))",
    ...Array.from(ancestors, root => `(allow file-read-metadata (literal ${JSON.stringify(root)}))`),
    ...Array.from(reads, root => `(allow file-read* (subpath ${JSON.stringify(root)}))`),
    `(allow file-write* (subpath ${JSON.stringify(input.tempDir)}))`,
    ...input.mounts.map(mount => `(${mount.access === "read" ? "deny" : "allow"} file-write* (subpath ${JSON.stringify(mount.path)}))`),
  ].join("\n");
}

/** 启动前核实 libproc ABI 与原子信号能力；缺能力不产生工具单元。 */
export async function checkMacosNativeHelper(helperPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(helperPath, ["--check"], { timeout: 5000, env: { PATH: "/usr/bin:/bin" } }, error => {
      if (error) reject(new ExecutionError("execution_unavailable", "macOS 原生监督器不可用：运行 npm run build:native 重建，并核实系统支持 libproc 身份与原子信号", undefined,
        typeof error.code === "string" ? "binary_missing" : "policy_missing"));
      else resolve();
    });
  });
}

/** 单元创建后的失败携带停止身份；false 由共享生命周期保留占用与临时目录。 */
export async function launchMacosNative(input: PreparedNativeLaunch, spec: LaunchSpec, helperPath: string): Promise<LaunchedUnit> {
  await checkMacosNativeHelper(helperPath);
  try { fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK); }
  catch { throw new ExecutionError("execution_unavailable", "macOS 缺少 sandbox-exec，原生执行不可用", undefined, "binary_missing"); }
  // 标记来自尚未加载工具代码的可信 Node；每单元独立目录不向其他任务开放。
  const markerPath = path.join(input.tempDir, "native-started");
  const bootstrap = "const fs=require('node:fs');fs.writeFileSync(process.argv[2]+'.tmp','started');fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);import(require('node:url').pathToFileURL(process.argv[1]).href);";
  const child = spawn(helperPath, ["--", "/usr/bin/sandbox-exec", "-p", macosNativeProfile(input), input.nodePath, "-e", bootstrap, input.workerPath, markerPath], {
    cwd: input.workspace,
    env: input.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", error => reject(new ExecutionError("execution_unavailable", `macOS 原生监督器启动失败：${error.message}`, undefined, "binary_missing")));
  });
  void exit.catch(() => undefined);
  if (child.pid === undefined) {
    await exit;
    throw new ExecutionError("execution_unavailable", "macOS 原生监督器未创建", undefined, "binary_missing");
  }
  const status = child.stdio[3] as Readable;
  const control = child.stdio[4] as Writable;
  const stderr = new PassThrough();
  child.stderr!.pipe(stderr);
  let stopResult: boolean | null = null;
  let resolveStop!: (result: boolean) => void;
  const stopped = new Promise<boolean>(resolve => { resolveStop = resolve; });
  const finishStop = (result: boolean): void => {
    if (stopResult === null) { stopResult = result; resolveStop(result); }
  };
  let stopPromise: Promise<boolean> | null = null;
  const unit: LaunchedUnit = {
    entry: {
      kind: "process_group", id: String(child.pid), label: `tool-worker native supervisor=${child.pid} task=${spec.taskId}`,
      stop: () => stopPromise ??= (async () => {
        if (stopResult !== null) return stopResult;
        if (!control.destroyed) control.end("stop\n");
        const timer = setTimeout(() => finishStop(false), 12_000);
        try { return await stopped; }
        finally { clearTimeout(timer); }
      })(),
    },
    stdin: child.stdin!, stdout: child.stdout!, stderr, exit,
  };
  let finishStart!: (error?: ExecutionError) => void;
  let supervisorStarted = false;
  let sandboxStarted = false;
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finishStart(new ExecutionError("execution_unavailable", "macOS 原生监督器启动核实超时", unit, "sandbox_rejected")), 5000);
    let settled = false;
    finishStart = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
  });
  const refreshMarker = (): void => {
    try {
      if (fs.readFileSync(markerPath, "utf8") !== "started") { failed(); return; }
      sandboxStarted = true;
      if (supervisorStarted) finishStart();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed();
    }
  };
  const markerPoll = setInterval(refreshMarker, 10);
  const failed = (): void => {
    finishStop(false);
    finishStart(new ExecutionError("execution_unavailable", "macOS 原生监督器状态不可核实；保留执行占用", unit, "sandbox_rejected"));
    control.end();
  };
  let buffer = "";
  status.setEncoding("utf8");
  status.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8192) { failed(); return; }
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: { type?: string; pid?: number; reaped?: boolean; reason?: string };
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) { failed(); return; }
        message = parsed;
      }
      catch { failed(); return; }
      if (message.type === "started" && Number.isInteger(message.pid) && message.pid! > 0) {
        unit.entry.label += ` worker=${message.pid}`;
        supervisorStarted = true;
        if (sandboxStarted) finishStart();
      } else if (message.type === "stopped" && typeof message.reaped === "boolean") {
        finishStop(message.reaped);
      } else if (message.type === "failed") {
        finishStart(new ExecutionError("execution_unavailable", `macOS 原生执行准备失败：${message.reason ?? "supervisor_failed"}`, unit, "sandbox_rejected"));
      } else { failed(); return; }
    }
  });
  status.on("error", failed);
  control.on("error", () => {
    // 自然退出可先关闭控制端；等待同次回收的状态或 close，不把 EPIPE 先缓存成失败。
  });
  child.once("close", () => {
    // 退出事件可能先于计时器；标记文件仍证明 SDK 失败前已进入受限 Node。
    refreshMarker();
    finishStop(false);
    finishStart(new ExecutionError("execution_unavailable", "macOS 原生执行入口在启动核实前退出", unit, sandboxStarted ? "worker_failed" : "sandbox_rejected"));
  });
  try { await started; return unit; }
  catch (error) { await unit.entry.stop(); throw error; }
  finally { clearInterval(markerPoll); }
}
