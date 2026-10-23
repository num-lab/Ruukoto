import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { resolveDirIdentitySync } from "@ruukoto/core/dir-identity.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { MAX_FRAME_BYTES } from "@ruukoto/control/protocol.ts";
import { readWorkspaceGit, WORKSPACE_GIT_COMMITS, WORKSPACE_GIT_OUTPUT_BYTES } from "@ruukoto/runtime/workspace-git.ts";
import { startTestRuntime } from "./helpers/testkit.ts";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "真实作者", GIT_AUTHOR_EMAIL: "author@example.invalid", GIT_COMMITTER_NAME: "真实作者", GIT_COMMITTER_EMAIL: "author@example.invalid", GIT_AUTHOR_DATE: "2026-10-17T10:00:00+09:00", GIT_COMMITTER_DATE: "2026-10-17T10:00:00+09:00", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const runGit = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fails = (code: string) => (error: unknown) => error instanceof RuntimeApiError && error.code === code;
function fixture() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-git-")));
  const root = path.join(parent, "work");
  fs.mkdirSync(root);
  return { parent, root, identity: resolveDirIdentitySync(root), init() { runGit(root, "init", "-q", "-b", "main"); }, close() { fs.rmSync(parent, { recursive: true, force: true }); } };
}

test("Git 历史保留真实分叉合并、父提交、作者与显式本地/远程/标签引用", async () => {
  const kit = fixture();
  try {
    kit.init(); runGit(kit.root, "commit", "--allow-empty", "-qm", "初始提交");
    const base = runGit(kit.root, "rev-parse", "HEAD");
    runGit(kit.root, "checkout", "-qb", "feature"); runGit(kit.root, "commit", "--allow-empty", "-qm", "<script>feature</script>");
    const feature = runGit(kit.root, "rev-parse", "HEAD");
    runGit(kit.root, "checkout", "-q", "main"); runGit(kit.root, "commit", "--allow-empty", "-qm", "main change");
    const main = runGit(kit.root, "rev-parse", "HEAD");
    runGit(kit.root, "merge", "--no-ff", "-qm", "merge feature", "feature");
    const head = runGit(kit.root, "rev-parse", "HEAD");
    runGit(kit.root, "tag", "-am", "release", "release-1"); runGit(kit.root, "tag", "lightweight", base);
    runGit(kit.root, "remote", "add", "origin", "https://example.invalid/private.git");
    runGit(kit.root, "update-ref", "refs/remotes/origin/main", head); runGit(kit.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const before = runGit(kit.root, "status", "--porcelain=v1");
    const result = await readWorkspaceGit("w", kit.identity);
    assert.equal(result.workspaceId, "w"); assert.equal(result.repository?.head, head); assert.equal(result.repository?.nextCursor, null);
    const commits = result.repository!.commits;
    assert.equal(commits.length, 4); assert.equal(commits[0].id, head); assert.deepEqual(commits[0].parents, [main, feature]);
    assert.equal(commits.find(commit => commit.id === feature)?.subject, "<script>feature</script>");
    assert.ok(commits.every(commit => commit.author === "真实作者" && commit.date === "2026-10-17T10:00:00+09:00"));
    assert.deepEqual(commits[0].refs, [{ name: "main", type: "branch" }, { name: "main", type: "branch", remote: "origin" }, { name: "release-1", type: "tag" }]);
    assert.deepEqual(commits.find(commit => commit.id === base)?.refs, [{ name: "lightweight", type: "tag" }]);
    assert.equal(runGit(kit.root, "status", "--porcelain=v1"), before);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < MAX_FRAME_BYTES);
  } finally { kit.close(); }
});

test("非仓库与空仓库不同，子目录和真实 worktree 使用所在仓库", async () => {
  const kit = fixture();
  try {
    assert.deepEqual(await readWorkspaceGit("w", kit.identity), { workspaceId: "w", repository: null });
    kit.init();
    assert.deepEqual(await readWorkspaceGit("w", kit.identity), { workspaceId: "w", repository: { head: null, commits: [], nextCursor: null } });
    runGit(kit.root, "commit", "--allow-empty", "-qm", "base");
    const head = runGit(kit.root, "rev-parse", "HEAD");
    const nested = path.join(kit.root, "nested"), worktree = path.join(kit.parent, "copy");
    fs.mkdirSync(nested); runGit(kit.root, "worktree", "add", "--detach", "-q", worktree, "HEAD");
    assert.equal((await readWorkspaceGit("n", resolveDirIdentitySync(nested))).repository?.head, head);
    assert.equal((await readWorkspaceGit("c", resolveDirIdentitySync(worktree))).repository?.head, head);
  } finally { kit.close(); }
});

