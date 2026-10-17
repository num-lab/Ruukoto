import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { preparePersonalFile, executePersonalFile } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-tool-io.ts";

const phase = process.argv[2];
if (["prepare", "execute"].includes(phase)) {
  const filename = process.argv[3];
  const prepared = phase === "execute" ? preparePersonalFile({ path: filename, access: "read", protectedRoots: [] }) : undefined;
  const open = nodeFs.openSync;
  let swapped = false;
  nodeFs.openSync = (target, ...args) => {
    if (!swapped && target === filename) {
      swapped = true;
      fs.renameSync(filename, filename + ".original");
      execFileSync("mkfifo", [filename]);
      process.stdout.write("swapped-to-real-fifo\n");
    }
    return open(target, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = prepared ? executePersonalFile(prepared) : preparePersonalFile({ path: filename, access: "read", protectedRoots: [] });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ code: error.code }) + "\n"); }
} else {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk29-fifo-review-"))), results = [];
  try {
    for (const operation of ["prepare", "execute"]) {
      const filename = path.join(root, operation); fs.writeFileSync(filename, "original");
      const child = spawnSync(process.execPath, [process.argv[1], operation, filename], { encoding: "utf8", timeout: 1000 });
      const blocked = child.error?.code === "ETIMEDOUT";
      results.push({ operation, blocked, code: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr });
      assert.equal(blocked, phase === "before", operation);
      assert.match(child.stdout, /swapped-to-real-fifo/);
    }
    process.stdout.write(JSON.stringify({ phase, node: process.version, platform: process.platform, results }, null, 2) + "\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
