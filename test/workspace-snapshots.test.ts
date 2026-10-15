import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Session, WorkDelegation } from "@ruukoto/core/types.ts";
import { parseWorkWriteTarget } from "@ruukoto/core/types.ts";
import { requireWorkspaceSnapshot, snapshotWorkspace } from "@ruukoto/core/workspace-snapshot.ts";
import { verifyImportedWorkCopySnapshots } from "@ruukoto/core/import-support.ts";
import { WorkCopyManager, type WorkCopyExecutor } from "@ruukoto/runtime/work-copy.ts";
import { WORKSPACE_SNAPSHOT_SCRIPT } from "@ruukoto/runtime/workspace-snapshot-script.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";

const shell = promisify(execFile);
const git = (cwd: string, ...args: string[]): Buffer => execFileSync("git", ["-C", cwd, ...args]);
function files(root: string): Record<string, { digest: string; mode: number; ino: number; mtime: number }> {
  const result: ReturnType<typeof files> = {};
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else result[path.relative(root, file)] = { digest: createHash("sha256").update(stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file)).digest("hex"), mode: stat.mode, ino: stat.ino, mtime: stat.mtimeMs };
    }
  };
  walk(root);
  return result;
}
function fixture(extra?: (input: Parameters<WorkCopyExecutor>[0]) => void) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-current-snapshot-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "value.txt"), "base\n".repeat(20));
  fs.writeFileSync(path.join(repo, "deleted.txt"), "old\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored\nnode_modules/\n");
  initGitRepo(repo);
  const stat = fs.statSync(repo);
  const session = { id: "parent", cwdReal: repo, cwdDev: stat.dev, cwdIno: stat.ino } as Session;
  const captures: Array<{ before: ReturnType<typeof files>; after: ReturnType<typeof files> }> = [];
  const registrations: Array<{ before: ReturnType<typeof files>; after: ReturnType<typeof files> }> = [];
  const manager = new WorkCopyManager({ worktreeRoot: path.join(root, "copies"), protectedRoots: () => [], execute: async input => {
    extra?.(input);
    const before = files(repo);
    const result = await shell("/bin/sh", ["-c", input.command], { cwd: input.workspace, maxBuffer: 4 * 1024 * 1024 });
    if (input.operation === "capture") captures.push({ before, after: files(repo) });
    if (input.operation === "create") registrations.push({ before, after: files(repo) });
    return { isError: false, content: result.stdout };
  } });
  const prepare = async (id = "work") => {
    const target = await manager.prepareWriteTarget(".", session, id, "parent-task");
    if (target.kind !== "worktree") assert.fail("需要 Git 副本");
    const work = { id, writeTarget: target } as WorkDelegation;
    return { work, target, parentTaskId: "parent-task" };
  };
  return { root, repo, session, manager, captures, registrations, prepare, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("已暂存的大小写改名只捕获实际名字，正常子增量可汇入并识别已应用", async () => {
  const f = fixture();
  try {
    fs.symlinkSync("value.txt", path.join(f.repo, "link"));
    git(f.repo, "add", "link");
    git(f.repo, "commit", "-m", "link");
    git(f.repo, "mv", "value.txt", "VALUE.txt");
    git(f.repo, "mv", "link", "LINK");
    const index = fs.readFileSync(path.join(f.repo, ".git/index"));
    const input = await f.prepare();
    const names = fs.readdirSync(input.target.path);
    assert.ok(names.includes("VALUE.txt") && names.includes("LINK"));
    assert.ok(!names.includes("value.txt") && !names.includes("link"));
    assert.equal((await f.manager.freeze(input)).bytes, 0);
    fs.writeFileSync(path.join(input.target.path, "VALUE.txt"), "child\n");
    fs.unlinkSync(path.join(input.target.path, "LINK"));
    fs.symlinkSync("VALUE.txt", path.join(input.target.path, "LINK"));
    assert.equal((await f.manager.integrate({ ...input, parentSession: f.session })).state, "applied");
    const finalNames = fs.readdirSync(f.repo);
    assert.ok(finalNames.includes("VALUE.txt") && finalNames.includes("LINK"));
    assert.equal(fs.readFileSync(path.join(f.repo, "VALUE.txt"), "utf8"), "child\n");
    assert.equal(fs.readlinkSync(path.join(f.repo, "LINK")), "VALUE.txt");
    assert.equal((await f.manager.integrate({ ...input, parentSession: f.session })).state, "already");
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    assert.deepEqual(f.captures[0].after, f.captures[0].before);
  } finally { f.cleanup(); }
});

test("子副本大小写改名保留真实路径；Git 拒绝套用时报告原因并零源写", async () => {
  const f = fixture();
  try {
    fs.symlinkSync("value.txt", path.join(f.repo, "link"));
    git(f.repo, "add", "link");
    const input = await f.prepare();
    fs.renameSync(path.join(input.target.path, "value.txt"), path.join(input.target.path, "Value.txt"));
    fs.renameSync(path.join(input.target.path, "link"), path.join(input.target.path, "Link"));
    const frozen = await f.manager.freeze(input);
    assert.match(frozen.patch.toString(), /rename to Value.txt/);
    assert.match(frozen.patch.toString(), /rename to Link/);
    const before = files(f.repo), child = files(input.target.path);
    const aliasesCase = fs.existsSync(path.join(f.repo, "VALUE.txt"));
    const result = await f.manager.integrateFrozen({ ...input, frozen, parentSession: f.session });
    // 区分大小写的文件系统可直接套用；APFS 的 Git apply 拒绝新名字与现有名字的别名冲突。
    if (aliasesCase) {
      assert.equal(result.state, "conflict");
      assert.match(result.detail ?? "", /already exists in working directory/);
      assert.deepEqual(files(f.repo), before);
    } else {
      assert.equal(result.state, "applied");
      assert.equal((await f.manager.integrateFrozen({ ...input, frozen, parentSession: f.session })).state, "already");
    }
    assert.deepEqual(files(input.target.path), child);
  } finally { f.cleanup(); }
});

for (const transition of ["file-to-directory", "directory-to-file"] as const) test(`已暂存的 ${transition} 按当前形态捕获，空冻结与子增量不读取过期 HEAD 路径`, async () => {
  const f = fixture();
  try {
    const source = path.join(f.repo, "node");
    if (transition === "file-to-directory") fs.writeFileSync(source, "old\n");
    else { fs.mkdirSync(source); fs.writeFileSync(path.join(source, "old.txt"), "old\n"); }
    git(f.repo, "add", "node");
    git(f.repo, "commit", "-m", "node");
    git(f.repo, "rm", "-r", "node");
    if (transition === "file-to-directory") { fs.mkdirSync(source); fs.writeFileSync(path.join(source, "current.txt"), "current\n"); }
    else fs.writeFileSync(source, "current\n");
    git(f.repo, "add", "node");
    const index = fs.readFileSync(path.join(f.repo, ".git/index"));
    const input = await f.prepare();
    assert.equal((await f.manager.freeze(input)).bytes, 0);
    const child = path.join(input.target.path, "node", ...(transition === "file-to-directory" ? ["current.txt"] : []));
    const result = path.join(source, ...(transition === "file-to-directory" ? ["current.txt"] : []));
    assert.equal(fs.readFileSync(child, "utf8"), "current\n");
    fs.writeFileSync(child, "child\n");
    assert.equal((await f.manager.integrate({ ...input, parentSession: f.session })).state, "applied");
    assert.equal(fs.readFileSync(result, "utf8"), "child\n");
    assert.equal((await f.manager.integrate({ ...input, parentSession: f.session })).state, "already");
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    assert.deepEqual(f.captures[0].after, f.captures[0].before);
  } finally { f.cleanup(); }
});

for (const transition of ["file-to-directory", "directory-to-file", "directory-to-link"] as const) test(`子副本 ${transition} 冻结不追随过期路径，汇入后重复请求保持已应用`, async () => {
  const f = fixture();
  try {
    const source = path.join(f.repo, "node");
    if (transition === "file-to-directory") fs.writeFileSync(source, "old\n");
    else { fs.mkdirSync(source); fs.writeFileSync(path.join(source, "old.txt"), "old\n"); }
    git(f.repo, "add", "node");
    git(f.repo, "commit", "-m", "node");
    const index = fs.readFileSync(path.join(f.repo, ".git/index"));
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "old.txt"), "outside\n");
    const beforeOutside = files(outside);
    const input = await f.prepare();
    const child = path.join(input.target.path, "node");
    fs.rmSync(child, { recursive: true });
    if (transition === "file-to-directory") { fs.mkdirSync(child); fs.writeFileSync(path.join(child, "new.txt"), "child\n"); }
    else if (transition === "directory-to-file") fs.writeFileSync(child, "child\n");
    else fs.symlinkSync(outside, child);
    const frozen = await f.manager.freeze(input);
    const verified = await f.manager.prepareVerificationTarget({ ...input, frozen, parentSession: f.session, verificationWorkId: "verify" });
    assert.equal(fs.lstatSync(path.join(verified.path, "node")).isSymbolicLink(), transition === "directory-to-link");
    assert.equal((await f.manager.integrateFrozen({ ...input, frozen, parentSession: f.session })).state, "applied");
    if (transition === "file-to-directory") assert.equal(fs.readFileSync(path.join(source, "new.txt"), "utf8"), "child\n");
    else if (transition === "directory-to-file") assert.equal(fs.readFileSync(source, "utf8"), "child\n");
    else assert.equal(fs.readlinkSync(source), outside);
    assert.equal((await f.manager.integrateFrozen({ ...input, frozen, parentSession: f.session })).state, "already");
    assert.deepEqual(files(outside), beforeOutside);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
  } finally { f.cleanup(); }
});

