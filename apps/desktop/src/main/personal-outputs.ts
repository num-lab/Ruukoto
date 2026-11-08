import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { PersonalDesktopOutput, PersonalDesktopOutputChunk } from "@ruukoto/view/personal-protocol.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { DesktopError } from "./environment.ts";

export const PERSONAL_OUTPUT_BYTES = 8 * 1024 * 1024;
export const PERSONAL_OUTPUT_CHUNK_BYTES = 128 * 1024;
export type PersonalOutputRequest = { origin: string; remoteId: string; profileId: string; publication: number; output: number };
export type PersonalOutputFile = { metadata: PersonalDesktopOutput; bytes: Buffer };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const invalid = () => new DesktopError("personal_output_invalid", "The file-transfer record can't be verified; read the original file again. The original operation wasn't redone.");

export function personalOutputMetadata(value: unknown): value is PersonalDesktopOutput {
  return object(value) && value.v === 1 && positive(value.publication) && positive(value.output) && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 128 && !!value.name.trim() && value.name !== "." && value.name !== ".." && !/[\x00-\x1f\x7f\\/]/.test(value.name) && typeof value.mime === "string" && value.mime.length > 0 && value.mime.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.mime) && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && typeof value.partial === "boolean";
}

function metadata(page: PersonalDesktopOutputChunk): PersonalDesktopOutput {
  return { v: page.v, publication: page.publication, output: page.output, name: page.name, mime: page.mime, sha256: page.sha256, bytes: page.bytes, partial: page.partial };
}
function sameMetadata(left: PersonalDesktopOutput, right: PersonalDesktopOutput) { return (Object.keys(left) as (keyof PersonalDesktopOutput)[]).every(key => left[key] === right[key]); }
function pageBytes(value: unknown, publication: number, output: number, offset: number, original?: PersonalDesktopOutput): { metadata: PersonalDesktopOutput; bytes: Buffer; nextOffset?: number } {
  if (!object(value) || value.offset !== offset || typeof value.base64 !== "string" || value.base64.length > Math.ceil(PERSONAL_OUTPUT_CHUNK_BYTES / 3) * 4 || value.nextOffset !== undefined && !positive(value.nextOffset) || !personalOutputMetadata(value) || value.publication !== publication || value.output !== output) throw invalid();
  const page = value as PersonalDesktopOutputChunk, saved = metadata(page);
  if (original && !sameMetadata(original, saved)) throw invalid();
  if (saved.partial || saved.bytes > PERSONAL_OUTPUT_BYTES) throw new DesktopError("personal_output_incomplete", "This file is incomplete or over 8 MiB and can't be previewed or downloaded; the original operation wasn't redone.");
  const bytes = Buffer.from(page.base64, "base64"), expected = Math.min(PERSONAL_OUTPUT_CHUNK_BYTES, saved.bytes - offset), next = offset + bytes.length;
  if (page.base64 !== bytes.toString("base64") || expected < 0 || bytes.length !== expected || page.nextOffset !== (next < saved.bytes ? next : undefined)) throw invalid();
  return { metadata: saved, bytes, nextOffset: page.nextOffset };
}

// Note: See .agents/notes/implemented/architecture/2026-11-05-personal-final-outputs.md
export async function readPersonalOutput(publication: number, output: number, read: (offset: number) => Promise<unknown>): Promise<PersonalOutputFile> {
  const chunks: Buffer[] = []; let offset = 0, saved: PersonalDesktopOutput | undefined;
  do {
    const page = pageBytes(await read(offset), publication, output, offset, saved);
    saved = page.metadata; chunks.push(page.bytes); offset += page.bytes.length;
    if (page.nextOffset === undefined) break;
  } while (offset < PERSONAL_OUTPUT_BYTES);
  const bytes = Buffer.concat(chunks);
  if (!saved || offset !== saved.bytes || createHash("sha256").update(bytes).digest("hex") !== saved.sha256) throw new DesktopError("personal_output_integrity", "File integrity verification failed; read the original file again. The original operation wasn't redone.");
  return { metadata: saved, bytes };
}

export function verifyPersonalOutputAccess(file: PersonalOutputFile, value: unknown): void {
  const page = pageBytes(value, file.metadata.publication, file.metadata.output, 0, file.metadata);
  if (!page.bytes.equals(file.bytes.subarray(0, PERSONAL_OUTPUT_CHUNK_BYTES))) throw invalid();
}

export async function savePersonalOutput(destination: string, bytes: Buffer, check: () => void): Promise<void> {
  if (!path.isAbsolute(destination) || destination.includes("\0")) throw new DesktopError("personal_output_destination", "The save location is invalid. Choose another one.");
  const temporary = path.join(path.dirname(destination), `.ruukoto-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    check();
    try { fs.renameSync(temporary, destination); }
    catch { throw new DesktopError("personal_output_save_failed", "The file wasn't saved completely; check the chosen location and retry the download. The original operation wasn't redone."); }
    created = false;
  } catch (error) {
    if (error instanceof DesktopError || error instanceof ControlClientError) throw error;
    throw new DesktopError("personal_output_save_failed", "The file wasn't saved completely; check the chosen location and retry the download. The original operation wasn't redone.");
  } finally {
    if (created) {
      try { await fs.promises.unlink(temporary); }
      catch { process.stderr.write("[ruukoto:desktop] Failed to remove an incomplete output temporary file; inspect the selected save directory.\n"); }
    }
  }
}
