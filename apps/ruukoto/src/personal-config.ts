import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { PersonalError } from "./personal-error.ts";
import { parsePersonalModel, type PersonalModelConfig } from "./personal-model.ts";
import type { PersonalProfileLock } from "./personal-profile.ts";

export function personalDevDirectory(repo: string, home = homedir()): string {
  return path.join(home, ".ruukoto-durable-dev", createHash("sha256").update(fs.realpathSync(repo)).digest("hex").slice(0, 12));
}

// Note: 见 .agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md
export function personalDevelopmentEnv(directory: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^RUUKOTO_(?:CODE_|SERVICE_|DESKTOP_)/.test(key) || /^RUUKOTO_(?:PRODUCT|(?:DATA|AGENT|CONTROL|PENDING|PERSONAL)_DIR|PERSONAL_WATCH_CHILD|OWNER_TOKEN(?:_FILE)?|EXECUTION_BACKEND|DISABLE_QQ|DISABLE_TELEGRAM|RELOAD_STATE_FILE)$/.test(key)) delete env[key];
  }
  env.RUUKOTO_PERSONAL_DIR = directory;
  return env;
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
  const { readPersonalSettings, savePersonalSettings } = await import("./personal-settings.ts");
  const snapshot = await readPersonalSettings(target);
  await savePersonalSettings(target, snapshot, snapshot.revisions.model, { kind: "config.save", target: "model", value: config });
}
