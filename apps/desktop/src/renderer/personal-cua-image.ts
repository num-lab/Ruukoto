export type CuaImagePage = { observation: number; id: string; mime: string; sha256: string; bytes: number; offset: number; base64: string; nextOffset?: number };
type Image = { id: string; mime: string; sha256: string; bytes: number; partial?: boolean };

export async function loadPersonalCuaImage(image: Image, observation: number, read: (offset: number) => Promise<CuaImagePage | null>, current: () => boolean): Promise<string | undefined> {
  if (image.partial || image.bytes > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(image.mime)) throw new Error("The new screenshot is incomplete or over the limit. Observe again.");
  const chunks: Uint8Array[] = []; let offset = 0, complete = false;
  while (!complete) {
    const page = await read(offset);
    if (!page || !current()) return;
    if (page.observation !== observation || page.id !== image.id || page.mime !== image.mime || page.sha256 !== image.sha256 || page.bytes !== image.bytes || page.offset !== offset) throw new Error("The new screenshot identity or length mismatches. Observe again.");
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(page.base64), char => char.charCodeAt(0)); }
    catch { throw new Error("The new screenshot transfer is invalid. Observe again."); }
    if (!bytes.length || bytes.length > 128 * 1024 || offset + bytes.length > image.bytes || page.nextOffset !== undefined && page.nextOffset !== offset + bytes.length) throw new Error("The new screenshot pagination is incomplete. Observe again.");
    chunks.push(bytes); offset += bytes.length; complete = page.nextOffset === undefined;
  }
  const bytes = new Uint8Array(offset); let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (!current()) return;
  if (offset !== image.bytes || hash !== image.sha256) throw new Error("The new screenshot failed integrity verification. Observe again.");
  return `data:${image.mime};base64,${btoa(chunks.map(chunk => Array.from(chunk, value => String.fromCharCode(value)).join("")).join(""))}`;
}
