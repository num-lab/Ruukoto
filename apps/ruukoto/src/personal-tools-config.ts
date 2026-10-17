import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assertGrantNotProtected, restrictedResolve } from "@ruukoto/agent/execution/approved-ops.ts";
import { personalProtectedRoots } from "./personal-command-config.ts";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_FORMAT, lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";
import type { PersonalToolCredential } from "./personal-tool-io.ts";

export type PersonalToolsConfig = { version: 1; generation: string; workspace: string; identity: { dev: number; ino: number }; credentials: PersonalToolCredential[]; search?: { apiKeyEnv: string } };
const invalid = () => new PersonalError("tools_config_invalid", "资料与网络配置无法核实，请保留档案并运行配置向导。");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validHost = (value: unknown): value is string => {
  try { return typeof value === "string" && !!value && new URL(`https://${value}`).host === value; } catch { return false; }
};
const envName = (value: unknown): value is string => typeof value === "string" && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value) && !value.startsWith("RUUKOTO_");
export function parsePersonalTools(value: unknown): PersonalToolsConfig {
  if (!object(value) || Object.keys(value).some(key => !["version", "generation", "workspace", "identity", "credentials", "search"].includes(key)) || value.version !== 1 || typeof value.generation !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value.generation) || typeof value.workspace !== "string" || !path.isAbsolute(value.workspace) || path.resolve(value.workspace) !== value.workspace || /[\x00-\x1f\x7f]/.test(value.workspace) || !object(value.identity) || !Number.isSafeInteger(value.identity.dev) || !Number.isSafeInteger(value.identity.ino) || Number(value.identity.dev) < 0 || Number(value.identity.ino) < 1 || !Array.isArray(value.credentials) || value.credentials.length > 32) throw invalid();
  const names = new Set<string>();
  const credentials = value.credentials.map((raw): PersonalToolCredential => {
    if (!object(raw) || Object.keys(raw).some(key => !["name", "host", "header", "env"].includes(key)) || typeof raw.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.name) || names.has(raw.name) || !validHost(raw.host) || !["authorization", "x-api-key"].includes(String(raw.header)) || !envName(raw.env)) throw invalid();
    names.add(raw.name); return { name: raw.name, host: raw.host, header: String(raw.header), env: raw.env };
  });
  if (value.search !== undefined && (!object(value.search) || Object.keys(value.search).some(key => key !== "apiKeyEnv") || !envName(value.search.apiKeyEnv))) throw invalid();
  return { version: 1, generation: value.generation, workspace: value.workspace, identity: { dev: Number(value.identity.dev), ino: Number(value.identity.ino) }, credentials, ...(object(value.search) ? { search: { apiKeyEnv: String(value.search.apiKeyEnv) } } : {}) };
}
export function personalReadPath(profile: string, target: string) {
  try {
    const resolved = restrictedResolve(target), stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() && !stat.isFile()) throw invalid();
    if (personalSystemPath(resolved)) throw invalid();
    assertGrantNotProtected(resolved, personalProtectedRoots(profile));
    return { path: resolved, dev: stat.dev, ino: stat.ino };
  } catch (error) { if (error instanceof PersonalError) throw error; throw invalid(); }
}
export function verifyPersonalTools(config: PersonalToolsConfig, profile: string) {
  const current = personalReadPath(profile, config.workspace);
  if (!fs.statSync(current.path).isDirectory() || current.dev !== config.identity.dev || current.ino !== config.identity.ino) throw new PersonalError("tools_directory_changed", "原资料目录身份已变化，已停止操作；请恢复原目录与配置。");
}
export function readPersonalTools(profile: PersonalProfileLock): PersonalToolsConfig | undefined {
  const filename = path.join(profile.directory, "tools.json");
  if (!fs.lstatSync(filename, { throwIfNoEntry: false })) return;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw invalid();
    return parsePersonalTools(JSON.parse(fs.readFileSync(filename, "utf8")));
  } catch (error) { if (error instanceof PersonalError) throw error; throw invalid(); }
}
export async function savePersonalTools(target: string | PersonalProfileLock, value: unknown) {
  const config = parsePersonalTools(value), profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  try {
    verifyPersonalTools(config, profile.directory);
    const current = readPersonalTools(profile);
    if (isDeepStrictEqual(current, config)) return;
    if (current?.generation === config.generation) throw invalid();
    const filename = path.join(profile.directory, "personal.sqlite");
    if (fs.existsSync(filename)) {
      const storage = await openNodeSqliteStorage(filename), context = BACKGROUND_CONTEXT;
      try {
        const format = await storage.findDocument({ kind: "ruukoto.format", scope: { kind: "session" } }, "current", context), saved = format && await storage.document(format.id, "current", context);
        if (!saved || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)) throw invalid();
        const pages = await Promise.all([...(["pending", "running", "waiting", "completing"] as const).map(status => storage.scanTasks({ status }, 1, undefined, context)), ...(["queued", "placed"] as const).map(status => storage.scanSubmissions({ status }, 1, undefined, context))]);
        if (pages.some(page => page.items.length)) throw new PersonalError("tools_config_pending", "仍有未完成输入或工作，未更改资料与网络配置；请先完成原工作，授权可在运行中撤销。");
        let cursor;
        do {
          const page = await storage.scanDocuments({ kind: "ruukoto.tool-operation", scope: { kind: "session" }, at: "current" }, 256, cursor, context);
          for (const record of page.items) {
            const saved = await storage.document(record.id, "current", context), operation = saved?.value.operation;
            if (!saved || saved.version !== 1 || operation !== undefined && !object(operation)) throw invalid();
            if (operation?.started && (!operation.stopped || operation.effect === "effect_unknown" && !operation.resolution)) throw new PersonalError("tools_config_pending", "原工具效果或外部结束未核实，未保存新配置；请先从原菜单核实。");
          }
          cursor = page.next;
        } while (cursor);

      } finally { await storage.close(context); }
    }
    const temporary = path.join(profile.directory, "tools.json.tmp");
    try {
      const existing = fs.lstatSync(temporary, { throwIfNoEntry: false });
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== process.getuid?.() || (existing.mode & 0o077))) throw invalid();
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || existing && (stat.dev !== existing.dev || stat.ino !== existing.ino)) throw invalid();
        fs.ftruncateSync(fd); fs.writeFileSync(fd, JSON.stringify(config) + "\n"); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, path.join(profile.directory, "tools.json"));
    } catch (error) { throw new PersonalError("tools_config_write_failed", "资料与网络配置未能保存；请检查磁盘后重新运行配置向导，原已提交配置保留。", { cause: error }); }

  } finally { if (typeof target === "string") profile.release(); }
}

export function personalSystemPath(target: string): boolean {
  const resolved = path.resolve(target);
  for (const root of ["/proc", "/sys", "/dev"]) {
    if (resolved === root || resolved.startsWith(root + path.sep) || root.startsWith(resolved.endsWith(path.sep) ? resolved : resolved + path.sep)) return true;
    const system = fs.statSync(root, { throwIfNoEntry: false }), stat = fs.statSync(fs.existsSync(resolved) ? resolved : path.dirname(resolved), { throwIfNoEntry: false });
    if (system && stat && system.dev === stat.dev) return true;
  }
  return false;
}
