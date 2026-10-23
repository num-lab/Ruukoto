import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpImages, MCP_IMAGE_LIMITS, McpImageError } from "@ruukoto/agent/mcp/images.ts";

const png = Buffer.from("89504e470d0a1a0a", "hex"), image = { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" };
test("MCP 图片校验：原顺序、三种签名、规范 base64、解码前预算", () => {
  const content = [{ type: "text" as const, text: "before" }, image, { ...image, mimeType: "image/jpeg", data: Buffer.from([255, 216, 255]).toString("base64") }, { ...image, mimeType: "image/webp", data: Buffer.from("RIFF0000WEBP").toString("base64") }];
  const valid = mcpImages({ content });
  assert.deepEqual([...valid.keys()], [1, 2, 3]);
  assert.deepEqual([...valid.values()].map(value => value instanceof McpImageError ? value.code : value.mimeType), ["image/png", "image/jpeg", "image/webp"]);
  for (const [data, mimeType, code] of [
    ["@@==", "image/png", "invalid_base64"], ["AA=A", "image/png", "invalid_base64"], ["AB==", "image/png", "invalid_base64"],
    ["", "image/png", "invalid_base64"], [image.data, "image/gif", "mime_unsupported"], [image.data, "image/jpeg", "mime_mismatch"],
    ["A".repeat(Math.ceil(MCP_IMAGE_LIMITS.maxBytes / 3) * 4 + 4), "image/png", "image_too_large"],
  ]) {
    const result = mcpImages({ content: [{ ...image, data, mimeType }] }).get(0);
    assert.ok(result instanceof McpImageError); assert.equal(result.code, code);
  }
  const max = Buffer.alloc(MCP_IMAGE_LIMITS.maxBytes); png.copy(max);
  assert.ok(!(mcpImages({ content: [{ ...image, data: max.toString("base64") }] }).get(0) instanceof McpImageError));
  const tooLarge = mcpImages({ content: [{ ...image, data: Buffer.concat([max, Buffer.from([0])]).toString("base64") }] }).get(0);
  assert.ok(tooLarge instanceof McpImageError); assert.equal(tooLarge.code, "image_too_large");
  const many = mcpImages({ content: Array.from({ length: 5 }, () => image) });
  const fifth = many.get(4); assert.ok(fifth instanceof McpImageError); assert.equal(fifth.code, "too_many_images");
});
