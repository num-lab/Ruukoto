import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { prepareNativeLaunch, type PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";
import { selectSkillReadRoots } from "@ruukoto/agent/execution/skill-roots.ts";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-mount-protection-")));
  const workspace = path.join(root, "workspace"), grant = path.join(root, "grant"), readRoot = path.join(root, "read-root");
  const protectedRoot = path.join(root, "private"), nested = path.join(protectedRoot, "nested"), workerPath = path.join(root, "worker.mjs");
  for (const target of [workspace, grant, readRoot, nested]) fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(nested, "secret"), "fixture only");
  fs.writeFileSync(workerPath, "process.exit(0);\n");
  const stat = fs.statSync(workspace);
  const spec: LaunchSpec = { taskId: "native-mount-protection", mode: "confirm", workspace,
    workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [{ path: grant, access: "read", purpose: "资料" }], readRoots: [{ path: readRoot }] };
  const prepared: PreparedNativeLaunch[] = [];
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const input of prepared) fs.rmSync(input.tempDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prepare = async (input = spec) => {
    const result = await prepareNativeLaunch({ workerPath, dependencyRoots: [], protectedRoots: [protectedRoot] }, input);
    prepared.push(result);
    return result;
  };
  return { spec, protectedRoot, nested, prepare };
}

test("原生启动将工作区、授予与只读根批量核对，保护树不按挂载数量重复扫描", async t => {
  const f = fixture(t), readdir = t.mock.method(fs, "readdirSync");
  syncBuiltinESMExports();
  const prepared = await f.prepare();
  assert.equal(prepared.mounts.length, 3);
  for (const directory of [f.protectedRoot, f.nested]) {
    assert.equal(readdir.mock.calls.filter(call => call.arguments[0] === directory).length, 2, "显式挂载和运行依赖各独立扫描一次");
  }
});

for (const source of ["workspace", "grant", "readRoot"] as const) test(`原生批量挂载仍在创建单元前拒绝受保护的 ${source}`, async t => {
  const f = fixture(t), spec = structuredClone(f.spec), stat = fs.statSync(f.nested);
  if (source === "workspace") {
    spec.workspace = f.nested;
    spec.workspaceIdentity = { dev: stat.dev, ino: stat.ino };
  } else if (source === "grant") spec.grantedPaths.push({ path: f.nested, access: "read", purpose: "受保护资料" });
  else spec.readRoots!.push({ path: f.nested, dev: stat.dev, ino: stat.ino });
  await assert.rejects(f.prepare(spec), error => error instanceof ExecutionError && error.code === "execution_unavailable" && error.reason === "sandbox_rejected" && error.unit === undefined);
});

// Note: 见 .agents/notes/implemented/feature/2026-10-29-skill-script-execution.md
function skillFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-roots-")));
  const workspace = path.join(root, "parent", "workspace"), good = path.join(root, "skills", "good");
  const linked = path.join(root, "skills", "linked"), bad = path.join(root, "skills", "bad");
  const covered = path.join(workspace, "skill-inside"), protectedDir = path.join(root, "protected"), outside = path.join(root, "outside");
  for (const dir of [workspace, good, linked, bad, covered, protectedDir, outside]) fs.mkdirSync(dir, { recursive: true });
  return { root, workspace, good, linked, bad, covered, protectedDir, outside, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("技能根选择：realpath 去重、覆盖保持原权限、HOME/可写根/受保护/缺失/漂移逐技能隔离", () => {
  const f = skillFixture();
  try {
    const alias = path.join(f.root, "alias");
    fs.symlinkSync(f.good, alias);
    const mounts = [{ path: f.workspace, access: "read_write" as const }];
    const result = selectSkillReadRoots({
      candidates: [
        { name: "good", dir: f.good },
        { name: "dup", dir: f.good },
        { name: "alias", dir: alias },
        { name: "covered", dir: f.covered },
        { name: "home", dir: os.homedir() },
        { name: "missing", dir: path.join(f.root, "gone") },
        { name: "protected", dir: f.protectedDir },
        { name: "conflict", dir: path.dirname(f.workspace) },
        { name: "linked", dir: f.linked },
      ],
      mounts, protectedRoots: [f.protectedDir], checkAliases: true,
    });
    assert.deepEqual(result.roots.map(root => root.path).sort(), [f.good, f.linked].sort());
    const stat = fs.statSync(f.good);
    assert.deepEqual(result.roots.find(root => root.path === f.good), { path: f.good, dev: stat.dev, ino: stat.ino });
    const reasons = new Map(result.unavailable.map(entry => [entry.name, entry.reason]));
    assert.deepEqual([...reasons.keys()].sort(), ["alias", "conflict", "home", "missing", "protected"]);
    assert.match(reasons.get("alias")!, /真实路径已变化/);
    assert.match(reasons.get("conflict")!, /可写根/);
    assert.match(reasons.get("home")!, /HOME/);
    assert.match(reasons.get("missing")!, /缺失/);
    assert.match(reasons.get("protected")!, /受保护/);
    // 原授权集合自身失效不折算成技能不可用：原样上抛
    assert.throws(() => selectSkillReadRoots({ candidates: [{ name: "good", dir: f.good }], mounts: [{ path: path.join(f.root, "gone"), access: "read_write" }], protectedRoots: [], checkAliases: true }));
  } finally {
    f.cleanup();
  }
});

test("技能根选择：跨已授权技能目录的合法硬链接不误伤，越出别名按技能隔离", () => {
  const f = skillFixture();
  try {
    fs.writeFileSync(path.join(f.good, "shared.txt"), "x");
    fs.linkSync(path.join(f.good, "shared.txt"), path.join(f.linked, "shared.txt"));
    fs.writeFileSync(path.join(f.outside, "hidden.txt"), "y");
    fs.linkSync(path.join(f.outside, "hidden.txt"), path.join(f.bad, "c.txt"));
    const result = selectSkillReadRoots({
      candidates: [{ name: "good", dir: f.good }, { name: "linked", dir: f.linked }, { name: "bad", dir: f.bad }],
      mounts: [{ path: f.workspace, access: "read_write" }], protectedRoots: [], checkAliases: true,
    });
    assert.deepEqual(result.roots.map(root => root.path).sort(), [f.good, f.linked].sort(), "两棵已授权目录间的合法硬链接采纳");
    assert.deepEqual(result.unavailable, [{ name: "bad", reason: "技能目录文件别名不安全" }], "越出一半条目的别名按技能隔离");
    // 原授权集合自身的别名不安全：原样上抛而非技能不可用
    assert.throws(() => selectSkillReadRoots({ candidates: [{ name: "good", dir: f.good }], mounts: [{ path: f.workspace, access: "read_write" }, { path: f.bad, access: "read" }], protectedRoots: [], checkAliases: true }), (error: unknown) => error instanceof ExecutionError);
  } finally {
    f.cleanup();
  }
});

test("技能根选择：checkAliases=false 不核实别名（本地启动器不追加根，仅共享逻辑可复用）", () => {
  const f = skillFixture();
  try {
    fs.writeFileSync(path.join(f.outside, "hidden.txt"), "y");
    fs.linkSync(path.join(f.outside, "hidden.txt"), path.join(f.bad, "c.txt"));
    const result = selectSkillReadRoots({
      candidates: [{ name: "bad", dir: f.bad }],
      mounts: [{ path: f.workspace, access: "read_write" }], protectedRoots: [], checkAliases: false,
    });
    assert.deepEqual(result.roots.map(root => root.path), [f.bad]);
    assert.deepEqual(result.unavailable, []);
  } finally {
    f.cleanup();
  }
});
