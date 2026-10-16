import type { BoundedText } from "@ruukoto/core/views.ts";
import { utf8ByteLength } from "@ruukoto/view/utf8.ts";

export function toolPage(page: BoundedText | null | undefined, offset: number, totalBytes?: number): { nextOffset: number; totalBytes: number } | null {
  if (page === undefined || (page === null && offset !== 0)) return null;
  if (page === null) return { nextOffset: 0, totalBytes: 0 };
  const count = utf8ByteLength(page.text);
  if (page.offset !== offset || !Number.isSafeInteger(page.totalBytes) || page.totalBytes < offset + count || (totalBytes !== undefined && totalBytes !== page.totalBytes) || (!count && offset < page.totalBytes)) return null;
  return { nextOffset: offset + count, totalBytes: page.totalBytes };
}