test("实际嵌套 Git 与索引 gitlink 仍拒绝捕获", async () => {
  for (const kind of ["nested", "gitlink"] as const) {
    const f = fixture();
    try {
      const nested = path.join(f.repo, "nested");
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, "value.txt"), "nested\n");
      if (kind === "nested") initGitRepo(nested);
      else git(f.repo, "update-index", "--add", "--cacheinfo", "160000", git(f.repo, "rev-parse", "HEAD").toString().trim(), "nested");
      const before = files(f.repo);
      await assert.rejects(f.prepare(), (error: unknown) => {
        assert.ok(error instanceof Error && "stdout" in error && typeof error.stdout === "string");
        assert.match(error.stdout, /"code":"snapshot_unsupported"/);
        return true;
      });
      assert.deepEqual(files(f.repo), before);
    } finally { f.cleanup(); }
  }
});

test("core.symlinks=false 仍按原始类型验证和汇入新增/改指向的链接", async () => {
  const f = fixture();
  try {
    fs.symlinkSync("value.txt", path.join(f.repo, "existing-link"));
    git(f.repo, "add", "existing-link");
    git(f.repo, "config", "core.symlinks", "false");
    const input = await f.prepare();
    fs.unlinkSync(path.join(input.target.path, "existing-link"));
    fs.symlinkSync("child.txt", path.join(input.target.path, "existing-link"));
    fs.symlinkSync("child.txt", path.join(input.target.path, "new-link"));
    fs.writeFileSync(path.join(input.target.path, "child.txt"), "child\n");
    const frozen = await f.manager.freeze(input);
    const verified = await f.manager.prepareVerificationTarget({ ...input, frozen, parentSession: f.session, verificationWorkId: "verify" });
    for (const name of ["existing-link", "new-link"]) {
      assert.equal(fs.lstatSync(path.join(verified.path, name)).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(path.join(verified.path, name)), "child.txt");
    }
    assert.equal((await f.manager.integrate({ ...input, parentSession: f.session })).state, "applied");
    for (const name of ["existing-link", "new-link"]) {
      assert.equal(fs.lstatSync(path.join(f.repo, name)).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(path.join(f.repo, name)), "child.txt");
    }
    assert.equal((await f.manager.integrate({ ...input, parentSession: f.session })).state, "already");
    assert.equal(git(f.repo, "config", "core.symlinks").toString().trim(), "false");
  } finally { f.cleanup(); }
});

