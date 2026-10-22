import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadSkillLibrary, skillLibraryVersion, skillsDirFor, type PinnedSkill, type SkillId, type SkillLibrary, type SkillSource } from "./skills.ts";

export const MANAGED_SKILL_LIMITS = { files: 512, bytes: 8 * 1024 * 1024, directories: 128, depth: 32, packages: 256 } as const;
type PackageState = "enabled" | "disabled" | "removed";
interface ManagedPackage { id: SkillId; directory: string; contentRevision: string; state: PackageState }
interface ManagedState { version: 1; revision: string; packages: ManagedPackage[] }
export class ManagedSkillsError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = "ManagedSkillsError"; }
}
const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revisionPattern = /^sha256:[0-9a-f]{64}$/;
const packageName = (name: string) => Boolean(name && name !== "." && name !== ".." && !/[\\/\x00-\x1f\x7f]/.test(name));
const invalidLayout = () => new ManagedSkillsError("skills_layout_invalid", "托管技能布局或权限无法核实；请保留托管区并恢复私有普通文件与目录。");
function stateFor(packages: ManagedPackage[]): ManagedState {
  return { version: 1, revision: digest(JSON.stringify({ version: 1, packages })), packages };
}
export function managedSkillsDirFor(hostDir: string): string { return path.join(hostDir, "managed-skills"); }

function privateStat(filename: string, directory: boolean): fs.Stats {
  const stat = fs.lstatSync(filename);
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw invalidLayout();
  return stat;
}
function readFile(filename: string, before: fs.Stats, privateFile: boolean, maximum: number): Buffer {
  if (before.size > maximum) throw new ManagedSkillsError("skills_limit_exceeded", "技能文件或包超过导入限额；请缩小技能包后重新预览。");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || (privateFile && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600))) throw invalidLayout();
    if (stat.size > maximum) throw new ManagedSkillsError("skills_limit_exceeded", "技能文件或包超过导入限额；请缩小技能包后重新预览。");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd), located = fs.lstatSync(filename);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || located.dev !== stat.dev || located.ino !== stat.ino) throw new ManagedSkillsError("skills_source_changed", "技能内容在读取期间变化；请重新预览后提交。");
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function parseState(bytes: Buffer): ManagedState {
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("version" in raw)) throw invalidLayout();
  if (raw.version !== 1) throw new ManagedSkillsError("skills_state_version_unknown", "托管技能清单版本不受支持；请使用匹配版本的后台，保留原清单。");
  if (Object.keys(raw).some(key => !["version", "revision", "packages"].includes(key)) || !("revision" in raw) || typeof raw.revision !== "string" || !("packages" in raw) || !Array.isArray(raw.packages) || raw.packages.length > MANAGED_SKILL_LIMITS.packages) throw invalidLayout();
  const packages: ManagedPackage[] = [], ids = new Set<string>();
  for (const value of raw.packages) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "contentRevision,directory,id,state" || typeof value.id !== "string" || !uuid.test(value.id) || ids.has(value.id) || typeof value.directory !== "string" || !packageName(value.directory) || typeof value.contentRevision !== "string" || !revisionPattern.test(value.contentRevision) || !["enabled", "disabled", "removed"].includes(value.state)) throw invalidLayout();
    ids.add(value.id);
    packages.push({ id: value.id, directory: value.directory, contentRevision: value.contentRevision, state: value.state });
  }
  const state = stateFor(packages);
  if (state.revision !== raw.revision) throw invalidLayout();
  return state;
}

