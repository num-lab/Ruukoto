import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { ManagedSkillsError, ManagedSkillsStore, MANAGED_SKILL_LIMITS, loadHostSkillLibrary, managedSkillsDirFor, reselectManagedSkills, validateManagedSkillsLayout } from "@ruukoto/agent/managed-skills.ts";
import { expandSkillCommand, loadSkillLibrary, readSkill, skillCatalogBlock, skillsDirFor } from "@ruukoto/agent/skills.ts";

const code = (expected: string) => (error: unknown) => error instanceof ManagedSkillsError && error.code === expected;
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-managed-skills-"))), host = path.join(root, "host"), source = path.join(root, "alpha");
  fs.mkdirSync(host); writeSkill(source);
  fs.mkdirSync(path.join(source, "refs")); fs.writeFileSync(path.join(source, "refs", "guide.md"), "原始引用资料");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ManagedSkillsStore(host);
  return { root, host, source, store, managed: managedSkillsDirFor(host) };
}
function writeSkill(directory: string, name?: string, explicit = false) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), `---\n${name ? `name: ${name}\n` : ""}description: 技能任务指引\n${explicit ? "disable-model-invocation: true\n" : ""}---\n任务正文，见 refs/guide.md\n`);
}
function install(store: ManagedSkillsStore, sourceDir: string) {
  const preview = store.preview(sourceDir);
  return store.import({ id: preview.id, sourceDir, contentRevision: preview.contentRevision, expectedRevision: preview.revision });
}

test("托管导入：保留包名、引用、源字节与权限；宿主元数据不改变原模型版本", t => {
  const f = fixture(t), bytes = fs.readFileSync(path.join(f.source, "SKILL.md")), before = loadSkillLibrary([{ dir: f.source, source: "external" }]);
  const imported = install(f.store, f.source), library = loadHostSkillLibrary(f.host), skill = library.skills[0];
  assert.equal(imported.name, "alpha"); assert.equal(imported.source, "managed"); assert.equal(imported.readOnly, false);
  assert.equal(library.version, before.version); assert.equal(skill.version, before.skills[0].version);
  assert.equal(skill.dir, path.join(f.managed, "packages", imported.id, "alpha"));
  assert.deepEqual(fs.readFileSync(path.join(f.source, "SKILL.md")), bytes);
  assert.match(readSkill(library, "alpha", "refs/guide.md"), /原始引用资料/);
  assert.doesNotMatch(skillCatalogBlock(library)!.text, /managed|external|sha256|\/tmp|只读/);
  for (const directory of [f.managed, path.join(f.managed, "packages"), path.dirname(skill.dir), skill.dir, path.join(skill.dir, "refs")]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (const filename of [path.join(f.managed, "state.json"), path.join(skill.dir, "SKILL.md"), path.join(skill.dir, "refs", "guide.md")]) { const stat = fs.statSync(filename); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1); }
  assert.notEqual(fs.statSync(path.join(f.source, "SKILL.md")).ino, fs.statSync(path.join(skill.dir, "SKILL.md")).ino);
});

test("外部维护：原嵌套与 symlink 排序赢家保留，只读详情以身份定位", t => {
  const f = fixture(t), external = skillsDirFor(f.host);
  writeSkill(f.source, "alpha");
  fs.mkdirSync(external); fs.symlinkSync(f.source, path.join(external, "a-linked")); writeSkill(path.join(external, "z-loser"), "alpha");
  const library = loadHostSkillLibrary(f.host), listing = f.store.list(), alpha = listing.skills[0];
  assert.equal(library.skills[0].dir, f.source); assert.equal(alpha.source, "external"); assert.equal(alpha.readOnly, true);
  assert.match(listing.diagnostics.join("\n"), /冲突/); assert.match(f.store.get(alpha.id).body, /任务正文/);
  assert.throws(() => f.store.remove({ id: alpha.id, expectedRevision: listing.revision }), code("skills_read_only"));
  const preview = f.store.preview(f.source); assert.equal(preview.conflicts[0].id, alpha.id);
  assert.throws(() => f.store.import({ id: preview.id, sourceDir: f.source, contentRevision: preview.contentRevision, expectedRevision: preview.revision }), code("skills_name_conflict"));
  assert.equal(fs.lstatSync(path.join(external, "a-linked")).isSymbolicLink(), true);
});