test("当前内容捕获零写入，登记仅新增专属 Git 元数据，普通汇入只应用子增量", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, "value.txt"), "staged\n".repeat(20));
    git(f.repo, "add", "value.txt");
    fs.writeFileSync(path.join(f.repo, "value.txt"), "staged\n".repeat(19) + "unstaged\n");
    fs.unlinkSync(path.join(f.repo, "deleted.txt"));
    fs.mkdirSync(path.join(f.repo, "nested"));
    const binary = Buffer.from([0, 0xff, 0x41, 0]);
    fs.writeFileSync(path.join(f.repo, "nested/new.bin"), binary);
    fs.writeFileSync(path.join(f.repo, "ignored"), "private\n");
    fs.mkdirSync(path.join(f.repo, "node_modules"));
    fs.writeFileSync(path.join(f.repo, "node_modules/local"), "dependency\n");
    fs.writeFileSync(path.join(f.repo, "crlf.txt"), "one\r\ntwo\r\n");
    fs.writeFileSync(path.join(f.repo, ".gitattributes"), "* filter=evil\ncrlf.txt text eol=lf\n");
    fs.writeFileSync(path.join(f.repo, "executable"), "#!/bin/sh\n");
    fs.chmodSync(path.join(f.repo, "executable"), 0o755);
    fs.symlinkSync("value.txt", path.join(f.repo, "link"));
    const marker = path.join(f.repo, "filter-ran");
    for (const kind of ["clean", "smudge"]) git(f.repo, "config", `filter.evil.${kind}`, `touch '${marker}'; cat`);
    git(f.repo, "config", "filter.evil.required", "true");
    const index = fs.readFileSync(path.join(f.repo, ".git/index"));
    const input = await f.prepare();
    const copy = input.target.path;
    assert.deepEqual(f.captures[0].after, f.captures[0].before);
    const registration = f.registrations[0];
    for (const [name, state] of Object.entries(registration.before)) assert.deepEqual(registration.after[name], state, name);
    const added = Object.keys(registration.after).filter(name => !(name in registration.before));
    assert.ok(added.every(name => name.startsWith(".git/worktrees/work/") || name === ".git/refs/heads/ruukoto/work-work" || name === ".git/logs/refs/heads/ruukoto/work-work"), added.join(","));
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readFileSync(path.join(copy, "value.txt")), fs.readFileSync(path.join(f.repo, "value.txt")));
    assert.deepEqual(fs.readFileSync(path.join(copy, "nested/new.bin")), binary);
    assert.equal(fs.existsSync(path.join(copy, "deleted.txt")), false);
    assert.equal(fs.existsSync(path.join(copy, "ignored")), false);
    assert.equal(fs.existsSync(path.join(copy, "node_modules")), false);
    assert.deepEqual(fs.readFileSync(path.join(copy, "crlf.txt")), Buffer.from("one\r\ntwo\r\n"));
    assert.equal(fs.readlinkSync(path.join(copy, "link")), "value.txt");
    assert.ok(fs.statSync(path.join(copy, "executable")).mode & 0o111);
    const frozenEmpty = await f.manager.freeze(input);
    assert.equal(frozenEmpty.bytes, 0);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    fs.writeFileSync(path.join(copy, "nested/new.bin"), Buffer.from([0, 0x23, 0xff, 0]));
    fs.writeFileSync(path.join(copy, "child.txt"), "child\n");
    const sourceGit = files(path.join(f.repo, ".git"));
    const frozen = await f.manager.freeze(input);
    assert.equal(frozen.snapshotDigest, input.target.snapshot.digest);
    assert.ok(!frozen.patch.includes(Buffer.from("diff --git a/value.txt")));
    const verified = await f.manager.prepareVerificationTarget({ ...input, frozen, parentSession: f.session, verificationWorkId: "verify" });
    assert.deepEqual(fs.readFileSync(path.join(verified.path, "value.txt")), fs.readFileSync(path.join(f.repo, "value.txt")));
    assert.equal(verified.snapshot.digest, input.target.snapshot.digest);
    // 验证副本登记后，汇入保持原 index/objects 与所有已存在 Git 字节。
    const beforeIntegrate = files(path.join(f.repo, ".git"));
    const integrated = await f.manager.integrate({ ...input, parentSession: f.session });
    assert.equal(integrated.state, "applied");
    assert.deepEqual(files(path.join(f.repo, ".git")), beforeIntegrate);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    assert.equal(fs.readFileSync(path.join(f.repo, "value.txt"), "utf8"), "staged\n".repeat(19) + "unstaged\n");
    assert.equal(git(f.repo, "show", ":value.txt").toString(), "staged\n".repeat(20));
    assert.deepEqual(fs.readFileSync(path.join(f.repo, "nested/new.bin")), Buffer.from([0, 0x23, 0xff, 0]));
    assert.equal(fs.readFileSync(path.join(f.repo, "child.txt"), "utf8"), "child\n");
    assert.equal((await f.manager.integrate({ ...input, parentSession: f.session })).state, "already");
    for (const [name, state] of Object.entries(sourceGit)) assert.deepEqual(files(path.join(f.repo, ".git"))[name], state, name);
  } finally { f.cleanup(); }
});