interface PackageContent { contentRevision: string; files: { relative: string; bytes: Buffer }[]; directories: string[]; bytes: number }
function packageContent(directory: string, privateContent: boolean, verifySource: () => void = () => undefined): PackageContent {
  const files: PackageContent["files"] = [], directories: string[] = [];
  let bytes = 0;
  const visit = (current: string, relative: string, depth: number) => {
    verifySource();
    const stat = privateContent ? privateStat(current, true) : fs.lstatSync(current);
    if (!stat.isDirectory() || depth > MANAGED_SKILL_LIMITS.depth) throw new ManagedSkillsError("skills_source_unsafe", "导入目录必须是无链接的普通技能包，目录深度须在限额内；请选择原始目录。");
    if (relative) directories.push(relative);
    if (directories.length > MANAGED_SKILL_LIMITS.directories) throw new ManagedSkillsError("skills_limit_exceeded", "技能包目录数量超过限额；请缩小后重新预览。");
    for (const name of fs.readdirSync(current).sort()) {
      if (!packageName(name)) throw new ManagedSkillsError("skills_source_unsafe", "技能包包含不安全路径名称；请修正源包后重新预览。");
      const filename = path.join(current, name), rel = relative ? `${relative}/${name}` : name, entry = fs.lstatSync(filename);
      if (entry.isDirectory()) { visit(filename, rel, depth + 1); continue; }
      if (!entry.isFile() || entry.nlink !== 1) throw new ManagedSkillsError("skills_source_unsafe", "导入拒绝符号链接、硬链接与特殊文件；请选择只含普通文件的原始技能目录。");
      if (privateContent) privateStat(filename, false);
      if (files.length >= MANAGED_SKILL_LIMITS.files) throw new ManagedSkillsError("skills_limit_exceeded", "技能包文件数量超过限额；请缩小后重新预览。");
      verifySource();
      const data = readFile(filename, entry, privateContent, MANAGED_SKILL_LIMITS.bytes - bytes);
      verifySource();
      bytes += data.length; files.push({ relative: rel, bytes: data });
    }
    verifySource();
    const after = fs.lstatSync(current);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new ManagedSkillsError("skills_source_changed", "技能目录在读取期间变化；请重新预览后提交。");
  };
  visit(directory, "", 0);
  return { contentRevision: digest(JSON.stringify({ directories, files: files.map(file => [file.relative, digest(file.bytes)]) })), files, directories, bytes };
}

