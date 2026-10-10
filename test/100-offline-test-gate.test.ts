import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

test("离线检查的 RUN_MODEL_CHECK=0 必须跳过真实模型，不能按非空字符串开启", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-offline-gate-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", "verification/foundation/test/07-connectivity.test.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"), RUN_MODEL_CHECK: "0" },
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.error, undefined, `模型门禁检查未正常退出：${result.error?.message}`);
    assert.equal(result.status, 0, `离线开关不得执行模型：${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /# SKIP 设置 RUN_MODEL_CHECK=1/, "必须由运行器确认真实模型用例已跳过");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
