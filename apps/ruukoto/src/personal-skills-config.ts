import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SCHEDULE_SUPERVISOR_TASK, PersonalSchedulesDoc, PersonalScheduleRunDoc } from "./personal-scheduler-records.ts";
import { lockPersonalProfile, PERSONAL_FORMAT, type PersonalProfileLock } from "./personal-profile.ts";
import { PersonalError } from "./personal-error.ts";

export type PersonalSkillsConfig = { version: 1; directory: string };
const invalid = () => new PersonalError("skills_config_invalid", "技能配置无法核实，请保留档案并运行技能配置向导。");

export function parsePersonalSkills(value: unknown): PersonalSkillsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["version", "directory"].includes(key)) || !("version" in value) || value.version !== 1 || !("directory" in value) || typeof value.directory !== "string" || !path.isAbsolute(value.directory) || path.resolve(value.directory) !== value.directory || /[\x00-\x1f\x7f]/.test(value.directory)) throw invalid();
  return { version: 1, directory: value.directory };
}

export function personalSkillsDirectory(config: PersonalSkillsConfig) {
  try {
    const root = fs.realpathSync(config.directory), skills = path.join(root, "skills"), stat = fs.statSync(skills);
    if (root !== config.directory || !stat.isDirectory()) throw invalid();
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) { throw new PersonalError("skills_directory_unavailable", "技能目录无法读取，请由拥有者恢复配置目录及其中的 skills 子目录后继续。", { cause: error }); }
}

export function readPersonalSkills(target: string | PersonalProfileLock): PersonalSkillsConfig | undefined {
  const filename = path.join(typeof target === "string" ? target : target.directory, "skills.json");
  try {
    const before = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!before) return;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) || before.size > 8192) throw invalid();
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 8192) throw invalid();
      const bytes = fs.readFileSync(fd);
      if (bytes.length > 8192) throw invalid();
      return parsePersonalSkills(JSON.parse(bytes.toString("utf8")));
    } finally { fs.closeSync(fd); }
  } catch (error) { throw new PersonalError("skills_config_invalid", "技能配置不是完整的私有普通文件，请保留档案并恢复原配置。", { cause: error }); }
}

export async function savePersonalSkills(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalSkills(value), profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  try {
    personalSkillsDirectory(config);
    if (isDeepStrictEqual(readPersonalSkills(profile), config)) return;
    const filename = path.join(profile.directory, "personal.sqlite"), context = BACKGROUND_CONTEXT;
    if (fs.existsSync(filename)) {
      const storage = await openNodeSqliteStorage(filename);
      try {
        const record = await storage.findDocument({ kind: "ruukoto.format", scope: { kind: "session" } }, "current", context), saved = record && await storage.document(record.id, "current", context);
        if (!saved || saved.version !== 1 || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)) throw invalid();
        const pending = () => new PersonalError("skills_config_pending", "仍有未完成输入或工作，未更改技能配置；请先用原配置完成原工作。");
        const scheduleRecord = await storage.findDocument({ kind: PersonalSchedulesDoc.definition.kind, scope: { kind: "session" } }, "current", context), schedules = scheduleRecord && await storage.document(scheduleRecord.id, "current", context);
        if (schedules) {
          if (schedules.version !== 1 || !Array.isArray(schedules.value.runs)) throw invalid();
          for (const runId of schedules.value.runs) {
            if (typeof runId !== "string") throw invalid();
            const record = await storage.findDocument({ kind: PersonalScheduleRunDoc.definition.kind, scope: { kind: "session" }, key: runId }, "current", context), saved = record && await storage.document(record.id, "current", context), run = saved?.value.run;
            if (!saved || saved.version !== 1 || !run || typeof run !== "object" || Array.isArray(run) || !run.result) throw pending();
          }
        }
        for (const status of ["pending", "running", "waiting", "completing"] as const) {
          let cursor;
          do {
            const page = await storage.scanTasks({ status }, 256, cursor, context);
            for (const task of page.items) if (task.kind !== SCHEDULE_SUPERVISOR_TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || task.owner !== undefined || !task.background || !isDeepStrictEqual(task.input, {}) || schedules?.value.supervisor !== task.id) throw pending();
            cursor = page.next;
          } while (cursor);
        }
        const submissions = await Promise.all((["queued", "placed"] as const).map(status => storage.scanSubmissions({ status }, 1, undefined, context)));
        if (submissions.some(page => page.items.length)) throw pending();
      } finally { await storage.close(context); }
    }
    const temporary = path.join(profile.directory, "skills.json.tmp");
    try {
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(config) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, path.join(profile.directory, "skills.json"));
    } catch (error) { throw new PersonalError("skills_config_write_failed", "技能配置未能保存，请检查磁盘与临时配置文件；原配置仍保留。", { cause: error }); }
  } finally { if (typeof target === "string") profile.release(); }
}