test("复制安全：源目录链接、引用链接、硬链接与 FIFO 全部拒绝且源不变", t => {
  const f = fixture(t), original = fs.readFileSync(path.join(f.source, "SKILL.md"));
  const linked = path.join(f.root, "linked"); fs.symlinkSync(f.source, linked);
  assert.throws(() => f.store.preview(linked), code("skills_source_unsafe"));
  const extra = path.join(f.source, "extra"); fs.symlinkSync(path.join(f.source, "SKILL.md"), extra);
  assert.throws(() => f.store.preview(f.source), code("skills_source_unsafe")); fs.unlinkSync(extra);
  fs.linkSync(path.join(f.source, "SKILL.md"), extra);
  assert.throws(() => f.store.preview(f.source), code("skills_source_unsafe")); fs.unlinkSync(extra);
  execFileSync("mkfifo", [extra]); assert.throws(() => f.store.preview(f.source), code("skills_source_unsafe"));
  assert.deepEqual(fs.readFileSync(path.join(f.source, "SKILL.md")), original); assert.equal(fs.existsSync(f.managed), false);
  assert.throws(() => f.store.preview(path.join(f.source, "..", "alpha")), code("skills_source_unsafe"));
});

test("复制安全：设备文件拒绝，不尝试读设备字节", t => {
  const f = fixture(t), target = path.join(f.source, "device"), original = fs.lstatSync;
  fs.writeFileSync(target, "fixture");
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
    const stat = Reflect.apply(original, fs, args);
    if (String(args[0]) === target && stat) { stat.isFile = () => false; stat.isDirectory = () => false; stat.isCharacterDevice = () => true; }
    return stat;
  }); syncBuiltinESMExports();
  try { assert.throws(() => f.store.preview(f.source), code("skills_source_unsafe")); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("导入限额与原解析规则：文件数、总量、深度、SKILL 大小与根正文", t => {
  const f = fixture(t);
  const many = path.join(f.root, "many"); writeSkill(many);
  for (let index = 0; index < MANAGED_SKILL_LIMITS.files; index++) fs.writeFileSync(path.join(many, `file-${index}`), "");
  assert.throws(() => f.store.preview(many), code("skills_limit_exceeded"));
  const directories = path.join(f.root, "many-directories"); writeSkill(directories);
  for (let index = 0; index <= MANAGED_SKILL_LIMITS.directories; index++) fs.mkdirSync(path.join(directories, `d-${index}`));
  assert.throws(() => f.store.preview(directories), code("skills_limit_exceeded"));
  fs.writeFileSync(path.join(f.source, "large"), Buffer.alloc(MANAGED_SKILL_LIMITS.bytes));
  assert.throws(() => f.store.preview(f.source), code("skills_limit_exceeded")); fs.unlinkSync(path.join(f.source, "large"));
  const deep = path.join(f.source, ...Array.from({ length: MANAGED_SKILL_LIMITS.depth + 1 }, () => "d")); fs.mkdirSync(deep, { recursive: true });
  assert.throws(() => f.store.preview(f.source), code("skills_source_unsafe"));
  const invalid = path.join(f.root, "invalid"); writeSkill(invalid); fs.writeFileSync(path.join(invalid, "SKILL.md"), "---\nname: [unclosed\n---\nx");
  assert.throws(() => f.store.preview(invalid), code("skills_package_invalid"));
  fs.writeFileSync(path.join(invalid, "SKILL.md"), `---\ndescription: test\n---\n${"x".repeat(65 * 1024)}`);
  assert.throws(() => f.store.preview(invalid), code("skills_package_invalid"));
  fs.renameSync(path.join(invalid, "SKILL.md"), path.join(invalid, "other.md"));
  assert.throws(() => f.store.preview(invalid), code("skills_package_invalid"));
});

test("预览与条件提交：引用变化及并发旧清单修订不改变原库", t => {
  const f = fixture(t), preview = f.store.preview(f.source);
  fs.writeFileSync(path.join(f.source, "refs", "guide.md"), "修改后引用");
  assert.throws(() => f.store.import({ id: preview.id, sourceDir: f.source, contentRevision: preview.contentRevision, expectedRevision: preview.revision }), code("skills_source_changed"));
  assert.equal(f.store.list().skills.length, 0);
  const other = path.join(f.root, "other"); writeSkill(other);
  const pending = f.store.preview(other), installed = install(f.store, f.source);
  assert.throws(() => f.store.import({ id: pending.id, sourceDir: other, contentRevision: pending.contentRevision, expectedRevision: pending.revision }), code("skills_revision_conflict"));
  const oldRevision = installed.revision;
  const disabled = f.store.setEnabled({ id: installed.id, expectedRevision: oldRevision, enabled: false });
  assert.throws(() => f.store.remove({ id: installed.id, expectedRevision: oldRevision }), code("skills_revision_conflict"));
  assert.equal(f.store.get(installed.id).state, "disabled"); assert.notEqual(disabled.revision, oldRevision);
});

test("最终发布重核源内容：复制期间变更保留暂存，原清单不提交", t => {
  const f = fixture(t), preview = f.store.preview(f.source), original = fs.writeFileSync;
  let changed = false;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof original>) => {
    const value = Reflect.apply(original, fs, args);
    if (!changed && String(args[0]).includes(`${path.sep}.staging${path.sep}`)) { changed = true; original(path.join(f.source, "refs", "guide.md"), "复制期间修改"); }
    return value;
  }); syncBuiltinESMExports();
  try { assert.throws(() => f.store.import({ id: preview.id, sourceDir: f.source, contentRevision: preview.contentRevision, expectedRevision: preview.revision }), code("skills_source_changed")); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  validateManagedSkillsLayout(f.host); assert.equal(f.store.list().skills.length, 0);
  assert.equal(fs.existsSync(path.join(f.managed, ".staging", preview.id)), true);
});