test("Git 读取排除注入环境与全局配置，不执行 hook/pager/signature 命令", async () => {
  const kit = fixture();
  const original = process.env;
  try {
    kit.init(); runGit(kit.root, "commit", "--allow-empty", "-qm", "safe");
    const head = runGit(kit.root, "rev-parse", "HEAD"), marker = path.join(kit.parent, "executed");
    const script = path.join(kit.parent, "unsafe.sh"); fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    runGit(kit.root, "config", "core.pager", script); runGit(kit.root, "config", "gpg.program", script); runGit(kit.root, "config", "log.showSignature", "true");
    runGit(kit.root, "config", "core.fsmonitor", script);
    const injected = path.join(kit.parent, "global"); fs.writeFileSync(injected, "not valid git configuration\n");
    process.env = { ...original, GIT_DIR: "/missing", GIT_WORK_TREE: "/missing", GIT_CONFIG_GLOBAL: injected, GIT_CONFIG_PARAMETERS: "invalid syntax", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.repositoryformatversion", GIT_CONFIG_VALUE_0: "999", GIT_ALTERNATE_OBJECT_DIRECTORIES: "/missing" };
    assert.equal((await readWorkspaceGit("w", kit.identity)).repository?.head, head);
    assert.equal(fs.existsSync(marker), false);
  } finally { process.env = original; kit.close(); }
});

test("Git 支持本地硬链接克隆、共享对象库与配置 include，仍不执行仓库程序", async () => {
  const kit = fixture();
  try {
    kit.init(); runGit(kit.root, "commit", "--allow-empty", "-qm", "真实中文提交");
    const head = runGit(kit.root, "rev-parse", "HEAD"), clone = path.join(kit.parent, "clone"), shared = path.join(kit.parent, "shared");
    runGit(kit.parent, "clone", "-q", kit.root, clone); runGit(kit.parent, "clone", "--shared", "-q", kit.root, shared);
    const object = path.join(kit.root, ".git", "objects", head.slice(0, 2), head.slice(2));
    assert.ok(fs.statSync(object).nlink > 1);
    const marker = path.join(kit.parent, "executed"), script = path.join(kit.parent, "command.sh"), included = path.join(kit.parent, "included");
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const hooks = path.join(kit.parent, "hooks"); fs.mkdirSync(hooks); fs.symlinkSync(script, path.join(hooks, "post-checkout"));
    for (const key of ["core.pager", "core.fsmonitor", "gpg.program", "core.alternateRefsCommand"]) runGit(kit.root, "config", "--file", included, key, script);
    runGit(kit.root, "config", "--file", included, "core.hooksPath", hooks);
    runGit(kit.root, "config", "--file", included, "log.showSignature", "true");
    runGit(kit.root, "config", "--file", included, "i18n.logOutputEncoding", "UTF-16");
    for (const root of [kit.root, clone, shared]) {
      runGit(root, "config", "include.path", included);
      fs.symlinkSync(script, path.join(root, ".git", "hooks", "post-checkout"));
      const result = await readWorkspaceGit("w", resolveDirIdentitySync(root));
      assert.equal(result.repository?.head, head);
      assert.equal(result.repository?.commits[0].subject, "真实中文提交");
    }
    assert.equal(fs.existsSync(marker), false);
    fs.renameSync(kit.root, `${kit.root}-old`); fs.mkdirSync(kit.root);
    await assert.rejects(readWorkspaceGit("w", kit.identity), fails("workspace_directory_changed"));
  } finally { kit.close(); }
});

test("Git 查询不枚举与提交无关的元数据目录", async context => {
  const kit = fixture();
  try {
    kit.init(); runGit(kit.root, "commit", "--allow-empty", "-qm", "base");
    fs.mkdirSync(path.join(kit.root, ".git", "gui-cache"));
    fs.writeFileSync(path.join(kit.root, ".git", "gui-cache", "unrelated"), "");
    context.mock.method(fs, "opendirSync", () => { throw new Error("历史查询不应枚举整个 Git 目录"); });
    syncBuiltinESMExports();
    assert.equal((await readWorkspaceGit("w", kit.identity)).repository?.commits.length, 1);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); kit.close(); }
});

