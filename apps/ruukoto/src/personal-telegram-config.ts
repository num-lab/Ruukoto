import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PersonalError } from "./personal-error.ts";
import { type PersonalProfileLock } from "./personal-profile.ts";

export type PersonalTelegramConfig = { version: 1; enabled: boolean; generation: string; apiBase: string; tokenEnv: string; tokenDigest: string; botId: string; ownerId: string; boundary: number; pairingId?: string };

export function parsePersonalTelegram(value: unknown): PersonalTelegramConfig {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("enabled" in value) || typeof value.enabled !== "boolean" || !("generation" in value) || typeof value.generation !== "string" || !/^[0-9a-f-]{36}$/.test(value.generation) || !("apiBase" in value) || typeof value.apiBase !== "string" || !("tokenEnv" in value) || typeof value.tokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value.tokenEnv) || /^RUUKOTO_(OWNER_TOKEN|SERVICE|CODE_|DESKTOP_|.*_DIR$|PRODUCT$|EXECUTION_BACKEND$)/.test(value.tokenEnv) || !("tokenDigest" in value) || typeof value.tokenDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.tokenDigest) || !("botId" in value) || typeof value.botId !== "string" || !/^[1-9][0-9]{0,15}$/.test(value.botId) || !("ownerId" in value) || typeof value.ownerId !== "string" || !/^[1-9][0-9]{0,15}$/.test(value.ownerId) || !("boundary" in value) || typeof value.boundary !== "number" || !Number.isSafeInteger(value.boundary) || value.boundary < 0) throw new PersonalError("telegram_config_invalid", "Telegram 配置无效，请通过原后台重新运行入口配对向导。");
  let url: URL;
  try { url = new URL(value.apiBase); } catch { throw new PersonalError("telegram_config_invalid", "Telegram 服务地址无效，请使用完整 HTTPS 地址。"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new PersonalError("telegram_config_invalid", "Telegram 服务地址应使用不含凭据的 HTTPS 地址；本机替身可使用 HTTP。");
  if ("pairingId" in value && (typeof value.pairingId !== "string" || !/^[0-9a-f-]{36}$/.test(value.pairingId))) throw new PersonalError("telegram_pairing_invalid", "Telegram 配对证明无效，请通过后台重新配对。");
  return { version: 1, enabled: value.enabled, generation: value.generation, apiBase: url.toString().replace(/\/+$/, ""), tokenEnv: value.tokenEnv, tokenDigest: value.tokenDigest, botId: value.botId, ownerId: value.ownerId, boundary: value.boundary, ...("pairingId" in value ? { pairingId: value.pairingId as string } : {}) };
}

export function telegramToken(config: PersonalTelegramConfig): string {
  const token = process.env[config.tokenEnv];
  if (!token || !/^[1-9][0-9]*:[\w-]+$/.test(token) || token.split(":")[0] !== config.botId || createHash("sha256").update(token).digest("hex") !== config.tokenDigest) throw new PersonalError("telegram_credentials_changed", "Telegram 凭据缺失或已变化，请设置原环境变量或通过原后台重新配对；未连接平台。");
  return token;
}

export function readPersonalTelegram(profile: PersonalProfileLock): PersonalTelegramConfig | undefined {
  const filename = path.join(profile.directory, "telegram.json");
  if (!fs.existsSync(filename)) return;
  let saved: unknown;
  try { saved = JSON.parse(fs.readFileSync(filename, "utf8")); } catch (error) { throw new PersonalError("telegram_config_invalid", "Telegram 配置无法读取，请保留档案并检查文件。", { cause: error }); }
  return parsePersonalTelegram(saved);
}

export async function savePersonalTelegram(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalTelegram(value);
  const { readPersonalSettings, savePersonalSettings } = await import("./personal-settings.ts");
  const snapshot = await readPersonalSettings(target);
  const receipt = await savePersonalSettings(target, snapshot, snapshot.revisions.telegram, { kind: "config.save", target: "telegram", value: config });
  if (!["active", "saved", "waiting"].includes(receipt.status)) throw new PersonalError(receipt.code, "入口设置未完成，请保留档案并查询原配置操作；不要自动重试。");
}
