import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { preparePersonalFileSearch, executePersonalFileSearch, personalSearchExecutable, stopPersonalFileSearch } from "../apps/ruukoto/src/personal-file-search.ts";

test("个人检索：原生只读资料根、过滤、原字节和持久停止", { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-search-"))), profile = path.join(root, "profile"), workspace = path.join(root, "data");
  fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, "normal.txt"), "needle\nNEEDLE\n");
  fs.writeFileSync(path.join(workspace, ".hidden.txt"), "needle\n");
  fs.writeFileSync(path.join(workspace, "ignored.txt"), "needle\n");
  fs.writeFileSync(path.join(workspace, ".ignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(workspace, "binary.txt"), Buffer.from("needle\n\0"));
  fs.symlinkSync(path.join(workspace, "normal.txt"), path.join(workspace, "alias.txt"));
  const stat = fs.statSync(workspace), roots = [{ path: workspace, dev: stat.dev, ino: stat.ino }];
  for (const mode of ["confirm", "full_access"] as const) {
    const prepared = await preparePersonalFileSearch(profile, `search-${mode}`, { name: "search_files", params: { query: "needle", limit: 1 }, cwd: workspace, executable: personalSearchExecutable(), roots }, mode);
    if (mode === "confirm") assert.deepEqual(prepared.input.mounts.filter(mount => mount.path === workspace), [{ path: workspace, access: "read" }]);
    const result = await executePersonalFileSearch(profile, prepared);
    assert.equal(result.effect, "returned", JSON.stringify(result.view)); assert.equal(result.stopped, true);
    assert.equal(result.view.scanComplete, true); assert.equal(result.view.partial, false);
    assert.deepEqual(result.view.entries.map(value => [value.path, value.line]), [["normal.txt", 1]]);
    assert.match(result.bytes.toString("utf8"), /needle/);
    assert.equal(result.view.rawStreams.stdoutBytes + result.view.rawStreams.stderrBytes, result.bytes.length);
    assert.equal(await stopPersonalFileSearch(profile, prepared), true);
    fs.mkdirSync(prepared.scratch.path, { mode: 0o700 });
    assert.equal(await stopPersonalFileSearch(profile, prepared), true);
    fs.rmdirSync(prepared.scratch.path);
  }
  const explicit = await preparePersonalFileSearch(profile, "search-glob", { name: "search_files", params: { query: "needle", glob: "*.txt", ignore_case: true }, cwd: workspace, executable: personalSearchExecutable(), roots }, "confirm");
  const result = await executePersonalFileSearch(profile, explicit);
  assert.deepEqual(result.view.entries.map(value => value.path).sort(), [".hidden.txt", "ignored.txt", "normal.txt", "normal.txt"]);
  const denied = await preparePersonalFileSearch(profile, "search-denied", { name: "list_files", params: { path: root }, cwd: workspace, executable: personalSearchExecutable(), roots }, "confirm");
  const outside = await executePersonalFileSearch(profile, denied);
  assert.equal(outside.view.code, "file_search_path_denied"); assert.equal(outside.stopped, true);
  assert.equal(outside.bytes.length, 0);
});

test("个人检索：取消保留部分、停止核实且原身份不重放", { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-search-cancel-"))), profile = path.join(root, "profile");
  fs.mkdirSync(profile, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stat = fs.statSync(root), prepared = await preparePersonalFileSearch(profile, "canceled-search", { name: "list_files", params: {}, cwd: root, executable: personalSearchExecutable(), roots: [{ path: root, dev: stat.dev, ino: stat.ino }] }, "full_access");
  const controller = new AbortController(); controller.abort();
  const result = await executePersonalFileSearch(profile, prepared, controller.signal);
  assert.equal(result.effect, "no_write"); assert.equal(result.partial, true); assert.equal(result.stopped, true);
  assert.equal(result.view.code, "file_search_canceled");
  await assert.rejects(executePersonalFileSearch(profile, prepared), { code: "file_search_directory_changed" });
});