test("Git 目录、gitdir 与 commondir 支持链接形式，坏指针仍明确拒绝", async () => {
  const kit = fixture();
  try {
    kit.init(); runGit(kit.root, "commit", "--allow-empty", "-qm", "base");
    const head = runGit(kit.root, "rev-parse", "HEAD"), marker = path.join(kit.root, ".git"), metadata = path.join(kit.parent, "metadata");
    fs.renameSync(marker, metadata); fs.symlinkSync(metadata, marker);
    assert.equal((await readWorkspaceGit("w", kit.identity)).repository?.head, head);
    fs.unlinkSync(marker); fs.writeFileSync(marker, `gitdir: ${metadata}\n`);
    const pointer = path.join(kit.parent, "gitdir"); fs.linkSync(marker, pointer);
    assert.equal((await readWorkspaceGit("w", kit.identity)).repository?.head, head);
    fs.unlinkSync(marker); fs.symlinkSync(pointer, marker);
    assert.equal((await readWorkspaceGit("w", kit.identity)).repository?.head, head);
    const worktree = path.join(kit.parent, "copy"); runGit(kit.root, "worktree", "add", "--detach", "-q", worktree, "HEAD");
    const gitDir = runGit(worktree, "rev-parse", "--git-dir"), common = path.join(gitDir, "commondir");
    fs.renameSync(common, `${common}.saved`); fs.symlinkSync("commondir.saved", common);
    assert.equal((await readWorkspaceGit("copy", resolveDirIdentitySync(worktree))).repository?.head, head);
    fs.writeFileSync(pointer, "not a gitdir pointer\n");
    await assert.rejects(readWorkspaceGit("w", kit.identity), fails("workspace_git_unsafe"));
  } finally { kit.close(); }
});

function history(root: string, count: number): string[] {
  const tree = runGit(root, "mktree"), ids: string[] = [];
  for (let index = 0; index < count; index++) ids.push(runGit(root, "commit-tree", tree, ...(ids.length ? ["-p", ids.at(-1)!] : []), "-m", `commit ${index}`));
  runGit(root, "update-ref", "refs/heads/main", ids.at(-1)!);
  return ids;
}

test("Git 游标绑定 HEAD 链接的分支身份，即使两个分支指向同一提交", async () => {
  const kit = fixture();
  try {
    kit.init(); history(kit.root, WORKSPACE_GIT_COMMITS + 1);
    runGit(kit.root, "branch", "other");
    const head = path.join(kit.root, ".git", "HEAD");
    fs.unlinkSync(head); fs.symlinkSync("refs/heads/main", head);
    const first = (await readWorkspaceGit("w", kit.identity)).repository!;
    assert.ok(first.nextCursor);
    fs.unlinkSync(head); fs.symlinkSync("refs/heads/other", head);
    await assert.rejects(readWorkspaceGit("w", kit.identity, first.nextCursor), fails("workspace_git_changed"));
  } finally { kit.close(); }
});

test("Git include 的 remote 变化淘汰游标，等价 alternates 对象库可继续分页", async () => {
  const kit = fixture();
  try {
    kit.init(); history(kit.root, WORKSPACE_GIT_COMMITS + 1);
    const shared = path.join(kit.parent, "shared"), include = path.join(kit.parent, "include");
    runGit(kit.parent, "clone", "--shared", "-q", kit.root, shared);
    runGit(shared, "config", "--file", include, "remote.first.url", "https://example.invalid/first");
    runGit(shared, "config", "include.path", include);
    const identity = resolveDirIdentitySync(shared), first = (await readWorkspaceGit("w", identity)).repository!;
    assert.ok(first.nextCursor);
    runGit(shared, "config", "--file", include, "--rename-section", "remote.first", "remote.second");
    await assert.rejects(readWorkspaceGit("w", identity, first.nextCursor), fails("workspace_git_changed"));
    const current = (await readWorkspaceGit("w", identity)).repository!;
    const objects = path.join(kit.parent, "objects"); fs.cpSync(path.join(kit.root, ".git", "objects"), objects, { recursive: true });
    fs.writeFileSync(path.join(shared, ".git", "objects", "info", "alternates"), `${objects}\n`);
    const last = (await readWorkspaceGit("w", identity, current.nextCursor!)).repository!;
    assert.equal(current.commits.length + last.commits.length, WORKSPACE_GIT_COMMITS + 1);
    assert.equal(last.nextCursor, null);
  } finally { kit.close(); }
});

