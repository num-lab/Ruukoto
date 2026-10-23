import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { resolveDirIdentitySync } from "@ruukoto/core/dir-identity.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { MAX_FRAME_BYTES } from "@ruukoto/control/protocol.ts";
import { listWorkspaceFiles, readWorkspaceFile, WORKSPACE_DIRECTORY_LIMIT, WORKSPACE_FILE_PAGE_BYTES } from "@ruukoto/runtime/workspace-files.ts";
import { startTestRuntime } from "./helpers/testkit.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
function fixture() {
  const parent = fs.mkdtempSync(path.join(tmpdir(), "ruukoto-files-"));
  fs.mkdirSync(path.join(parent, "work"));
  const root = fs.realpathSync(path.join(parent, "work"));
  return { parent, root, identity: resolveDirIdentitySync(root), close: () => fs.rmSync(parent, { recursive: true, force: true }) };
}
const fails = (code: string) => (error: unknown): boolean => error instanceof RuntimeApiError && error.code === code;

test("工作区文件按层排序读取，文本、Markdown、空文件与图片保留真实内容", () => {
  const kit = fixture();
  try {
    fs.mkdirSync(path.join(kit.root, "src"));
    fs.writeFileSync(path.join(kit.root, "src", "index.ts"), "const value = '<script>';\n");
    fs.writeFileSync(path.join(kit.root, "README.md"), "# 真实文件\n");
    fs.writeFileSync(path.join(kit.root, "empty.txt"), "");
    fs.writeFileSync(path.join(kit.root, "photo.png"), png);
    fs.writeFileSync(path.join(kit.root, "document.pdf"), "%PDF-1.7");
    fs.writeFileSync(path.join(kit.root, "vector.svg"), "<svg onload='alert(1)'/>");
    fs.writeFileSync(path.join(kit.root, "fake.png"), "并非图片");
    fs.writeFileSync(path.join(kit.root, "binary"), Buffer.from([255, 0, 1]));
    const files = listWorkspaceFiles("workspace", kit.identity, "");
    assert.equal(files.path, ""); assert.equal(files.truncated, false);
    assert.deepEqual(files.entries[0], { name: "src", path: "src", kind: "directory" });
    assert.deepEqual(listWorkspaceFiles("workspace", kit.identity, "src").entries, [{ name: "index.ts", path: "src/index.ts", kind: "file" }]);
    const read = (file: string) => Buffer.from(readWorkspaceFile("workspace", kit.identity, file).data, "base64");
    assert.equal(read("src/index.ts").toString(), "const value = '<script>';\n");
    assert.equal(read("README.md").toString(), "# 真实文件\n");
    assert.equal(read("empty.txt").length, 0);
    assert.deepEqual(read("photo.png"), png);
    for (const file of ["document.pdf", "vector.svg", "fake.png", "binary"]) assert.deepEqual(read(file), fs.readFileSync(path.join(kit.root, file)));
  } finally { kit.close(); }
});

test("路径、目录身份与符号链接不能绕过只读范围", () => {
  const kit = fixture();
  try {
    const outside = path.join(kit.parent, "outside");
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret.txt"), "不可返回");
    fs.writeFileSync(path.join(kit.root, "ordinary.txt"), "普通正文");
    for (const file of ["../outside/secret.txt", "/etc/passwd", "C:/secret", "src/../file", "a//b", "./a", "a/./b", "a\\b", "a\0b", ""]) assert.throws(() => readWorkspaceFile("workspace", kit.identity, file), fails("invalid_params"), file);
    fs.symlinkSync(outside, path.join(kit.root, "linked"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(kit.root, "secret-link"));
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "linked/secret.txt"), fails("workspace_path_unsafe"));
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "secret-link"), fails("workspace_path_unsafe"));
    assert.ok(!listWorkspaceFiles("workspace", kit.identity, "").entries.some(entry => entry.name === "linked" || entry.name === "secret-link"));
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "missing"), fails("workspace_file_not_found"));
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, ""), fails("invalid_params"));
    fs.mkdirSync(path.join(kit.root, "directory"));
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "directory"), fails("workspace_path_unsafe"));
    fs.renameSync(kit.root, path.join(kit.parent, "old")); fs.mkdirSync(kit.root);
    assert.throws(() => listWorkspaceFiles("workspace", kit.identity, ""), fails("workspace_directory_changed"));
  } finally { kit.close(); }
});