test("后续同文件不同 hunk 修改即使补丁可套用也拒绝，保留双方字节", async () => {
  const f = fixture();
  try {
    const input = await f.prepare();
    const child = "child\n" + "base\n".repeat(19);
    fs.writeFileSync(path.join(input.target.path, "value.txt"), child);
    const frozen = await f.manager.freeze(input);
    fs.writeFileSync(path.join(f.repo, "value.txt"), "base\n".repeat(19) + "owner\n");
    const patch = path.join(f.root, "patch");
    fs.writeFileSync(patch, frozen.patch);
    git(f.repo, "apply", "--check", patch);
    const before = files(f.repo);
    const result = await f.manager.integrateFrozen({ ...input, frozen, parentSession: f.session });
    assert.equal(result.state, "conflict");
    assert.deepEqual(files(f.repo), before);
    assert.equal(fs.readFileSync(path.join(input.target.path, "value.txt"), "utf8"), child);
  } finally { f.cleanup(); }
});

test("外部捕获竞态、非 UTF-8 名字、路径祖先链接在源写入前拒绝", async () => {
  const f = fixture();
  try {
    const privateRepo = path.join(f.root, "private"), index = path.join(f.root, "index");
    const source = path.join(f.root, "race-source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "value.txt"), "base\n");
    initGitRepo(source);
    const modified = WORKSPACE_SNAPSHOT_SCRIPT.replace("const afterTree = rawTree", "fs.writeFileSync(path.join(input.source, 'value.txt'), 'race');\n  const afterTree = rawTree");
    const result = await shell(process.execPath, ["-e", modified, "capture", JSON.stringify({ source, gitdir: privateRepo, index })]).catch(error => error);
    assert.match(result.stdout, /"code":"snapshot_changed"/);
    // APFS 不允许无效 UTF-8 名字；直接向真实脚本的 Git 路径解析送入坏 wire 字节。
    const invalid = WORKSPACE_SNAPSHOT_SCRIPT.replace("const before = fingerprint", "parsePaths(Buffer.from([0xff, 0]));\n  const before = fingerprint");
    const invalidResult = await shell(process.execPath, ["-e", invalid, "capture", JSON.stringify({ source: f.repo, gitdir: path.join(f.root, "invalid"), index })]).catch(error => error);
    assert.match(invalidResult.stdout, /"code":"snapshot_unsupported"/);
    assert.match(invalidResult.stderr, /UTF-8/);
    fs.mkdirSync(path.join(f.repo, "dir"));
    fs.writeFileSync(path.join(f.repo, "dir/value.txt"), "tracked\n");
    git(f.repo, "add", "dir/value.txt");
    fs.rmSync(path.join(f.repo, "dir"), { recursive: true });
    fs.symlinkSync(source, path.join(f.repo, "dir"));
    const before = files(source);
    await assert.rejects(f.prepare("ancestor-link"));
    assert.deepEqual(files(source), before);
  } finally { f.cleanup(); }
});

test("基线缺失、身份或摘要损坏拒绝执行、恢复和导入，不回退 HEAD", async () => {
  const f = fixture();
  try {
    const input = await f.prepare();
    const original = input.target.snapshot;
    assert.deepEqual(requireWorkspaceSnapshot(original), original);
    assert.throws(() => parseWorkWriteTarget(JSON.stringify({ ...input.target, snapshot: undefined })), { code: "snapshot_missing" });
    assert.throws(() => requireWorkspaceSnapshot({ ...original, tree: "0".repeat(40) }), { code: "snapshot_corrupt" });
    assert.throws(() => verifyImportedWorkCopySnapshots([{ id: "work", write_target: JSON.stringify({ ...input.target, snapshot: undefined }) }]), { code: "snapshot_missing" });
    const altered = snapshotWorkspace({ ...original, source: { ...original.source, ino: original.source.ino + 1 } });
    input.target.snapshot = altered;
    await assert.rejects(f.manager.freeze(input), { code: "snapshot_changed" });
    input.target.snapshot = original;
    const baseline = path.join(original.repository.path, "ruukoto-baseline");
    fs.writeFileSync(baseline, "{}");
    await assert.rejects(f.manager.freeze(input), { code: "snapshot_corrupt" });
  } finally { f.cleanup(); }
});

for (const alias of ["alternates", "symlink", "hardlink", "commondir"] as const) test(`私有基线 ${alias} 不取得源对象写入资格，缺对象在模型预检前拒绝`, async () => {
  const f = fixture();
  try {
    const input = await f.prepare();
    const oid = git(f.repo, "hash-object", "--no-filters", "value.txt").toString().trim();
    const sourceObject = path.join(f.repo, ".git/objects", oid.slice(0, 2), oid.slice(2));
    const repository = input.target.snapshot.repository.path;
    const privateObject = path.join(repository, "objects", oid.slice(0, 2), oid.slice(2));
    fs.utimesSync(sourceObject, new Date("2000-01-01"), new Date("2000-01-01"));
    fs.unlinkSync(privateObject);
    assert.throws(() => f.manager.assertCopy(input.work, input.target, "预检"), { code: "snapshot_corrupt" });
    if (alias === "alternates") fs.writeFileSync(path.join(repository, "objects/info/alternates"), path.join(f.repo, ".git/objects") + "\n");
    if (alias === "symlink") fs.symlinkSync(sourceObject, privateObject);
    if (alias === "hardlink") fs.linkSync(sourceObject, privateObject);
    if (alias === "commondir") fs.writeFileSync(path.join(repository, "commondir"), path.join(f.repo, ".git") + "\n");
    const before = files(path.join(f.repo, ".git"));
    await assert.rejects(f.manager.freeze(input), { code: "snapshot_corrupt" });
    assert.deepEqual(files(path.join(f.repo, ".git")), before);
  } finally { f.cleanup(); }
});

test("来源 worktree 的 Git 指向切换即使 HEAD/index 相同也使旧基线失效", async () => {
  const f = fixture();
  try {
    const source = path.join(f.root, "linked"), other = path.join(f.root, "other");
    git(f.repo, "worktree", "add", "--no-checkout", "--detach", source, "HEAD");
    git(source, "read-tree", "HEAD");
    fs.writeFileSync(path.join(source, "value.txt"), "baseline\n");
    fs.mkdirSync(other);
    fs.cpSync(path.join(f.repo, ".git"), path.join(other, ".git"), { recursive: true });
    const stat = fs.statSync(f.root);
    const session = { ...f.session, cwdReal: f.root, cwdDev: stat.dev, cwdIno: stat.ino };
    const target = await f.manager.prepareWriteTarget(source, session, "linked-work", "parent");
    assert.ok(target.kind === "worktree");
    const input = { target, work: { id: "linked-work", writeTarget: target } as WorkDelegation, parentTaskId: "parent" };
    fs.writeFileSync(path.join(target.path, "value.txt"), "child\n");
    const frozen = await f.manager.freeze(input);
    const pointer = fs.readFileSync(path.join(source, ".git"), "utf8");
    fs.writeFileSync(path.join(source, ".git"), pointer.replace(f.repo, other));
    await assert.rejects(f.manager.freeze(input), { code: "snapshot_changed" });
    await assert.rejects(f.manager.integrateFrozen({ ...input, frozen, parentSession: session }), { code: "snapshot_changed" });
    assert.equal(fs.readFileSync(path.join(source, "value.txt"), "utf8"), "baseline\n");
  } finally { f.cleanup(); }
});

test("split-index 私有读取保留三类忽略规则，来源共享索引零写入且保存字节参与摘要", async () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.repo, ".git/info/exclude"), "info-ignored\n");
    fs.writeFileSync(path.join(f.repo, "exclude-rules"), "configured-ignored\n");
    git(f.repo, "config", "core.excludesfile", "exclude-rules");
    for (const name of ["info-ignored", "configured-ignored", "ignored"]) fs.writeFileSync(path.join(f.repo, name), "private\n");
    git(f.repo, "update-index", "--split-index");
    const shared = fs.readdirSync(path.join(f.repo, ".git")).find(name => name.startsWith("sharedindex."))!;
    fs.utimesSync(path.join(f.repo, ".git", shared), new Date("2000-01-01"), new Date("2000-01-01"));
    const input = await f.prepare();
    assert.deepEqual(f.captures[0].after, f.captures[0].before);
    for (const name of ["info-ignored", "configured-ignored", "ignored"]) assert.equal(fs.existsSync(path.join(input.target.path, name)), false);
    const saved = path.join(input.target.snapshot.repository.path, shared);
    assert.deepEqual(fs.readFileSync(saved), fs.readFileSync(path.join(f.repo, ".git", shared)));
    fs.appendFileSync(saved, "tamper");
    assert.throws(() => f.manager.assertCopy(input.work, input.target, "预检"), { code: "snapshot_corrupt" });
  } finally { f.cleanup(); }
});