test("超过400条真实历史可连续分页到根提交，跨页分支合并无重复遗漏", async () => {
  const kit = fixture();
  try {
    kit.init(); const ids = history(kit.root, WORKSPACE_GIT_COMMITS * 2 + 3), tree = runGit(kit.root, "mktree");
    const feature = runGit(kit.root, "commit-tree", tree, "-p", ids[WORKSPACE_GIT_COMMITS - 1], "-m", "branch across pages");
    const merge = runGit(kit.root, "commit-tree", tree, "-p", ids.at(-1)!, "-p", feature, "-m", "merge across pages");
    runGit(kit.root, "update-ref", "refs/heads/main", merge); runGit(kit.root, "update-ref", "refs/heads/feature", feature);
    const expected = runGit(kit.root, "log", "--all", "--topo-order", "--format=%H").split("\n");
    const commits: string[] = []; let cursor: string | undefined, pages = 0;
    do {
      const page = await readWorkspaceGit("w", kit.identity, cursor);
      assert.ok(page.repository); assert.ok(page.repository.commits.length <= WORKSPACE_GIT_COMMITS);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < MAX_FRAME_BYTES);
      commits.push(...page.repository.commits.map(commit => commit.id));
      cursor = page.repository.nextCursor ?? undefined; pages++;
      assert.ok(pages < 10, "有限夹具应到达尾页");
    } while (cursor);
    assert.equal(pages, 3); assert.ok(commits.length > 400);
    assert.deepEqual(commits, expected); assert.equal(new Set(commits).size, commits.length); assert.equal(commits.at(-1), ids[0]);
  } finally { kit.close(); }
});

test("Git游标绑定全部refs、HEAD、shallow、Git身份和工作区，非仓库也拒绝旧游标", async () => {
  const kit = fixture();
  try {
    kit.init(); const ids = history(kit.root, WORKSPACE_GIT_COMMITS + 1);
    runGit(kit.root, "update-ref", "refs/heads/alias", ids.at(-1)!);
    const cursor = (await readWorkspaceGit("w", kit.identity)).repository!.nextCursor!;
    for (const ref of ["refs/custom/history", "refs/stash", "refs/notes/commits"]) {
      runGit(kit.root, "update-ref", ref, ids[0]);
      await assert.rejects(readWorkspaceGit("w", kit.identity, cursor), fails("workspace_git_changed"));
      runGit(kit.root, "update-ref", "-d", ref);
    }
    runGit(kit.root, "symbolic-ref", "HEAD", "refs/heads/alias");
    await assert.rejects(readWorkspaceGit("w", kit.identity, cursor), fails("workspace_git_changed"));
    runGit(kit.root, "symbolic-ref", "HEAD", "refs/heads/main");
    fs.writeFileSync(path.join(kit.root, ".git", "shallow"), ids[0] + "\n");
    await assert.rejects(readWorkspaceGit("w", kit.identity, cursor), fails("workspace_git_changed"));
    fs.unlinkSync(path.join(kit.root, ".git", "shallow"));
    await assert.rejects(readWorkspaceGit("other", kit.identity, cursor), fails("workspace_git_changed"));
    const moved = path.join(kit.parent, "old-git"); fs.renameSync(path.join(kit.root, ".git"), moved);
    await assert.rejects(readWorkspaceGit("w", kit.identity, cursor), fails("workspace_git_changed"));
    fs.cpSync(moved, path.join(kit.root, ".git"), { recursive: true });
    await assert.rejects(readWorkspaceGit("w", kit.identity, cursor), fails("workspace_git_changed"));
    for (const invalid of ["", "%%%", "x".repeat(257), Buffer.from(JSON.stringify({ offset: -1, revision: "a".repeat(64) })).toString("base64url"), Buffer.from(JSON.stringify({ offset: 200, revision: "a".repeat(64), args: [] })).toString("base64url")]) await assert.rejects(readWorkspaceGit("w", kit.identity, invalid), fails("invalid_params"));
  } finally { kit.close(); }
});