test("拥有者预览普通硬链接可完整分页，另一名字修改后拒绝旧修订", () => {
  const kit = fixture();
  try {
    const source = path.join(kit.parent, "source.html"), link = path.join(kit.root, "linked.html");
    const content = Buffer.from("<p>硬链接正文</p>\n".repeat(20_000));
    fs.writeFileSync(source, content); fs.linkSync(source, link);
    assert.ok(listWorkspaceFiles("workspace", kit.identity, "").entries.some(entry => entry.name === "linked.html" && entry.kind === "file"));
    const first = readWorkspaceFile("workspace", kit.identity, "linked.html");
    const second = readWorkspaceFile("workspace", kit.identity, "linked.html", { offset: WORKSPACE_FILE_PAGE_BYTES, version: first.version });
    assert.deepEqual(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")]), content);
    fs.writeFileSync(source, "另一名字修改正文");
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "linked.html", { offset: WORKSPACE_FILE_PAGE_BYTES, version: first.version }), fails("workspace_file_changed"));
    assert.equal(Buffer.from(readWorkspaceFile("workspace", kit.identity, "linked.html").data, "base64").toString(), "另一名字修改正文");
  } finally { kit.close(); }
});

test("硬链接读取期间从另一名字修改内容仍丢弃结果", context => {
  const kit = fixture();
  try {
    const source = path.join(kit.parent, "source.txt"), link = path.join(kit.root, "linked.txt");
    fs.writeFileSync(source, "原文"); fs.linkSync(source, link);
    const read = fs.readSync;
    context.mock.method(fs, "readSync", (...args: Parameters<typeof read>) => {
      const count = read(...args);
      fs.writeFileSync(source, "修改后原文");
      return count;
    });
    syncBuiltinESMExports();
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "linked.txt"), fails("workspace_file_changed"));
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); kit.close(); }
});

test("目录项有界，超过1MiB的多字节文件及控制字符按修订分页完整读取", () => {
  const kit = fixture();
  try {
    for (let index = 0; index <= WORKSPACE_DIRECTORY_LIMIT; index++) fs.writeFileSync(path.join(kit.root, `file-${index}`), "");
    const files = listWorkspaceFiles("workspace", kit.identity, "");
    assert.equal(files.entries.length, WORKSPACE_DIRECTORY_LIMIT); assert.equal(files.truncated, true);
    const content = Buffer.from("开头" + "汉🙂\x01".repeat(160_000) + "最后一行");
    fs.writeFileSync(path.join(kit.root, "large.txt"), content);
    let offset = 0, version: string | undefined;
    const chunks: Buffer[] = [];
    do {
      const page = readWorkspaceFile("workspace", kit.identity, "large.txt", { offset, version });
      assert.equal(page.offset, offset); assert.equal(page.size, content.length);
      assert.equal(page.encoding, "base64"); assert.ok(Buffer.byteLength(JSON.stringify(page)) < MAX_FRAME_BYTES);
      const bytes = Buffer.from(page.data, "base64");
      assert.equal(bytes.length, Math.min(WORKSPACE_FILE_PAGE_BYTES, content.length - offset));
      chunks.push(bytes); version = page.version; offset += bytes.length;
    } while (offset < content.length);
    assert.ok(chunks.length > 4); assert.deepEqual(Buffer.concat(chunks), content);
    const first = readWorkspaceFile("workspace", kit.identity, "large.txt");
    fs.writeFileSync(path.join(kit.root, "large.txt"), "已改变");
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "large.txt", { offset: WORKSPACE_FILE_PAGE_BYTES, version: first.version }), fails("workspace_file_changed"));
    for (const page of [{ offset: -1 }, { offset: 1 }, { length: 0 }, { length: NaN }, { offset: Number.MAX_VALUE }]) assert.throws(() => readWorkspaceFile("workspace", kit.identity, "large.txt", page), fails("invalid_params"));
  } finally { kit.close(); }
});

