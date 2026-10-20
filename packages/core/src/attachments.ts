import type { ImageMimeType } from "./types.ts";

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 192 * 1024;
export type AttachmentId = string;
/** id 同时作为提交后产物的 ID，重试不改变引用。 */
export interface AttachmentMetadata { id: AttachmentId; name: string; size: number }
export interface AttachmentReference extends AttachmentMetadata {
  taskId: string;
  sessionId: string;
  mimeType: ImageMimeType | null;
  contentHash: string;
}
export type AttachmentUpload = {
  session_id: string;
  attachment_id: AttachmentId;
  name: string;
  offset: number;
  total_bytes: number;
  content_hash: string;
  data: string;
};