test("清单写失败：已发布孤立包和临时清单不变成已安装技能，原包与源保留", t => {
  const f = fixture(t), first = install(f.store, f.source), other = path.join(f.root, "other"); writeSkill(other);
  const preview = f.store.preview(other), before = fs.readFileSync(path.join(f.managed, "state.json")), original = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof original>) => {
    if (String(args[1]) === path.join(f.managed, "state.json")) throw Object.assign(new Error("fixture state rename failure"), { code: "EIO" });
    return Reflect.apply(original, fs, args);
  }); syncBuiltinESMExports();
  try { assert.throws(() => f.store.import({ id: preview.id, sourceDir: other, contentRevision: preview.contentRevision, expectedRevision: preview.revision }), code("skills_state_write_failed")); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(path.join(f.managed, "state.json")), before);
  assert.equal(fs.existsSync(path.join(f.managed, "packages", preview.id, "other", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(other, "SKILL.md")), true);
  const reopened = new ManagedSkillsStore(f.host); assert.deepEqual(reopened.list().skills.map(skill => skill.id), [first.id]);
  assert.throws(() => reopened.get(preview.id), code("skill_not_found"));
  const fresh = install(reopened, other); assert.equal(fresh.name, "other");
});

test("安全重开：部分临时清单、暂存与合法孤立包保留但不可见", t => {
  const f = fixture(t); fs.mkdirSync(f.managed, { mode: 0o700 });
  fs.writeFileSync(path.join(f.managed, "state.json.tmp"), "{partial", { mode: 0o600 });
  const staging = path.join(f.managed, ".staging", randomUUID(), "unfinished"), orphan = path.join(f.managed, "packages", randomUUID(), "orphan");
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(staging, "SKILL.md"), "partial", { mode: 0o600 });
  fs.mkdirSync(orphan, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(orphan, "SKILL.md"), "---\ndescription: orphan\n---\nx", { mode: 0o600 });
  validateManagedSkillsLayout(f.host); assert.equal(loadHostSkillLibrary(f.host).skills.length, 0);
  assert.equal(new ManagedSkillsStore(f.host).list().skills.length, 0);
  assert.equal(fs.readFileSync(path.join(f.managed, "state.json.tmp"), "utf8"), "{partial");
  install(f.store, f.source); assert.equal(fs.existsSync(staging), true); assert.equal(fs.existsSync(orphan), true);
});

test("布局拒绝：未知管理节点/版本、非私有对象、链接与已提交包损坏", t => {
  const f = fixture(t), installed = install(f.store, f.source), filename = path.join(f.managed, "state.json"), saved = fs.readFileSync(filename);
  fs.mkdirSync(path.join(f.managed, "unknown"), { mode: 0o700 }); assert.throws(() => validateManagedSkillsLayout(f.host), code("skills_layout_invalid")); fs.rmdirSync(path.join(f.managed, "unknown"));
  fs.writeFileSync(filename, JSON.stringify({ ...JSON.parse(saved.toString()), version: 2 })); assert.throws(() => validateManagedSkillsLayout(f.host), code("skills_state_version_unknown")); fs.writeFileSync(filename, saved);
  fs.chmodSync(filename, 0o644); assert.throws(() => validateManagedSkillsLayout(f.host), code("skills_layout_invalid")); fs.chmodSync(filename, 0o600);
  const link = path.join(f.managed, "state.json.tmp"); fs.linkSync(filename, link); assert.throws(() => validateManagedSkillsLayout(f.host), code("skills_layout_invalid")); fs.unlinkSync(link);
  fs.symlinkSync(f.source, link); assert.throws(() => validateManagedSkillsLayout(f.host), code("skills_layout_invalid")); fs.unlinkSync(link);
  const body = path.join(f.managed, "packages", installed.id, "alpha", "SKILL.md"); fs.writeFileSync(body, "tampered"); assert.throws(() => loadHostSkillLibrary(f.host), code("skills_layout_invalid"));
});

