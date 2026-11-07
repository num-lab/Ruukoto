import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Note: See .agents/notes/implemented/testing/2026-11-07-ci-shards-and-fixtures.md
// shortcut: Only proven same-UID conflicts are isolated; extend this list when another fixture collides.
const MACOS_EXCLUSIVE = ["test/100-worker-stop.test.ts", "test/101-native-macos-helper.test.ts", "test/background-processes-recovery.test.ts", "test/background-processes.test.ts", "test/native-macos-identity.test.ts"];

export function appTestBatches(files, platform, shard = "1/1") {
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error("Invalid shard; use --shard=index/total (1-based)");
  const [index, total] = shard.split("/").map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) throw new Error("Invalid shard; require 1 <= index <= total");
  if (files.length === 0) throw new Error("No application tests found; restore the full checkout and run from the repository root");
  const exclusive = platform === "darwin" ? MACOS_EXCLUSIVE : [];
  for (const file of exclusive) {
    if (!files.includes(file)) throw new Error(`Missing macOS exclusive test ${file}; restore the full checkout`);
  }
  const ordinary = files.filter(file => !exclusive.includes(file));
  const batches = [
    { files: index === 1 ? [...exclusive] : [], serial: true },
    { files: ordinary.filter((_, position) => position % total === index - 1), serial: false },
  ].filter(batch => batch.files.length > 0);
  if (batches.length === 0) throw new Error(`Shard ${shard} has no application tests; reduce the shard count`);
  return batches;
}

function runAppTests() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !args[0].startsWith("--shard="))) throw new Error("Usage: npm run test:app [-- --shard=index/total]");
  const files = fs.readdirSync("test").filter(file => file.endsWith(".test.ts")).sort().map(file => `test/${file}`);
  for (const batch of appTestBatches(files, process.platform, args[0]?.slice("--shard=".length))) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${batch.serial ? 1 : 2}`, ...batch.files], {
      env: { ...process.env, RUN_MODEL_CHECK: "0", RUN_BACKGROUND_BROWSER_CHECK: "0" }, stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.signal) {
      process.stderr.write(`[ruukoto:test] Application tests terminated by ${result.signal}; remaining batches did not run\n`);
      process.exitCode = 1;
      process.kill(process.pid, result.signal);
      return;
    }
    if (result.status === null) throw new Error("Application tests reported no exit status; remaining batches did not run, inspect the child process");
    if (result.status !== 0) {
      process.stderr.write(`[ruukoto:test] Application tests exited with ${result.status}; remaining batches did not run\n`);
      process.exitCode = result.status;
      return;
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runAppTests();
  } catch (error) {
    process.stderr.write(`[ruukoto:test] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
