import * as fs from "node:fs";
import * as path from "node:path";
import { DesktopError } from "./environment.ts";

export interface PersonalTargetConfig { host: string; controlDir: string }
export const DEFAULT_PERSONAL_CONTROL_DIR = "/var/lib/ruukoto/control";
export function personalSocketPath(userData: string): string { return path.join(userData, "ssh", "personal.sock"); }
export function validatePersonalConfig(value: unknown, userData: string): PersonalTargetConfig {
  if (!value || typeof value !== "object" || !("host" in value) || typeof value.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.host)) throw new DesktopError("invalid_ssh_host", "SSH 主机别名须以字母或数字开头，只能含字母、数字、点、下划线与连字符。");
  const controlDir = "controlDir" in value ? value.controlDir : DEFAULT_PERSONAL_CONTROL_DIR;
  if (typeof controlDir !== "string" || !/^\/[A-Za-z0-9._/-]*$/.test(controlDir)) throw new DesktopError("invalid_control_dir", "远端控制目录须为绝对路径，只能含字母、数字、点、下划线、连字符与斜杠。");
  const local = personalSocketPath(userData);
  if (!path.isAbsolute(local) || local.includes(":") || local.includes("\0")) throw new DesktopError("invalid_socket_path", "应用数据目录无法用于 SSH socket 转发；请使用不含冒号的绝对路径。");
  if (Buffer.byteLength(path.posix.join(controlDir, "control.sock")) > 107 || Buffer.byteLength(local) > (process.platform === "darwin" ? 103 : 107)) throw new DesktopError("socket_path_too_long", "控制 socket 路径过长；请缩短远端控制目录或应用数据目录。");
  return { host: value.host, controlDir: path.posix.normalize(controlDir) };
}
export function loadPersonalConfig(userData: string): PersonalTargetConfig | null {
  let contents: string;
  try { contents = fs.readFileSync(path.join(userData, "personal.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DesktopError("personal_config_read", "无法读取 Personal 配置；请检查应用数据目录的权限。");
  }
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch { throw new DesktopError("personal_config_invalid", "Personal 配置无法解析；请重新保存连接配置。"); }
  return validatePersonalConfig(value, userData);
}
export function savePersonalConfig(userData: string, value: unknown): PersonalTargetConfig {
  const config = validatePersonalConfig(value, userData);
  try {
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(userData, "personal.json.tmp"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
    fs.renameSync(path.join(userData, "personal.json.tmp"), path.join(userData, "personal.json"));
  } catch { throw new DesktopError("personal_config_write", "Personal 配置保存失败；请检查应用数据目录的权限后重试。"); }
  return config;
}
