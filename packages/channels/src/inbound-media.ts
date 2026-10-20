/** 入站图片先落安全暂存，再与任务归属一起提升；下载 URL/凭据只活在适配器闭包。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ArtifactStore, imageMime } from "@ruukoto/agent/artifacts.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { ImageMimeType, InboundEvent, InboundMedia, InboundMediaMessage, NotifyTarget } from "@ruukoto/core/types.ts";
export type { InboundMediaMessage } from "@ruukoto/core/types.ts";

import { MAX_ATTACHMENTS as MAX_INBOUND_IMAGES, MAX_ATTACHMENT_BYTES as MAX_INBOUND_IMAGE_BYTES } from "@ruukoto/core/attachments.ts";
export { MAX_INBOUND_IMAGES, MAX_INBOUND_IMAGE_BYTES };
export const INBOUND_MEDIA_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
export const INBOUND_MEDIA_DOWNLOAD_ATTEMPTS = 3;
export const INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;

const REASONS = new Set(["too_many_images", "image_too_large", "mime_unsupported", "mime_mismatch", "download_unavailable", "download_failed", "download_interrupted", "media_corrupt", "orphan_expired", "image_input_unsupported"]);

/** 仅允许固定错误码落账，平台错误正文不会成为拒绝说明。 */
export class MediaError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    const safeReason = REASONS.has(reason) ? reason : "download_unavailable";
    super(safeReason);
    this.reason = safeReason;
  }
}

export interface InboundMediaDownload {
  declaredMime?: string;
  sizeBytes?: number;
  download(signal: AbortSignal): Promise<Response>;
}

interface StageInput {
  source: string;
  externalId: string;
  actor: string | null;
  body: string;
  replyTarget: NotifyTarget | null;
  receivedAt?: string;
  media: InboundMediaDownload[];
  signal?: AbortSignal;
}

function mime(value: string | null | undefined): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function allowedMime(value: string | null): value is ImageMimeType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

export class InboundMediaStore {
  private readonly root: string;
  private readonly staging = new Map<string, Promise<InboundMediaMessage>>();

  constructor(private readonly dataDir: string, private readonly store: Store, private readonly artifacts: ArtifactStore) {
    this.root = path.join(dataDir, "inbound-media");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error("入站媒体目录不能是符号链接");
    fs.chmodSync(this.root, 0o700);
  }

  getMessage(source: string, externalId: string): InboundMediaMessage | null {
    return this.store.findInboundMediaMessage(source, externalId);
  }

  getMessageById(id: string): InboundMediaMessage | null { return this.store.getInboundMediaMessage(id); }
  listReadyMessages(): InboundMediaMessage[] { return this.store.listInboundMediaMessages(["ready"]); }
  listRejectedMessages(): InboundMediaMessage[] { return this.store.listInboundMediaMessages(["rejected", "expired"]); }
  hasMedia(event: Pick<InboundEvent, "source" | "externalId">): boolean { return this.getMessage(event.source, event.externalId) !== null; }

  stage(input: StageInput): Promise<InboundMediaMessage> {
    const key = JSON.stringify([input.source, input.externalId]);
    const active = this.staging.get(key);
    if (active) return active;
    const result = this.stageMessage(input).finally(() => { this.staging.delete(key); });
    this.staging.set(key, result);
    return result;
  }

  private async stageMessage(input: StageInput): Promise<InboundMediaMessage> {
    input.signal?.throwIfAborted();
    let message = this.getMessage(input.source, input.externalId);
    if (message && message.status !== "staging") return message;
    message = this.store.withTx(() => this.store.createInboundMediaMessage({ ...input,
      body: input.body.slice(0, 100_000), receivedAt: input.receivedAt ?? new Date().toISOString(), mediaCount: input.media.length }));
    if (input.media.length === 0 || input.media.length > MAX_INBOUND_IMAGES) return this.rejectMessage(input.source, input.externalId, "too_many_images")!;
    try {
      for (const [index, download] of input.media.entries()) {
        let row = this.store.withTx(() => this.store.createInboundMedia(message!, index, mime(download.declaredMime)));
        if (row.status === "ready") { this.readStaged(row); continue; }
        if (download.sizeBytes !== undefined && download.sizeBytes > MAX_INBOUND_IMAGE_BYTES) throw new MediaError("image_too_large");
        const declared = mime(download.declaredMime);
        if (declared && !allowedMime(declared)) throw new MediaError("mime_unsupported");
        const result = await this.download(download, row.id, input.signal);
        input.signal?.throwIfAborted();
        const file = this.fileFor(row);
        const temporary = `${file}.part`;
        try {
          const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
          try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, result.bytes); }
          finally { fs.closeSync(fd); }
          fs.renameSync(temporary, file);
          this.store.withTx(() => this.store.setInboundMediaReady(row.id, { mimeType: result.mimeType,
            byteCount: result.bytes.length, contentHash: createHash("sha256").update(result.bytes).digest("hex") }));
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      this.store.withTx(() => this.store.setInboundMediaMessageState(message!.id, "ready"));
      return this.getMessage(input.source, input.externalId)!;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (!(error instanceof MediaError)) throw error; // 本地存储故障保留 staging，不伪装成平台拒绝。
      return this.rejectMessage(input.source, input.externalId, error.reason)!;
    }
  }

