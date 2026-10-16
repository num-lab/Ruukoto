import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { PersonalError } from "./personal-error.ts";

export const PERSONAL_FORMAT = { product: "ruukoto", format: 1, pi: "1.3.0", extensions: { personal: 1 } } as const;

export function personalDirectory(): string {
  return path.resolve(process.env.RUUKOTO_PERSONAL_DIR ?? path.join(homedir(), ".ruukoto-durable"));
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md
export function lockPersonalProfile(directory: string): { release(): void } {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const names = fs.readdirSync(directory);
  const allowed = new Set(["profile.json", "owner.sqlite", "owner.sqlite-journal", "personal.sqlite", "personal.sqlite-wal", "personal.sqlite-shm"]);
  if (names.some(name => !allowed.has(name) || !fs.lstatSync(path.join(directory, name)).isFile()) || (!names.includes("profile.json") && names.some(name => !name.startsWith("owner.sqlite")))) {
    throw new PersonalError("profile_unrecognized", "所选目录不是新的个人档案。请保留原资料，另选空目录。");
  }
  fs.chmodSync(directory, 0o700);
  for (const name of names) fs.chmodSync(path.join(directory, name), 0o600);
  const ownerFile = path.join(directory, "owner.sqlite");
  fs.closeSync(fs.openSync(ownerFile, "a", 0o600));
  // 锁由 SQLite 持有至连接关闭，进程崩溃由 OS 释放；不删除锁文件，避免并发进程锁住不同 inode。
  const owner = new DatabaseSync(ownerFile);
  try {
    owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (error) {
    owner.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5) {
      throw new PersonalError("profile_busy", "个人实例或配置向导正在使用此档案，请连接运行中实例或等待它停止。", { cause: error });
    }
    throw new PersonalError("profile_lock_failed", "无法锁定个人档案，请检查目录与磁盘状态。", { cause: error });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    owner.close();
  };
  try {
    const manifest = path.join(directory, "profile.json");
    if (fs.existsSync(manifest)) {
      const saved: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (!isDeepStrictEqual(saved, PERSONAL_FORMAT)) {
        throw new PersonalError("profile_version", "个人档案版本不受当前程序支持，请使用对应版本并在停止实例后安排升级。");
      }
    } else {
      fs.writeFileSync(manifest, JSON.stringify(PERSONAL_FORMAT) + "\n", { flag: "wx", mode: 0o600 });
    }
    return { release };
  } catch (error) {
    release();
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("profile_invalid", "无法核实个人档案，请保留现场并检查档案标记。", { cause: error });
  }
}
