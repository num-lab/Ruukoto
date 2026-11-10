import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type AttachmentUpload } from "@ruukoto/core/attachments.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { DesktopAttachment } from "../shared/bridge.ts";
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
      if (!before.isFile() || before.size > MAX_ATTACHMENT_BYTES) throw new DesktopError("attachment_limit", "Choose regular files no larger than 8 MiB.");
      const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
      let size = 0;
      while (size < buffer.length) { const read = fs.readSync(fd, buffer, size, buffer.length - size, size); if (!read) break; size += read; }
      const after = fs.fstatSync(fd);
      if (size > MAX_ATTACHMENT_BYTES || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new DesktopError("attachment_changed", "The selected file changed while reading; save it and choose again.");
      return buffer.subarray(0, size);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError("attachment_read_failed", "The selected file isn't readable and wasn't attached; check it and choose again.");
  }
}


export function readSelectedAttachment(file: string): { name: string; bytes: Buffer; sha256: string } {
  const name = path.basename(file);
  if (!name.trim() || name.length > 128 || name === "." || name === ".." || /[\x00-\x1f\x7f\\/]/.test(name)) throw new DesktopError("attachment_name_invalid", "Invalid attachment name; choose a regular file name of at most 128 characters.");
  const bytes = readAttachmentBytes(file);
  return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// Note: See .agents/notes/implemented/architecture/2026-10-16-owner-attachments.md
export async function pickAttachments(sessionId: string, source: AttachmentPicker): Promise<DesktopAttachment[]> {
  if (typeof sessionId !== "string" || !sessionId) throw new DesktopError("invalid_params", "Select a chat before attaching files.");
  const instanceId = source.instanceId();
  const check = () => { if (!instanceId || source.instanceId() !== instanceId) throw new DesktopError("attachment_instance_changed", "The connection target changed; files weren't attached. Choose again."); };
  check();
  const files = await source.pick();
  check();
  if (files.length > MAX_ATTACHMENTS) throw new DesktopError("attachment_limit", `Choose at most ${MAX_ATTACHMENTS} files at a time.`);
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
      if (result.nextOffset !== offset + chunk.length || result.complete !== (result.nextOffset === bytes.length)) throw new DesktopError("attachment_upload_failed", "The attachment wasn't saved contiguously and wasn't attached; choose again.");
      offset = result.nextOffset;
    } while (offset < bytes.length);
    attachments.push(attachment);
  }
  return attachments;
}


/** Register local metadata before a first send owns attachment snapshots. */
export function stageAttachments(files: string[]): StagedAttachment[] {
  if (files.length > MAX_ATTACHMENTS) throw new DesktopError("attachment_limit", `Choose at most ${MAX_ATTACHMENTS} files at a time.`);
  return files.map(file => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new DesktopError("attachment_limit", "Choose regular files no larger than 8 MiB.");
      return { token: `draft_${randomUUID()}`, name: path.basename(file), size: stat.size, path: file };
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("attachment_read_failed", "The selected file isn't readable and wasn't attached; check it and choose again.");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
}
