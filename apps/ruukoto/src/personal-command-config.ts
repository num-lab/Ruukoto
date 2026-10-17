import * as fs from "node:fs";
import * as path from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_FORMAT, lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";

export type PersonalCommandConfig = { version: 1; workspace: string; identity: { dev: number; ino: number }; machineId: string; tmpdir: string };
const context = BACKGROUND_CONTEXT;
const validPath = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

export function parsePersonalCommands(value: unknown): PersonalCommandConfig {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["version", "workspace", "identity", "machineId", "tmpdir"].includes(key)) || !("version" in value) || value.version !== 1 || !("workspace" in value) || !validPath(value.workspace) || !("tmpdir" in value) || !validPath(value.tmpdir) || !("machineId" in value) || typeof value.machineId !== "string" || !/^[0-9a-f]{32}$/.test(value.machineId) || !("identity" in value) || !value.identity || typeof value.identity !== "object" || Array.isArray(value.identity) || Object.keys(value.identity).some(key => !["dev", "ino"].includes(key)) || !("dev" in value.identity) || !Number.isSafeInteger(value.identity.dev) || Number(value.identity.dev) < 0 || !("ino" in value.identity) || !Number.isSafeInteger(value.identity.ino) || Number(value.identity.ino) <= 0) throw new PersonalError("command_config_invalid", "命令配置无效，请保留档案并恢复原配置；不要手工改写目录或执行身份。");
  return { version: 1, workspace: value.workspace, identity: { dev: Number(value.identity.dev), ino: Number(value.identity.ino) }, machineId: value.machineId, tmpdir: value.tmpdir };
}

function protectedRoots(profileDirectory: string) {
  return [fs.realpathSync(profileDirectory), fs.realpathSync(fileURLToPath(new URL("../../../", import.meta.url))), ...[".ruukoto", ".ruukoto-code", ".ruukoto-dev", ".ruukoto-code-dev", ".ruukoto-durable", ".ruukoto-durable-dev", ".ssh", ".aws", ".config", ".pi"].map(name => path.join(homedir(), name))];
}

export function verifyPersonalCommandConfig(config: PersonalCommandConfig, profileDirectory: string): void {
  if (process.platform !== "linux") throw new PersonalError("command_platform_unsupported", "受限命令需要 Linux；请在原 Linux 实例配置和恢复。");
  try {
    const saved = parsePersonalCommands(config);
    const workspace = fs.lstatSync(saved.workspace);
    if (!workspace.isDirectory() || workspace.isSymbolicLink() || fs.realpathSync(saved.workspace) !== saved.workspace || workspace.dev !== saved.identity.dev || workspace.ino !== saved.identity.ino || fs.readFileSync("/etc/machine-id", "utf8").trim() !== saved.machineId || fs.realpathSync(tmpdir()) !== saved.tmpdir) throw new PersonalError("command_config_changed", "命令的原目录、机器或临时目录无法核实，已停止；请恢复原环境并保留档案。");
    assertGrantNotProtected(saved.workspace, protectedRoots(profileDirectory));
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
  return { directory, native: { workerPath: fileURLToPath(new URL("../../../worker/personal-command-worker.mjs", import.meta.url)), dependencyRoots: [], protectedRoots: protectedRoots(profileDirectory) } };
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
  const config = parsePersonalCommands(value);
  verifyPersonalCommandConfig(config, profile.directory);
  return config;
}

async function checkEnablement(profile: PersonalProfileLock) {
  const filename = path.join(profile.directory, "personal.sqlite");
  if (!fs.existsSync(filename)) return;
  const storage = await openNodeSqliteStorage(filename);
  try {
    const format = await storage.findDocument({ kind: "ruukoto.format", scope: { kind: "session" } }, "current", context);
    const saved = format && await storage.document(format.id, "current", context);
    if (!saved || saved.version !== 1 || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)) throw new PersonalError("extension_version", "个人业务格式无法核实，未保存命令配置；请保留档案并使用对应程序。");
    const pages = await Promise.all([...(["pending", "running", "waiting", "completing"] as const).map(status => storage.scanTasks({ status }, 1, undefined, context)), ...(["queued", "placed"] as const).map(status => storage.scanSubmissions({ status }, 1, undefined, context))]);
    if (pages.some(page => page.items.length)) throw new PersonalError("command_config_pending", "档案仍有未完成输入或工作，未保存命令配置；请先用原配置完成处理，再启用命令。");
  } finally { await storage.close(context); }
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-command-configuration.md
export async function savePersonalCommands(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalCommands(value);
  const profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  try {
    verifyPersonalCommandConfig(config, profile.directory);
    const current = readPersonalCommands(profile);
    if (current) {
      if (!isDeepStrictEqual(current, config)) throw new PersonalError("command_config_changed", "命令配置已固定，未覆盖；请保留原目录和配置，其他目录使用新的隔离档案。");
      return;
    }
    try { await checkEnablement(profile); } catch (error) {
      if (error instanceof PersonalError) throw error;
      throw new PersonalError("command_config_check_failed", "无法核实档案是否可启用命令，未保存；请保留档案并检查存储。", { cause: error });
    }
    try { replaceConfig(profile.directory, config); } catch (error) {
      throw new PersonalError("command_config_write_failed", "命令配置未能保存，请保留档案并检查磁盘后重新查看配置。", { cause: error });
    }
  } finally { if (typeof target === "string") profile.release(); }
}

function replaceConfig(directory: string, config: PersonalCommandConfig) {
  fs.writeFileSync(path.join(directory, "command.json.tmp"), JSON.stringify(config) + "\n", { mode: 0o600 });
  fs.renameSync(path.join(directory, "command.json.tmp"), path.join(directory, "command.json"));
}
