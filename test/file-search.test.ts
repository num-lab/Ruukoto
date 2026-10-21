import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import { createLocalLauncher, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { createNativeLauncher } from "@ruukoto/agent/execution/native.ts";
import { FILE_SEARCH_BYTES, type FileSearchResult } from "@ruukoto/agent/file-search.ts";

async function fixture(options: { fake?: string; scope?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-search-")));
  const work = path.join(root, "work"), granted = path.join(root, "granted");
  fs.mkdirSync(work); fs.mkdirSync(granted);
  fs.writeFileSync(path.join(work, "sample.txt"), "Needle literal.*\nneedle lower\nliteralXYZ\n");
  const previous = process.env.PATH;
  if (options.fake !== undefined) {
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    if (options.fake) fs.writeFileSync(path.join(bin, "rg"), `#!${process.execPath}\n${options.fake}\n`, { mode: 0o755 });
    process.env.PATH = bin;
  }
  const stat = fs.statSync(work);
  const spec: LaunchSpec = { taskId: "search-test", mode: options.scope ? "confirm" : "full_access", workspace: work,
    workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [{ path: granted, access: "read", purpose: "测试资料" }] };
  let host: ToolWorkerHost;
  try { host = await ToolWorkerHost.start(createLocalLauncher(), spec); }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  let n = 0;
  const call = async (name: "list_files" | "search_files", params: Record<string, unknown> = {}) => {
    const streams = new Map<string, Buffer[]>();
    const response = await host.call({ opId: `op-${++n}`, sdkCallId: `sdk-${n}`, name, params, timeoutMs: 20_000,
      onData: (stream, chunk) => { const chunks = streams.get(stream) ?? []; chunks.push(chunk); streams.set(stream, chunks); } });
    return { response, result: response.details as FileSearchResult, stream: (name = "file_search") => Buffer.concat(streams.get(name) ?? []) };
  };
  return { root, work, granted, host, call, cleanup: async () => { assert.equal(await host.stop(), true); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("实际 worker：字面/大小写/glob 与根内过滤；忽略父级、全局及 rg 配置", async () => {
  const previous = { config: process.env.RIPGREP_CONFIG_PATH, git: process.env.GIT_CONFIG_GLOBAL };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "search-config-"));
  fs.writeFileSync(path.join(directory, "rg-config"), "--hidden\n--glob=!sample.txt\n");
  fs.writeFileSync(path.join(directory, "global-ignore"), "global.txt\n");
  fs.writeFileSync(path.join(directory, "gitconfig"), `[core]\nexcludesFile = ${path.join(directory, "global-ignore")}\n`);
  process.env.RIPGREP_CONFIG_PATH = path.join(directory, "rg-config"); process.env.GIT_CONFIG_GLOBAL = path.join(directory, "gitconfig");
  const f = await fixture({ scope: true });
  try {
    fs.writeFileSync(path.join(f.root, ".ignore"), "parent.txt\n");
    fs.writeFileSync(path.join(f.work, ".gitignore"), "ignored.txt\n");
    for (const name of ["parent.txt", "global.txt", "ignored.txt", ".hidden.txt", "line\nbreak.txt"]) fs.writeFileSync(path.join(f.work, name), "needle literal.*\n");
    fs.writeFileSync(path.join(f.work, "binary.txt"), Buffer.from("needle\0secret"));
    fs.symlinkSync(f.granted, path.join(f.work, "linked")); fs.writeFileSync(path.join(f.granted, "outside.txt"), "needle");
    const list = (await f.call("list_files")).result;
    assert.equal(list.scanComplete, true); assert.equal(list.partial, false);
    assert.deepEqual(list.entries.map(entry => entry.path).sort(), ["global.txt", "line\nbreak.txt", "parent.txt", "sample.txt"]);
    const glob = (await f.call("list_files", { glob: "*.txt" })).result;
    assert.ok(glob.entries.some(entry => entry.path === ".hidden.txt")); assert.ok(glob.entries.some(entry => entry.path === "ignored.txt"));
    assert.ok(!glob.entries.some(entry => /binary|linked|outside/.test(entry.path)));
    const exact = (await f.call("search_files", { query: "literal.*", glob: "sample.txt" })).result;
    assert.deepEqual(exact.entries, [{ path: "sample.txt", line: 1, text: "Needle literal.*" }]);
    assert.equal((await f.call("search_files", { query: "NEEDLE", glob: "sample.txt" })).result.capturedCount, 0);
    assert.equal((await f.call("search_files", { query: "NEEDLE", ignore_case: true, glob: "sample.txt" })).result.capturedCount, 2);
    assert.equal((await f.call("search_files", { query: "literalZZZ", glob: "sample.txt" })).result.capturedCount, 0);
    const empty = (await f.call("list_files", { glob: "absent*" })).result;
    assert.equal(empty.scanComplete, true); assert.equal(empty.capturedCount, 0);
    const newline = (await f.call("search_files", { query: "needle", glob: "line*" })).result;
    assert.equal(newline.entries[0].path, "line\nbreak.txt");
  } finally {
    await f.cleanup(); fs.rmSync(directory, { recursive: true, force: true });
    if (previous.config === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = previous.config;
    if (previous.git === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous.git;
  }
});

test("实际 worker：只读根、授予路径、越界/链接/目录替换与参数拒绝", async () => {
  const f = await fixture({ scope: true });
  try {
    fs.writeFileSync(path.join(f.granted, "granted.txt"), "granted");
    assert.equal((await f.call("list_files", { path: f.granted })).result.entries[0].path, "granted.txt");
    for (const params of [{ path: f.root }, { path: "..", glob: "**/*" }]) assert.equal((await f.call("list_files", params)).result.code, "file_search_path_denied");
    fs.symlinkSync(f.granted, path.join(f.work, "link"));
    assert.equal((await f.call("list_files", { path: "link" })).result.code, "file_search_path_denied");
    assert.equal((await f.call("list_files", { path: "sample.txt" })).result.code, "file_search_not_directory");
    for (const params of [{ query: "" }, { query: "a\nb" }, { query: "x".repeat(4097) }, { query: "x", limit: 0 }, { query: "x", limit: 201 }, { query: "x", glob: "x".repeat(513) }, { query: "x", ignore_case: "true" }, { query: "x", executable: "bash" }]) {
      assert.equal((await f.call("search_files", params)).result.code, "file_search_invalid_params");
    }
    fs.renameSync(f.work, path.join(f.root, "old")); fs.mkdirSync(f.work);
    assert.equal((await f.call("list_files")).result.code, "file_search_directory_changed");
  } finally { await f.cleanup(); }
});

test("实际 worker：预览限制不停止证据捕获，长行/整体预览有界，二进制晚发现撤回早期命中", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.work, "many.txt"), Array.from({ length: 150 }, (_, i) => `needle-${i} ${"x".repeat(3000)}`).join("\n") + "\n");
    const limited = await f.call("search_files", { query: "needle", glob: "many.txt", limit: 1 });
    assert.equal(limited.result.entries.length, 1); assert.equal(limited.result.capturedCount, 150);
    assert.equal(limited.result.entries[0].text?.length, 2048); assert.equal(limited.result.entries[0].lineTruncated, true);
    assert.equal(limited.result.scanComplete, true); assert.equal(limited.result.partial, false); assert.equal(limited.result.previewTruncated, true);
    assert.match(limited.stream().toString(), /needle-149/);
    const large = (await f.call("search_files", { query: "needle", glob: "many.txt", limit: 200 })).result;
    assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 64 * 1024); assert.ok(large.entries.length < 150);
    fs.writeFileSync(path.join(f.work, "late-binary.txt"), `needle\n${"x".repeat(200_000)}\0secret`);
    assert.equal((await f.call("search_files", { query: "needle", glob: "late-binary.txt" })).result.capturedCount, 0);
    assert.equal((await f.call("list_files", { glob: "late-binary.txt" })).result.capturedCount, 0);
    fs.writeFileSync(path.join(f.root, "outside.txt"), "outside");
    assert.equal((await f.call("list_files", { path: f.root, glob: "outside.txt" })).result.capturedCount, 1, "完全访问保留现有范围含义");
  } finally { await f.cleanup(); }
});

