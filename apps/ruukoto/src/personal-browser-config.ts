import { hasPendingPersonalWork } from "./personal-config-idle.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PERSONAL_FORMAT, lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";
import { PersonalError } from "./personal-error.ts";

export type PersonalBrowserConfig = { version: 1; generation: string; binaryPath: string; chromePath: string; headed: boolean };
const invalid = () => new PersonalError("browser_config_invalid", "浏览器配置无法核实，请保留档案并运行浏览器配置向导。");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function parsePersonalBrowser(value: unknown): PersonalBrowserConfig {
  if (!object(value) || Object.keys(value).some(key => !["version", "generation", "binaryPath", "chromePath", "headed"].includes(key)) || value.version !== 1 || typeof value.generation !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value.generation) || typeof value.headed !== "boolean") throw invalid();
  for (const key of ["binaryPath", "chromePath"]) if (typeof value[key] !== "string" || !path.isAbsolute(value[key]) || path.resolve(value[key]) !== value[key] || /[\x00-\x1f\x7f]/.test(value[key])) throw invalid();
  return { version: 1, generation: value.generation, binaryPath: String(value.binaryPath), chromePath: String(value.chromePath), headed: value.headed };
}
export function readPersonalBrowser(profile: PersonalProfileLock): PersonalBrowserConfig | undefined {
  const filename = path.join(profile.directory, "browser.json");
  if (!fs.lstatSync(filename, { throwIfNoEntry: false })) return;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw invalid();
    return parsePersonalBrowser(JSON.parse(fs.readFileSync(filename, "utf8")));
  } catch (error) { if (error instanceof PersonalError) throw error; throw invalid(); }
}
export async function savePersonalBrowser(target: string | PersonalProfileLock, value: unknown) {
  const config = parsePersonalBrowser(value), profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  try {
    const current = readPersonalBrowser(profile);
    if (isDeepStrictEqual(current, config)) return;
    if (current?.generation === config.generation) throw invalid();
    const filename = path.join(profile.directory, "personal.sqlite");
    if (fs.existsSync(filename)) {
      const storage = await openNodeSqliteStorage(filename), context = BACKGROUND_CONTEXT;
      try {
        const format = await storage.findDocument({ kind: "ruukoto.format", scope: { kind: "session" } }, "current", context), saved = format && await storage.document(format.id, "current", context);
        if (!saved || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)) throw invalid();
        if (await hasPendingPersonalWork(storage)) throw new PersonalError("browser_config_pending", "仍有未完成输入或工作，未更改浏览器配置；请先完成原工作。");
        const record = await storage.findDocument({ kind: "ruukoto.browser", scope: { kind: "session" } }, "current", context), browser = record && await storage.document(record.id, "current", context);
        if (browser?.value.stateJson !== undefined) {
          let state: unknown;
          try { state = JSON.parse(String(browser.value.stateJson)); } catch { throw invalid(); }
          if (!object(state) || !Array.isArray(state.bindings) || state.bindings.some(binding => !object(binding) || binding.state !== "closed")) throw new PersonalError("browser_config_pending", "原浏览器尚未核实关闭，未更改配置；请先在浏览器管理中停止原浏览器。");
        }
        let cursor;
        do {
          const page = await storage.scanDocuments({ kind: "ruukoto.browser-operation", scope: { kind: "session" }, at: "current" }, 256, cursor, context);
          for (const record of page.items) {
            const saved = await storage.document(record.id, "current", context), operation = saved?.value.operation;
            if (!saved || saved.version !== 1 || operation !== undefined && !object(operation)) throw invalid();
            if (operation?.started && (!operation.stopped || operation.effect === "effect_unknown" && !operation.resolution)) throw new PersonalError("browser_config_pending", "原网页效果或浏览器停止未核实，未保存新配置；请从原菜单核实。");
          }
          cursor = page.next;
        } while (cursor);
      } finally { await storage.close(context); }
    }
    const temporary = path.join(profile.directory, "browser.json.tmp"), destination = path.join(profile.directory, "browser.json");
    try {
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(config) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, destination);
    } catch (error) { throw new PersonalError("browser_config_write_failed", "浏览器配置未能保存，请检查磁盘及临时配置文件后重新运行向导；已提交配置保留。", { cause: error }); }
  } finally { if (typeof target === "string") profile.release(); }
}
