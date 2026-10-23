import { createHash } from "node:crypto";
import { imageMime } from "../artifacts.ts";
import type { ImageMimeType } from "@ruukoto/core/types.ts";
import type { CallToolResult } from "./transport.ts";

export const MCP_IMAGE_LIMITS = { maxImages: 4, maxBytes: 8 * 1024 * 1024 } as const;
export type McpImage = { bytes: Buffer; mimeType: ImageMimeType; contentHash: string };
export class McpImageError extends Error {
  constructor(readonly code: "too_many_images" | "image_too_large" | "invalid_base64" | "mime_unsupported" | "mime_mismatch") { super(code); }
}

function decodeImage(part: { data: string; mimeType: string }, count: number): McpImage {
  if (count > MCP_IMAGE_LIMITS.maxImages) throw new McpImageError("too_many_images");
  if (part.data.length > Math.ceil(MCP_IMAGE_LIMITS.maxBytes / 3) * 4) throw new McpImageError("image_too_large");
  if (!part.data.length || part.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) throw new McpImageError("invalid_base64");
  if (!["image/jpeg", "image/png", "image/webp"].includes(part.mimeType)) throw new McpImageError("mime_unsupported");
  const bytes = Buffer.from(part.data, "base64");
  if (bytes.length > MCP_IMAGE_LIMITS.maxBytes) throw new McpImageError("image_too_large");
  if (bytes.toString("base64") !== part.data) throw new McpImageError("invalid_base64");
  const mimeType = imageMime(bytes);
  if (!mimeType || mimeType !== part.mimeType) throw new McpImageError("mime_mismatch");
  return { bytes, mimeType, contentHash: createHash("sha256").update(bytes).digest("hex") };
}

/** 解码前核实数量和长度；仅接受规范 base64 及与声明一致的实际图片签名。 */
// Note: 见 .agents/notes/implemented/architecture/2026-10-23-mcp-image-results.md
export function mcpImages(result: CallToolResult): Map<number, McpImage | McpImageError> {
  const images = new Map<number, McpImage | McpImageError>();
  let count = 0;
  for (const [index, part] of (result.content ?? []).entries()) {
    if (part.type !== "image") continue;
    try { images.set(index, decodeImage(part, ++count)); } catch (error) {
      if (!(error instanceof McpImageError)) throw error;
      images.set(index, error);
    }
  }
  return images;
}

export function mcpImageProblem(code: string): string {
  return `图片未能展示（${code}）；原工具应答已收到，图片问题不改变原动作结果。请报告拥有者，勿因缺图重试原动作。`;
}
