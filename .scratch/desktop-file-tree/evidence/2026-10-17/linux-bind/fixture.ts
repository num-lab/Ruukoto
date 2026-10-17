import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { listWorkspaceFiles } from "./packages/runtime/src/workspace-files.ts";
import { resolveDirIdentitySync } from "@ruukoto/core/dir-identity.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const base = "/tmp/ruukoto-directory-bind";
const workspace = path.join(base, "workspace");
const protectedRoot = path.join(base, "protected");
const protectedChild = path.join(protectedRoot, "nested");
const rootAlias = path.join(base, "root-alias");
const childAlias = path.join(workspace, "alias");
const dynamicAlias = path.join(protectedRoot, "new-relation");
for (const dir of [workspace, protectedChild, rootAlias, childAlias, dynamicAlias]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(workspace, "ordinary.txt"), "ordinary\n");
fs.writeFileSync(path.join(protectedChild, "secret.txt"), "fixture-only\n");
const mounted: string[] = [];
const checks: Array<Record<string, unknown>> = [];
function mount(source: string, target: string): void {
  const result = spawnSync("mount", ["--bind", source, target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  mounted.push(target);
}
function unmount(): void {
  const target = mounted.pop();
  assert.ok(target);
  const result = spawnSync("umount", [target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
function rejected(root: string, relative: string, label: string): void {
  const identity = resolveDirIdentitySync(root);
  let observed = "";
  assert.throws(() => listWorkspaceFiles("fixture-workspace", identity, relative, [protectedRoot]), cause => {
    if (!(cause instanceof RuntimeApiError)) return false;
    observed = cause.code;
    return cause.code === "workspace_path_unsafe";
  });
  checks.push({ label, result: "passed", code: observed });
}
try {
  const ordinary = listWorkspaceFiles("fixture-workspace", resolveDirIdentitySync(workspace), "", [protectedRoot]);
  assert.ok(ordinary.entries.some(entry => entry.name === "ordinary.txt"));
  checks.push({ label: "ordinary-directory-allowed", result: "passed", entries: ordinary.entries });

  mount(protectedChild, rootAlias);
  assert.equal(fs.statSync(rootAlias).ino, fs.statSync(protectedChild).ino);
  rejected(rootAlias, "", "protected-subdirectory-bind-as-workspace-root-denied");
  unmount();

  mount(protectedChild, childAlias);
  assert.equal(fs.statSync(childAlias).ino, fs.statSync(protectedChild).ino);
  rejected(workspace, "alias", "protected-subdirectory-bind-as-workspace-child-denied");
  unmount();

  const originalOpen = fs.opendirSync;
  let injected = false;
  const beforeIdentity = resolveDirIdentitySync(workspace);
  fs.opendirSync = function (target, options) {
    const directory = originalOpen(target, options);
    if (String(target) === workspace) {
      const originalRead = directory.readSync.bind(directory);
      directory.readSync = function () {
        const entry = originalRead();
        if (!injected) {
          injected = true;
          mount(workspace, dynamicAlias);
        }
        return entry;
      };
    }
    return directory;
  };
  syncBuiltinESMExports();
  try {
    rejected(workspace, "", "new-protected-bind-relation-during-read-denied");
  } finally {
    fs.opendirSync = originalOpen;
    syncBuiltinESMExports();
  }
  assert.ok(injected);
  const afterIdentity = resolveDirIdentitySync(workspace);
  assert.equal(beforeIdentity.dev, afterIdentity.dev);
  assert.equal(beforeIdentity.ino, afterIdentity.ino);
  checks.push({ label: "workspace-identity-remained-stable-during-mount", result: "passed" });
  unmount();
  const changing = path.join(protectedRoot, "stale-file-kind");
  fs.writeFileSync(changing, "stale-file-kind\n");
  const originalReaddir = fs.readdirSync;
  let staleKindInjected = false;
  fs.readdirSync = function (target, options) {
    const entries = originalReaddir(target, options);
    if (String(target) === protectedRoot && !staleKindInjected && options && typeof options === "object" && options.withFileTypes) {
      const classified = entries.find(entry => typeof entry !== "string" && entry.name === "stale-file-kind");
      assert.ok(classified && typeof classified !== "string" && classified.isFile());
      fs.unlinkSync(changing);
      fs.mkdirSync(changing);
      mount(workspace, changing);
      assert.ok(fs.statSync(changing).isDirectory());
      assert.equal(fs.statSync(changing).ino, fs.statSync(workspace).ino);
      staleKindInjected = true;
    }
    return entries;
  };
  syncBuiltinESMExports();
  try {
    rejected(workspace, "", "stale-file-dirent-replaced-with-directory-bind-denied");
  } finally {
    fs.readdirSync = originalReaddir;
    syncBuiltinESMExports();
  }
  assert.ok(staleKindInjected);
  unmount();
  fs.rmdirSync(changing);
  const after = listWorkspaceFiles("fixture-workspace", resolveDirIdentitySync(workspace), "", [protectedRoot]);
  assert.deepEqual(after, ordinary);
  checks.push({ label: "ordinary-directory-allowed-after-unmount", result: "passed" });
  process.stdout.write(JSON.stringify({ platform: process.platform, node: process.version, checks, remainingMounts: mounted.length }, null, 2) + "\n");
} finally {
  while (mounted.length) unmount();
  fs.rmSync(base, { recursive: true, force: true });
}
