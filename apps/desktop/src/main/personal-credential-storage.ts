import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopError } from "./environment.ts";
import type { PersonalCredentialStorage } from "./personal-credentials.ts";

type SafeStorage = Pick<Electron.SafeStorage, "isAsyncEncryptionAvailable" | "encryptStringAsync" | "decryptStringAsync">;
const LIMIT = 64 * 1024;
const unavailable = () => new DesktopError("personal_credentials_unavailable", "安全存储不可用；请解锁钥匙串或检查应用授权后重新连接并核实原凭据。");

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export function electronPersonalCredentialStorage(userData: string, packaged: boolean, storage: SafeStorage, ready: () => Promise<unknown>): PersonalCredentialStorage {
  const directory = path.join(userData, "personal-credentials");
  const filename = path.join(directory, packaged ? "production.v1.enc" : "development.v1.enc");
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action).catch(() => { throw unavailable(); });
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const privateFile = (fd: number) => {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.() || info.size > LIMIT + 4096) throw unavailable();
  };
  const privateDirectory = (): boolean => {
    let info: fs.Stats;
    try { info = fs.lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw unavailable();
    return true;
  };
  const readDisk = (file: string): Buffer | null => {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try { privateFile(fd); return fs.readFileSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const encryptor = async () => {
    await ready();
    if (!await storage.isAsyncEncryptionAvailable()) throw unavailable();
  };
  const syncDirectory = () => {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const save = async (value: string) => {
    if (Buffer.byteLength(value) > LIMIT) throw unavailable();
    await encryptor();
    const encrypted = await storage.encryptStringAsync(value);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory();
    const temporary = path.join(directory, `${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, encrypted, { flush: true }); }
      finally { fs.closeSync(fd); }
      const bytes = readDisk(temporary);
      if (!bytes || (await storage.decryptStringAsync(bytes)).result !== value) throw unavailable();
      fs.renameSync(temporary, filename);
      syncDirectory();
    } finally {
      try { fs.unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write("[ruukoto:desktop] 安全存储临时密文未清理；请检查应用数据目录权限。\n"); }
    }
  };
  return {
    read: () => run(async () => {
      if (!privateDirectory()) return null;
      const bytes = readDisk(filename);
      if (!bytes) return null;
      privateDirectory();
      await encryptor();
      const decrypted = await storage.decryptStringAsync(bytes);
      if (Buffer.byteLength(decrypted.result) > LIMIT) throw unavailable();
      if (decrypted.shouldReEncrypt) await save(decrypted.result);
      return decrypted.result;
    }),
    write: value => run(() => save(value)),
    remove: () => run(async () => {
      if (!privateDirectory()) return;
      const bytes = readDisk(filename);
      if (!bytes) return;
      privateDirectory();
      fs.unlinkSync(filename);
      syncDirectory();
    }),
  };
}