test("读取期间的父目录替换、打开替身与原位修改均丢弃结果", context => {
  const kit = fixture();
  try {
    const directory = path.join(kit.root, "src"), original = path.join(directory, "file.txt"), outside = path.join(kit.parent, "outside");
    fs.mkdirSync(directory); fs.mkdirSync(outside); fs.writeFileSync(original, "原文"); fs.writeFileSync(path.join(outside, "file.txt"), "秘密");
    const open = fs.openSync;
    context.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
      if (args[0] === original) { fs.renameSync(directory, `${directory}-old`); fs.symlinkSync(outside, directory); }
      return open(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "src/file.txt"), fails("workspace_file_changed"));
    context.mock.restoreAll(); syncBuiltinESMExports();
    fs.unlinkSync(directory); fs.renameSync(`${directory}-old`, directory);
    const read = fs.readSync;
    let changed = false;
    context.mock.method(fs, "readSync", (...args: Parameters<typeof read>) => {
      const count = read(...args);
      if (!changed) { changed = true; fs.writeFileSync(original, "修改后原文"); }
      return count;
    });
    syncBuiltinESMExports();
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "src/file.txt"), fails("workspace_file_changed"));
    context.mock.restoreAll(); syncBuiltinESMExports();
    changed = false;
    context.mock.method(fs, "readSync", (...args: Parameters<typeof read>) => {
      const count = read(...args);
      if (!changed) { changed = true; fs.renameSync(directory, `${directory}-old`); fs.symlinkSync(outside, directory); }
      return count;
    });
    syncBuiltinESMExports();
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "src/file.txt"), fails("workspace_path_unsafe"));
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); kit.close(); }
});

test("目录枚举中的父链变化可见，文件读取失败不会泄漏宿主路径", context => {
  const kit = fixture();
  try {
    const directory = path.join(kit.root, "src"), outside = path.join(kit.parent, "outside");
    fs.mkdirSync(directory); fs.mkdirSync(outside); fs.writeFileSync(path.join(directory, "file.txt"), "原文");
    const opendir = fs.opendirSync;
    context.mock.method(fs, "opendirSync", (...args: Parameters<typeof opendir>) => {
      const handle = opendir(...args);
      fs.renameSync(directory, `${directory}-old`); fs.symlinkSync(outside, directory);
      return handle;
    });
    syncBuiltinESMExports();
    assert.throws(() => listWorkspaceFiles("workspace", kit.identity, "src"), fails("workspace_path_unsafe"));
    context.mock.restoreAll(); syncBuiltinESMExports();
    fs.unlinkSync(directory); fs.renameSync(`${directory}-old`, directory);
    context.mock.method(fs, "readSync", () => { throw Object.assign(new Error(`EACCES: ${directory}`), { code: "EACCES" }); });
    syncBuiltinESMExports();
    assert.throws(() => readWorkspaceFile("workspace", kit.identity, "src/file.txt"), (error: unknown) => fails("workspace_file_unavailable")(error) && error instanceof Error && !error.message.includes(kit.root));
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); kit.close(); }
});

test("拥有者控制面浏览不受 Agent 保护目录限制，仍核实登记工作区与相对路径", async context => {
  const kit = await startTestRuntime("desktop-files", () => ({ kind: "text", text: "不应调用" }));
  try {
    const opened = await kit.client.request<OpResult<"open_workspace">>("open_workspace", { cwd: kit.work[0], request_id: "workspace-files" });
    const workspaceId = opened.session.projectId;
    fs.writeFileSync(path.join(kit.work[0], "owner.txt"), "拥有者工作区正文");
    fs.linkSync(path.join(kit.work[0], "owner.txt"), path.join(kit.work[1], "owner-alias.txt"));
    const protectedRoots = kit.runtime.protectedRoots(), readdir = fs.readdirSync;
    context.mock.method(fs, "readdirSync", (...args: Parameters<typeof readdir>) => {
      assert.ok(!protectedRoots.some(root => String(args[0]) === root || String(args[0]).startsWith(`${root}${path.sep}`)), "拥有者文件查询不应枚举无关保护树");
      return readdir(...args);
    });
    syncBuiltinESMExports();
    context.mock.method(kit.runtime, "protectedRoots", () => [fs.realpathSync(kit.work[0])]);
    const files = await kit.client.request<OpResult<"list_workspace_files">>("list_workspace_files", { workspace_id: workspaceId });
    assert.ok(files.entries.some(entry => entry.name === "owner.txt"));
    const preview = await kit.client.request<OpResult<"read_workspace_file">>("read_workspace_file", { workspace_id: workspaceId, path: "owner.txt" });
    assert.equal(Buffer.from(preview.data, "base64").toString(), "拥有者工作区正文");
    await assert.rejects(kit.client.request("list_workspace_files", { workspace_id: workspaceId, root: kit.work[1] }), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_params");
    await assert.rejects(kit.client.request("read_workspace_file", { workspace_id: workspaceId, path: "../work-1/secret.txt" }), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_params");
    await assert.rejects(kit.client.request("list_workspace_files", { workspace_id: "missing" }), (error: unknown) => error instanceof Error && "code" in error && error.code === "workspace_not_found");
    assert.equal(kit.server.calls.length, 0);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await kit.shutdown(); }
});
