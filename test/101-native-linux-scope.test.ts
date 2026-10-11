/** cgroup 成员证据不足时必须保留未核实停止。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { linuxNativeScopeEmpty } from "@ruukoto/agent/execution/native-linux.ts";

test("Linux scope 只接受已知组的完整空成员证据或确认删除", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-scope-evidence-"));
  const group = path.join(root, "scope");
  fs.mkdirSync(group);
  try {
    assert.equal(linuxNativeScopeEmpty(null), false);
    assert.equal(linuxNativeScopeEmpty(group), false, "组存在但缺少 cgroup.events 不能证明为空");
    fs.writeFileSync(path.join(group, "cgroup.events"), "populated 1\nfrozen 0\n");
    assert.equal(linuxNativeScopeEmpty(group), false);
    fs.writeFileSync(path.join(group, "cgroup.events"), "populated 01\nfrozen 0\n");
    assert.equal(linuxNativeScopeEmpty(group), false, "不能用子串匹配成员状态");
    fs.writeFileSync(path.join(group, "cgroup.events"), "populated 0\nfrozen 0\n");
    assert.equal(linuxNativeScopeEmpty(group), true);
    fs.rmSync(path.join(group, "cgroup.events"));
    fs.mkdirSync(path.join(group, "cgroup.events"));
    assert.equal(linuxNativeScopeEmpty(group), false, "读取失败不能证明为空");
    fs.rmSync(group, { recursive: true });
    assert.equal(linuxNativeScopeEmpty(group), true, "已知组目录已删除");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
