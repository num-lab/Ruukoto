import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { savePersonalArtifact, readPersonalArtifact, exportPersonalArtifact, type PersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";

function fixture(t: TestContext): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "personal-artifacts-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const fileFor = (directory: string, ref: PersonalArtifact) => path.join(directory, "artifacts", `${ref.id}.bin`);
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;

test("个人产物：二进制与跨页 UTF-8 保留原字节，引用固定身份、长度与哈希", async t => {
  const directory = fixture(t), original = Buffer.concat([Buffer.from([0, 255, 1, 128]), Buffer.from("完整原文与分页🙂\n".repeat(700))]);
  const ref = await savePersonalArtifact(directory, original, { mime: "text/plain; charset=utf-8" });
  assert.equal(ref.bytes, original.length); assert.equal(ref.partial, false);
  assert.equal(ref.sha256, createHash("sha256").update(original).digest("hex"));
  const stat = fs.statSync(fileFor(directory, ref));
  assert.deepEqual(ref.identity, { dev: stat.dev, ino: stat.ino });
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(fs.statSync(path.join(directory, "artifacts")).mode & 0o777, 0o700);
  const pages: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const page = await readPersonalArtifact(directory, ref, offset), bytes = Buffer.from(page.base64, "base64");
    assert.equal(page.offset, offset); assert.equal(page.bytes, original.length); assert.equal(page.partial, false); assert.equal(page.mime, ref.mime);
    assert.equal(bytes.length, Math.min(3072, original.length - offset)); pages.push(bytes);
    if (page.nextOffset === undefined) break;
    assert.equal(page.nextOffset, offset + bytes.length); offset = page.nextOffset;
  }
  assert.deepEqual(Buffer.concat(pages), original);
  assert.equal((await readPersonalArtifact(directory, ref, ref.bytes + 1)).base64, "");
  const empty = await savePersonalArtifact(directory, Buffer.alloc(0));
  assert.deepEqual(await readPersonalArtifact(directory, empty), { base64: "", offset: 0, bytes: 0, partial: false, mime: "application/octet-stream" });
  await assert.rejects(readPersonalArtifact(directory, ref, -1), code("artifact_input_invalid"));
  await assert.rejects(readPersonalArtifact(directory, ref, NaN), code("artifact_input_invalid"));
});

test("个人产物：超出 8 MiB 与主动片段均标 partial，只允许分页核实", async t => {
  const directory = fixture(t), original = Buffer.alloc(8 * 1024 * 1024 + 1, 0xa5);
  const ref = await savePersonalArtifact(directory, original);
  assert.equal(ref.bytes, 8 * 1024 * 1024); assert.equal(ref.partial, true);
  assert.deepEqual(fs.readFileSync(fileFor(directory, ref)), original.subarray(0, ref.bytes));
  assert.equal((await readPersonalArtifact(directory, ref)).partial, true);
  const target = path.join(directory, "export.bin");
  await assert.rejects(exportPersonalArtifact(directory, ref, target), code("artifact_partial"));
  assert.equal(fs.existsSync(target), false);
  const partial = await savePersonalArtifact(directory, Buffer.from("已捕获部分"), { partial: true });
  assert.equal((await readPersonalArtifact(directory, partial)).partial, true);
});

