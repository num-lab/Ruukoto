import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type AttachmentUpload } from "@ruukoto/core/attachments.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { DesktopAttachment } from "../shared/bridge.ts";
import type { PersonalDesktopAttachment, PersonalDesktopAttachmentUpload } from "@ruukoto/view/personal-protocol.ts";
import { DesktopError } from "./environment.ts";

export interface StagedAttachment { token: string; name: string; size: number; path: string }

interface AttachmentPicker {
  instanceId(): string | null;
  pick(): Promise<string[]>;
  upload(params: AttachmentUpload): Promise<{ nextOffset: number; complete: boolean }>;
  attachmentId?(file: string, index: number): string;
}
export function readAttachmentBytes(file: string): Buffer {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > MAX_ATTACHMENT_BYTES) throw new DesktopError("attachment_limit", "请选择不超过 8 MiB 的普通文件。");
      const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
      let size = 0;
      while (size < buffer.length) { const read = fs.readSync(fd, buffer, size, buffer.length - size, size); if (!read) break; size += read; }
      const after = fs.fstatSync(fd);
      if (size > MAX_ATTACHMENT_BYTES || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new DesktopError("attachment_changed", "所选文件读取时发生变化，请保存后重新选择。");
      return buffer.subarray(0, size);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError("attachment_read_failed", "所选文件不可读，未附加；请检查文件后重新选择。");
  }
}

export function personalAttachment(value: unknown): value is PersonalDesktopAttachment {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === "id,mime,name,sha256,size" && "id" in value && typeof value.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) && "name" in value && typeof value.name === "string" && !!value.name.trim() && value.name.length <= 128 && value.name !== "." && value.name !== ".." && !/[\x00-\x1f\x7f\\/]/.test(value.name) && "size" in value && Number.isSafeInteger(value.size) && Number(value.size) >= 0 && Number(value.size) <= MAX_ATTACHMENT_BYTES && "mime" in value && typeof value.mime === "string" && !!value.mime && value.mime.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.mime) && "sha256" in value && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}

export function personalAttachments(value: unknown): value is PersonalDesktopAttachment[] {
  return Array.isArray(value) && value.length <= MAX_ATTACHMENTS && value.every(personalAttachment) && new Set(value.map(item => item.id)).size === value.length;
}

export function readSelectedAttachment(file: string): { name: string; bytes: Buffer; sha256: string } {
  const name = path.basename(file);
  if (!name.trim() || name.length > 128 || name === "." || name === ".." || /[\x00-\x1f\x7f\\/]/.test(name)) throw new DesktopError("attachment_name_invalid", "附件名称无效，请选择不超过 128 个字符的普通文件名。");
  const bytes = readAttachmentBytes(file);
  return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// Note: See .agents/notes/implemented/architecture/2026-10-16-owner-attachments.md
export async function pickAttachments(sessionId: string, source: AttachmentPicker): Promise<DesktopAttachment[]> {
  if (typeof sessionId !== "string" || !sessionId) throw new DesktopError("invalid_params", "请选择会话后附加文件。");
  const instanceId = source.instanceId();
  const check = () => { if (!instanceId || source.instanceId() !== instanceId) throw new DesktopError("attachment_instance_changed", "连接目标已变化，未附加文件；请重新选择。"); };
  check();
  const files = await source.pick();
  check();
  if (files.length > MAX_ATTACHMENTS) throw new DesktopError("attachment_limit", `每次最多选择 ${MAX_ATTACHMENTS} 个文件。`);
  const attachments: DesktopAttachment[] = [];
  for (const [index, file] of files.entries()) {
    const { bytes, name, sha256: hash } = readSelectedAttachment(file);
    check();
    const attachment = { id: source.attachmentId?.(file, index) ?? `att_${randomUUID()}`, name, size: bytes.length };
    let offset = 0;
    do {
      const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
      const params: AttachmentUpload = { session_id: sessionId, attachment_id: attachment.id, name: attachment.name, offset, total_bytes: bytes.length, content_hash: hash, data: chunk.toString("base64") };
      let result: Awaited<ReturnType<AttachmentPicker["upload"]>>;
      try { result = await source.upload(params); }
      catch (error) {
        check();
        if (!(error instanceof ControlClientError) || error.outcome === "rejected") throw error;
        result = await source.upload(params);
      }
      check();
      if (result.nextOffset !== offset + chunk.length || result.complete !== (result.nextOffset === bytes.length)) throw new DesktopError("attachment_upload_failed", "附件未连续保存，未附加文件；请重新选择。");
      offset = result.nextOffset;
    } while (offset < bytes.length);
    attachments.push(attachment);
  }
  return attachments;
}

const PERSONAL_ATTACHMENT_CHUNK_BYTES = 64 * 1024;
function attachmentMime(bytes: Buffer, name: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return path.extname(name).toLowerCase() === ".csv" ? "text/csv" : "application/octet-stream";
}

// Note: See .agents/notes/implemented/architecture/2026-11-07-personal-inbound-attachments.md
export async function uploadPersonalAttachments(files: string[], check: () => void, upload: (value: PersonalDesktopAttachmentUpload) => Promise<unknown>): Promise<PersonalDesktopAttachment[]> {
  const result: PersonalDesktopAttachment[] = [];
  for (const file of files) {
    check();
    const { bytes, name, sha256 } = readSelectedAttachment(file), id = randomUUID(), mime = attachmentMime(bytes, name);
    let offset = 0;
    do {
      check();
      const chunk = bytes.subarray(offset, offset + PERSONAL_ATTACHMENT_CHUNK_BYTES);
      const value: PersonalDesktopAttachmentUpload = { v: 1, attachmentId: id, name, mime, totalBytes: bytes.length, sha256, offset, base64: chunk.toString("base64") };
      let response: unknown;
      try { response = await upload(value); }
      catch (error) {
        check();
        if (!(error instanceof ControlClientError) || error.outcome === "rejected" || error.outcome === "not_sent") throw error;
        response = await upload(value);
      }
      check();
      const next = offset + chunk.length;
      if (!response || typeof response !== "object" || !("v" in response) || response.v !== 1 || !("attachmentId" in response) || response.attachmentId !== id || !("nextOffset" in response) || response.nextOffset !== next || !("complete" in response) || response.complete !== (next === bytes.length)) throw new DesktopError("attachment_upload_failed", "附件未完整保存，本条输入未发送；请重新选择附件。");
      offset = next;
    } while (offset < bytes.length);
    result.push({ id, name, size: bytes.length, mime, sha256 });
  }
  return result;
}

/** Register local metadata before a first send owns attachment snapshots. */
export function stageAttachments(files: string[]): StagedAttachment[] {
  if (files.length > MAX_ATTACHMENTS) throw new DesktopError("attachment_limit", `每次最多选择 ${MAX_ATTACHMENTS} 个文件。`);
  return files.map(file => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new DesktopError("attachment_limit", "请选择不超过 8 MiB 的普通文件。");
      return { token: `draft_${randomUUID()}`, name: path.basename(file), size: stat.size, path: file };
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("attachment_read_failed", "所选文件不可读，未附加；请检查文件后重新选择。");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
}
