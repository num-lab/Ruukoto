import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { preparePersonalCommand, runPersonalCommand, readPersonalCommandOutput } from "../../../../apps/ruukoto/src/personal-command-execution.ts";
import { verifyPersonalCommandConfig } from "../../../../apps/ruukoto/src/personal-command-config.ts";

assert.equal(process.platform, "linux");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-operation-modes-")));
const profile = path.join(root, "profile"), workspace = path.join(root, "workspace"), directory = path.join(profile, "commands");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(profile, 0o700); fs.mkdirSync(workspace, { mode: 0o700 });
const stat = fs.statSync(workspace), machineId = fs.readFileSync("/etc/machine-id", "utf8").trim();
const config = { version: 1 as const, workspace, identity: { dev: stat.dev, ino: stat.ino }, machineId, tmpdir: fs.realpathSync(os.tmpdir()) };
const native = { workerPath: fileURLToPath(new URL("../../../../worker/personal-command-worker.mjs", import.meta.url)), dependencyRoots: [], protectedRoots: [profile] };
for (const mode of ["confirm", "auto-review", "full_access"] as const) {
  verifyPersonalCommandConfig(config, profile, mode);
  const spec: LaunchSpec = { taskId: `verify-${mode}`, mode, workspace, workspaceIdentity: config.identity, grantedPaths: [] };
  const input = await preparePersonalCommand(native, spec);
  const ref = { executionId: `native_${randomBytes(12).toString("hex")}`, machineId };
  const result = await runPersonalCommand({ directory, ref, command: "printf verified", spec, input, timeoutMs: 15_000 });
  assert.equal(result.receipt.exit.code, 0); assert.equal(result.exited, true);
  const output = await readPersonalCommandOutput(directory, ref, result.receipt.fingerprint, "stdout");
  assert.equal(Buffer.from(output.data, "base64").toString(), "verified");
  process.stdout.write(`${JSON.stringify({ mode, exitCode: result.receipt.exit.code, exited: result.exited, output: "verified" })}\n`);
}
const protectedStat = fs.statSync(profile);
await assert.rejects(preparePersonalCommand(native, { taskId: "protected", mode: "confirm", workspace: profile, workspaceIdentity: { dev: protectedStat.dev, ino: protectedStat.ino }, grantedPaths: [] }), { code: "execution_unavailable" });
process.stdout.write(`${JSON.stringify({ restrictedProtectedRootRejected: true, fixture: root })}\n`);
