/**
 * 工具工作进程入口：在执行边界内（受限沙箱或启动账户）运行上游编码工具。
 *
 * 职责边界（issue 03 实施计划 §1）：
 * - 只执行 read/edit/write/bash 四种编码工具；没有模型、SDK 会话、持久化，
 *   不接收审批、模式切换或控制面协议；完全访问能访问同账户资料；
 * - 通过 BashOperations.onData 与文件 Operations 包装器，把未经截断的原始
 *   输出/正文流回后台（后台存产物后另生成限长模型视图）；
 * - Shell 子进程以独立进程组启动并登记；中止与关停时先整组回收再退出。
 *   脱离原组的后代由平台停止协议核实；local 不保证回收此类后代，
 *   无法核实时由宿主保留占用。
 *
 * 通信：stdin/stdout 上的换行分帧 JSON；stderr 只用于诊断日志。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { killProcessGroup } from "../managed-processes.ts";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  generateUnifiedPatch,
  getShellConfig,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { statsFromPatch } from "@ruukoto/core/history.ts";
import { grantCoversPath } from "@ruukoto/core/worktree.ts";
import type { EditStats } from "@ruukoto/core/types.ts";
import { imageMime } from "../artifacts.ts";
import {
  DATA_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  WORKER_TOOL_NAMES,
  type DataStream,
  type WorkerMessage,
  type WorkerRequest,
} from "./protocol.ts";

// ---------- 输出通道（含背压与单帧上限） ----------

let stdoutDrained: Promise<void> = Promise.resolve();

function sendMessage(msg: WorkerMessage): void {
  const line = JSON.stringify(msg);
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    // 图片结果无法按正文流分块；只失败当前操作，保留 worker 与已捕获的原文。
    const opId = "opId" in msg ? msg.opId : undefined;
    fail(`工作进程消息超限：op=${opId ?? "?"}`, opId);
    return;
  }
  stdoutDrained = stdoutDrained.then(async () => {
    const ok = process.stdout.write(`${line}\n`);
    if (!ok) await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  });
}

function fail(message: string, opId?: string): void {
  if (opId) {
    sendMessage({ type: "result", opId, ok: false, content: [{ type: "text", text: `工具执行失败：${message}` }], isError: true, errorMessage: message });
  } else {
    sendMessage({ type: "fatal", message });
  }
}

// ---------- 原始数据流（未经上游截断的正文） ----------

function streamData(opId: string, stream: DataStream, data: Buffer): void {
  for (let offset = 0; offset < data.length; offset += DATA_CHUNK_BYTES) {
    const chunk = data.subarray(offset, Math.min(offset + DATA_CHUNK_BYTES, data.length));
    sendMessage({ type: "data", opId, stream, chunk: chunk.toString("base64") });
  }
}

// ---------- Shell 子进程登记表 ----------

interface TrackedChild {
  stop?: Promise<boolean>;
}

const trackedChildren = new Map<number, TrackedChild>();
let childrenReaped = true;

async function killTrackedChild(pid: number): Promise<boolean> {
  const entry = trackedChildren.get(pid);
  if (!entry) return true;
  entry.stop ??= killProcessGroup(pid);
  const reaped = await entry.stop;
  if (reaped) trackedChildren.delete(pid);
  else childrenReaped = false;
  return reaped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function shutdown(): Promise<void> {
  const results = await Promise.all(Array.from(trackedChildren.keys(), pid => killTrackedChild(pid)));
  sendMessage({ type: "stopped", reaped: childrenReaped && results.every(Boolean) });
  await stdoutDrained;
  process.exit(0);
}

// ---------- 上游工具与自定义 Operations ----------

/** 当前运行中调用的 opId（供 Operations 包装器关联数据流）。 */
const activeOpIds = new Map<string, string>(); // toolName -> opId（并发同名调用以前者为准；SDK 默认顺序执行）