test("实际 worker：rg 缺失、退出2、输出预算均返回具名失败和部分证据", async () => {
  for (const [fake, code] of [
    ["", "file_search_unavailable"],
    ["process.stdout.write('sample.txt\\0'); process.stderr.write('permission denied'); process.exitCode = 2;", "file_search_failed"],
    ["process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 120));", "file_search_output_limit"],
  ]) {
    const f = await fixture({ fake });
    try {
      const out = await f.call("list_files");
      assert.equal(out.response.isError, true); assert.equal(out.result.code, code); assert.equal(out.result.partial, true); assert.equal(out.result.scanComplete, false);
      assert.ok(out.stream().length + out.stream("stderr").length <= FILE_SEARCH_BYTES);
      if (code === "file_search_failed") { assert.equal(out.result.capturedCount, 1); assert.match(out.stream("stderr").toString(), /permission denied/); }
    } finally { await f.cleanup(); }
  }
});

test("实际 worker：10秒预算停止检索、保留计数且 worker 可继续服务", async () => {
  const f = await fixture({ fake: "process.stdout.write('sample.txt\\0'); setInterval(() => {}, 1000);" });
  try {
    const out = await f.call("list_files");
    assert.equal(out.result.code, "file_search_timeout"); assert.equal(out.result.capturedCount, 1); assert.equal(out.result.partial, true);
    const read = await f.host.call({ opId: "read-after-timeout", sdkCallId: "read-after-timeout", name: "read", params: { path: "sample.txt" } });
    assert.equal(read.isError, false);
  } finally { await f.cleanup(); }
});

