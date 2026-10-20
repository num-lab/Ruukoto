import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PersonalError } from "./personal-error.ts";
import { lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";

export type PersonalTelegramConfig = { version: 1; enabled: boolean; generation: string; apiBase: string; tokenEnv: string; tokenDigest: string; botId: string; ownerId: string; boundary: number };

export function parsePersonalTelegram(value: unknown): PersonalTelegramConfig {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("enabled" in value) || typeof value.enabled !== "boolean" || !("generation" in value) || typeof value.generation !== "string" || !/^[0-9a-f-]{36}$/.test(value.generation) || !("apiBase" in value) || typeof value.apiBase !== "string" || !("tokenEnv" in value) || typeof value.tokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value.tokenEnv) || /^RUUKOTO_(OWNER_TOKEN|SERVICE|CODE_|DESKTOP_|.*_DIR$|PRODUCT$|EXECUTION_BACKEND$)/.test(value.tokenEnv) || !("tokenDigest" in value) || typeof value.tokenDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.tokenDigest) || !("botId" in value) || typeof value.botId !== "string" || !/^[1-9][0-9]{0,15}$/.test(value.botId) || !("ownerId" in value) || typeof value.ownerId !== "string" || !/^[1-9][0-9]{0,15}$/.test(value.ownerId) || !("boundary" in value) || typeof value.boundary !== "number" || !Number.isSafeInteger(value.boundary) || value.boundary < 0) throw new PersonalError("telegram_config_invalid", "Telegram 配置无效，请停止实例后重新运行入口配对向导。");
  let url: URL;
  try { url = new URL(value.apiBase); } catch { throw new PersonalError("telegram_config_invalid", "Telegram 服务地址无效，请使用完整 HTTPS 地址。"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new PersonalError("telegram_config_invalid", "Telegram 服务地址应使用不含凭据的 HTTPS 地址；本机替身可使用 HTTP。");
  return { version: 1, enabled: value.enabled, generation: value.generation, apiBase: url.toString().replace(/\/+$/, ""), tokenEnv: value.tokenEnv, tokenDigest: value.tokenDigest, botId: value.botId, ownerId: value.ownerId, boundary: value.boundary };
}

export function telegramToken(config: PersonalTelegramConfig): string {
  const token = process.env[config.tokenEnv];
  if (!token || !/^[1-9][0-9]*:[\w-]+$/.test(token) || token.split(":")[0] !== config.botId || createHash("sha256").update(token).digest("hex") !== config.tokenDigest) throw new PersonalError("telegram_credentials_changed", "Telegram 凭据缺失或已变化，请设置原环境变量或停止实例后重新配对；未连接平台。");
  return token;
}

export function readPersonalTelegram(profile: PersonalProfileLock): PersonalTelegramConfig | undefined {
  const filename = path.join(profile.directory, "telegram.json");
  if (!fs.existsSync(filename)) return;
  let saved: unknown;
  try { saved = JSON.parse(fs.readFileSync(filename, "utf8")); } catch (error) { throw new PersonalError("telegram_config_invalid", "Telegram 配置无法读取，请保留档案并检查文件。", { cause: error }); }
  return parsePersonalTelegram(saved);
}

export function savePersonalTelegram(target: string | PersonalProfileLock, value: unknown): void {
  const config = parsePersonalTelegram(value);
  const profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  try { replaceConfig(profile.directory, config); } catch (error) { throw new PersonalError("telegram_config_write_failed", "入口配置未能保存，平台接管边界可能已确认；请保留档案并重新配对。", { cause: error }); }
  finally { if (typeof target === "string") profile.release(); }
}

function replaceConfig(directory: string, config: PersonalTelegramConfig): void {
  fs.writeFileSync(path.join(directory, "telegram.json.tmp"), JSON.stringify(config) + "\n", { mode: 0o600 });
  fs.renameSync(path.join(directory, "telegram.json.tmp"), path.join(directory, "telegram.json"));
}
