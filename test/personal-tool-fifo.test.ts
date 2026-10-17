import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { preparePersonalFile, executePersonalFile } from "../apps/ruukoto/src/personal-tool-io.ts";
import { executeApprovedFileOp } from "@ruukoto/agent/execution/approved-ops.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";

const operations = ["prepare", "read", "approved-read"] as const;
const operation = process.argv[2];
if (operations.some(value => value === operation)) {
  const filename = process.argv[3], prepared = operation === "prepare" ? undefined : preparePersonalFile({ path: filename, access: "read", protectedRoots: [] });
  const open = nodeFs.openSync;
  let swapped = false;
  nodeFs.openSync = (target, ...args) => {
    if (!swapped && target === filename) {
      swapped = true;
      fs.renameSync(filename, filename + ".original");
      execFileSync("mkfifo", [filename]);
    }
    return open(target, ...args);
  };
  syncBuiltinESMExports();
  if (operation === "prepare") assert.throws(() => preparePersonalFile({ path: filename, access: "read", protectedRoots: [] }), PersonalError);
  else if (operation === "read") assert.equal(executePersonalFile(prepared!).effect, "not_executed");
  else assert.equal(executeApprovedFileOp(prepared!).ok, false);
  assert.equal(swapped, true);
} else {
  for (const operation of operations) test(`文件竞态：${operation} 打开前换成真实 FIFO，立即拒绝而不阻塞宿主`, () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk29-fifo-"))), filename = path.join(root, "target"), self = fileURLToPath(import.meta.url);
    fs.writeFileSync(filename, "original");
    try {
      // 竞态发生在同步 open 内；独立进程保留超时反例，避免回归挂住整个测试宿主。
      const child = spawnSync(process.execPath, [...(self.endsWith(".ts") ? ["--import", "tsx"] : []), self, operation, filename], { encoding: "utf8", timeout: 5000 });
      assert.equal(child.error, undefined, `${child.error?.message}\n${child.stderr}`);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(fs.readFileSync(filename + ".original", "utf8"), "original");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