test("仅原索引引用的 staged blob 缺失或删除阶段清单不能通过恢复预检", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, "value.txt"), "staged-only\n");
    git(f.repo, "add", "value.txt");
    const oid = git(f.repo, "rev-parse", ":value.txt").toString().trim();
    fs.writeFileSync(path.join(f.repo, "value.txt"), "unstaged-current\n");
    const input = await f.prepare();
    const repository = input.target.snapshot.repository.path;
    fs.unlinkSync(path.join(repository, "objects", oid.slice(0, 2), oid.slice(2)));
    assert.throws(() => f.manager.assertCopy(input.work, input.target, "恢复"), { code: "snapshot_corrupt" });
    await assert.rejects(f.manager.freeze(input), { code: "snapshot_corrupt" });
    fs.writeFileSync(path.join(repository, "ruukoto-source-stages"), "");
    assert.throws(() => f.manager.assertCopy(input.work, input.target, "恢复"), { code: "snapshot_corrupt" });
  } finally { f.cleanup(); }
});

test("缺少 promisor blob 时拒绝捕获，不向来源下载对象", async () => {
  const f = fixture();
  try {
    git(f.repo, "config", "uploadpack.allowFilter", "true");
    const source = path.join(f.root, "partial");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${f.repo}`, source]);
    git(source, "read-tree", "HEAD");
    fs.writeFileSync(path.join(source, "value.txt"), "unstaged-current\n");
    const before = files(path.join(source, ".git"));
    const result = await shell(process.execPath, ["-e", WORKSPACE_SNAPSHOT_SCRIPT, "capture", JSON.stringify({ source, gitdir: path.join(f.root, "promisor-private"), index: path.join(f.root, "promisor-index") })]).catch(error => error);
    assert.match(result.stdout, /RUUKOTO_SNAPSHOT_ERROR=/);
    assert.deepEqual(files(path.join(source, ".git")), before);
  } finally { f.cleanup(); }
});

test("宿主空模板和固定 SHA-1 私有格式不继承用户模板的对象旁路", async () => {
  const f = fixture();
  try {
    const template = path.join(f.root, "template");
    fs.mkdirSync(path.join(template, "objects/info"), { recursive: true });
    fs.writeFileSync(path.join(template, "objects/info/alternates"), path.join(f.repo, ".git/objects") + "\n");
    const before = files(path.join(f.repo, ".git"));
    const repository = path.join(f.root, "template-private");
    await shell(process.execPath, ["-e", WORKSPACE_SNAPSHOT_SCRIPT, "capture", JSON.stringify({ source: f.repo, gitdir: repository, index: path.join(f.root, "template-index") })], {
      env: { ...process.env, GIT_TEMPLATE_DIR: template, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "init.defaultObjectFormat", GIT_CONFIG_VALUE_0: "sha256" },
    });
    assert.deepEqual(files(path.join(f.repo, ".git")), before);
    assert.equal(fs.existsSync(path.join(repository, "objects/info/alternates")), false);
    assert.equal(git(repository, "rev-parse", "--show-object-format").toString().trim(), "sha1");
  } finally { f.cleanup(); }
});
