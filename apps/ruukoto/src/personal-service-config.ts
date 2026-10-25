import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PersonalError } from "./personal-error.ts";
import type { PersonalProfileLock } from "./personal-profile.ts";
import type { PersonalSettingsReceipt } from "./personal-settings-records.ts";

export type PersonalServiceConfig = { version: 1; helperPath: string; policyPath: string; sudoPath: string };

export function parsePersonalServices(value: unknown): PersonalServiceConfig {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["version", "helperPath", "policyPath", "sudoPath"].includes(key))
    || !("version" in value) || value.version !== 1 || !("helperPath" in value) || typeof value.helperPath !== "string" || !("policyPath" in value) || typeof value.policyPath !== "string" || !("sudoPath" in value) || typeof value.sudoPath !== "string"
    || ![value.helperPath, value.policyPath, value.sudoPath].every(item => typeof item === "string" && item.length <= 4096 && path.isAbsolute(item) && !/[\x00-\x1f\x7f]/.test(item))) {
    throw new PersonalError("service_config_invalid", "服务配置无效，请保留原配置；helper、策略和 sudo 均须使用绝对路径，生产固定通过 sudo 调用。");
  }
  return { version: 1, helperPath: value.helperPath, policyPath: value.policyPath, sudoPath: value.sudoPath };
}

export function readPersonalServices(profile: PersonalProfileLock): PersonalServiceConfig | undefined {
  const filename = path.join(profile.directory, "service.json");
  if (!fs.existsSync(filename)) return;
  let saved: unknown;
  try { saved = JSON.parse(fs.readFileSync(filename, "utf8")); } catch (error) {
    throw new PersonalError("service_config_invalid", "服务配置无法读取，请保留档案并恢复原配置文件。", { cause: error });
  }
  return saved === null ? undefined : parsePersonalServices(saved);
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-25-personal-execution-configuration-versions.md
export async function savePersonalServices(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalServices(value);
  const { executePersonalSettings } = await import("./personal-settings.ts");
  const snapshot = await executePersonalSettings(target, { v: 1, op: "settings.read" }) as { profile: { directory: string; id: string }; revisions: { services: string } };
  const result = await executePersonalSettings(target, { v: 2, id: randomUUID(), profile: snapshot.profile, expectedRevision: snapshot.revisions.services, op: { kind: "config.save", target: "services", value: config } }) as PersonalSettingsReceipt;
  if (!["active", "saved", "waiting"].includes(result.status)) throw new PersonalError(result.code, "服务设置未完成，请保留档案并查询原设置操作；不要自动重试。");
}