function bashOperations(): BashOperations {
  return {
    exec: (command, cwd, options) =>
      new Promise((resolve) => {
        const shell = getShellConfig();
        const child = spawn(shell.shell, [...shell.args, command], {
          cwd,
          detached: true, // 独立进程组：中止/关停可整组回收
          env: options.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const pid = child.pid!;
        if (pid !== undefined) trackedChildren.set(pid, {});
        const opId = currentOpId("bash");
        child.stdout!.on("data", (d: Buffer) => {
          options.onData(d);
          if (opId) streamData(opId, "stdout", d);
        });
        child.stderr!.on("data", (d: Buffer) => {
          options.onData(d);
          if (opId) streamData(opId, "stderr", d);
        });
        const onAbort = () => {
          void killTrackedChild(pid);
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const finish = (exitCode: number | null) => {
          options.signal?.removeEventListener("abort", onAbort);
          // 主 Shell 退出后仍核实原组，后台子进程不能丢失停止归属。
          void killTrackedChild(pid).then(() => resolve({ exitCode }));
        };
        child.on("error", () => finish(127));
        child.on("close", (code) => finish(code));
      }),
  };
}

function currentOpId(toolName: string): string | undefined {
  return activeOpIds.get(toolName);
}

function readOperations(): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const buf = await fs.promises.readFile(absolutePath);
      const opId = currentOpId("read");
      if (opId) streamData(opId, "file_read", buf);
      return buf;
    },
    // 路径解析已发生在工作进程内（执行边界内）；access 同样在此核对
    access: async (absolutePath) => {
      await fs.promises.access(absolutePath, fs.constants.R_OK);
    },
  };
}

// ---------- 宿主钉定的只读范围（SubAgent 限定资料范围，agent-direction issue 11） ----------
// ponytail：范围只覆盖 read；write/edit/bash 的口子由"工具不装配"堵住
// （只读 SubAgent 会话的宿主工具清单不含这三个工具，模型无从调用）。

/** 经 realpath 的只读根列表（含会话 cwd）；null = init 未提供 readRoots，完全保持旧行为。 */
let readScopeRoots: string[] | null = null;

/** 启动钉定复核：每个只读根 realpath 后 dev/ino 必须与宿主钉定一致（范围变化 = 明确失败）。 */
function pinReadRoots(cwd: string, roots: Array<{ path: string; dev?: number; ino?: number }>): void {
  const pinned: string[] = [];
  for (const root of roots) {
    const real = fs.realpathSync(root.path);
    const st = fs.statSync(real);
    if (root.dev !== undefined && root.ino !== undefined && (st.dev !== root.dev || st.ino !== root.ino)) {
      throw new Error(`只读根已变化（宿主钉定不符）：${root.path}`);
    }
    pinned.push(real);
  }
  readScopeRoots = [fs.realpathSync(cwd), ...pinned];
}

/**
 * 受限解析并核对只读范围：逐段 lstat 拒绝符号链接组件（最后一段可缺失，
 * 不存在文件的"不存在"错误照常上报）；解析到真实目标后要求落在 cwd 或任一
 * 只读根之内（realpath 前缀比较 + path.sep 边界）。
 */
function scopedResolveInReadScope(target: string): string {
  const resolved = path.resolve(target);
  const parts = resolved.split(path.sep).filter((p) => p.length > 0);
  let current = "";
  for (let i = 0; i < parts.length; i++) {
    current = `${current}/${parts[i]}`;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      if (i === parts.length - 1) break; // 目标可不存在：前缀判定只依赖已逐段核实的上层路径
      throw new Error(`路径超出宿主钉定的只读范围（中间路径段不可达：${current}）`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(`路径超出宿主钉定的只读范围（符号链接组件：${current}）`);
    }
  }
  let realTarget = resolved;
  try {
    realTarget = fs.realpathSync(resolved); // 逐段无符号链接时与 resolved 一致；仍取 realpath 作规范化
  } catch {
    // 目标不存在：resolved 已逐段确认无符号链接，直接用于前缀比较
  }
  for (const root of readScopeRoots!) {
    if (grantCoversPath(root, realTarget)) return resolved;
  }
  throw new Error("路径超出宿主钉定的只读范围");
}

