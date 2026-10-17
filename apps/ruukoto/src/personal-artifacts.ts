import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PersonalError } from "./personal-error.ts";
import type { PersonalProfileLock } from "./personal-profile.ts";

export type PersonalArtifact = { id: string; bytes: number; sha256: string; partial: boolean; mime: string; identity: { dev: number; ino: number } };
const CAP_BYTES = 8 * 1024 * 1024, PAGE_BYTES = 3072;
const unavailable = () => new PersonalError("artifact_unavailable", "原产物缺失、损坏或权限无法核实，请保留档案并报告拥有者。");

function privateObject(filename: string, directory: boolean): fs.Stats {
  const stat = fs.lstatSync(filename);
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw unavailable();
  return stat;
}

function artifactDirectory(profile: string | PersonalProfileLock, create = false): string {
  const directory = typeof profile === "string" ? profile : profile.directory;
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) throw unavailable();
  privateObject(directory, true);
  const root = path.join(directory, "artifacts");
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  privateObject(root, true);
  return root;
}

function writeExclusive(filename: string, bytes: Buffer): PersonalArtifact["identity"] {
  const fd = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    const { dev, ino } = fs.fstatSync(fd);
    return { dev, ino };
  } finally { fs.closeSync(fd); }
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** 先保存不可变字节，再由调用方把返回引用与来源写入 durable；跨文件与数据库不保证原子。 */
export async function savePersonalArtifact(profile: string | PersonalProfileLock, bytes: Uint8Array, options: { partial?: boolean; mime?: string } = {}): Promise<PersonalArtifact> {
  try {
    const root = artifactDirectory(profile, true), id = randomUUID(), temporary = path.join(root, `.tmp-${randomUUID()}`), target = path.join(root, `${id}.bin`);
    const content = Buffer.from(bytes.subarray(0, CAP_BYTES)), mime = options.mime ?? "application/octet-stream";
    if (!mime || mime.length > 256 || /[\x00-\x1f\x7f]/.test(mime)) throw new PersonalError("artifact_input_invalid", "产物 MIME 无法核实，请修正来源类型后再保存。");
    const identity = writeExclusive(temporary, content);
    // link 原子发布且不替换同名文件；失败留下受保护原文，不能误删已经登记的产物。
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    syncDirectory(root);
    const stat = privateObject(target, false);
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size !== content.length) throw unavailable();
    return { id, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), partial: !!options.partial || bytes.length > CAP_BYTES, mime, identity };
  } catch (error) {
    if (error instanceof PersonalError && error.code === "artifact_input_invalid") throw error;
    throw new PersonalError("artifact_write_failed", "产物未能完整登记，请保留档案并检查磁盘；已写文件仍保留。", { cause: error });
  }
}

function verifiedBytes(profile: string | PersonalProfileLock, ref: PersonalArtifact): Buffer {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.id) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > CAP_BYTES || !/^[0-9a-f]{64}$/.test(ref.sha256) || typeof ref.partial !== "boolean" || typeof ref.mime !== "string" || !ref.mime || ref.mime.length > 256 || /[\x00-\x1f\x7f]/.test(ref.mime) || !Number.isSafeInteger(ref.identity.dev) || !Number.isSafeInteger(ref.identity.ino)) throw unavailable();
    const target = path.join(artifactDirectory(profile), `${ref.id}.bin`), before = privateObject(target, false);
    if (before.dev !== ref.identity.dev || before.ino !== ref.identity.ino || before.size !== ref.bytes) throw unavailable();
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== ref.bytes) throw unavailable();
      const bytes = Buffer.alloc(ref.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw unavailable();
        offset += count;
      }
      if (fs.fstatSync(fd).size !== ref.bytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw unavailable();
      return bytes;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    throw new PersonalError("artifact_unavailable", "原产物缺失、损坏或权限无法核实，请保留档案并报告拥有者。", { cause: error });
  }
}

/** 每页核实原文件身份、长度与哈希，再返回最多 3072 原字节的 base64；partial 不代表完整捕获。 */
export async function readPersonalArtifact(profile: string | PersonalProfileLock, ref: PersonalArtifact, offset = 0): Promise<{ base64: string; offset: number; nextOffset?: number; bytes: number; partial: boolean; mime: string }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new PersonalError("artifact_input_invalid", "产物偏移须为非负安全整数，请使用结果中的 nextOffset。");
  const bytes = verifiedBytes(profile, ref), page = bytes.subarray(offset, offset + PAGE_BYTES), next = offset + page.length;
  return { base64: page.toString("base64"), offset, ...(next < bytes.length ? { nextOffset: next } : {}), bytes: bytes.length, partial: ref.partial, mime: ref.mime };
}

/** 完整核实后原子发布到一个新文件；拒绝 partial 与已存在目标，保留原产物。 */
export async function exportPersonalArtifact(profile: string | PersonalProfileLock, ref: PersonalArtifact, destination: string): Promise<void> {
  const bytes = verifiedBytes(profile, ref);
  if (ref.partial) throw new PersonalError("artifact_partial", "产物仅捕获了片段，不能完整导出；请分页查看已有字节并核实原操作。");
  const target = path.resolve(destination), directory = path.dirname(target), temporary = path.join(directory, `.ruukoto-artifact-${randomUUID()}`);
  try {
    writeExclusive(temporary, bytes);
    try { fs.linkSync(temporary, target); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new PersonalError("artifact_destination_exists", "导出目标已存在，未覆盖；请选择新的文件路径。");
      throw error;
    }
    fs.unlinkSync(temporary);
    syncDirectory(directory);
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("artifact_export_failed", "产物导出未能核实完成，请检查目标文件与目录；原产物仍保留。", { cause: error });
  } finally { fs.rmSync(temporary, { force: true }); }
}
