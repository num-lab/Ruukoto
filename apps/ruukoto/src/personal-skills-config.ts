import * as fs from "node:fs";
import * as path from "node:path";
import type { PersonalProfileLock } from "./personal-profile.ts";
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
  const config = parsePersonalSkills(value);
  personalSkillsDirectory(config);
  const { readPersonalSettings, savePersonalSettings } = await import("./personal-settings.ts");
  const snapshot = await readPersonalSettings(target);
  await savePersonalSettings(target, snapshot, snapshot.revisions.skills, { kind: "config.save", target: "skills", value: config });
}