test("实际 worker：主动取消等待检索进程停止，返回部分计数而无写入效果", async () => {
  const f = await fixture({ fake: "process.stdout.write('sample.txt\\0'); setInterval(() => {}, 1000);" });
  try {
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const pending = f.host.call({ opId: "cancel-search", sdkCallId: "cancel-search", name: "list_files", params: {}, timeoutMs: 5_000, onData: () => began() });
    await started;
    await f.host.abort("cancel-search");
    const result = (await pending).details as FileSearchResult;
    assert.equal(result.code, "file_search_canceled"); assert.equal(result.partial, true); assert.equal(result.capturedCount, 1);
  } finally { await f.cleanup(); }
});

test("实际 worker：非 UTF-8 路径明确不支持，不生成替换字符路径", { skip: process.platform !== "linux" }, async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(Buffer.concat([Buffer.from(f.work + "/"), Buffer.from([0xff]), Buffer.from(".txt")]), "needle\n");
    for (const name of ["list_files", "search_files"] as const) {
      const out = await f.call(name, name === "search_files" ? { query: "needle" } : {});
      assert.equal(out.result.code, "file_search_encoding_unsupported"); assert.equal(out.result.partial, true);
      assert.ok(out.result.entries.every(entry => !entry.path.includes("\uFFFD")));
    }
  } finally { await f.cleanup(); }
});

test("真实原生 worker：搜索限定到工作区和只读来源，显式 glob 不扩授权，替换后拒绝旧执行", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "search-native-")));
  const work = path.join(root, "work"), source = path.join(root, "source"), outside = path.join(root, "private");
  for (const directory of [work, source, outside]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(source, ".source.txt"), "source needle\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret\n");
  fs.symlinkSync(outside, path.join(work, "escape"));
  const stat = fs.statSync(work), readStat = fs.statSync(source);
  const host = ToolWorkerHost.create(createNativeLauncher(), { taskId: "search-native", mode: "confirm", workspace: work,
    workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [], readRoots: [{ path: source, dev: readStat.dev, ino: readStat.ino }] });
  try {
    await host.start();
    let n = 0;
    const search = async (params: Record<string, unknown>) => (await host.call({ opId: `native-${++n}`, sdkCallId: `native-${n}`, name: "search_files", params })).details as FileSearchResult;
    const result = await search({ query: "needle", path: source, glob: "*.txt" });
    assert.equal(result.scanComplete, true, JSON.stringify(result)); assert.equal(result.entries[0].path, ".source.txt");
    assert.equal((await search({ query: "secret", path: outside, glob: "**/*" })).code, "file_search_path_denied");
    assert.equal((await search({ query: "secret", path: work, glob: "**/*" })).capturedCount, 0);
    const write = await host.call({ opId: "source-write", sdkCallId: "source-write", name: "write", params: { path: path.join(source, ".source.txt"), content: "changed" } });
    assert.equal(write.isError, true, "原生来源只读挂载不能被写工具旁路");
    assert.equal(fs.readFileSync(path.join(source, ".source.txt"), "utf8"), "source needle\n");
    if (process.platform === "linux") {
      fs.writeFileSync(Buffer.concat([Buffer.from(work + "/"), Buffer.from([0xff])]), "needle\n");
      const unsupported = await search({ query: "needle", path: work, glob: "*" });
      assert.equal(unsupported.code, "file_search_encoding_unsupported"); assert.equal(unsupported.partial, true);
    }
    fs.renameSync(source, path.join(root, "old-source")); fs.mkdirSync(source);
    await assert.rejects(search({ query: "needle", path: source }), { code: "execution_unavailable" });
  } finally { assert.equal(await host.stop(), true); fs.rmSync(root, { recursive: true, force: true }); }
});
