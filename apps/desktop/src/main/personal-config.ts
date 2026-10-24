import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DesktopError } from "./environment.ts";

export interface PersonalProfileIdentity { id: string; directory: string }
export interface PersonalTargetConfig { v: 1; origin: string; binding?: { remoteId: string; profile: PersonalProfileIdentity } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function personalOrigin(value: unknown): string {
  if (typeof value !== "string" || !/^https:\/\/[^/?#\\]+\/?$/i.test(value) || /[\x00-\x20\x7f]/.test(value)) throw new DesktopError("invalid_personal_origin", "请输入个人 Agent 的完整 HTTPS 地址。");
  let url: URL;
  try { url = new URL(value); } catch { throw new DesktopError("invalid_personal_origin", "请输入个人 Agent 的完整 HTTPS 地址。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new DesktopError("invalid_personal_origin", "地址只包含 HTTPS 主机与可选端口，请去除路径、账号与查询参数。");
  return url.origin;
}
export function personalProfile(value: unknown): value is PersonalProfileIdentity {
  return object(value) && Object.keys(value).length === 2 && typeof value.id === "string" && /^sha256:[0-9a-f]{64}$/.test(value.id) && typeof value.directory === "string" && path.posix.isAbsolute(value.directory) && path.posix.resolve(value.directory) === value.directory && !/[\x00-\x1f\x7f]/.test(value.directory);
}
export function validatePersonalConfig(value: unknown): PersonalTargetConfig {
  if (!object(value) || Object.keys(value).some(key => !["v", "origin", "binding"].includes(key)) || value.v !== undefined && value.v !== 1) throw new DesktopError("personal_config_invalid", "个人连接配置版本无效，请保留原记录并检查客户端版本。");
  const origin = personalOrigin(value.origin);
  if (value.binding === undefined) return { v: 1, origin };
  if (!object(value.binding) || Object.keys(value.binding).length !== 2 || typeof value.binding.remoteId !== "string" || !/^[0-9a-f-]{36}$/.test(value.binding.remoteId) || !personalProfile(value.binding.profile)) throw new DesktopError("personal_config_invalid", "个人连接归属无法核实，请保留原记录并重新配对。");
  return { v: 1, origin, binding: { remoteId: value.binding.remoteId, profile: { ...value.binding.profile } } };
}
export function readPersonalRecord(filename: string): unknown | null {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 256 * 1024) throw new DesktopError("personal_record_invalid", "个人连接记录无法安全读取，请保留原文件并检查应用数据目录。");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw: string;
  try { raw = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new DesktopError("personal_record_invalid", "个人连接记录损坏，请保留原文件并核实原请求。"); }
  if (value === null) throw new DesktopError("personal_record_invalid", "个人连接记录内容无效，请保留原文件并核实原请求。");
  return value;
}
export function writePersonalRecord(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(path.dirname(filename));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0) throw new DesktopError("personal_record_write", "个人连接记录目录权限无效，请检查应用数据目录；未发送请求。");
  if (fs.lstatSync(filename, { throwIfNoEntry: false })) readPersonalRecord(filename);
  const raw = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(raw) > 256 * 1024) throw new DesktopError("personal_record_write", "个人连接记录超过上限，未发送请求。");
  const temporary = `${filename}.${randomUUID()}.tmp`, fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export function loadPersonalConfig(userData: string): PersonalTargetConfig | null {
  const value = readPersonalRecord(path.join(userData, "personal-remote.json"));
  if (value === null) return null;
  if (!object(value) || value.v !== 1) throw new DesktopError("personal_config_invalid", "个人连接配置版本无效，请保留原记录并检查客户端版本。");
  return validatePersonalConfig(value);
}
export function savePersonalConfig(userData: string, value: unknown): PersonalTargetConfig {
  const config = validatePersonalConfig(value);
  writePersonalRecord(path.join(userData, "personal-remote.json"), config);
  return config;
}
export function personalPendingFile(userData: string, config: PersonalTargetConfig): string {
  return path.join(userData, "pending", "personal-remote", createHash("sha256").update(JSON.stringify([config.origin, config.binding])).digest("hex") + ".json");
}
function legacyRecords(userData: string) {
  const directory = path.join(userData, "pending", "personal-settings"), stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DesktopError("legacy_maintenance_invalid", "旧维护记录目录无法核实，请保留原应用数据并检查。");
  return fs.readdirSync(directory).sort().map(name => {
    const filename = path.join(directory, name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new DesktopError("legacy_maintenance_invalid", "旧维护记录无法核实，请保留原文件并检查原服务。");
    return { path: filename, digest: createHash("sha256").update(fs.readFileSync(filename)).digest("hex") };
  });
}
export function legacyPersonalMaintenance(userData: string, origin: string): string[] {
  const records = legacyRecords(userData), acknowledged = readPersonalRecord(path.join(userData, "personal-legacy-verified.json"));
  return object(acknowledged) && acknowledged.v === 1 && acknowledged.origin === origin && JSON.stringify(acknowledged.records) === JSON.stringify(records) ? [] : records.map(record => record.path);
}
export function acknowledgeLegacyPersonalMaintenance(userData: string, origin: string): void {
  writePersonalRecord(path.join(userData, "personal-legacy-verified.json"), { v: 1, origin, records: legacyRecords(userData), verifiedAt: Date.now() });
}
