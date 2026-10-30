import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("scratch 的普通暂存只带工单、结论和源码，不带原始运行产物", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ruukoto-scratch-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: join(root, "global-config"), GIT_CONFIG_NOSYSTEM: "1" });
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  copyFileSync(new URL("../.gitignore", import.meta.url), join(root, ".gitignore"));

  const retained = [".scratch/example/spec.md", ".scratch/example/issues/01-work.md", ".scratch/example/evidence/result.md", ".scratch/example/evidence/repro.mts", ".scratch/example/evidence/nested/repro.py", ".scratch/demo/package.json"];
  const raw = [".scratch/example/check.log", ".scratch/example/run.stdout", ".scratch/example/run.stderr", ".scratch/example/source.tar.gz", ".scratch/example/records.tgz", ".scratch/example/evidence/nested/screenshot.png", ".scratch/example/snapshot.sqlite", ".scratch/example/snapshot.sqlite-wal", ".scratch/example/evidence/request.json", ".scratch/example/evidence/nested/session.jsonl", ".scratch/example/evidence/output.txt"];
  for (const file of [...retained, ...raw]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "fixture\n");
  }
  git(["add", "--", ".scratch"]);
  assert.deepEqual(git(["ls-files", "-z"]).split("\0").filter(Boolean).sort(), retained.sort());
  const rejected = spawnSync("git", ["add", "--", raw[0]], { cwd: root, env, encoding: "utf8" });
  assert.equal(rejected.status, 1, "显式添加被忽略的原始输出也须拒绝，不能依赖通配暂存恰好漏掉它");

  git(["add", "-f", "--", raw[0]]);
  writeFileSync(join(root, raw[0]), "changed fixture\n");
  git(["add", "--", raw[0]]);
  assert.equal(git(["show", `:${raw[0]}`]), "changed fixture\n", "忽略规则不取消已有文件的跟踪，也不声称能阻止强制添加");
});
