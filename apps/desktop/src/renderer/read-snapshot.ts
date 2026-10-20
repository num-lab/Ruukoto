// Note: 见 .agents/notes/implemented/feature/2026-10-17-desktop-read-snapshot.md
export const FILE_PAGE_BYTES = 256 * 1024;
export type PreviewFile = { path: string; size: number } & ({ kind: "text" | "markdown"; content: string } | { kind: "image"; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; dataUrl: string } | { kind: "unsupported" });
export interface ReadSnapshotState { loading: boolean; file?: PreviewFile; error?: string; partial?: boolean }

export function readSnapshotFile(path: string, data: Uint8Array, totalBytes: number): PreviewFile {
  const base = { path, size: totalBytes };
  const starts = (...prefix: number[]) => prefix.every((value, index) => data[index] === value);
  if (data.length !== totalBytes) return { ...base, kind: "unsupported" };
  const mimeType = starts(137, 80, 78, 71, 13, 10, 26, 10) ? "image/png" : starts(255, 216, 255) && data.at(-2) === 255 && data.at(-1) === 217 ? "image/jpeg" : ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(data.subarray(0, 6))) && data.at(-1) === 59 ? "image/gif" : data.length >= 12 && starts(82, 73, 70, 70) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80 && new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true) === data.length - 8 ? "image/webp" : null;
  if (mimeType) {
    let binary = "";
    for (let offset = 0; offset < data.length; offset += 32 * 1024) binary += String.fromCharCode(...data.subarray(offset, offset + 32 * 1024));
    return { ...base, kind: "image", mimeType, dataUrl: `data:${mimeType};base64,${btoa(binary)}` };
  }
  if (data.includes(0) || /\.(?:pdf|png|jpe?g|gif|webp|svg)$/i.test(path)) return { ...base, kind: "unsupported" };
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch (cause) { if (!(cause instanceof TypeError)) throw cause; return { ...base, kind: "unsupported" }; }
  return { ...base, kind: /\.(md|markdown)$/i.test(path) ? "markdown" : "text", content };
}
