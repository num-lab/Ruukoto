import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  fs.mkdirSync(new URL("../worker/", import.meta.url), { recursive: true });
  const result = spawnSync("/usr/bin/clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
    "packages/agent/src/execution/native-macos-supervisor.c", "-framework", "ApplicationServices", "-o", "worker/native-macos-supervisor",
  ], { cwd: root, stdio: "inherit" });
  if (result.error) process.stderr.write(`[ruukoto:build] macOS 原生监督器编译失败：${result.error.message}\n`);
  process.exitCode = result.error ? 1 : result.status ?? 1;
}
