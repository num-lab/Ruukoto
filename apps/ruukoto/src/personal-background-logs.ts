import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, type Hash } from "node:crypto";
import { PersonalError } from "./personal-error.ts";

export type PersonalBackgroundLogs = { stdout: { dev: number; ino: number; bytes: number; sha256: string }; stderr: { dev: number; ino: number; bytes: number; sha256: string } };
const LIMIT = 16 * 1024 * 1024;
function privateObject(target: string, directory: boolean) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new PersonalError("background_evidence_invalid", "后台证据归属无法核实；保留占用和现场，请核实原档案。");
  return stat;
}
export class PersonalBackgroundCapture {
  private readonly streams: Record<"stdout" | "stderr", { fd: number; bytes: number; hash: Hash }>;
  private closed = false;
  constructor(directory: string) {
    fs.mkdirSync(directory, { mode: 0o700 }); privateObject(directory, true);
    const open = (name: string) => ({ fd: fs.openSync(path.join(directory, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600), bytes: 0, hash: createHash("sha256") });
    const stdout = open("stdout");
    try { this.streams = { stdout, stderr: open("stderr") }; }
    catch (error) { fs.closeSync(stdout.fd); throw error; }
  }
  append(stream: "stdout" | "stderr", bytes: Buffer) {
    if (this.closed) return { logs: this.snapshot(), reason: "background_output_closed" };
    const current = this.streams[stream], available = Math.max(0, LIMIT - this.streams.stdout.bytes - this.streams.stderr.bytes), keep = bytes.subarray(0, available);
    let written = 0, failed = false;
    try { while (written < keep.length) { const count = fs.writeSync(current.fd, keep, written, keep.length - written); if (count <= 0) throw new PersonalError("background_log_failed", "后台日志写入未取得进展。"); written += count; } fs.fsyncSync(current.fd); }
    catch { failed = true; } // 保留短写的实际字节，调用方登记 partial 并停止原执行。
    current.bytes += written; current.hash.update(keep.subarray(0, written));
    return { logs: this.snapshot(), ...(failed || available <= bytes.length ? { reason: failed ? "background_log_failed" : "background_output_limit" } : {}) };
  }
  snapshot(): PersonalBackgroundLogs {
    const value = (stream: "stdout" | "stderr") => { const current = this.streams[stream], stat = fs.fstatSync(current.fd); return { dev: stat.dev, ino: stat.ino, bytes: current.bytes, sha256: current.hash.copy().digest("hex") }; };
    return { stdout: value("stdout"), stderr: value("stderr") };
  }
  close() { if (!this.closed) { this.closed = true; for (const stream of Object.values(this.streams)) fs.closeSync(stream.fd); } }
}

export function readPersonalBackgroundLog(directory: string, logs: PersonalBackgroundLogs | undefined, stream: "stdout" | "stderr", offset = 0) {
  if (!["stdout", "stderr"].includes(stream) || !Number.isSafeInteger(offset) || offset < 0) throw new PersonalError("background_invalid_params", "选择 stdout 或 stderr，offset 使用非负字节位置。");
  if (!logs) throw new PersonalError("background_output_unavailable", "后台尚未保存日志；请查询原状态并结束本轮，勿重放命令。");
  try {
    privateObject(directory, true);
    const filename = path.join(directory, stream), expected = logs[stream], before = privateObject(filename, false), fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd), hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.bytes || stat.size > LIMIT) throw new PersonalError("background_evidence_invalid", "后台日志身份或大小不符；保留现场并核实原档案。");
      for (let at = 0; at < stat.size;) { const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - at), at); if (!count) throw new PersonalError("background_evidence_invalid", "后台日志读取不完整；请保留现场。"); hash.update(chunk.subarray(0, count)); at += count; }
      if (hash.digest("hex") !== expected.sha256) throw new PersonalError("background_evidence_invalid", "后台日志校验不符；保留现场并核实原档案。");
      const bytes = Buffer.alloc(Math.min(32 * 1024, Math.max(0, stat.size - offset))), count = fs.readSync(fd, bytes, 0, bytes.length, offset), kept = bytes.subarray(0, count);
      return { base64: kept.toString("base64"), text: kept.toString("utf8"), offset, nextOffset: offset + count, totalBytes: stat.size };
    } finally { fs.closeSync(fd); }
  } catch (error) { if (error instanceof PersonalError) throw error; throw new PersonalError("background_evidence_invalid", "后台日志无法核实；保留现场并查询原档案。", { cause: error }); }
}
