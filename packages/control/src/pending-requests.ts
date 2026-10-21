// Note: 见 .agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md
/**
 * 待确认请求记录（拥有者私有目录）：提交与控制操作的去重锚点。
 *
 * 纪律（issue 04 §3）：
 * - 发送前先生成 request_id 并把操作类型与完整请求参数原子落盘
 *   （临时文件 + rename，0600）；写入失败时不得发送请求；
 * - 输入确认接收后清除；手动压缩关联原命令，保留到核实唯一终态；
 * - 记录绑定数据实例标识：后台重启保留标识可继续核实；新数据库分配新
 *   标识，此时保留待核实输入并要求拥有者处理，不向空后台重发；
 * - 记录用于核实原请求，不作为会话历史副本；令牌等凭据
 *   永远不写入这里。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dirEnvFor, productFromEnv, productRootDir } from "@ruukoto/core/product.ts";
import { parseWorkflowControl, workflowLaunchDigest, type WorkflowLaunch } from "@ruukoto/core/workflow.ts";

export interface PendingRequest {
  requestId: string;
  op: "submit" | "continue" | "branch_session" | "compact_session" | "workflow_start" | "workflow_answer" | "workflow_control" | "owner_question_answer" | "owner_question_cancel" | "session_background_end";
  /** 完整原请求参数，包含请求键、业务输入及操作使用的原版本。 */
  params: Record<string, unknown>;
  /** 提交时握手返回的数据实例标识。 */
  instanceId: string;
  createdAt: string;
}

export interface PendingRequestList {
  records: PendingRequest[];
  /** 无法解析的记录文件名（保留在磁盘上，需人工处理）。 */
  corrupt: string[];
}

export type PendingRequestRead = { kind: "record"; record: PendingRequest } | { kind: "absent" | "corrupt" };

export function defaultPendingDir(): string {
  const product = productFromEnv();
  return dirEnvFor(product, "PENDING") ?? path.join(productRootDir(product), "pending");
}

function validWorkflowParams(record: PendingRequest): boolean {
  const params = record.params;
  if (record.op === "session_background_end") return params.request_id === record.requestId && typeof params.session_id === "string" && params.session_id.trim().length > 0 && Object.keys(params).every(key => key === "session_id" || key === "request_id");
  if (record.op === "owner_question_answer" || record.op === "owner_question_cancel") {
    if (params.request_id !== record.requestId || typeof params.session_id !== "string" || !params.session_id.trim() ||
      typeof params.question_id !== "string" || !params.question_id.trim() || !Number.isSafeInteger(params.question_version) || (params.question_version as number) < 1) return false;
    if (record.op === "owner_question_answer") {
      if (!Array.isArray(params.answers) || params.answers.length < 1 || params.answers.length > 3 || !params.model_selection) return false;
      return params.answers.every((answer: unknown) => {
        if (typeof answer !== "object" || answer === null || Array.isArray(answer) || Object.keys(answer).some(key => !["text", "option", "options"].includes(key)) ||
          !("text" in answer) || typeof answer.text !== "string" || answer.text.length > 4096 || (answer.text !== "" && !answer.text.trim())) return false;
        if (answer.text === "") return !("option" in answer) && !("options" in answer);
        if ("option" in answer) return !("options" in answer) && Number.isSafeInteger(answer.option) && (answer.option as number) >= 0 && (answer.option as number) < 5;
        if ("options" in answer) {
          if (!Array.isArray(answer.options) || answer.options.length < 1 || answer.options.length > 5 ||
            answer.options.some(option => !Number.isSafeInteger(option) || option < 0 || option >= 5)) return false;
          const selected = answer.options as number[];
          return selected.every((option, index) => index === 0 || option > selected[index - 1]);
        }
        return true;
      });
    }
    return true;
  }
  if (!record.op.startsWith("workflow_")) return true;
  if (params.request_id !== record.requestId) return false;
  const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (record.op === "workflow_start") {
    workflowLaunchDigest({ name: params.name, script: params.script, title: params.title, description: params.description, input: params.input,
      maxAttempts: params.max_attempts, durationMs: params.duration_ms } as WorkflowLaunch);
    return nonempty(params.session_id) && "input" in params &&
      ((nonempty(params.name) && params.script === undefined) || (nonempty(params.script) && params.name === undefined)) &&
      (params.max_attempts === undefined || positive(params.max_attempts)) && (params.duration_ms === undefined || positive(params.duration_ms));
  }
  if (!nonempty(params.run_id)) return false;
  if (record.op === "workflow_answer") return nonempty(params.step_key) && positive(params.question_version) && positive(params.run_version) && "answer" in params;
  return positive(params.expected_version) && parseWorkflowControl(params.control) !== undefined;
}

export class PendingRequestStore {
  readonly dir: string;

  constructor(dir: string = defaultPendingDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private fileFor(requestId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
      throw new Error(`request_id 含非法字符：${requestId}`);
    }
    return path.join(this.dir, `${requestId}.json`);
  }

  /** 原子保存（先写临时文件再 rename）；抛错时调用方不得发送请求。 */
  save(record: PendingRequest): void {
    const file = this.fileFor(record.requestId);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** 所属入口已完成核实：清除记录（幂等）。 */
  clear(requestId: string): void {
    try {
      fs.rmSync(this.fileFor(requestId), { force: true });
    } catch {
      // 清除失败不阻断流程；下次核实会再次关联并清除
    }
  }

  /** 严格读取：仅 ENOENT 算不存在；损坏记录单列，其余 IO 错误向调用方传出。 */
  read(requestId: string): PendingRequestRead {
    let text: string;
    try { text = fs.readFileSync(this.fileFor(requestId), "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    let raw: PendingRequest;
    try { raw = JSON.parse(text) as PendingRequest; }
    catch { return { kind: "corrupt" }; }
    try {
      if (typeof raw?.requestId !== "string" || raw.requestId !== requestId ||
        !["submit", "continue", "branch_session", "compact_session", "workflow_start", "workflow_answer", "workflow_control", "owner_question_answer", "owner_question_cancel", "session_background_end"].includes(raw.op) ||
        typeof raw.params !== "object" || raw.params === null || Array.isArray(raw.params) ||
        typeof raw.instanceId !== "string" || !raw.instanceId ||
        typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt)) || !validWorkflowParams(raw)) return { kind: "corrupt" };
    } catch { return { kind: "corrupt" }; }
    return { kind: "record", record: raw };
  }

  /** 严格删除：仅 ENOENT 算不存在，其余 IO 错误向调用方传出。 */
  remove(requestId: string): "removed" | "absent" {
    try { fs.unlinkSync(this.fileFor(requestId)); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent";
      throw error;
    }
    return "removed";
  }

  /** 全部待确认记录；损坏文件保留并单独列出（不静默丢弃）。 */
  list(strict = false): PendingRequestList {
    const records: PendingRequest[] = [];
    const corrupt: string[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch (error) {
      if (strict) throw error;
      return { records, corrupt };
    }
    for (const file of files) {
      try {
        const result = this.read(file.slice(0, -5));
        if (result.kind === "record") records.push(result.record);
        else corrupt.push(file);
      } catch {
        corrupt.push(file);
      }
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { records, corrupt };
  }
}
