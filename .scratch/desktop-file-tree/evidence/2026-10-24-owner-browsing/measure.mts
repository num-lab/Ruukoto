import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { startTestRuntime } from "../../../../test/helpers/testkit.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";

const target = path.resolve(process.argv[2]);
const content = fs.readFileSync(target);
const kit = await startTestRuntime("owner-browse-perf", () => ({ kind: "text", text: "不应调用" }));
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function measure<K extends TuiOp>(label: string, op: K, params: OpParams<K>): Promise<OpResult<K>> {
  const start = performance.now();
  const result = await kit.client.request<OpResult<K>>(op, params);
  print({ label, ms: +(performance.now() - start).toFixed(3) });
  return result;
}
try {
  const opened = await kit.client.request<OpResult<"open_workspace">>("open_workspace", { cwd: path.dirname(target), request_id: "performance-files" });
  const params = { workspace_id: opened.session.projectId };
  print({ bytes: content.length, lines: content.toString().split("\n").length, transport: "isolated-control-socket", startupExcluded: true });
  for (let round = 0; round < 3; round++) {
    await measure(`directory-${round}`, "list_workspace_files", params);
    const file = await measure(`file-${round}`, "read_workspace_file", { ...params, path: path.basename(target) });
    assert.deepEqual(Buffer.from(file.data, "base64"), content);
    await measure(`git-detect-${round}`, "read_workspace_git", params);
  }
  await Promise.all([
    measure("concurrent-file", "read_workspace_file", { ...params, path: path.basename(target) }),
    measure("concurrent-lightweight", "list_session_summaries", params),
  ]);
  const git = (...args: string[]) => execFileSync("git", ["-C", kit.work[0], ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
  const repository = await kit.client.request<OpResult<"open_workspace">>("open_workspace", { cwd: kit.work[0], request_id: "performance-git" });
  for (let round = 0; round < 3; round++) {
    const result = await measure(`git-one-commit-${round}`, "read_workspace_git", { workspace_id: repository.session.projectId });
    assert.equal(result.repository?.commits.length, 1);
  }
  assert.equal(kit.server.calls.length, 0);
} finally { await kit.shutdown(); }