  private async download(input: InboundMediaDownload, mediaId: string, parentSignal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: ImageMimeType }> {
    for (let attempt = 0; attempt < INBOUND_MEDIA_DOWNLOAD_ATTEMPTS; attempt++) {
      parentSignal?.throwIfAborted();
      const timeout = AbortSignal.timeout(INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS);
      const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
      let abortListener: (() => void) | undefined;
      let response: Response | undefined;
      try {
        const canceled = new Promise<never>((_, reject) => {
          abortListener = () => reject(signal.reason);
          signal.addEventListener("abort", abortListener, { once: true });
        });
        const work = async () => {
          response = await input.download(signal);
          signal.throwIfAborted();
          if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new MediaError("download_unavailable");
            throw new Error("download_temporarily_unavailable");
          }
          const declared = mime(input.declaredMime);
          const responseMime = mime(response.headers.get("content-type"));
          // 某些文件服务器仅声明二进制流；适配器有平台 MIME 时仍要求其与 magic 一致。
          const effectiveMime = declared ?? responseMime;
          if (!allowedMime(effectiveMime)) throw new MediaError("mime_unsupported");
          if (responseMime && responseMime !== "application/octet-stream" && responseMime !== effectiveMime) throw new MediaError("mime_mismatch");
          if (Number(response.headers.get("content-length") ?? "0") > MAX_INBOUND_IMAGE_BYTES) throw new MediaError("image_too_large");
          this.store.withTx(() => this.store.setInboundMediaDownloading(mediaId, effectiveMime));
          if (!response.body) throw new MediaError("mime_mismatch");
          const reader = response.body.getReader();
          const cancelReader = () => { void reader.cancel().catch(() => {}); };
          signal.addEventListener("abort", cancelReader, { once: true });
          const chunks: Buffer[] = [];
          let count = 0;
          try {
            for (;;) {
              signal.throwIfAborted();
              const chunk = await reader.read();
              if (chunk.done) break;
              count += chunk.value.byteLength;
              if (count > MAX_INBOUND_IMAGE_BYTES) throw new MediaError("image_too_large");
              chunks.push(Buffer.from(chunk.value));
            }
          } finally {
            signal.removeEventListener("abort", cancelReader);
            await reader.cancel().catch(() => {});
          }
          signal.throwIfAborted();
          const bytes = Buffer.concat(chunks, count);
          if (imageMime(bytes) !== effectiveMime) throw new MediaError("mime_mismatch");
          return { bytes, mimeType: effectiveMime };
        };
        return await Promise.race([work(), canceled]);
      } catch (error) {
        if (parentSignal?.aborted || error instanceof MediaError) throw error;
        if (attempt === INBOUND_MEDIA_DOWNLOAD_ATTEMPTS - 1) throw new MediaError("download_failed");
        await delay(250 * (attempt + 1), undefined, { signal: parentSignal });
      } finally {
        if (abortListener) signal.removeEventListener("abort", abortListener);
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
    }
    throw new MediaError("download_failed");
  }

  rejectMessage(source: string, externalId: string, reason: string): InboundMediaMessage | null {
    const message = this.getMessage(source, externalId);
    if (!message || message.status === "bound" || message.status === "rejected" || message.status === "expired") return message;
    this.store.withTx(() => this.store.rejectInboundMedia(message.id, REASONS.has(reason) ? reason : "download_unavailable"));
    return this.getMessage(source, externalId);
  }

  attachEvent(source: string, externalId: string, eventId: string): void {
    const message = this.getMessage(source, externalId);
    const event = this.store.getInboundEvent(eventId);
    if (!message || !event || event.source !== source || event.externalId !== externalId ||
      (message.eventId && message.eventId !== eventId) || !["ready", "bound"].includes(message.status)) throw new Error("入站图片事件归属不一致");
    this.store.attachInboundMediaEvent(message.id, eventId);
  }

