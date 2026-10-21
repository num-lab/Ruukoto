/** 策略输入与产品接线回归；真实 OS 拒绝与停止另由原生探针和 smoke 证明。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ExecutionError, createLauncherFor, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { assertNativeFileLinks, prepareNativeLaunch, NATIVE_WORKER_PATH, type PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";
import { nativeNetworkFilter, linuxNativeArgs } from "@ruukoto/agent/execution/native-linux.ts";
import { macosNativeProfile } from "@ruukoto/agent/execution/native-macos.ts";
import { resolveFileSearchExecutable } from "@ruukoto/agent/tool-worker/file-search.ts";

test("macOS 身份有界重查只接受明确退出或完整身份，持续权限失败与损坏字段拒绝", { skip: process.platform !== "darwin" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-identity-check-")), binary = path.join(directory, "check");
  try {
    execFileSync("/usr/bin/clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", fileURLToPath(new URL("./fixtures/native-identity-check.c", import.meta.url)),
      "-I", fileURLToPath(new URL("../", import.meta.url)), "-o", binary], { encoding: "utf8", timeout: 30_000 });
    assert.match(execFileSync(binary, [], { encoding: "utf8", timeout: 5_000 }), /七项身份重查与拒绝检查通过/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function filterResult(filter: Buffer, arch: number, syscall: number): number {
  let value = 0;
  for (let pc = 0; pc * 8 < filter.length; pc++) {
    const offset = pc * 8, code = filter.readUInt16LE(offset), key = filter.readUInt32LE(offset + 4);
    if (code === 0x20) value = key === 4 ? arch : syscall;
    else if (code === 0x15) pc += filter[offset + (value === key ? 2 : 3)];
    else if (code === 0x45) pc += filter[offset + ((value & key) !== 0 ? 2 : 3)];
    else if (code === 0x06) return key;
    else assert.fail("未知 BPF 指令");
  }
  assert.fail("BPF 没有返回判定");
}

test("原生网络过滤拒绝路径 socket、socketpair 外发、io_uring 与另一 ABI，并保留 libuv 管道", () => {
  for (const [name, arch, calls, socketpair] of [
    ["x64", 0xc000003e, [41, 42, 44, 46, 307, 425], 53],
    ["arm64", 0xc00000b7, [198, 203, 206, 211, 269, 425], 199],
  ] as const) {
    const filter = nativeNetworkFilter(name);
    for (const syscall of calls) assert.equal(filterResult(filter, arch, syscall), 0x00050001);
    assert.equal(filterResult(filter, arch, socketpair), 0x7fff0000);
    assert.equal(filterResult(filter, arch, 0), 0x7fff0000);
    assert.equal(filterResult(filter, 0x40000003, 0), 0x80000000);
    assert.equal(filterResult(filter, arch, 0x40000000 | 41), 0x80000000);
  }
  assert.throws(() => nativeNetworkFilter("unknown"), error => error instanceof ExecutionError && error.code === "execution_unavailable");
});

test("native 完全访问使用启动账户，库层 local 仍可注入", () => {
  assert.equal(createLauncherFor({ backend: "native" }, "confirm").kind, "native");
  assert.equal(createLauncherFor({ backend: "native" }, "auto-review").kind, "native");
  assert.equal(createLauncherFor({ backend: "native" }, "full_access").kind, "local");
  assert.equal(createLauncherFor({ backend: "local" }, "confirm").kind, "local");
});

test("硬链接的所有名字须在同权限授权内；工作区内合法链接保留，外部与只读别名拒绝", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-links-")));
  const workspace = path.join(root, "work"), readonly = path.join(workspace, "readonly"), outside = path.join(root, "private");
  fs.mkdirSync(readonly, { recursive: true }); fs.mkdirSync(outside);
  const source = path.join(workspace, "source"), alias = path.join(workspace, "alias");
  fs.writeFileSync(source, "virtual"); fs.linkSync(source, alias);
  const mounts: PreparedNativeLaunch["mounts"] = [{ path: workspace, access: "read_write" }];
  const unavailable = (error: unknown): boolean => error instanceof ExecutionError && error.code === "execution_unavailable";
  try {
    assert.doesNotThrow(() => assertNativeFileLinks(mounts));
    if (process.platform === "linux") {
      const rawPath = Buffer.concat([Buffer.from(workspace + "/"), Buffer.from([0xff])]);
      fs.writeFileSync(rawPath, "原字节路径");
      assert.doesNotThrow(() => assertNativeFileLinks(mounts), "文件别名核实不能先把非 UTF-8 文件名替换成其他路径");
    }
    assert.doesNotThrow(() => assertNativeFileLinks([...mounts, { path: source, access: "read_write" }]));
    fs.linkSync(source, path.join(outside, "secret"));
    assert.throws(() => assertNativeFileLinks(mounts), unavailable);
    if (process.platform === "darwin") {
      const volumeAlias = "/System/Volumes/Data" + workspace;
      if (fs.existsSync(volumeAlias)) {
        assert.throws(() => assertNativeFileLinks([...mounts, { path: volumeAlias, access: "read_write" }]), unavailable);
        assert.throws(() => assertNativeFileLinks([...mounts, { path: path.join(volumeAlias, "source"), access: "read_write" }]), unavailable);
      }
      const caseAlias = path.join(workspace, "SOURCE");
      if (fs.existsSync(caseAlias)) assert.throws(() => assertNativeFileLinks([...mounts, { path: caseAlias, access: "read_write" }]), unavailable);
    }
    fs.unlinkSync(path.join(outside, "secret"));
    fs.linkSync(source, path.join(readonly, "material"));
    assert.throws(() => assertNativeFileLinks([...mounts, { path: readonly, access: "read" }]), unavailable);
    assert.doesNotThrow(() => assertNativeFileLinks([{ path: workspace, access: "read" }]));
    fs.symlinkSync(path.join(outside, "missing"), path.join(workspace, "escape"));
    assert.doesNotThrow(() => assertNativeFileLinks(mounts));
    assert.throws(() => assertNativeFileLinks([{ path: path.join(root, "missing"), access: "read" }]), { code: "ENOENT" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("原生授权规范化、保护根、嵌套只读、目录身份与环境拒绝在创建单元前完成", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-input-")));
  const workspace = path.join(root, "work"), readonly = path.join(workspace, "readonly"), protectedRoot = path.join(root, "private");
  fs.mkdirSync(readonly, { recursive: true }); fs.mkdirSync(protectedRoot);
  const stat = fs.statSync(workspace);
  const spec: LaunchSpec = { taskId: "test-native", mode: "confirm", workspace,
    workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [{ path: readonly, access: "read", purpose: "资料" }] };
  const prepared: PreparedNativeLaunch[] = [];
  const priorPath = process.env.PATH;
  const unavailable = (error: unknown): boolean => error instanceof ExecutionError && error.code === "execution_unavailable";
  try {
    const first = await prepareNativeLaunch({ protectedRoots: [protectedRoot] }, spec);
    prepared.push(first);
    const rg = resolveFileSearchExecutable()!;
    assert.ok(rg, "环境前提须已有 rg");
    assert.ok(first.runtimeReadRoots.some(root => rg === root || rg.startsWith(root + path.sep)), "原生依赖开放宿主已解析 rg 的实际安装位置");
    const second = await prepareNativeLaunch({ protectedRoots: [protectedRoot] }, spec);
    prepared.push(second);
    const codeRoot = fs.realpathSync(fileURLToPath(new URL("../", import.meta.url)));
    await assert.rejects(prepareNativeLaunch({ protectedRoots: [codeRoot, NATIVE_WORKER_PATH] }, spec), unavailable);
    await assert.rejects(prepareNativeLaunch({ protectedRoots: [codeRoot], dependencyRoots: [path.join(codeRoot, "node_modules")] }, spec), unavailable);
    assert.notEqual(first.tempDir, second.tempDir);
    assert.equal(fs.statSync(first.tempDir).mode & 0o777, 0o700);
    assert.equal(first.env.HOME, path.join(first.tempDir, "home"));
    assert.equal(first.env.TMPDIR, path.join(first.tempDir, "tmp"));
    assert.deepEqual(Object.keys(first.env).sort(), ["GIT_CONFIG_NOSYSTEM", "HOME", "LANG", "PATH", "TMPDIR"]);
    assert.ok(!first.runtimeReadRoots.includes(os.homedir()));
    assert.ok(first.runtimeReadRoots.some(p => path.basename(p) === "node_modules"));
    const profile = macosNativeProfile(first);
    assert.ok(profile.includes(`(deny file-write* (subpath ${JSON.stringify(readonly)}))`));
    assert.ok(profile.includes("(deny default)"));
    const args = linuxNativeArgs(first);
    assert.ok(args.indexOf("--tmpfs") < args.indexOf("--ro-bind"), "临时文件系统先创建，不能遮蔽临时目录中的运行依赖");
    assert.ok(args.indexOf(workspace) < args.indexOf(readonly), "可写父根先挂，嵌套只读后挂");
    await assert.rejects(prepareNativeLaunch({ protectedRoots: [protectedRoot] }, { ...spec, workspace: root }), unavailable);
    await assert.rejects(prepareNativeLaunch({}, { ...spec, workspaceIdentity: { dev: -1, ino: -1 } }), unavailable);
    await assert.rejects(prepareNativeLaunch({}, { ...spec, workspaceIdentity: undefined }), unavailable);
    await assert.rejects(prepareNativeLaunch({}, { ...spec, readRoots: [{ path: readonly, dev: -1, ino: -1 }] }), unavailable);
    await assert.rejects(prepareNativeLaunch({}, { ...spec, grantedPaths: [...spec.grantedPaths, { path: readonly, access: "read_write", purpose: "冲突" }] }), unavailable);
    await assert.rejects(prepareNativeLaunch({}, { ...spec, env: { SSH_AUTH_SOCK: "/virtual-agent" } }), unavailable);
    fs.symlinkSync(workspace, path.join(root, "alias"));
    await assert.rejects(prepareNativeLaunch({}, { ...spec, workspace: path.join(root, "alias") }), unavailable);
    await assert.rejects(prepareNativeLaunch({ workerPath: path.join(root, "missing-worker") }, spec),
      error => unavailable(error) && (error as ExecutionError).reason === "binary_missing");
    const tools = path.join(root, "custom", "bin");
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(tools, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(path.join(root, "custom", "virtual-private"), "virtual-token");
    process.env.PATH = `${tools}${path.delimiter}${priorPath ?? ""}`;
    const limited = await prepareNativeLaunch({}, spec); prepared.push(limited);
    assert.ok(limited.runtimeReadRoots.includes(path.join(tools, "git")));
    assert.ok(!limited.runtimeReadRoots.includes(path.dirname(tools)), "未知 bin 不开放其资料父目录");
    await assert.rejects(prepareNativeLaunch({ protectedRoots: [path.dirname(tools)] }, spec), unavailable);
    const sensitive = path.join(protectedRoot, "material");
    fs.writeFileSync(sensitive, "virtual-token");
    const alias = path.join(workspace, "same-object"); fs.linkSync(sensitive, alias);
    await assert.rejects(prepareNativeLaunch({ protectedRoots: [sensitive] }, {
      ...spec, grantedPaths: [{ path: alias, access: "read", purpose: "同 inode 的另一名字" }],
    }), unavailable);
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    for (const input of prepared) fs.rmSync(input.tempDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
