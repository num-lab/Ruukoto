import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ArtifactStore, imageMime } from "@ruukoto/agent/artifacts.ts";
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type AttachmentId, type AttachmentMetadata, type AttachmentReference, type AttachmentUpload } from "@ruukoto/core/attachments.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { ImageMimeType } from "@ruukoto/core/types.ts";

interface StagedAttachment { id: AttachmentId; instanceId: string; sessionId: string; name: string; size: number; contentHash: string; complete: boolean; mimeType: ImageMimeType | null }
export interface PreparedAttachment { metadata: StagedAttachment; bytes: Buffer }

// Note: 见 .agents/notes/implemented/architecture/2026-10-16-owner-attachments.md
export class OwnerAttachments {
  private readonly root: string;
  constructor(dataDir: string, private readonly store: Store, private readonly artifacts: ArtifactStore) {
    this.root = path.join(dataDir, "attachment-staging");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new RuntimeApiError("attachment_unavailable", "附件暂存目录不可用，请检查后台数据目录。");
    fs.chmodSync(this.root, 0o700);
  }
  private file(id: AttachmentId, suffix: string): string { return path.join(this.root, `${id}.${suffix}`); }
  private id(id: unknown): asserts id is AttachmentId {
    if (typeof id !== "string" || !/^att_[a-f0-9-]{36}$/.test(id)) throw new RuntimeApiError("invalid_params", "附件引用无效，请重新选择文件。");
  }
  private name(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && Buffer.byteLength(value) <= 512 && !/[/\\\x00-\x1f\x7f]/.test(value); }
  private read(id: AttachmentId): StagedAttachment {
    const fd = fs.openSync(this.file(id, "json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096) throw new RuntimeApiError("attachment_unavailable", "附件暂存记录无效，请重新选择文件。");
      const metadata = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<StagedAttachment> | null;
      if (!metadata || metadata.id !== id || typeof metadata.instanceId !== "string" || !metadata.instanceId || typeof metadata.sessionId !== "string" || !metadata.sessionId || !this.name(metadata.name) || !Number.isSafeInteger(metadata.size) || metadata.size! < 0 || metadata.size! > MAX_ATTACHMENT_BYTES || typeof metadata.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(metadata.contentHash) || typeof metadata.complete !== "boolean" || (metadata.mimeType !== null && !["image/jpeg", "image/png", "image/webp"].includes(metadata.mimeType ?? ""))) throw new RuntimeApiError("attachment_unavailable", "附件暂存记录无效，请重新选择文件。");
      return metadata as StagedAttachment;
    } finally { fs.closeSync(fd); }
  }
  private save(metadata: StagedAttachment): void {
    const temporary = this.file(metadata.id, `${randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, this.file(metadata.id, "json")); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  private owned(metadata: StagedAttachment, sessionId: string): void {
    if (metadata.instanceId !== this.store.db.getInstanceId() || metadata.sessionId !== sessionId) throw new RuntimeApiError("attachment_scope", "附件不属于当前会话或数据实例，请重新选择文件。");
  }
  put(input: AttachmentUpload): { nextOffset: number; complete: boolean } {
    this.id(input.attachment_id);
    if (!this.name(input.name) || !Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.total_bytes) || input.total_bytes < 0 || input.total_bytes > MAX_ATTACHMENT_BYTES || typeof input.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(input.content_hash) || typeof input.data !== "string" || input.data.length > Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new RuntimeApiError("invalid_params", "附件大小、名称或分块参数无效，请重新选择文件。");
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.toString("base64") !== input.data || input.offset + bytes.length > input.total_bytes || (bytes.length === 0 && input.total_bytes !== 0)) throw new RuntimeApiError("invalid_params", "附件分块无效，请重新选择文件。");
    let metadata: StagedAttachment;
    try { metadata = this.read(input.attachment_id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RuntimeApiError("attachment_unavailable", "附件暂存记录不可读，请重新选择文件。");
      if (input.offset !== 0) throw new RuntimeApiError("attachment_offset", "附件分块不连续，请重新选择文件。");
      metadata = { id: input.attachment_id, instanceId: this.store.db.getInstanceId(), sessionId: input.session_id, name: input.name, size: input.total_bytes, contentHash: input.content_hash, complete: false, mimeType: null };
      this.save(metadata);
    }
    this.owned(metadata, input.session_id);
    if (metadata.id !== input.attachment_id || metadata.name !== input.name || metadata.size !== input.total_bytes || metadata.contentHash !== input.content_hash) throw new RuntimeApiError("attachment_conflict", "附件引用与原内容不一致，请重新选择文件。");
    const target = this.file(metadata.id, "bin");
    try {
      const fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > metadata.size || input.offset > stat.size) throw new RuntimeApiError("attachment_offset", "附件分块不连续，请重新选择文件。");
        if (input.offset < stat.size || metadata.complete) {
          const previous = Buffer.alloc(bytes.length);
          if (fs.readSync(fd, previous, 0, previous.length, input.offset) !== bytes.length || !previous.equals(bytes)) throw new RuntimeApiError("attachment_conflict", "附件分块与已保存内容不一致，请重新选择文件。");
        } else if (fs.writeSync(fd, bytes, 0, bytes.length, input.offset) !== bytes.length) throw new RuntimeApiError("attachment_unavailable", "附件保存不完整，请检查后台存储后重新选择文件。");
        const nextOffset = fs.fstatSync(fd).size;
        if (nextOffset === metadata.size) {
          const complete = fs.readFileSync(fd);
          if (createHash("sha256").update(complete).digest("hex") !== metadata.contentHash) throw new RuntimeApiError("attachment_hash", "附件内容校验失败，请重新选择文件。");
          metadata = { ...metadata, complete: true, mimeType: imageMime(complete) };
          this.save(metadata);
        }
        return { nextOffset, complete: metadata.complete };
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error instanceof RuntimeApiError) throw error;
      throw new RuntimeApiError("attachment_unavailable", "附件保存失败，未提交任务；请检查后台存储后重新选择文件。");
    }
  }
  prepare(sessionId: string, references: AttachmentMetadata[]): PreparedAttachment[] {
    if (!Array.isArray(references) || references.length > MAX_ATTACHMENTS || new Set(references.map(ref => ref?.id)).size !== references.length) throw new RuntimeApiError("invalid_params", `每次最多附加 ${MAX_ATTACHMENTS} 个文件，引用不能重复。`);
    return references.map(ref => {
      if (!ref || typeof ref !== "object") throw new RuntimeApiError("invalid_params", "附件引用格式无效。");
      const id = ref.id;
      this.id(id);
      let metadata: StagedAttachment;
      let bytes: Buffer;
      try {
        metadata = this.read(id);
        const fd = fs.openSync(this.file(id, "bin"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new Error("invalid_size"); bytes = fs.readFileSync(fd); }
        finally { fs.closeSync(fd); }
      } catch { throw new RuntimeApiError("attachment_unavailable", "附件快照不可读，请重新选择文件。"); }
      this.owned(metadata, sessionId);
      if (metadata.name !== ref.name || metadata.size !== ref.size) throw new RuntimeApiError("attachment_conflict", "附件引用与已保存内容不一致，请重新选择文件。");
      if (!metadata.complete || bytes.length !== metadata.size || createHash("sha256").update(bytes).digest("hex") !== metadata.contentHash || imageMime(bytes) !== metadata.mimeType) throw new RuntimeApiError("attachment_hash", "附件未保存完整或内容已变化，请重新选择文件。");
      if (this.store.getArtifact(id)) throw new RuntimeApiError("attachment_bound", "附件已用于其他提交，请重新选择文件。");
      return { metadata, bytes };
    });
  }
  bind(taskId: string, sessionId: string, prepared: PreparedAttachment[]): void {
    if (!prepared.length) return;
    const attachments: AttachmentReference[] = prepared.map(({ metadata, bytes }) => {
      try { this.artifacts.importAttachment({ id: metadata.id, taskId, sessionId, name: metadata.name, mimeType: metadata.mimeType, contentHash: metadata.contentHash, byteCount: metadata.size }, bytes); }
      catch { throw new RuntimeApiError("attachment_unavailable", "附件归属保存失败，任务未提交；请检查后台存储后重试原输入。"); }
      return { id: metadata.id, taskId, sessionId, name: metadata.name, size: metadata.size, contentHash: metadata.contentHash, mimeType: metadata.mimeType };
    });
    this.store.appendEvent({ type: "task.attachments", taskId, sessionId, attachments }, { taskId, sessionId });
  }

  /**
   * Rebuild recalled attachments from immutable target-task artifacts using fresh att_ IDs.
   * Never reuse old task-bound references or modify original artifacts.
   * The caller ensures request idempotency through persisted draftAttachments.
   */
  restoreForRecall(recall: { targetTaskId: string; sessionId: string; originalAttachments: AttachmentMetadata[] }): AttachmentMetadata[] {
    return recall.originalAttachments.map(original => {
      const artifact = this.store.getArtifact(original.id);
      if (!artifact || artifact.status !== "complete" || artifact.taskId !== recall.targetTaskId || artifact.sessionId !== recall.sessionId ||
          !artifact.contentHash || artifact.byteCount !== original.size || artifact.name !== original.name) {
        throw new RuntimeApiError("attachment_unavailable", "撤回输入的原附件记录不完整，无法重建草稿。");
      }
      let bytes: Buffer;
      try {
        bytes = this.artifacts.read(original.id, 0, artifact.byteCount);
      } catch {
        throw new RuntimeApiError("attachment_unavailable", "撤回输入的原附件内容不可读，无法重建草稿。");
      }
      if (bytes.length !== artifact.byteCount || createHash("sha256").update(bytes).digest("hex") !== artifact.contentHash) {
        throw new RuntimeApiError("attachment_hash", "撤回输入的原附件内容校验失败，无法重建草稿。");
      }
      const metadata: StagedAttachment = {
        id: `att_${randomUUID()}`, instanceId: this.store.db.getInstanceId(), sessionId: recall.sessionId,
        name: original.name, size: original.size, contentHash: artifact.contentHash, complete: true, mimeType: artifact.mimeType ?? null,
      };
      try {
        const fd = fs.openSync(this.file(metadata.id, "bin"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, bytes); }
        finally { fs.closeSync(fd); }
        this.save(metadata);
      } catch {
        fs.rmSync(this.file(metadata.id, "bin"), { force: true });
        throw new RuntimeApiError("attachment_unavailable", "撤回草稿附件保存失败，请重试撤回。");
      }
      return { id: metadata.id, name: metadata.name, size: metadata.size };
    });
  }
}