test("个人产物：缺失、损坏、同内容换 inode、链接与不受保护对象均明确拒绝", async t => {
  const changes: Array<{ name: string; change(directory: string, ref: PersonalArtifact): void }> = [
    { name: "缺失", change: (directory, ref) => fs.unlinkSync(fileFor(directory, ref)) },
    { name: "截短", change: (directory, ref) => fs.truncateSync(fileFor(directory, ref), 1) },
    { name: "等长损坏", change: (directory, ref) => fs.writeFileSync(fileFor(directory, ref), Buffer.alloc(ref.bytes, 0)) },
    { name: "同内容替换", change(directory, ref) { const target = fileFor(directory, ref); fs.renameSync(target, `${target}.original`); fs.copyFileSync(`${target}.original`, target); } },
    { name: "文件符号链接", change(directory, ref) { const target = fileFor(directory, ref); fs.renameSync(target, `${target}.original`); fs.symlinkSync(`${target}.original`, target); } },
    { name: "文件硬链接", change: (directory, ref) => fs.linkSync(fileFor(directory, ref), path.join(directory, "alias")) },
    { name: "公开文件", change: (directory, ref) => fs.chmodSync(fileFor(directory, ref), 0o644) },
    { name: "公开目录", change: directory => fs.chmodSync(path.join(directory, "artifacts"), 0o755) },
    { name: "公开档案", change: directory => fs.chmodSync(directory, 0o755) },
    { name: "目录符号链接", change(directory) { const root = path.join(directory, "artifacts"); fs.renameSync(root, `${root}-original`); fs.symlinkSync(`${root}-original`, root); } },
  ];
  for (const change of changes) await t.test(change.name, async t => {
    const directory = fixture(t), ref = await savePersonalArtifact(directory, Buffer.from("受保护的原字节"));
    change.change(directory, ref);
    await assert.rejects(readPersonalArtifact(directory, ref), code("artifact_unavailable"));
    const target = path.join(directory, "export.bin");
    await assert.rejects(exportPersonalArtifact(directory, ref, target), code("artifact_unavailable"));
    assert.equal(fs.existsSync(target), false);
  });
  await t.test("坏引用", async t => {
    const directory = fixture(t), ref = await savePersonalArtifact(directory, Buffer.from("source"));
    for (const changed of [{ ...ref, id: "../source" }, { ...ref, bytes: ref.bytes + 1 }, { ...ref, sha256: "0".repeat(64) }, { ...ref, identity: { ...ref.identity, ino: ref.identity.ino + 1 } }]) await assert.rejects(readPersonalArtifact(directory, changed), code("artifact_unavailable"));
  });
});

test("个人产物：完整核实后独占导出，已有目标与链接不被覆盖", async t => {
  const directory = fixture(t), original = Buffer.from([0, 255, 128, 10, 99]), ref = await savePersonalArtifact(directory, original);
  const target = path.join(directory, "export.bin");
  await exportPersonalArtifact(directory, ref, target);
  assert.deepEqual(fs.readFileSync(target), original); assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  fs.writeFileSync(target, "原目标");
  await assert.rejects(exportPersonalArtifact(directory, ref, target), code("artifact_destination_exists"));
  assert.equal(fs.readFileSync(target, "utf8"), "原目标");
  const link = path.join(directory, "export-link.bin"); fs.symlinkSync(target, link);
  await assert.rejects(exportPersonalArtifact(directory, ref, link), code("artifact_destination_exists"));
  assert.equal(fs.readFileSync(target, "utf8"), "原目标");
  assert.deepEqual(fs.readFileSync(fileFor(directory, ref)), original); assert.equal(fs.statSync(fileFor(directory, ref)).nlink, 1);
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".ruukoto-artifact-")), false);
});

test("个人产物：保存写盘失败保留受保护字节且不声称成功，错误不泄露内部路径", async t => {
  const directory = fixture(t), sync = nodeFs.fsyncSync;
  t.mock.method(nodeFs, "fsyncSync", () => { throw new Error(`private-path:${directory}`); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(savePersonalArtifact(directory, Buffer.from("已写入的证据")), (error: unknown) => {
    assert.ok(error instanceof PersonalError); assert.equal(error.code, "artifact_write_failed"); assert.ok(!error.message.includes(directory)); return true;
  });
  t.mock.restoreAll(); syncBuiltinESMExports();
  const names = fs.readdirSync(path.join(directory, "artifacts"));
  assert.equal(names.length, 1); assert.match(names[0], /^\.tmp-/);
  assert.equal(fs.readFileSync(path.join(directory, "artifacts", names[0]), "utf8"), "已写入的证据");
  assert.equal(fs.statSync(path.join(directory, "artifacts", names[0])).mode & 0o777, 0o600);
  let calls = 0;
  t.mock.method(nodeFs, "fsyncSync", (fd: number) => { if (++calls === 2) throw new Error("directory-fsync-failed"); sync(fd); }); syncBuiltinESMExports();
  await assert.rejects(savePersonalArtifact(directory, Buffer.from("已发布的证据")), code("artifact_write_failed"));
  t.mock.restoreAll(); syncBuiltinESMExports();
  const published = fs.readdirSync(path.join(directory, "artifacts")).find(name => name.endsWith(".bin"));
  assert.ok(published); assert.equal(fs.readFileSync(path.join(directory, "artifacts", published), "utf8"), "已发布的证据");
});
