// Note: See .agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md
// Note: See .agents/notes/implemented/architecture/2026-11-10-single-product.md
/**
 * Private journals bind each original request key and complete parameters to its
 * data instance before sending. Lost responses retain that record for verification;
 * malformed records remain visible on disk and never become new input.
 */

import * as fs from "node:fs";
import { parseCodeScheduleConfig } from "@ruukoto/core/code-scheduler.ts";
import { parseModelSelection } from "@ruukoto/core/model-selection.ts";
import { isSessionDefaultMode } from "@ruukoto/core/types.ts";
import * as path from "node:path";
import { parseWorkflowControl, workflowLaunchDigest, type WorkflowLaunch } from "@ruukoto/core/workflow.ts";

export interface PendingRequest {
  requestId: string;
  op: "submit" | "message_recall" | "branch_session" | "compact_session" | "workflow_start" | "workflow_answer" | "workflow_control" | "owner_question_answer" | "owner_question_cancel" | "session_background_end" | "code_schedule_save" | "code_schedule_control" | "open_side_chat" | "submit_side_chat" | "create_managed_session" | "desktop_start_chat";
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


export function validCodeScheduleParams(op: "code_schedule_save" | "code_schedule_control", params: Record<string, unknown>, requestId: string): boolean {
    if (params.request_id !== requestId) return false;
    const fields = op === "code_schedule_save" ? ["request_id", "plan_id", "expected_version", "config"] : ["request_id", "plan_id", "expected_version", "control", "acknowledge_run_id", "expected_run_version"];
    if (Object.keys(params).some(key => !fields.includes(key))) return false;
    if (op === "code_schedule_save") { parseCodeScheduleConfig(params.config); if (params.plan_id === undefined) return params.expected_version === undefined; }
    if (typeof params.plan_id !== "string" || !params.plan_id || !Number.isSafeInteger(params.expected_version) || Number(params.expected_version) < 1) return false;
    if (op === "code_schedule_control" && ((params.acknowledge_run_id !== undefined) !== (params.expected_run_version !== undefined) || params.expected_run_version !== undefined && (!Number.isSafeInteger(params.expected_run_version) || Number(params.expected_run_version) < 1))) return false;
    return op === "code_schedule_save" || ["pause", "resume", "cancel"].includes(String(params.control)) && (params.acknowledge_run_id === undefined || params.control === "resume" && typeof params.acknowledge_run_id === "string" && !!params.acknowledge_run_id);
}

export function validInputParams(record: Pick<PendingRequest, "op" | "params" | "requestId">): boolean {
  const params = record.params;
  if (record.op === "submit") {
    if (params.request_id !== record.requestId || typeof params.session_id !== "string" || !params.session_id.trim() || typeof params.input !== "string") return false;
    if (Object.keys(params).some(key => !["session_id", "request_id", "input", "model_selection", "attachments", "access_mode", "granted_paths", "guidance"].includes(key)) ||
      params.access_mode !== undefined && !isSessionDefaultMode(params.access_mode) || params.guidance !== undefined && typeof params.guidance !== "boolean") return false;
    if (params.attachments !== undefined && (!Array.isArray(params.attachments) || !params.attachments.every((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      return Object.keys(item).every(key => ["id", "name", "size"].includes(key)) && typeof item.id === "string" && !!item.id && typeof item.name === "string" && !!item.name && Number.isSafeInteger(item.size) && Number(item.size) >= 0;
    }))) return false;
    if (params.granted_paths !== undefined && (!Array.isArray(params.granted_paths) || !params.granted_paths.every((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      return Object.keys(item).every(key => ["path", "access", "purpose"].includes(key)) && typeof item.path === "string" && (item.access === "read" || item.access === "read_write") && typeof item.purpose === "string";
    }))) return false;
    try { parseModelSelection(params.model_selection); }
    catch { return false; }
    return true;
  }
  if (record.op === "owner_question_answer" || record.op === "owner_question_cancel") {
    if (params.request_id !== record.requestId || typeof params.session_id !== "string" || !params.session_id.trim() ||
      typeof params.question_id !== "string" || !params.question_id.trim() || !Number.isSafeInteger(params.question_version) || (params.question_version as number) < 1) return false;
    const fields = record.op === "owner_question_answer" ? ["session_id", "question_id", "question_version", "request_id", "answers"] : ["session_id", "question_id", "question_version", "request_id"];
    if (Object.keys(params).some(key => !fields.includes(key))) return false;
    if (record.op === "owner_question_answer") {
      if (!Array.isArray(params.answers) || params.answers.length < 1 || params.answers.length > 3) return false;
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
  return true;
}

function validWorkflowParams(record: PendingRequest): boolean {
  const params = record.params;
  if (!validInputParams(record)) return false;
  if (record.op === "code_schedule_save" || record.op === "code_schedule_control") return validCodeScheduleParams(record.op, params, record.requestId);
  if (record.op === "message_recall") return params.request_id === record.requestId && typeof params.session_id === "string" && !!params.session_id && typeof params.task_id === "string" && !!params.task_id && Number.isSafeInteger(params.expected_revision) && Number(params.expected_revision) >= 0 && (params.purpose === "queued" || params.purpose === "historical");
  if (record.op === "session_background_end") return params.request_id === record.requestId && typeof params.session_id === "string" && params.session_id.trim().length > 0 && Object.keys(params).every(key => key === "session_id" || key === "request_id");
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

  constructor(dir: string) {
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
        !["submit", "message_recall", "branch_session", "compact_session", "workflow_start", "workflow_answer", "workflow_control", "owner_question_answer", "owner_question_cancel", "session_background_end", "code_schedule_save", "code_schedule_control", "open_side_chat", "submit_side_chat", "create_managed_session", "desktop_start_chat"].includes(raw.op) ||
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
