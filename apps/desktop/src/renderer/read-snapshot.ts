// Note: 见 .agents/notes/implemented/feature/2026-10-17-desktop-read-snapshot.md
export const READ_SNAPSHOT_BYTES = 256 * 1024;
export type PreviewFile = { path: string; size: number } & ({ kind: "text" | "markdown"; content: string } | { kind: "image"; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; dataUrl: string } | { kind: "unsupported" });
export interface ReadSnapshotState { loading: boolean; file?: PreviewFile; error?: string; partial?: boolean; truncated?: boolean }

export function readSnapshotFile(path: string, data: Uint8Array, base64: string, totalBytes: number): PreviewFile {
  const base = { path, size: totalBytes };
  const starts = (...prefix: number[]) => prefix.every((value, index) => data[index] === value);
  const mimeType = starts(137, 80, 78, 71, 13, 10, 26, 10) ? "image/png" : starts(255, 216, 255) ? "image/jpeg" : starts(71, 73, 70, 56) ? "image/gif" : starts(82, 73, 70, 70) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80 ? "image/webp" : null;
  if (mimeType) return data.length === totalBytes ? { ...base, kind: "image", mimeType, dataUrl: `data:${mimeType};base64,${base64}` } : { ...base, kind: "unsupported" };
  if (data.includes(0) || /\.(?:pdf|png|jpe?g|gif|webp)$/i.test(path)) return { ...base, kind: "unsupported" };
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: data.length < totalBytes }); }
  catch { return { ...base, kind: "unsupported" }; }
  return { ...base, kind: /\.(md|markdown)$/i.test(path) ? "markdown" : "text", content };
}
