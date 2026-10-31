import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("retired scratch content stays out of ordinary staging", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ruukoto-repository-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: join(root, "global-config"), GIT_CONFIG_NOSYSTEM: "1" });
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  copyFileSync(join(repository, ".gitignore"), join(root, ".gitignore"));
  const retained = ["test/fixtures/input.json", "verification/demo/package.json"];
  const ignored = [".scratch/example/spec.md", ".scratch/example/issues/01-work.md", ".scratch/example/evidence/repro.mts", ".scratch/example/evidence/capture.png"];
  for (const file of [...retained, ...ignored]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "fixture\n");
  }
  git(["add", "--all"]);
  assert.deepEqual(git(["ls-files", "-z"]).split("\0").filter(Boolean).sort(), [".gitignore", ...retained].sort());
  assert.equal(spawnSync("git", ["add", "--", ignored[0]], { cwd: root, env }).status, 1);
});

test("the current tree has no retired work-tracking directories", () => {
  for (const path of [".scratch", "docs/agents", "docs/postmortem"]) assert.equal(existsSync(join(repository, path)), false, path);
  const tracked = execFileSync("git", ["ls-files", "--", ".scratch"], { cwd: repository, encoding: "utf8" });
  assert.equal(tracked, "", "stage the removal of retired scratch content");
});

test("approved desktop baselines retain their pre-migration bytes", () => {
  const root = join(repository, "test/fixtures/desktop-baselines");
  const manifest: Record<string, string> = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.ok(Object.keys(manifest).length > 0);
  for (const [path, hash] of Object.entries(manifest)) {
    assert.equal(createHash("sha256").update(readFileSync(join(root, path))).digest("hex"), hash, path);
  }
});

test("documentation gates cover relocated postmortems", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ruukoto-doc-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, ".agents/postmortem"), { recursive: true });
  mkdirSync(join(root, "apps"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  for (const file of ["markdown-scan.ts", "verify-md-links.ts", "verify-md-wrap.ts", "verify-doc-refs.ts"]) copyFileSync(join(repository, "scripts", file), join(root, "scripts", file));
  const run = (script: string) => spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: root, encoding: "utf8" });
  const postmortem = join(root, ".agents/postmortem/example.md");
  writeFileSync(postmortem, "# Example\n\n[Missing](absent.md)\n");
  const brokenLink = run("verify-md-links.ts");
  assert.equal(brokenLink.status, 1, brokenLink.stderr);
  assert.match(brokenLink.stderr, /\.agents\/postmortem\/example\.md/);
  writeFileSync(postmortem, "# Example\n\nA paragraph\nwith hard wrapping.\n");
  const wrapped = run("verify-md-wrap.ts");
  assert.equal(wrapped.status, 1, wrapped.stderr);
  assert.match(wrapped.stderr, /\.agents\/postmortem\/example\.md/);
  writeFileSync(postmortem, "# Example\n\nA single-line paragraph.\n");
  writeFileSync(join(root, "apps/example.ts"), "// See .agents/postmortem/absent.md\n");
  const brokenReference = run("verify-doc-refs.ts");
  assert.equal(brokenReference.status, 1, brokenReference.stderr);
  assert.match(brokenReference.stderr, /\.agents\/postmortem\/absent\.md/);
  writeFileSync(join(root, "apps/example.ts"), "// See .agents/postmortem/example.md\n");
  for (const script of ["verify-md-links.ts", "verify-md-wrap.ts", "verify-doc-refs.ts"]) {
    const result = run(script);
    assert.equal(result.status, 0, result.stderr);
  }
});
