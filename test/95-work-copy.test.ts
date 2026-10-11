import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Session, WorkDelegation, WorkWriteTarget } from "@ruukoto/core/types.ts";
import { assertWorktreeGrantAllowed, WorkCopyError, WorkCopyManager } from "@ruukoto/runtime/work-copy.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";

const HASH = "0123456789abcdef0123456789abcdef01234567";

test("并行汇总使用各自临时资料，另一项工作的 patch 不会被读取或套用", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-integrate-parallel-")));
  const temp = path.join(root, "tmp");
  const bin = path.join(root, "bin");
  fs.mkdirSync(temp);
  fs.mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  // 两份 patch 都已写出后才允许汇总继续，稳定复现共享固定路径的污染。
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = --numstat ]; then
    touch "$BARRIER_MARKER"
    tries=0
    until [ -f "$BARRIER_PEER" ]; do
      tries=$((tries + 1))
      [ "$tries" -lt 500 ] || exit 1
      sleep 0.01
    done
  fi
done
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
  const execute = promisify(execFile);
  const manager = new WorkCopyManager({
    worktreeRoot: path.join(root, "copies"),
    protectedRoots: () => [],
    execute: async (input) => {
      const name = path.basename(input.workspace);
      const { stdout } = await execute("bash", ["-c", input.command], {
        cwd: input.workspace,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp, REAL_GIT: realGit,
          BARRIER_MARKER: path.join(root, name + ".ready"),
          BARRIER_PEER: path.join(root, (name === "left" ? "right" : "left") + ".ready") },
        timeout: 10_000,
      });
      return { isError: false, content: stdout };
    },
  });
  try {
    const inputs: Array<Parameters<WorkCopyManager["integrate"]>[0]> = [];
    for (const name of ["left", "right"]) {
      const repo = path.join(root, name);
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, "value.txt"), "base\n");
      initGitRepo(repo);
      const stat = fs.statSync(repo);
      const session = { id: name, cwdReal: repo, cwdDev: stat.dev, cwdIno: stat.ino } as Session;
      const target = await manager.prepareWriteTarget(".", session, name, "parent-" + name);
      assert.ok(target.kind === "worktree");
      fs.writeFileSync(path.join(target.path, "value.txt"), name + "\n");
      inputs.push({ work: { id: name } as WorkDelegation, target, parentSession: session, parentTaskId: "parent-" + name });
    }
    const results = await Promise.all(inputs.map((input) => manager.integrate(input)));
    assert.deepEqual(results.map((result) => result.state), ["applied", "applied"]);
    for (const name of ["left", "right"]) {
      assert.equal(fs.readFileSync(path.join(root, name, "value.txt"), "utf8"), name + "\n");
    }
    const directories = fs.readdirSync(temp);
    assert.equal(directories.length, 2);
    assert.notEqual(directories[0], directories[1]);
    for (const directory of directories) assert.equal(fs.statSync(path.join(temp, directory)).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-work-copy-")));
  const worktreeRoot = path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(gitDir);
  const stat = fs.statSync(root);
  const session = { id: "parent", cwdReal: root, cwdDev: stat.dev, cwdIno: stat.ino } as Session;
  let output = "";
  const calls: { parentTaskId: string; command: string }[] = [];
  const manager = new WorkCopyManager({
    worktreeRoot,
    protectedRoots: () => [`${root}-protected`],
    execute: async (input) => {
      calls.push({ parentTaskId: input.parentTaskId, command: input.command });
      const workId = path.basename(input.copyDir);
      const gitdir = path.join(gitDir, "worktrees", workId);
      fs.mkdirSync(gitdir, { recursive: true });
      fs.writeFileSync(path.join(input.copyDir, ".git"), `gitdir: ${gitdir}\n`);
      return { isError: false, content: output };
    },
  });
  return { root, worktreeRoot, gitDir, session, manager, calls, setOutput: (value: string) => { output = value; }, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(worktreeRoot, { recursive: true, force: true }); } };
}