test("启停/逻辑移除：仅显式与停用独立，旧引用不变，移除只作用稳定身份", t => {
  const f = fixture(t); writeSkill(f.source, "alpha", true);
  const first = install(f.store, f.source), pinned = loadHostSkillLibrary(f.host), directory = pinned.skills[0].dir;
  assert.equal(skillCatalogBlock(pinned), null); assert.match(expandSkillCommand(pinned, "/skill:alpha"), /任务正文/);
  const disabled = f.store.setEnabled({ id: first.id, enabled: false, expectedRevision: first.revision });
  assert.equal(loadHostSkillLibrary(f.host).skills.length, 0); assert.equal(reselectManagedSkills(pinned, f.host)!.skills.length, 0);
  assert.throws(() => expandSkillCommand(loadHostSkillLibrary(f.host), "/skill:alpha"), /未知技能/);
  assert.match(expandSkillCommand(pinned, "/skill:alpha"), /任务正文/);
  const alternate = path.join(f.root, "alternate"); writeSkill(alternate, "alpha");
  const second = install(f.store, alternate);
  assert.throws(() => f.store.setEnabled({ id: first.id, enabled: true, expectedRevision: second.revision }), code("skills_name_conflict"));
  const removed = f.store.remove({ id: first.id, expectedRevision: second.revision });
  assert.equal(removed.state, "removed"); assert.equal(f.store.get(first.id).body, first.body); assert.equal(f.store.get(second.id).state, "enabled");
  assert.equal(fs.existsSync(directory), true); assert.equal(fs.readFileSync(path.join(directory, "refs", "guide.md"), "utf8"), "原始引用资料");
  assert.deepEqual(f.store.list().skills.map(skill => skill.id), [second.id]);
  assert.throws(() => f.store.setEnabled({ id: first.id, enabled: true, expectedRevision: removed.revision }), code("skill_removed"));
  assert.notEqual(disabled.revision, first.revision);
});

test("重名外部来源保持赢家，重新启用拒绝覆盖；后续选择不复活，旧库引用可读", t => {
  const f = fixture(t), first = install(f.store, f.source), pinned = loadHostSkillLibrary(f.host), old = JSON.stringify(pinned);
  writeSkill(path.join(skillsDirFor(f.host), "a"), "alpha");
  const current = loadHostSkillLibrary(f.host); assert.equal(current.skills[0].source, "external"); assert.match(current.diagnostics.join("\n"), /冲突/);
  const disabled = f.store.setEnabled({ id: first.id, enabled: false, expectedRevision: first.revision });
  assert.throws(() => f.store.setEnabled({ id: first.id, enabled: true, expectedRevision: disabled.revision }), code("skills_name_conflict"));
  const filtered = reselectManagedSkills(pinned, f.host)!; assert.equal(filtered.skills.length, 0); assert.equal(JSON.stringify(pinned), old);
  assert.match(readSkill(pinned, "alpha", "refs/guide.md"), /原始引用资料/);
  f.store.remove({ id: first.id, expectedRevision: disabled.revision });
  assert.equal(reselectManagedSkills(pinned, f.host)!.skills.length, 0); assert.equal(new ManagedSkillsStore(f.host).get(first.id).state, "removed");
});

test("列表有界且诊断截断可见，详情仅按身份返回单个正文", t => {
  const f = fixture(t), external = skillsDirFor(f.host);
  for (let index = 0; index < 103; index++) writeSkill(path.join(external, `s-${index}`), "duplicate");
  const listing = f.store.list({ limit: 1 }); assert.equal(listing.skills.length, 1); assert.equal(listing.diagnostics.length, 100); assert.equal(listing.diagnosticsTruncated, true);
  assert.equal(f.store.list({ offset: 1 }).skills.length, 0);
  for (const input of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }]) assert.throws(() => f.store.list(input), code("invalid_params"));
  assert.throws(() => f.store.get(path.join(f.source, "SKILL.md")), code("skill_not_found"));
});

test("共享来源：Personal 托管根与外部配置根分别传入，不在外部库创建管理目录", t => {
  const f = fixture(t), external = path.join(f.root, "external"); writeSkill(path.join(skillsDirFor(external), "outside"));
  const store = new ManagedSkillsStore(f.host, [skillsDirFor(external)]); install(store, f.source);
  const library = loadHostSkillLibrary(f.host, [skillsDirFor(external)]);
  assert.deepEqual(library.skills.map(skill => skill.name), ["outside", "alpha"]); assert.equal(fs.existsSync(managedSkillsDirFor(external)), false);
});

