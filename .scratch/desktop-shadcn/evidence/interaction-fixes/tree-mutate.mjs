import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [readyPath, action] = process.argv.slice(2);
assert.ok(readyPath && path.isAbsolute(readyPath) && ["add", "remove"].includes(action), "用法：node /tmp/ruukoto-qa-tree-mutate.mjs /绝对路径/ready.json add|remove");
const ready = JSON.parse(fs.readFileSync(readyPath, "utf8"));
assert.equal(ready.preparedOnly, false, "prepare-only 的临时目录已清理；请使用正在运行的 fixture ready.json。");
assert.ok(Number.isSafeInteger(ready.fixturePid) && ready.fixturePid > 1);
process.kill(ready.fixturePid, 0);
const workspace = fs.realpathSync(ready.workspace);
assert.ok(path.isAbsolute(ready.workspace));
assert.ok(workspace.includes("/ruukoto-it-mygo-issue20-code-") && workspace.endsWith("/work-0/git-workspace"));
const markerPath = path.join(workspace, ".ruukoto-qa-owner.json");
assert.equal(fs.lstatSync(markerPath).isSymbolicLink(), false);
const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
assert.equal(marker.fixturePid, ready.fixturePid); assert.equal(fs.realpathSync(marker.workspace), workspace); assert.equal(marker.purpose, "issue20-live-files");
const sourceDirectory = path.join(workspace, "src");
assert.equal(fs.realpathSync(sourceDirectory), sourceDirectory);
const files = [path.join(workspace, "qa-live-added.ts"), path.join(sourceDirectory, "qa-live-nested.ts")];
const canonical = value => path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
assert.equal(canonical(ready.workspaceMutation.rootFile), files[0]); assert.equal(canonical(ready.workspaceMutation.nestedFile), files[1]);
const content = "export const liveTreeRefresh = true;\n";
for (const file of files) {
  if (fs.existsSync(file)) {
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(file, "utf8"), content, "只删除此助手创建且未改动的验收文件。");
    if (action === "remove") fs.unlinkSync(file);
  } else if (action === "add") fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
}
process.stdout.write(`${action}: ${files.join(", ")}\n`);