test("工作副本保护读写授权的路径边界", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-grant-")));
  const worktreeRoot = path.join(root, "worktrees");
  const child = path.join(worktreeRoot, "w1");
  const evil = `${worktreeRoot}-evil`;
  fs.mkdirSync(child, { recursive: true });
  try {
    assert.throws(() => assertWorktreeGrantAllowed(worktreeRoot, "read_write", worktreeRoot));
    assert.throws(() => assertWorktreeGrantAllowed(child, "read_write", worktreeRoot));
    assert.throws(() => assertWorktreeGrantAllowed(path.dirname(worktreeRoot), "read_write", worktreeRoot));
    assert.doesNotThrow(() => assertWorktreeGrantAllowed(worktreeRoot, "read", worktreeRoot));
    assert.doesNotThrow(() => assertWorktreeGrantAllowed(child, "read", worktreeRoot));
    assert.doesNotThrow(() => assertWorktreeGrantAllowed(evil, "read_write", worktreeRoot));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("工作副本创建失败保留现场、成功钉定基线与副本身份", async () => {
  const f = fixture();
  try {
    f.setOutput(HASH);
    const target = await f.manager.prepareWriteTarget(".", f.session, "w1", "parent-task");
    assert.equal(target.kind, "worktree");
    assert.equal(target.baseCommit, HASH);
    assert.equal(fs.existsSync(target.path), true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].parentTaskId, "parent-task");

    const failed = new WorkCopyManager({
      worktreeRoot: path.join(path.dirname(f.root), `${path.basename(f.root)}-failed-worktrees`),
      protectedRoots: () => [],
      execute: async () => ({ isError: true, errorMessage: "container failed", content: "" }),
    });
    await assert.rejects(() => failed.prepareWriteTarget(".", f.session, "failed", "parent-task"), (err: WorkCopyError) => {
      assert.equal(err.code, "worktree_failed");
      assert.match(err.message, /路径 .*failed/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(path.dirname(f.root), `${path.basename(f.root)}-failed-worktrees`, "failed")), true);
    fs.rmSync(path.join(path.dirname(f.root), `${path.basename(f.root)}-failed-worktrees`), { recursive: true, force: true });
  } finally {
    f.cleanup();
  }
});

test("副本身份被替换时拒绝继续使用", async () => {
  const f = fixture();
  try {
    f.setOutput(HASH);
    const target = await f.manager.prepareWriteTarget(".", f.session, "w1", "parent-task") as Extract<WorkWriteTarget, { kind: "worktree" }>;
    fs.rmSync(target.path, { recursive: true, force: true });
    fs.mkdirSync(target.path);
    assert.throws(() => f.manager.assertCopy({ id: "work-1" } as WorkDelegation, target, "请新建委派"), (err: WorkCopyError) => err.code === "worktree_gone");
  } finally {
    f.cleanup();
  }
});

test("汇总解析 applied、already、empty、conflict 与损坏输出", async () => {
  for (const [state, extra] of [
    ["applied", `RUUKOTO_HEAD=${HASH}\nRUUKOTO_PATCH_BYTES=12\n2\t1\tsrc/a.ts\n`],
    ["already", `RUUKOTO_HEAD=${HASH}\nRUUKOTO_PATCH_BYTES=12\n2\t1\tsrc/a.ts\n`],
    ["empty", ""],
    ["conflict", `patch failed\nRUUKOTO_HEAD=${HASH}\nRUUKOTO_PATCH_BYTES=12\n-\t1\tsrc/a.ts\n`],
    ["conflict", "unexpected output"],
  ] as const) {
    const f = fixture();
    try {
      f.setOutput(`${HASH}\nRUUKOTO_STATE=${state}\n${extra}`);
      const target = await f.manager.prepareWriteTarget(".", f.session, "w1", "parent-task") as Extract<WorkWriteTarget, { kind: "worktree" }>;
      const result = await f.manager.integrate({
        work: { id: "work-1" } as WorkDelegation,
        target,
        parentSession: f.session,
        parentTaskId: "integrating-parent-task",
      });
      assert.equal(result.state, state);
      assert.equal(f.calls[1].parentTaskId, "integrating-parent-task");
      if (state === "applied") assert.deepEqual([result.filesChanged, result.insertions, result.deletions], [1, 2, 1]);
    } finally {
      f.cleanup();
    }
  }
});
