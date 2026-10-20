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
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-16-owner-attachments.md
export async function pickAttachments(sessionId: string, source: AttachmentPicker): Promise<DesktopAttachment[]> {
  if (typeof sessionId !== "string" || !sessionId) throw new DesktopError("invalid_params", "请选择会话后附加文件。");
  const instanceId = source.instanceId();
  const check = () => { if (!instanceId || source.instanceId() !== instanceId) throw new DesktopError("attachment_instance_changed", "连接目标已变化，未附加文件；请重新选择。"); };
  check();
  const files = await source.pick();
  check();
  if (files.length > MAX_ATTACHMENTS) throw new DesktopError("attachment_limit", `每次最多选择 ${MAX_ATTACHMENTS} 个文件。`);
  const attachments: DesktopAttachment[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.size > MAX_ATTACHMENT_BYTES) throw new DesktopError("attachment_limit", "请选择不超过 8 MiB 的普通文件。");
        const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
        let size = 0;
        while (size < buffer.length) { const read = fs.readSync(fd, buffer, size, buffer.length - size, size); if (!read) break; size += read; }
        const after = fs.fstatSync(fd);
        if (size > MAX_ATTACHMENT_BYTES || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new DesktopError("attachment_changed", "所选文件读取时发生变化，请保存后重新选择。");
        bytes = buffer.subarray(0, size);
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("attachment_read_failed", "所选文件不可读，未附加；请检查文件后重新选择。");
    }
    check();
    const attachment = { id: `att_${randomUUID()}`, name: path.basename(file), size: bytes.length };
    const hash = createHash("sha256").update(bytes).digest("hex");
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

/** 新对话尚未建会话：先只登记所选文件并读元数据，等会话建好后按 token 补做上传。 */
export function stageAttachments(files: string[]): StagedAttachment[] {
  if (files.length > MAX_ATTACHMENTS) throw new DesktopError("attachment_limit", `每次最多选择 ${MAX_ATTACHMENTS} 个文件。`);
  return files.map(file => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new DesktopError("attachment_limit", "请选择不超过 8 MiB 的普通文件。");
      return { token: `draft_${randomUUID()}`, name: path.basename(file), size: stat.size, path: file };
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("attachment_read_failed", "所选文件不可读，未附加；请检查文件后重新选择。");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
}
