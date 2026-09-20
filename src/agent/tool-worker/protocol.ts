/**
 * 工具工作进程协议：最小有界消息集（换行分帧 JSON over stdio）。
 *
 * 工作进程只接受工具调用并返回数据：不获得审批、模式切换或控制面凭据；
 * 参数经结构化消息传递，绝不拼入启动器 Shell 命令。上游工具定义（read/
 * edit/write/bash）的完整执行——含路径解析与 Shell 子进程——都发生在工作
 * 进程所在的执行边界内（请求确认模式为任务容器，完全访问为执行账户）。
 *
 * 帧界限：单帧 MAX_FRAME_BYTES；正文数据分块 DATA_CHUNK_BYTES 并以 base64
 * 传输（任意分块安全，跨块 UTF-8 由按字节累积的产物存储处理）。
 */

/** 单帧上限（控制消息与数据块都受此约束）。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** 正文数据块的净载荷上限（base64 前的字节数）。 */
export const DATA_CHUNK_BYTES = 512 * 1024;

/** 后台 → 工作进程。 */
export type WorkerRequest =
  | { type: "init"; cwd: string; label: string }
  | {
      type: "tool_call";
      /** 宿主操作 id（协议关联键）。 */
      opId: string;
      /** 模型生成的 SDK 调用 id（仅供上游工具内部使用，不作身份）。 */
      sdkCallId: string;
      name: string;
      params: Record<string, unknown>;
      /** 整体超时毫秒；超时由工作进程中止执行。 */
      timeoutMs?: number;
    }
  | { type: "abort"; opId: string }
  | { type: "shutdown" };

export type DataStream = "stdout" | "stderr" | "file_read";

/** 工作进程 → 后台。 */
export type WorkerMessage =
  | { type: "ready"; pid: number }
  | { type: "data"; opId: string; stream: DataStream; chunk: string }
  | {
      type: "result";
      opId: string;
      ok: boolean;
      /** AgentToolResult.content（TextContent | ImageContent）。 */
      content: unknown[];
      details?: unknown;
      isError?: boolean;
      errorMessage?: string;
    }
  | { type: "fatal"; message: string };

/** 本工作进程支持的编码工具（其余名字一律拒绝）。 */
export const WORKER_TOOL_NAMES = ["read", "edit", "write", "bash"] as const;