/** 可在 Personal 持档案锁后复用；安全暂存与孤立包可重开，不提交或清理它们。 */
export function validateManagedSkillsLayout(hostDir: string): void { readManagedState(hostDir); }
function readManagedState(hostDir: string): ManagedState {
  const root = managedSkillsDirFor(hostDir);
  try {
    if (!fs.lstatSync(root, { throwIfNoEntry: false })) return stateFor([]);
    privateStat(root, true);
    const names = fs.readdirSync(root);
    if (names.some(name => !["state.json", "state.json.tmp", "packages", ".staging"].includes(name))) throw invalidLayout();
    for (const collection of ["packages", ".staging"]) {
      const container = path.join(root, collection);
      if (!names.includes(collection)) continue;
      privateStat(container, true);
      const ids = fs.readdirSync(container);
      if (ids.length > MANAGED_SKILL_LIMITS.packages) throw invalidLayout();
      for (const id of ids) {
        if (!uuid.test(id)) throw invalidLayout();
        const holder = path.join(container, id); privateStat(holder, true);
        const children = fs.readdirSync(holder);
        if (children.length > 1 || children.some(name => !packageName(name))) throw invalidLayout();
        if (children.length) packageContent(path.join(holder, children[0]), true);
      }
    }
    if (names.includes("state.json.tmp")) {
      const filename = path.join(root, "state.json.tmp");
      readFile(filename, privateStat(filename, false), true, 1024 * 1024);
    }
    if (!names.includes("state.json")) return stateFor([]);
    const filename = path.join(root, "state.json"), state = parseState(readFile(filename, privateStat(filename, false), true, 1024 * 1024));
    for (const item of state.packages) {
      const content = packageContent(path.join(root, "packages", item.id, item.directory), true);
      if (content.contentRevision !== item.contentRevision) throw invalidLayout();
    }
    return state;
  } catch (error) {
    if (error instanceof ManagedSkillsError) throw error;
    throw new ManagedSkillsError("skills_layout_invalid", "托管技能清单或包无法完整核实；请保留托管区并恢复原文件。", { cause: error });
  }
}
function sourceFor(hostDir: string, item: ManagedPackage): SkillSource {
  return { dir: path.join(managedSkillsDirFor(hostDir), "packages", item.id, item.directory), source: "managed", id: item.id, contentRevision: item.contentRevision };
}
export function loadHostSkillLibrary(hostDir: string, externalDirs: string[] = [skillsDirFor(hostDir)]): SkillLibrary {
  const state = readManagedState(hostDir);
  return loadSkillLibrary([...externalDirs.map(dir => ({ dir, source: "external" as const })), ...state.packages.filter(item => item.state === "enabled").map(item => sourceFor(hostDir, item))]);
}
/** 新任务仅过滤原参考的托管选择；原任务恢复、正文及引用读取保留钉版。 */
export function reselectManagedSkills(library: SkillLibrary | null, hostDir: string): SkillLibrary | null {
  if (!library) return null;
  const state = readManagedState(hostDir);
  const skills = library.skills.filter(skill => {
    if (skill.source !== "managed") return true;
    const selected = state.packages.find(item => item.id === skill.id);
    if (!selected || selected.contentRevision !== skill.contentRevision || skill.dir !== fs.realpathSync(sourceFor(hostDir, selected).dir)) throw invalidLayout();
    return selected.state === "enabled";
  });
  return { skills, diagnostics: [...library.diagnostics], version: skillLibraryVersion(skills) };
}
function summary(skill: PinnedSkill, state: PackageState = "enabled") {
  return { id: skill.id!, name: skill.name, description: skill.description.slice(0, 1024), explicitOnly: skill.disableModelInvocation, source: skill.source!, readOnly: skill.readOnly!, state, contentRevision: skill.contentRevision! };
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-managed-skills.md
export class ManagedSkillsStore {
  constructor(private readonly hostDir: string, private readonly externalDirs: string[] = [skillsDirFor(hostDir)]) {}
  private entries(state: ManagedState) {
    const external = loadSkillLibrary(this.externalDirs.map(dir => ({ dir, source: "external" as const })));
    const skills = external.skills.map(skill => ({ skill, item: undefined as ManagedPackage | undefined }));
    const diagnostics = [...external.diagnostics];
    for (const item of state.packages) {
      const library = loadSkillLibrary([sourceFor(this.hostDir, item)]);
      if (library.skills.length !== 1) throw invalidLayout();
      diagnostics.push(...library.diagnostics);
      skills.push({ skill: library.skills[0], item });
    }
    const enabled = loadHostSkillLibrary(this.hostDir, this.externalDirs);
    diagnostics.push(...enabled.diagnostics.filter(value => !diagnostics.includes(value)));
    return { skills, diagnostics };
  }
  list(input: { offset?: number; limit?: number } = {}) {
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ManagedSkillsError("invalid_params", "技能列表分页超出范围；请使用非负偏移与 1–100 条页大小。");
    const state = readManagedState(this.hostDir), entries = this.entries(state), visible = entries.skills.filter(entry => entry.item?.state !== "removed");
    const diagnostics = entries.diagnostics.slice(0, 100).map(value => value.slice(0, 1024));
    return { revision: state.revision, skills: visible.slice(offset, offset + limit).map(entry => summary(entry.skill, entry.item?.state)), offset, hasMore: offset + limit < visible.length, diagnostics, diagnosticsTruncated: entries.diagnostics.length > diagnostics.length || entries.diagnostics.some(value => value.length > 1024) };
  }
  get(id: SkillId) {
    const state = readManagedState(this.hostDir), entry = this.entries(state).skills.find(entry => entry.skill.id === id);
    if (!entry) throw new ManagedSkillsError("skill_not_found", "技能身份不存在；请刷新所属后台的技能列表。");
    return { revision: state.revision, ...summary(entry.skill, entry.item?.state), body: entry.skill.body };
  }
  private source(directory: string): { content: PackageContent; skill: PinnedSkill; diagnostics: string[] } {
    // 祖先的无关子项也会改变 ctime；丢弃不稳定读取，至多重读三次，发布仍核对预览哈希。
    for (let attempt = 0; ; attempt++) {
      try { return this.readSource(directory); }
      catch (error) {
        if (!(error instanceof ManagedSkillsError) || error.code !== "skills_source_changed" || attempt === 2) throw error;
      }
    }
  }
  private readSource(directory: string) {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || !packageName(path.basename(directory)) || /[\x00-\x1f\x7f]/.test(directory)) throw new ManagedSkillsError("skills_source_unsafe", "请选择有效的绝对技能目录后重新预览。");
    try {
      if (fs.realpathSync(directory) !== directory) throw new ManagedSkillsError("skills_source_unsafe", "导入目录路径包含符号链接；请选择原始普通目录。");
      const ancestors: { filename: string; stat: fs.Stats }[] = [];
      for (let filename = directory; ; filename = path.dirname(filename)) {
        const stat = fs.lstatSync(filename);
        if (!stat.isDirectory()) throw new ManagedSkillsError("skills_source_unsafe", "源目录父路径包含链接或特殊对象；请选择原始普通目录。");
        ancestors.push({ filename, stat });
        if (path.dirname(filename) === filename) break;
      }
      const verifySource = () => {
        for (const ancestor of ancestors) {
          const current = fs.lstatSync(ancestor.filename);
          if (!current.isDirectory() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino || current.ctimeMs !== ancestor.stat.ctimeMs) throw new ManagedSkillsError("skills_source_changed", "源目录或父路径在读取期间变化；未提交，请稳定目录后重新预览。");
        }
        if (fs.realpathSync(directory) !== directory) throw new ManagedSkillsError("skills_source_unsafe", "源目录路径在读取期间出现链接；未提交，请恢复原目录后重新预览。");
      };
      const content = packageContent(directory, false, verifySource);
      if (!content.files.some(file => file.relative === "SKILL.md")) throw new ManagedSkillsError("skills_package_invalid", "单个技能包根目录须包含 SKILL.md；请选择技能包后重新预览。");
      const library = loadSkillLibrary([{ dir: directory, source: "external" }]);
      verifySource();
      if (library.skills.length !== 1) throw new ManagedSkillsError("skills_package_invalid", "技能正文或描述未通过原解析规则；请修正源包后重新预览。");
      if (library.skills[0].contentRevision !== digest(content.files.find(file => file.relative === "SKILL.md")!.bytes)) throw new ManagedSkillsError("skills_source_changed", "正文与预览内容在读取期间变化；请重新预览。");
      return { content, skill: library.skills[0], diagnostics: library.diagnostics };
    } catch (error) {
      if (error instanceof ManagedSkillsError) throw error;
      throw new ManagedSkillsError("skills_source_unavailable", "技能源目录无法完整读取；源库未更改，请恢复目录后重新预览。", { cause: error });
    }
  }
  private conflicts(name: string, state: ManagedState, except?: SkillId) {
    return this.entries(state).skills.filter(entry => entry.skill.name === name && entry.skill.id !== except && (!entry.item || entry.item.state === "enabled")).map(entry => summary(entry.skill, entry.item?.state));
  }
  preview(sourceDir: string) {
    const state = readManagedState(this.hostDir), source = this.source(sourceDir);
    return { ...summary(source.skill), id: randomUUID(), source: "managed" as const, readOnly: false, sourceDir, contentRevision: source.content.contentRevision, revision: state.revision, files: source.content.files.length, bytes: source.content.bytes, diagnostics: source.diagnostics, conflicts: this.conflicts(source.skill.name, state) };
  }
  private checkRevision(state: ManagedState, expected: string) {
    if (state.revision !== expected) throw new ManagedSkillsError("skills_revision_conflict", "托管技能清单已变化；请刷新当前状态并比较后重新提交。");
  }
  private commit(state: ManagedState) {
    const root = managedSkillsDirFor(this.hostDir), temporary = path.join(root, "state.json.tmp");
    try {
      const before = fs.lstatSync(temporary, { throwIfNoEntry: false });
      if (before) privateStat(temporary, false);
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || before && (stat.dev !== before.dev || stat.ino !== before.ino)) throw invalidLayout();
        fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, JSON.stringify(state) + "\n"); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, path.join(root, "state.json"));
    } catch (error) {
      throw new ManagedSkillsError("skills_state_write_failed", "技能清单未提交；源库与原清单保留，请检查托管区后读回核实。", { cause: error });
    }
  }
  import(input: { id: SkillId; sourceDir: string; contentRevision: string; expectedRevision: string }) {
    const state = readManagedState(this.hostDir); this.checkRevision(state, input.expectedRevision);
    if (!uuid.test(input.id) || !revisionPattern.test(input.contentRevision)) throw new ManagedSkillsError("invalid_params", "导入身份或内容修订无效；请重新预览技能包。");
    if (state.packages.length >= MANAGED_SKILL_LIMITS.packages) throw new ManagedSkillsError("skills_limit_exceeded", "托管技能包数量已达限额；请保留旧引用并检查托管区。");
    const root = managedSkillsDirFor(this.hostDir), staging = path.join(root, ".staging", input.id), published = path.join(root, "packages", input.id);
    if (state.packages.some(item => item.id === input.id) || fs.existsSync(staging) || fs.existsSync(published)) throw new ManagedSkillsError("skills_package_exists", "本次导入身份已有内容；请先按原身份读回核实，未提交时重新预览。");
    for (const collection of ["packages", ".staging"]) {
      const container = path.join(root, collection);
      if (fs.existsSync(container) && fs.readdirSync(container).length >= MANAGED_SKILL_LIMITS.packages) throw new ManagedSkillsError("skills_limit_exceeded", "安全暂存或已发布包数量已达限额；未新建内容，请保留托管区并检查容量。");
    }
    const source = this.source(input.sourceDir);
    if (source.content.contentRevision !== input.contentRevision) throw new ManagedSkillsError("skills_source_changed", "源技能与预览内容不同；未导入，请重新预览。");
    if (this.conflicts(source.skill.name, state).length) throw new ManagedSkillsError("skills_name_conflict", "技能名称与当前可用来源冲突；请修改源包名称或选择其他技能后重新预览。");
    const item: ManagedPackage = { id: input.id, directory: path.basename(input.sourceDir), contentRevision: input.contentRevision, state: "enabled" };
    try {
      fs.mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw new ManagedSkillsError("skills_copy_failed", "托管根未能创建；源库未更改，请检查磁盘后重新预览。", { cause: error });
    }
    try {
      for (const collection of ["packages", ".staging"]) {
        const filename = path.join(root, collection);
        if (!fs.existsSync(filename)) fs.mkdirSync(filename, { mode: 0o700 });
        privateStat(filename, true);
      }
      fs.mkdirSync(staging, { mode: 0o700 });
      const target = path.join(staging, item.directory); fs.mkdirSync(target, { mode: 0o700 });
      for (const relative of source.content.directories) fs.mkdirSync(path.join(target, relative), { mode: 0o700 });
      for (const file of source.content.files) fs.writeFileSync(path.join(target, file.relative), file.bytes, { mode: 0o600, flag: "wx" });
      const copied = packageContent(target, true), parsed = loadSkillLibrary([{ dir: target, source: "managed", id: item.id, contentRevision: item.contentRevision }]);
      if (copied.contentRevision !== input.contentRevision || parsed.skills.length !== 1 || parsed.skills[0].name !== source.skill.name || this.source(input.sourceDir).content.contentRevision !== input.contentRevision) throw new ManagedSkillsError("skills_source_changed", "复制内容或源目录已变化；暂存未发布，请重新预览。");
      this.checkRevision(readManagedState(this.hostDir), input.expectedRevision);
      if (this.conflicts(source.skill.name, state).length) throw new ManagedSkillsError("skills_name_conflict", "技能名称在发布前产生冲突；暂存未提交，请刷新后重新预览。");
      fs.renameSync(staging, published);
    } catch (error) {
      if (error instanceof ManagedSkillsError) throw error;
      throw new ManagedSkillsError("skills_copy_failed", "技能复制或发布失败；源库与原清单保留，暂存不作为已安装技能，请检查后重新预览。", { cause: error });
    }
    this.checkRevision(readManagedState(this.hostDir), input.expectedRevision);
    const next = stateFor([...state.packages, item]); this.commit(next);
    return { revision: next.revision, ...summary({ ...source.skill, id: item.id, source: "managed", readOnly: false, contentRevision: item.contentRevision }), body: source.skill.body };
  }
  private change(id: SkillId, expectedRevision: string, status: PackageState) {
    const state = readManagedState(this.hostDir); this.checkRevision(state, expectedRevision);
    const item = state.packages.find(item => item.id === id);
    if (!item) throw new ManagedSkillsError("skills_read_only", "只能管理选定的托管技能；外部来源由原技能库维护。");
    if (item.state === "removed" && status !== "removed") throw new ManagedSkillsError("skill_removed", "技能已逻辑移除；原字节保留供历史引用，如需新安装请重新导入。");
    const skill = loadSkillLibrary([sourceFor(this.hostDir, item)]).skills[0];
    if (!skill) throw invalidLayout();
    if (status === "enabled" && item.state !== status) {
      if (this.conflicts(skill.name, state, id).length) throw new ManagedSkillsError("skills_name_conflict", "重新启用与当前可用技能重名；请先处理来源冲突后再启用。");
    }
    const next = stateFor(state.packages.map(value => value.id === id ? { ...value, state: status } : value));
    if (item.state !== status) this.commit(next);
    return { revision: next.revision, ...summary(skill, status), body: skill.body };
  }
  setEnabled(input: { id: SkillId; enabled: boolean; expectedRevision: string }) {
    if (typeof input.enabled !== "boolean") throw new ManagedSkillsError("invalid_params", "技能启用状态须为布尔值。");
    return this.change(input.id, input.expectedRevision, input.enabled ? "enabled" : "disabled");
  }
  remove(input: { id: SkillId; expectedRevision: string }) { return this.change(input.id, input.expectedRevision, "removed"); }
}