/** 只读范围启用时的受限 ReadOperations（init 未提供 readRoots 时完全不启用）。 */
function scopedReadOperations(): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const resolved = scopedResolveInReadScope(absolutePath);
      // O_NOFOLLOW 打开 + fstat + readFileSync(fd)：防打开瞬间目标被替换（TOCTOU）
      const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (fs.fstatSync(fd).isDirectory()) throw new Error("目标是目录，无正文可读");
        const buf = fs.readFileSync(fd);
        const opId = currentOpId("read");
        if (opId) streamData(opId, "file_read", buf);
        return buf;
      } finally {
        fs.closeSync(fd);
      }
    },
    access: async (absolutePath) => {
      const resolved = scopedResolveInReadScope(absolutePath);
      await fs.promises.access(resolved, fs.constants.R_OK);
    },
  };
}

// 探测与图像结果复用同一次受限读取；按调用创建，取消后不复用旧内容。
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-12-read-images.md
function createWorkerReadTool(cwd: string): ReturnType<typeof createReadToolDefinition> {
  const operations = readScopeRoots ? scopedReadOperations() : readOperations();
  let bytes: Buffer | undefined;
  return createReadToolDefinition(cwd, { operations: {
    ...operations,
    detectImageMimeType: async absolutePath => {
      bytes = await operations.readFile(absolutePath);
      return imageMime(bytes);
    },
    readFile: async absolutePath => bytes ?? operations.readFile(absolutePath),
  } });
}

function editOperations(): EditOperations {
  return {
    readFile: async (absolutePath) => fs.promises.readFile(absolutePath),
    writeFile: async (absolutePath, content) => {
      await fs.promises.writeFile(absolutePath, content, "utf8");
    },
    access: async (absolutePath) => {
      await fs.promises.access(absolutePath, fs.constants.W_OK | fs.constants.R_OK);
    },
  };
}

function writeOperations(onStats: (stats: EditStats) => void): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      let previous: string | undefined;
      try {
        previous = await fs.promises.readFile(absolutePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") previous = "";
      }
      await fs.promises.writeFile(absolutePath, content, "utf8");
      if (previous !== undefined) {
        try {
          onStats(statsFromPatch(generateUnifiedPatch(absolutePath, previous, content)));
        } catch {
          // 展示统计失败不能把已成功的写入报为失败。
        }
      }
    },
    mkdir: async (dir) => {
      await fs.promises.mkdir(dir, { recursive: true });
    },
  };
}

interface LoadedTools {
  cwd: string;
  tools: Map<string, ToolDefinition<any, any, any>>;
}

function loadTools(cwd: string): LoadedTools {
  const tools = new Map<string, ToolDefinition<any, any, any>>([
    ["edit", createEditToolDefinition(cwd, { operations: editOperations() })],
    ["bash", createBashToolDefinition(cwd, { operations: bashOperations(), exposeSessionEnvironment: false })],
  ]);
  return { cwd, tools };
}

// ---------- 调用处理 ----------

interface InFlightCall {
  controller: AbortController;
  timer: NodeJS.Timeout | undefined;
}

const inFlight = new Map<string, InFlightCall>();
let loaded: LoadedTools | null = null;
/** init 与其他消息并发处理：工具调用先等 init 完成，abort 不受等待影响。 */
let initPromise: Promise<void> | null = null;

