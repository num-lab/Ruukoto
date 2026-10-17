import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalFormatDoc } from "./personal-harness.ts";
import { PersonalServiceDoc, personalServiceConfig } from "./personal-services.ts";
import { PersonalServiceOperationsDoc } from "./personal-service-operations.ts";
import { PERSONAL_FORMAT, lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";

export type PersonalServiceConfig = { version: 1; helperPath: string; policyPath: string; sudoPath: string };
const context = BACKGROUND_CONTEXT;

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
  return parsePersonalServices(saved);
}

async function checkEnablement(storage: Storage, config: PersonalServiceConfig): Promise<void> {
  const format = await storage.findDocument({ kind: PersonalFormatDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  const saved = format && await storage.document(format.id, "current", context);
  if (!saved || saved.version !== 1 || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)) throw new PersonalError("extension_version", "个人业务格式无法核实，未保存服务配置；请保留档案并使用对应程序。");
  const service = await storage.findDocument({ kind: PersonalServiceDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  const savedService = service && await storage.document(service.id, "current", context);
  if (savedService && (savedService.version !== PersonalServiceDoc.definition.version || savedService.value.fingerprint !== personalServiceConfig({ ...config, useSudo: true }).fingerprint)) throw new PersonalError("service_config_changed", "服务配置与档案原指纹不符，未保存；请恢复原 helper、策略和 sudo 路径。");
  const operations = await storage.findDocument({ kind: PersonalServiceOperationsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  const savedOperations = operations && await storage.document(operations.id, "current", context);
  if (savedOperations && (!savedService || savedOperations.version !== 1 || savedOperations.value.enabled !== true)) throw new PersonalError("service_operations_config", "原服务操作配置无法核实，未保存；请保留档案并使用原配置。");
  if (savedService && savedOperations) return;
  const tasks = await Promise.all((["pending", "running", "waiting", "completing"] as const).map(status => storage.scanTasks({ status }, 1, undefined, context)));
  const inputs = await Promise.all((["queued", "placed"] as const).map(status => storage.scanSubmissions({ status }, 1, undefined, context)));
  if ([...tasks, ...inputs].some(page => page.items.length)) throw new PersonalError("service_config_pending", "档案仍有未完成输入或工作，未保存服务配置；请先用原配置启动并完成处理，再启用服务。");
}

async function checkProfile(profile: PersonalProfileLock, config: PersonalServiceConfig): Promise<void> {
  const filename = path.join(profile.directory, "personal.sqlite");
  if (!fs.existsSync(filename)) return;
  const storage = await openNodeSqliteStorage(filename);
  try { await checkEnablement(storage, config); }
  finally { await storage.close(context); }
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-service-configuration.md
export async function savePersonalServices(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalServices(value);
  const profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  try {
    const current = readPersonalServices(profile);
    if (current) {
      if (!isDeepStrictEqual(current, config)) throw new PersonalError("service_config_changed", "服务配置已固定，未覆盖；请保留原配置，其他部署使用新的隔离档案。");
      return;
    }
    try { await checkProfile(profile, config); } catch (error) {
      if (error instanceof PersonalError) throw error;
      throw new PersonalError("service_config_check_failed", "无法核实档案是否可启用服务，未保存；请保留档案并检查存储。", { cause: error });
    }
    try { replaceConfig(profile.directory, config); } catch (error) {
      throw new PersonalError("service_config_write_failed", "服务配置未能保存，请保留档案并检查磁盘后重新查看配置。", { cause: error });
    }
  } finally { if (typeof target === "string") profile.release(); }
}

function replaceConfig(directory: string, config: PersonalServiceConfig): void {
  fs.writeFileSync(path.join(directory, "service.json.tmp"), JSON.stringify(config) + "\n", { mode: 0o600 });
  fs.renameSync(path.join(directory, "service.json.tmp"), path.join(directory, "service.json"));
}
