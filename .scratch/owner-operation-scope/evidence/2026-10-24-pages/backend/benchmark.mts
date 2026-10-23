import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listWorkspaceFiles } from "@ruukoto/runtime/workspace-files.ts";
import { resolveDirIdentitySync } from "@ruukoto/core/dir-identity.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-directory-page-bench-"));
try {
  for (let index = 11_999; index >= 0; index--) fs.writeFileSync(path.join(root, `file-${String(index).padStart(5, "0")}`), "");
  const identity = resolveDirIdentitySync(root);
  const rounds: { round: number; page: string; elapsedMs: number; timerTicks: number; entries: number }[] = [];
  for (let round = 0; round < 3; round++) {
    let cursor: string | undefined;
    for (const page of ["first", "next"]) {
      let timerTicks = 0;
      const timer = setInterval(() => { timerTicks++; }, 0), start = performance.now();
      const result = await listWorkspaceFiles("bench", identity, "", cursor);
      clearInterval(timer);
      const elapsedMs = performance.now() - start;
      assert.equal(result.entries.length, 200);
      assert.equal(result.entries[0].name, page === "first" ? "file-00000" : "file-00200");
      assert.ok(result.nextCursor);
      assert.ok(timerTicks > 0);
      cursor = result.nextCursor;
      rounds.push({ round: round + 1, page, elapsedMs, timerTicks, entries: result.entries.length });
    }
  }
  process.stdout.write(`${JSON.stringify({ platform: process.platform, node: process.version, count: 12_000, rounds }, null, 2)}\n`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
