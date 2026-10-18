import { hasPendingPersonalWork } from "./personal-config-idle.ts";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { PersonalError } from "./personal-error.ts";
import { parsePersonalModel, type PersonalModelConfig } from "./personal-model.ts";
import { PERSONAL_FORMAT, lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";

export function personalDevDirectory(repo: string, home = homedir()): string {
  return path.join(home, ".ruukoto-durable-dev", createHash("sha256").update(fs.realpathSync(repo)).digest("hex").slice(0, 12));
}

export function readPersonalConfig(profile: PersonalProfileLock): PersonalModelConfig {
  let saved: unknown;
  try { saved = JSON.parse(fs.readFileSync(path.join(profile.directory, "model.json"), "utf8")); } catch (error) {
    throw new PersonalError("model_config_unavailable", "无法读取个人模型配置，请停止实例后运行模型配置向导。", { cause: error });
  }
  return parsePersonalModel(saved);
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
export async function savePersonalConfig(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalModel(value);
  const profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  const directory = profile.directory;
  try {
    if (fs.existsSync(path.join(directory, "model.json")) && isDeepStrictEqual(readPersonalConfig(profile), config)) return;
    const filename = path.join(directory, "personal.sqlite"), context = BACKGROUND_CONTEXT;
    if (fs.existsSync(filename)) {
      const storage = await openNodeSqliteStorage(filename);
      try {
        const record = await storage.findDocument({ kind: "ruukoto.format", scope: { kind: "session" } }, "current", context), saved = record && await storage.document(record.id, "current", context);
        if (!saved || saved.version !== 1 || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)) throw new PersonalError("extension_version", "个人业务格式无法核实，未更改模型；请保留档案并使用对应程序。");
        if (await hasPendingPersonalWork(storage)) throw new PersonalError("model_changed_pending", "仍有未完成输入或工作，未更改模型；请先用原配置完成处理。");
      } finally { await storage.close(context); }
    }
    fs.writeFileSync(path.join(directory, "model.json.tmp"), JSON.stringify(config) + "\n", { mode: 0o600 });
    fs.renameSync(path.join(directory, "model.json.tmp"), path.join(directory, "model.json"));
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("model_config_write_failed", "模型配置未能保存，请保留档案并检查磁盘；原配置可能仍有效。", { cause: error });
  } finally { if (typeof target === "string") profile.release(); }
}