test("worktree分页游标同时绑定外部common Git目录身份", async () => {
  const kit = fixture();
  try {
    kit.init(); history(kit.root, WORKSPACE_GIT_COMMITS + 1);
    const worktree = path.join(kit.parent, "copy"); runGit(kit.root, "worktree", "add", "--detach", "-q", worktree, "HEAD");
    const identity = resolveDirIdentitySync(worktree), cursor = (await readWorkspaceGit("copy", identity)).repository!.nextCursor!;
    const original = path.join(kit.parent, "common-old"); fs.renameSync(path.join(kit.root, ".git"), original);
    fs.cpSync(original, path.join(kit.root, ".git"), { recursive: true });
    await assert.rejects(readWorkspaceGit("copy", identity, cursor), fails("workspace_git_changed"));
  } finally { kit.close(); }
});

for (const worktree of [false, true]) test(`grafts跨页变化淘汰旧游标，保留稳定grafts支持：${worktree ? "common Git目录" : "普通仓库"}`, async () => {
  const kit = fixture();
  try {
    kit.init(); const ids = history(kit.root, WORKSPACE_GIT_COMMITS + 3);
    const root = worktree ? path.join(kit.parent, "copy") : kit.root;
    if (worktree) runGit(kit.root, "worktree", "add", "--detach", "-q", root, "HEAD");
    const identity = resolveDirIdentitySync(root), first = (await readWorkspaceGit("w", identity)).repository!;
    assert.equal(first.commits.length, WORKSPACE_GIT_COMMITS); assert.ok(first.nextCursor);
    const grafts = path.join(kit.root, ".git", "info", "grafts"); fs.writeFileSync(grafts, ids[100] + "\n");
    assert.equal(Number(runGit(root, "--no-replace-objects", "rev-list", "--all", "--count")), 103);
    await assert.rejects(readWorkspaceGit("w", identity, first.nextCursor), fails("workspace_git_changed"));
    const refreshed = (await readWorkspaceGit("w", identity)).repository!;
    assert.equal(refreshed.commits.length, 103); assert.equal(refreshed.nextCursor, null);
    fs.writeFileSync(grafts, ids[1] + "\n");
    const stable = (await readWorkspaceGit("w", identity)).repository!;
    assert.ok(stable.nextCursor);
    const last = (await readWorkspaceGit("w", identity, stable.nextCursor)).repository!;
    assert.equal(stable.commits.length + last.commits.length, WORKSPACE_GIT_COMMITS + 2); assert.equal(last.nextCursor, null);
  } finally { kit.close(); }
});

test("同一页log返回后grafts变化也返回changed", async () => {
  const kit = fixture(), original = process.env;
  try {
    kit.init(); const ids = history(kit.root, 3), realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    const bin = path.join(kit.parent, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const fs=require('node:fs');const args=process.argv.slice(2);const result=spawnSync(${JSON.stringify(realGit)},args,{encoding:'utf8'});if(args.includes('log'))fs.writeFileSync(${JSON.stringify(path.join(kit.root, ".git", "info", "grafts"))},${JSON.stringify(ids[1] + "\n")});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);\n`, { mode: 0o755 });
    process.env = { ...original, PATH: bin };
    await assert.rejects(readWorkspaceGit("w", kit.identity), fails("workspace_git_changed"));
  } finally { process.env = original; kit.close(); }
});

test("同一页读取期间refs变化返回changed，不把不同修订拼入历史", async () => {
  const kit = fixture(), original = process.env;
  try {
    kit.init(); runGit(kit.root, "commit", "--allow-empty", "-qm", "base");
    const head = runGit(kit.root, "rev-parse", "HEAD"), realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    const bin = path.join(kit.parent, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);const result=spawnSync(${JSON.stringify(realGit)},args,{encoding:'utf8'});if(args.includes('log'))spawnSync(${JSON.stringify(realGit)},[${JSON.stringify(`--git-dir=${path.join(kit.root, ".git")}`)},'update-ref','refs/custom/changed',${JSON.stringify(head)}]);process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);\n`, { mode: 0o755 });
    process.env = { ...original, PATH: bin };
    await assert.rejects(readWorkspaceGit("w", kit.identity), fails("workspace_git_changed"));
  } finally { process.env = original; kit.close(); }
});

