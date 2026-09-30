/**
 * 工具工作进程入口：在执行边界内（任务容器或执行账户）运行上游编码工具。
 *
 * 职责边界（issue 03 实施计划 §1）：
 * - 只执行 read/edit/write/bash 四种编码工具；没有模型、SDK 会话、持久化，
 *   也拿不到审批、模式切换或控制面凭据；
 * - 通过 BashOperations.onData 与文件 Operations 包装器，把未经截断的原始
 *   输出/正文流回后台（后台存产物后另生成限长模型视图）；
 * - Shell 子进程以独立进程组启动并登记；中止与关停时先整组回收再退出。
 *   逃逸组（setsid 等）只有容器/systemd cgroup 能兜底——这是执行边界的职责，
 *   不是本进程的承诺。
 *
 * 通信：stdin/stdout 上的换行分帧 JSON；stderr 只用于诊断日志。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
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
import { statsFromPatch } from "../../core/history.ts";
import type { EditStats } from "../../core/types.ts";
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
    // 单帧超限只可能来自异常超大块；协议层保证 DATA_CHUNK_BYTES 分块，此处防御
    fail(`工作进程消息超限：op=${(msg as any).opId ?? "?"}`);
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
  pid: number;
  killed: boolean;
}

const trackedChildren = new Map<number, TrackedChild>();

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // 负 pid = 子进程整组（shell 子进程以 detached 启动，pgid == pid）
  } catch {
    // 组已不存在
  }
}

async function killTrackedChild(pid: number, termGraceMs = 3000, killGraceMs = 3000): Promise<boolean> {
  const entry = trackedChildren.get(pid);
  if (!entry || entry.killed) return true;
  entry.killed = true;
  signalGroup(pid, "SIGTERM");
  let deadline = Date.now() + termGraceMs;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(50);
  if (!groupAlive(pid)) return true;
  signalGroup(pid, "SIGKILL");
  deadline = Date.now() + killGraceMs;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(50);
  return !groupAlive(pid);
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function killAllTrackedChildren(): Promise<void> {
  const pids = Array.from(trackedChildren.keys());
  await Promise.all(pids.map((pid) => killTrackedChild(pid)));
  trackedChildren.clear();
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
        trackedChildren.set(pid, { pid, killed: false });
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
          trackedChildren.delete(pid);
          resolve({ exitCode });
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
    ["read", createReadToolDefinition(cwd, { operations: readOperations() })],
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
  const def = req.name === "write"
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
      await killAllTrackedChildren();
      process.exit(0);
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
  void killAllTrackedChildren().then(() => process.exit(0));
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
  void killAllTrackedChildren().then(() => process.exit(0));
});
process.stdin.on("error", () => {});
