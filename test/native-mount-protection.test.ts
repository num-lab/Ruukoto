import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { prepareNativeLaunch, type PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";

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