for (const kind of ["missing", "failed", "invalid", "limit", "timeout"] as const) test(`Git ${kind} 失败有可判别 code 且不泄漏 stderr`, async () => {
  const kit = fixture();
  const original = process.env;
  try {
    kit.init();
    const bin = path.join(kit.parent, "bin"); fs.mkdirSync(bin);
    const script = kind === "failed" ? "process.stderr.write('PRIVATE_PATH'); process.exit(128)" : kind === "invalid" ? "process.stdout.write('invalid')" : kind === "limit" ? `process.stdout.write('a'.repeat(${WORKSPACE_GIT_OUTPUT_BYTES + 4096}))` : "setTimeout(() => {}, 20000)";
    if (kind !== "missing") fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
    process.env = { ...original, PATH: bin };
    await assert.rejects(readWorkspaceGit("w", kit.identity), (error: unknown) => fails(`workspace_git_${kind === "failed" ? "unavailable" : kind}`)(error) && error instanceof Error && !error.message.includes("PRIVATE_PATH") && !error.message.includes(kit.parent));
  } finally { process.env = original; kit.close(); }
});

test("拥有者 Git 查询不受 Agent 保护目录限制，仍拒绝额外路径与命令参数", async context => {
  const kit = await startTestRuntime("desktop-git", () => ({ kind: "text", text: "不应调用" }));
  try {
    runGit(kit.work[0], "init", "-q", "-b", "main"); runGit(kit.work[0], "commit", "--allow-empty", "-qm", "owner history");
    const opened = await kit.client.request<OpResult<"open_workspace">>("open_workspace", { cwd: kit.work[0], request_id: "workspace-git" });
    const protectedRoots = kit.runtime.protectedRoots(), readdir = fs.readdirSync;
    context.mock.method(fs, "readdirSync", (...args: Parameters<typeof readdir>) => {
      assert.ok(!protectedRoots.some(root => String(args[0]) === root || String(args[0]).startsWith(`${root}${path.sep}`)), "拥有者 Git 查询不应枚举无关保护树");
      return readdir(...args);
    });
    syncBuiltinESMExports();
    context.mock.method(kit.runtime, "protectedRoots", () => [fs.realpathSync(kit.work[0])]);
    const result = await kit.client.request<OpResult<"read_workspace_git">>("read_workspace_git", { workspace_id: opened.session.projectId });
    assert.equal(result.repository?.commits[0].subject, "owner history");
    history(kit.work[0], WORKSPACE_GIT_COMMITS + 1);
    const first = await kit.client.request<OpResult<"read_workspace_git">>("read_workspace_git", { workspace_id: opened.session.projectId });
    assert.ok(first.repository?.nextCursor);
    const second = await kit.client.request<OpResult<"read_workspace_git">>("read_workspace_git", { workspace_id: opened.session.projectId, cursor: first.repository.nextCursor });
    assert.equal(first.repository.commits.length + second.repository!.commits.length, WORKSPACE_GIT_COMMITS + 1);
    assert.equal(second.repository!.nextCursor, null);
    const wireFails = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;
    for (const extra of [{ path: kit.work[1] }, { args: ["--exec=unsafe"] }, { limit: 0 }, { cursor: 4 }, { cursor: null }, { cursor: "not-a-cursor" }]) await assert.rejects(kit.client.request("read_workspace_git", { workspace_id: opened.session.projectId, ...extra }), wireFails("invalid_params"));
    await assert.rejects(kit.client.request("read_workspace_git", { workspace_id: "missing" }), wireFails("workspace_not_found"));
    assert.equal(kit.server.calls.length, 0);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await kit.shutdown(); }
});
