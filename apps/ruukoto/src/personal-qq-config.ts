import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PersonalError } from "./personal-error.ts";
import { lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";
import { oneBotAccountId, oneBotMessageId } from "@ruukoto/channels/qq/onebot.ts";

export type PersonalQqConfig = { version: 1; enabled: boolean; generation: string; endpoint: string; tokenEnv: string; tokenDigest: string; botId: string; ownerId: string; boundary: number; boundaryMessageId: string };

export function parsePersonalQq(value: unknown): PersonalQqConfig {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("enabled" in value) || typeof value.enabled !== "boolean" || !("generation" in value) || typeof value.generation !== "string" || !/^[0-9a-f-]{36}$/.test(value.generation) || !("endpoint" in value) || typeof value.endpoint !== "string" || !("tokenEnv" in value) || typeof value.tokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value.tokenEnv) || /^RUUKOTO_(OWNER_TOKEN|SERVICE|CODE_|DESKTOP_|.*_DIR$|PRODUCT$|EXECUTION_BACKEND$)/.test(value.tokenEnv) || !("tokenDigest" in value) || typeof value.tokenDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.tokenDigest) || !("botId" in value) || typeof value.botId !== "string" || oneBotAccountId(value.botId) !== value.botId || !("ownerId" in value) || typeof value.ownerId !== "string" || oneBotAccountId(value.ownerId) !== value.ownerId || !("boundaryMessageId" in value) || typeof value.boundaryMessageId !== "string" || oneBotMessageId(value.boundaryMessageId) !== value.boundaryMessageId || !("boundary" in value) || typeof value.boundary !== "number" || !Number.isSafeInteger(value.boundary) || value.boundary < 0) throw new PersonalError("qq_config_invalid", "QQ 配置无效，请停止实例后重新运行入口配对向导。");
  if (value.ownerId === value.botId) throw new PersonalError("qq_config_invalid", "QQ 拥有者须与登录账号不同，请用拥有者好友重新配对。");
  let url: URL;
  try { url = new URL(value.endpoint); } catch { throw new PersonalError("qq_config_invalid", "QQ 服务地址无效，请使用完整 WebSocket 地址。"); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new PersonalError("qq_config_invalid", "QQ 服务须使用无凭据的 WSS 地址；同机服务可使用回环 WS。");
  return { version: 1, enabled: value.enabled, generation: value.generation, endpoint: url.toString(), tokenEnv: value.tokenEnv, tokenDigest: value.tokenDigest, botId: value.botId, ownerId: value.ownerId, boundary: value.boundary, boundaryMessageId: value.boundaryMessageId };
}

export function qqToken(config: PersonalQqConfig): string {
  const token = process.env[config.tokenEnv];
  if (!token || /[\r\n]/.test(token) || createHash("sha256").update(token).digest("hex") !== config.tokenDigest) throw new PersonalError("qq_credentials_changed", "QQ 凭据缺失或已变化，请恢复原环境变量或停止实例后重新配对；未连接平台。");
  return token;
}

export function readPersonalQq(profile: PersonalProfileLock): PersonalQqConfig | undefined {
  const filename = path.join(profile.directory, "qq.json");
  if (!fs.existsSync(filename)) return;
  let saved: unknown;
  try { saved = JSON.parse(fs.readFileSync(filename, "utf8")); } catch (error) { throw new PersonalError("qq_config_invalid", "QQ 配置无法读取，请保留档案并检查文件。", { cause: error }); }
  return parsePersonalQq(saved);
}

export function savePersonalQq(target: string | PersonalProfileLock, value: unknown) {
  const config = parsePersonalQq(value), profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  try {
    fs.writeFileSync(path.join(profile.directory, "qq.json.tmp"), JSON.stringify(config) + "\n", { mode: 0o600 });
    fs.renameSync(path.join(profile.directory, "qq.json.tmp"), path.join(profile.directory, "qq.json"));
  } catch (error) { throw new PersonalError("qq_config_write_failed", "QQ 入口配置未能保存，请保留档案并重新配对。", { cause: error }); }
  finally { if (typeof target === "string") profile.release(); }
}