async function handleToolCall(req: Extract<WorkerRequest, { type: "tool_call" }>): Promise<void> {
  if (!initPromise) {
    fail("工作进程尚未初始化", req.opId);
    return;
  }
  try {
    await initPromise;
  } catch (err) {
    fail(`工作进程初始化失败：${(err as Error).message}`, req.opId);
    return;
  }
  if (!loaded) {
    fail("工作进程尚未初始化", req.opId);
    return;
  }
  if (!(WORKER_TOOL_NAMES as readonly string[]).includes(req.name)) {
    // 白名单之外的名字一律拒绝：不加载任何自动发现的扩展或可执行文件
    fail(`未知工具：${req.name}`, req.opId);
    return;
  }
  let writeStats: EditStats | undefined;
  const def = req.name === "read"
    ? createWorkerReadTool(loaded.cwd)
    : req.name === "write"
      ? createWriteToolDefinition(loaded.cwd, { operations: writeOperations((stats) => { writeStats = stats; }) })
      : loaded.tools.get(req.name)!;
  const controller = new AbortController();
  const timer = req.timeoutMs ? setTimeout(() => controller.abort(new Error("timeout")), req.timeoutMs) : undefined;
  inFlight.set(req.opId, { controller, timer });
  if (!activeOpIds.has(req.name)) activeOpIds.set(req.name, req.opId);
  try {
    const result = await def.execute(req.opId, req.params as any, controller.signal, undefined, {
      cwd: loaded.cwd,
    } as any);
    sendMessage({
      type: "result",
      opId: req.opId,
      ok: true,
      content: result.content as unknown[],
      details: req.name === "write" ? (writeStats ? { editStats: writeStats } : undefined) : result.details,
      isError: Boolean((result as any).isError),
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    sendMessage({
      type: "result",
      opId: req.opId,
      ok: false,
      content: [{ type: "text", text: aborted ? "操作已中止" : `工具执行失败：${(err as Error).message}` }],
      isError: true,
      errorMessage: (err as Error).message,
    });
  } finally {
    if (timer) clearTimeout(timer);
    inFlight.delete(req.opId);
    if (activeOpIds.get(req.name) === req.opId) activeOpIds.delete(req.name);
  }
}

async function handleMessage(raw: string): Promise<void> {
  let req: WorkerRequest;
  try {
    req = JSON.parse(raw) as WorkerRequest;
  } catch {
    fail("无法解析的请求帧");
    return;
  }
  switch (req.type) {
    case "init": {
      const cwd = path.resolve(req.cwd);
      if (req.readRoots !== undefined) {
        try {
          pinReadRoots(cwd, req.readRoots);
        } catch (err) {
          // 范围变化明确失败：不带着与宿主钉定不符的范围服务（host 收 fatal 后回收执行单元）
          fail(`宿主钉定的只读范围复核失败：${(err as Error).message}`);
          // sendMessage 的写入是排队的异步链：给 fatal 帧落管道的机会再退出（上不封顶等会卡死，封 500ms）
          await Promise.race([stdoutDrained, sleep(500)]);
          process.exit(1);
        }
      }
      // 宿主钉定的工作区身份（issue 16）：cwd 已是写入根的钉定路径（每项任务
      // 重建 Driver 后，perm dry-run 由 LaunchSpec 带走）。失误时拒绝服务。
      if (req.workspace !== undefined) {
        try {
          const st = fs.statSync(fs.realpathSync(cwd));
          if (st.dev !== req.workspace.dev || st.ino !== req.workspace.ino) {
            fail(`宿主钉定的工作区身份复核失败：${cwd}（${st.dev}:${st.ino} ≠ ${req.workspace.dev}:${req.workspace.ino}）`);
            await Promise.race([stdoutDrained, sleep(500)]);
            process.exit(1);
          }
        } catch (err) {
          fail(`宿主钉定的工作区身份复核失败：${cwd}（${(err as Error).message}）`);
          await Promise.race([stdoutDrained, sleep(500)]);
          process.exit(1);
        }
      }
      initPromise = (async () => {
        await fs.promises.mkdir(cwd, { recursive: true }).catch(() => {});
        loaded = loadTools(cwd);
      })();
      await initPromise;
      break;
    }
    case "tool_call":
      await handleToolCall(req);
      break;
    case "abort": {
      const call = inFlight.get(req.opId);
      call?.controller.abort(new Error("aborted by host"));
      break;
    }
    case "shutdown":
      await shutdown();
      break;
    default:
      break;
  }
}

// ---------- 启动 ----------

process.on("uncaughtException", (err) => {
  fail(`工作进程内部错误：${err.message}`);
});
process.on("unhandledRejection", (err) => {
  fail(`工作进程未处理的异步错误：${(err as Error).message}`);
});
process.on("SIGTERM", () => {
  void shutdown();
});

sendMessage({ type: "ready", pid: process.pid });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      fail("请求帧超限");
      process.exit(1);
    }
    void handleMessage(line);
  }
});
process.stdin.on("end", () => {
  // 后台通道关闭：视为关停指令
  void shutdown();
});
process.stdin.on("error", () => {});
