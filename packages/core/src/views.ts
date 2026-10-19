/**
 * 传输层视图：控制面线上载荷的有界化。
 *
 * 规则（issue 04 §2）：握手、任务详情、实时事件、replay 与历史/产物读取按
 * 序列化后的字节数设限。持久化层（事件表、确认请求、工具操作）保持完整；
 * 只有发往客户端的载荷经这里的有界视图转换：
 * - 大参数对象 → 结构保留的预览（长字符串截断并标注），完整序列化正文经
 *   get_confirmation_params / get_tool_op_params 按 ID 分段读取；
 * - 运行中正文与思考在源头按 FRAGMENT_TEXT_CAP 分块，不限制完整内容长度。
 */

import type { ConfirmationRequest, PersistentEvent, Task, ToolOp } from "./types.ts";

export type InputPurpose = "user" | "internal_report";

/** 用途由宿主持久绑定派生，不采信客户端字段；displayInput 仅任务详情携带，不改任务或历史原文。 */
export type TaskView = Task & { inputPurpose: InputPurpose; displayInput?: string; wait?: import("./agent-wait.ts").AgentWaitView; resourcePhase?: "execution" | "conversation"; reportParked?: boolean };

/** 事件与查询应答中内联参数的上限（序列化字节）。 */
export const PARAMS_INLINE_CAP = 8 * 1024;
/** 预览对象中单个字符串的上限（字符）。 */
export const PARAMS_PREVIEW_STRING_CAP = 256;
/** 正文与思考单个增量的上限（字节）。 */
export const FRAGMENT_TEXT_CAP = 8 * 1024;
/** 历史/参数等分段读取的默认页大小与上限。 */
export const SEGMENT_DEFAULT_BYTES = 64 * 1024;
export const SEGMENT_MAX_BYTES = 256 * 1024;

export interface BoundedText {
  text: string;
  offset: number;
  totalBytes: number;
  truncated: boolean;
}

/** 任务输出预览（快照与 get_task 携带；state 区分生成中与中断前捕获）。 */
export interface OutputPreview {
  messageId: string;
  text: string;
  totalBytes: number;
  truncated: boolean;
  /** 来源事件序号；客户端据此判断新旧。 */
  seq: number;
  state: "generating" | "captured_partial";
}

export type ConfirmationRequestView = Omit<ConfirmationRequest, "params"> & {
  params: Record<string, unknown>;
  paramsBytes: number;
  paramsTruncated: boolean;
};

export type ToolOpView = Omit<ToolOp, "params"> & {
  params: Record<string, unknown>;
  paramsBytes: number;
  paramsTruncated: boolean;
};

/** 深拷贝并截断长字符串的预览（结构保留；截断处标注原始字节数）。 */
export function previewValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= PARAMS_PREVIEW_STRING_CAP) return value;
    return `${value.slice(0, PARAMS_PREVIEW_STRING_CAP)}…[截断，共 ${Buffer.byteLength(value, "utf8")} 字节]`;
  }
  if (Array.isArray(value)) {
    if (depth >= 6) return "[…]";
    return value.slice(0, 32).map((v) => previewValue(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth >= 6) return { "…": "层级过深" };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = previewValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 参数 → 有界视图：小于上限原样内联；超限给预览并标注完整字节数。 */
export function paramsToView(params: Record<string, unknown>): {
  params: Record<string, unknown>;
  paramsBytes: number;
  paramsTruncated: boolean;
} {
  const json = JSON.stringify(params);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= PARAMS_INLINE_CAP) {
    return { params, paramsBytes: bytes, paramsTruncated: false };
  }
  return { params: previewValue(params) as Record<string, unknown>, paramsBytes: bytes, paramsTruncated: true };
}

export function confirmationToView(c: ConfirmationRequest): ConfirmationRequestView {
  return { ...c, ...paramsToView(c.params) };
}

export function toolOpToView(op: ToolOp): ToolOpView {
  return { ...op, ...paramsToView(op.params) };
}

/**
 * 事件 → 线上载荷：携带完整参数的工具/审批事件替换为有界预览。
 * 其余事件原样返回（output_fragment 在源头已有界）。
 */
export function capEventForWire(event: PersistentEvent): PersistentEvent {
  const body = event.body;
  if (body.type === "task.tool_intent" || body.type === "task.awaiting_confirmation") {
    const view = paramsToView(body.params);
    if (!view.paramsTruncated) return event;
    return { ...event, body: { ...body, ...view } };
  }
  return event;
}

/** 帧字节数（JSON + 换行）。 */
export function frameBytes(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj) + "\n", "utf8");
}
