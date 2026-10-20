import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { parsePersonalTools, readPersonalTools, savePersonalTools, personalSystemPath } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";

const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
for (const committed of [false, true]) test(`资料配置：写盘失败保留${committed ? "原配置" : "待保存私有文件"}，再次保存可恢复`, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-tools-config-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stat = fs.statSync(workspace), original = parsePersonalTools({ version: 1, generation: "first", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
  if (committed) await savePersonalTools(directory, original);
  const next = { ...original, generation: "next" };
  const nodeFs = createRequire(import.meta.url)("node:fs") as typeof fs;
  t.mock.method(nodeFs, "fsyncSync", () => { throw new Error("测试磁盘失败"); });
  syncBuiltinESMExports();
  await assert.rejects(savePersonalTools(directory, next), code("tools_config_write_failed"));
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.ok(fs.existsSync(path.join(directory, "tools.json.tmp")));
  const before = lockPersonalProfile(directory);
  try { assert.deepEqual(readPersonalTools(before), committed ? original : undefined); } finally { before.release(); }
  await savePersonalTools(directory, next);
  const profile = lockPersonalProfile(directory);
  try { assert.deepEqual(readPersonalTools(profile), next); } finally { profile.release(); }
});

test("资料配置：非法凭据host返回类型化错误，系统执行与设备路径明确排除", () => {
  const config = { version: 1, generation: "test", workspace: "/tmp", identity: { dev: 1, ino: 2 }, credentials: [{ name: "key", host: "invalid:port", header: "authorization", env: "HTTP_KEY" }] };
  assert.throws(() => parsePersonalTools(config), code("tools_config_invalid"));
  for (const target of ["/", "/proc", "/proc/self/environ", "/sys/kernel", "/dev/fd/1"]) assert.equal(personalSystemPath(target), true);
});
