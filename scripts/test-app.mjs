import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Note: 见 .agents/notes/implemented/testing/2026-10-13-workflow-joint-acceptance.md
// Note: 见 .agents/notes/implemented/testing/2026-10-22-ci-prerequisites.md
// shortcut: 只隔离已证实会碰撞的同 UID 全局夹具；新增同类用例时更新此清单。
const MACOS_EXCLUSIVE = ["test/100-worker-stop.test.ts", "test/101-native-macos-helper.test.ts", "test/background-processes-recovery.test.ts", "test/background-processes.test.ts", "test/native-macos-identity.test.ts"];

export function appTestBatches(files, platform) {
  if (files.length === 0) throw new Error("没有发现应用测试；请恢复完整检出并从仓库根运行");
  if (platform !== "darwin") return [{ files: [...files], serial: false }];
  for (const file of MACOS_EXCLUSIVE) {
    if (!files.includes(file)) throw new Error(`缺少 macOS 独占测试 ${file}；请恢复完整检出`);
  }
  return [
    { files: [...MACOS_EXCLUSIVE], serial: true },
    { files: files.filter(file => !MACOS_EXCLUSIVE.includes(file)), serial: false },
  ].filter(batch => batch.files.length > 0);
}

function runAppTests() {
  const files = fs.readdirSync("test").filter(file => file.endsWith(".test.ts")).sort().map(file => `test/${file}`);
  for (const batch of appTestBatches(files, process.platform)) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${batch.serial ? 1 : 2}`, ...batch.files], {
      env: { ...process.env, RUN_MODEL_CHECK: "0", RUN_BACKGROUND_BROWSER_CHECK: "0" }, stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.signal) {
      process.stderr.write(`[ruukoto:test] 应用测试因 ${result.signal} 终止；剩余批次未运行\n`);
      process.exitCode = 1;
      process.kill(process.pid, result.signal);
      return;
    }
    if (result.status === null) throw new Error("应用测试未报告退出码；剩余批次未运行，请核实子进程状态");
    if (result.status !== 0) {
      process.stderr.write(`[ruukoto:test] 应用测试退出码 ${result.status}；剩余批次未运行\n`);
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