  /** 调用方须与建任务/markInboundQueued共同放在一个 Store.withTx 中。 */
  promote(eventId: string, taskId: string, sessionId: string): string[] {
    const event = this.store.getInboundEvent(eventId);
    const task = this.store.getTask(taskId);
    if (!event || !task || event.taskId !== taskId || task.sourceEventId !== eventId || task.sessionId !== sessionId) throw new Error("入站图片任务归属不一致");
    const message = this.getMessage(event.source, event.externalId);
    if (!message) return event.artifactRefs;
    if (message.eventId !== eventId || (message.taskId && message.taskId !== taskId) || !["ready", "bound"].includes(message.status)) throw new Error("入站图片未完成暂存或归属不一致");
    const rows = this.store.listInboundMedia(message.id);
    if (rows.length !== message.mediaCount || rows.some((row) => !["ready", "promoted"].includes(row.status))) throw new Error("入站图片暂存不完整");
    const refs = rows.map((row) => {
      const id = row.artifactId ?? `art_${row.id}`;
      if (row.status === "promoted") {
        this.artifacts.readImage(id, { taskId, sessionId });
      } else {
        const bytes = this.readStaged(row);
        this.artifacts.importImage({ id, taskId, sessionId, name: `inbound image ${row.mediaIndex + 1}`,
          mimeType: row.mimeType!, contentHash: row.contentHash!, byteCount: row.byteCount }, bytes);
      }
      return id;
    });
    this.store.bindInboundMedia(message.id, eventId, taskId, refs);
    return refs;
  }

  private fileFor(row: InboundMedia): string {
    if (!/^med_[a-f0-9]+\.bin$/.test(row.fileName)) throw new MediaError("media_corrupt");
    return path.join(this.root, row.fileName);
  }

  private readStaged(row: InboundMedia): Buffer {
    try {
      const fd = fs.openSync(this.fileFor(row), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_INBOUND_IMAGE_BYTES) throw new MediaError("media_corrupt");
        bytes = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
      const actualMime = imageMime(bytes);
      if (!allowedMime(actualMime) || actualMime !== row.declaredMime ||
        (row.mimeType && actualMime !== row.mimeType) ||
        (row.contentHash && createHash("sha256").update(bytes).digest("hex") !== row.contentHash) ||
        (row.status === "ready" && bytes.length !== row.byteCount)) throw new MediaError("media_corrupt");
      return bytes;
    } catch { throw new MediaError("media_corrupt"); }
  }

  /** rename已完成而DB未定稿可重新核实；没有下载闭包的未完成下载明确收尾，不保存URL。 */
  recover(): InboundMediaMessage[] {
    this.cleanup();
    for (const message of this.store.listInboundMediaMessages(["staging", "ready"])) {
      try {
        const rows = this.store.listInboundMedia(message.id);
        if (rows.length !== message.mediaCount || rows.length === 0 || rows.some((row) => row.status === "pending")) throw new MediaError("download_interrupted");
        for (const row of rows) {
          if (row.status === "downloading" && !fs.existsSync(this.fileFor(row))) throw new MediaError("download_interrupted");
          const bytes = this.readStaged(row);
          if (row.status === "downloading") this.store.withTx(() => this.store.setInboundMediaReady(row.id, {
            mimeType: imageMime(bytes)!, byteCount: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") }));
        }
        this.store.withTx(() => this.store.setInboundMediaMessageState(message.id, "ready"));
      } catch (error) { this.rejectMessage(message.source, message.externalId, error instanceof MediaError ? error.reason : "media_corrupt"); }
    }
    return this.listReadyMessages();
  }

  cleanup(now = Date.now()): void {
    for (const message of this.store.listInboundMediaMessages(["staging", "ready", "rejected", "expired"])) {
      if (this.staging.has(JSON.stringify([message.source, message.externalId]))) continue;
      const event = message.eventId ? this.store.getInboundEvent(message.eventId) : null;
      const role = event ? this.store.getAgentRole(event.targetRole) : null;
      // 提交已创建任务但入站尚未回填的窗口，也必须保留恢复所需的图片。
      if (message.taskId || event?.taskId || (event && role && this.store.findTaskByRequest(role.sessionId, `evt:${event.id}`)) ||
          now - Date.parse(message.createdAt) < INBOUND_MEDIA_ORPHAN_TTL_MS) continue;
      for (const row of this.store.listInboundMedia(message.id)) {
        const file = this.fileFor(row);
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.part`, { force: true });
      }
      if (message.status !== "rejected" && message.status !== "expired") this.store.withTx(() => {
        this.store.rejectInboundMedia(message.id, "orphan_expired", true);
        if (message.eventId) this.store.failRegisteredInbound(message.eventId);
      });
    }
  }
}