test("安全半成品容量：满集合拒绝新导入，不能制造下一次重开无效布局", t => {
  const f = fixture(t), container = path.join(f.managed, ".staging");
  fs.mkdirSync(container, { recursive: true, mode: 0o700 });
  for (let index = 0; index < MANAGED_SKILL_LIMITS.packages; index++) fs.mkdirSync(path.join(container, randomUUID()), { mode: 0o700 });
  const preview = f.store.preview(f.source);
  assert.throws(() => f.store.import({ id: preview.id, sourceDir: f.source, contentRevision: preview.contentRevision, expectedRevision: preview.revision }), code("skills_limit_exceeded"));
  assert.equal(fs.readdirSync(container).length, MANAGED_SKILL_LIMITS.packages);
  validateManagedSkillsLayout(f.host); assert.equal(f.store.list().skills.length, 0);
});

test("源父路径竞态：临时换成越界链接再复原，预览和提交都拒绝", t => {
  const f = fixture(t), parent = path.join(f.root, "source-parent"), source = path.join(parent, "alpha"), outside = path.join(f.root, "outside-parent"), backup = path.join(f.root, "source-backup");
  writeSkill(source); fs.writeFileSync(path.join(source, "refs.txt"), "SOURCE_REFERENCE");
  writeSkill(path.join(outside, "alpha")); fs.writeFileSync(path.join(outside, "alpha", "refs.txt"), "OUTSIDE_SECRET");
  const preview = f.store.preview(source), original = fs.readdirSync;
  let swapped = false;
  const restore = () => { if (swapped) { fs.unlinkSync(parent); fs.renameSync(backup, parent); swapped = false; } };
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof original>) => {
    if (String(args[0]) === source && !swapped) { fs.renameSync(parent, backup); fs.symlinkSync(outside, parent); swapped = true; }
    return Reflect.apply(original, fs, args);
  }); syncBuiltinESMExports();
  try {
    const rejected = (error: unknown) => error instanceof ManagedSkillsError && ["skills_source_changed", "skills_source_unsafe"].includes(error.code);
    assert.throws(() => f.store.preview(source), rejected); restore();
    assert.throws(() => f.store.import({ id: preview.id, sourceDir: source, contentRevision: preview.contentRevision, expectedRevision: preview.revision }), rejected);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); restore(); }
  assert.equal(fs.readFileSync(path.join(source, "refs.txt"), "utf8"), "SOURCE_REFERENCE"); assert.equal(f.store.list().skills.length, 0);
});

test("已提交回执：之后文件系统不可读不误报未保存，恢复读取后可核实状态", t => {
  const f = fixture(t), preview = f.store.preview(f.source), originalRename = fs.renameSync, originalStat = fs.lstatSync;
  let committed = false;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof originalRename>) => {
    const value = Reflect.apply(originalRename, fs, args);
    if (String(args[1]) === path.join(f.managed, "state.json")) committed = true;
    return value;
  });
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof originalStat>) => {
    if (committed) throw Object.assign(new Error("fixture post-commit read failure"), { code: "EIO" });
    return Reflect.apply(originalStat, fs, args);
  }); syncBuiltinESMExports();
  try {
    const imported = f.store.import({ id: preview.id, sourceDir: f.source, contentRevision: preview.contentRevision, expectedRevision: preview.revision });
    assert.equal(imported.state, "enabled"); assert.equal(committed, true); committed = false;
    const disabled = f.store.setEnabled({ id: imported.id, enabled: false, expectedRevision: imported.revision });
    assert.equal(disabled.state, "disabled"); assert.equal(committed, true); committed = false;
    assert.equal(f.store.get(imported.id).state, "disabled");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("源父路径共享：无关子项变动可完整重读，持续变动三次后拒绝", t => {
  const f = fixture(t), original = fs.readdirSync;
  let changes = 0, persistent = false;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof original>) => {
    if (String(args[0]) === f.source && (persistent || changes === 0)) fs.mkdirSync(path.join(f.root, `unrelated-${changes++}`));
    return Reflect.apply(original, fs, args);
  }); syncBuiltinESMExports();
  try {
    assert.equal(f.store.preview(f.source).name, "alpha"); assert.equal(changes, 1);
    persistent = true;
    assert.throws(() => f.store.preview(f.source), code("skills_source_changed")); assert.equal(changes, 4);
    assert.equal(fs.existsSync(f.managed), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
