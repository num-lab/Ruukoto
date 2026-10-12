/** cgroup 成员证据不足时必须保留未核实停止。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import nodeFs from "node:fs";
import childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import { launchLinuxNative, linuxNativeScopeEmpty } from "@ruukoto/agent/execution/native-linux.ts";

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

for (const missing of ["scope-group", "writable-kill"] as const) {
  test(`Linux manager 可用但缺 ${missing} 时拒绝并保留停止身份`, async context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-scope-policy-"));
    const marker = new PassThrough();
    const child = Object.assign(new childProcess.ChildProcess(), { pid: 999999, stdin: new PassThrough(),
      stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, null, marker] });
    const access = nodeFs.accessSync, exists = nodeFs.existsSync;
    let scope = "", launches = 0, killChecked = false;
    context.mock.method(nodeFs, "accessSync", (target: fs.PathLike, mode?: number) => {
      if (["/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl"].includes(String(target))) return;
      if (String(target).endsWith("/cgroup.kill")) {
        assert.equal(mode, fs.constants.W_OK);
        killChecked = true;
        throw Object.assign(new Error("验证 cgroup.kill 无写权限"), { code: "EACCES" });
      }
      return access(target, mode);
    });
    context.mock.method(nodeFs, "existsSync", (target: fs.PathLike) => {
      if (String(target) === "/sys/fs/cgroup/cgroup.controllers") return true;
      if (String(target) === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns") return false;
      return exists(target);
    });
    context.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
      const group = missing === "scope-group" ? "" : `/user.slice/user-999.slice/user@999.service/app.slice/${scope}`;
      callback(null, args.includes("is-system-running") ? "running\n" : `LoadState=loaded\nActiveState=active\nControlGroup=${group}\n`, "");
      return new childProcess.ChildProcess();
    });
    context.mock.method(childProcess, "spawn", (_file: string, args: readonly string[]) => {
      launches++;
      assert.equal(_file, "/usr/bin/systemd-run");
      assert.ok(args.includes("Delegate=yes"));
      scope = args[args.indexOf("--unit") + 1];
      setImmediate(() => marker.end("started\n"));
      return child;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(launchLinuxNative({ workspace: root, mounts: [], runtimeReadRoots: [], toolAliases: [], env: {},
        tempDir: root, nodePath: process.execPath, workerPath: path.join(root, "worker.mjs") }, {
        taskId: "missing-cgroup-policy", mode: "confirm", workspace: root, grantedPaths: [],
      }), error => {
        assert.ok(error instanceof ExecutionError && error.code === "execution_unavailable" && error.reason === "policy_missing");
        assert.equal(error.unit?.entry.kind, "systemd_unit");
        assert.equal(error.unit?.entry.id, scope);
        assert.equal(typeof error.unit?.entry.stop, "function");
        return true;
      });
      assert.equal(launches, 1, "缺能力不能启动替代执行环境");
      assert.equal(killChecked, missing === "writable-kill");
    } finally {
      child.emit("exit", 0, null);
      marker.destroy(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      context.mock.restoreAll(); syncBuiltinESMExports();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
