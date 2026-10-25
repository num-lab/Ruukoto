import * as fs from "node:fs";
import * as path from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import { PersonalError } from "./personal-error.ts";
import type { PersonalProfileLock } from "./personal-profile.ts";
import { randomUUID } from "node:crypto";
import type { PersonalSettingsReceipt } from "./personal-settings-records.ts";
import type { PersonalServiceMode } from "./personal-service-operations.ts";

export type PersonalCommandConfig = { version: 1; workspace: string; identity: { dev: number; ino: number }; machineId: string; tmpdir: string };
const validPath = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

export function parsePersonalCommands(value: unknown): PersonalCommandConfig {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["version", "workspace", "identity", "machineId", "tmpdir"].includes(key)) || !("version" in value) || value.version !== 1 || !("workspace" in value) || !validPath(value.workspace) || !("tmpdir" in value) || !validPath(value.tmpdir) || !("machineId" in value) || typeof value.machineId !== "string" || !/^[0-9a-f]{32}$/.test(value.machineId) || !("identity" in value) || !value.identity || typeof value.identity !== "object" || Array.isArray(value.identity) || Object.keys(value.identity).some(key => !["dev", "ino"].includes(key)) || !("dev" in value.identity) || !Number.isSafeInteger(value.identity.dev) || Number(value.identity.dev) < 0 || !("ino" in value.identity) || !Number.isSafeInteger(value.identity.ino) || Number(value.identity.ino) <= 0) throw new PersonalError("command_config_invalid", "命令配置无效，请保留档案并恢复原配置；不要手工改写目录或执行身份。");
  return { version: 1, workspace: value.workspace, identity: { dev: Number(value.identity.dev), ino: Number(value.identity.ino) }, machineId: value.machineId, tmpdir: value.tmpdir };
}

export function personalProtectedRoots(profileDirectory: string) {
  return [fs.realpathSync(profileDirectory), fs.realpathSync(fileURLToPath(new URL("../../../", import.meta.url))), ...[".ruukoto", ".ruukoto-code", ".ruukoto-dev", ".ruukoto-code-dev", ".ruukoto-durable", ".ruukoto-durable-dev", ".ssh", ".aws", ".config", ".pi"].map(name => path.join(homedir(), name))];
}

// Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-operation-specific-checks.md
export function verifyPersonalCommandConfig(config: PersonalCommandConfig, profileDirectory: string, mode: PersonalServiceMode = "confirm"): void {
  if (process.platform !== "linux") throw new PersonalError("command_platform_unsupported", "个人命令需要 Linux；请在原 Linux 实例配置和恢复。");
  try {
    const saved = parsePersonalCommands(config);
    const workspace = fs.lstatSync(saved.workspace);
    if (!workspace.isDirectory() || workspace.isSymbolicLink() || fs.realpathSync(saved.workspace) !== saved.workspace || workspace.dev !== saved.identity.dev || workspace.ino !== saved.identity.ino || fs.readFileSync("/etc/machine-id", "utf8").trim() !== saved.machineId || fs.realpathSync(tmpdir()) !== saved.tmpdir) throw new PersonalError("command_config_changed", "命令的原目录、机器或临时目录无法核实，已停止；请恢复原环境并保留档案。");
    if (mode !== "full_access") assertGrantNotProtected(saved.workspace, personalProtectedRoots(profileDirectory));
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("command_config_invalid", "命令目录不可用或包含受保护资料，已停止；请保留档案并检查原目录与配置。", { cause: error });
  }
}

export function personalCommandEnvironment(profileDirectory: string, config: PersonalCommandConfig) {
  verifyPersonalCommandConfig(config, profileDirectory);
  const directory = path.join(fs.realpathSync(profileDirectory), "commands");
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))) throw new PersonalError("command_config_invalid", "命令证据目录无法核实，请保留档案并恢复原私有目录。");
  return { directory, native: { workerPath: fileURLToPath(new URL("../../../worker/personal-command-worker.mjs", import.meta.url)), dependencyRoots: [], protectedRoots: personalProtectedRoots(profileDirectory) } };
}

export function readPersonalCommands(profile: PersonalProfileLock): PersonalCommandConfig | undefined {
  const filename = path.join(profile.directory, "command.json");
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new PersonalError("command_config_invalid", "命令配置必须是私有普通文件，请保留档案并恢复原配置文件。");
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(filename, "utf8")); } catch (error) {
    throw new PersonalError("command_config_invalid", "命令配置无法读取，请保留档案并恢复原配置文件。", { cause: error });
  }
  if (value === null) return;
  const config = parsePersonalCommands(value);
  verifyPersonalCommandConfig(config, profile.directory);
  return config;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-25-personal-execution-configuration-versions.md
export async function savePersonalCommands(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalCommands(value);
  const { executePersonalSettings } = await import("./personal-settings.ts");
  const snapshot = await executePersonalSettings(target, { v: 1, op: "settings.read" }) as { profile: { directory: string; id: string }; revisions: { commands: string } };
  const result = await executePersonalSettings(target, { v: 2, id: randomUUID(), profile: snapshot.profile, expectedRevision: snapshot.revisions.commands, op: { kind: "config.save", target: "commands", value: config } }) as PersonalSettingsReceipt;
  if (!["active", "saved", "waiting"].includes(result.status)) throw new PersonalError(result.code, "命令设置未完成，请保留档案并查询原设置操作；不要自动重试。");
}
