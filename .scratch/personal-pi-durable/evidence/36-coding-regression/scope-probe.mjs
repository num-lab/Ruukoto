import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const trees = process.argv.slice(2).map(tree => fs.realpathSync(tree));
assert.equal(trees.length, 2);
const assets = ["worker/worker.mjs", "worker/workflow-script.mjs", "worker/native-macos-supervisor", "dist/ruukoto-code-0.1.0.tgz", "package-lock.json", "packages/core/src/db.ts"];
const imports = [
  ["packages/agent", "@earendil-works/pi-coding-agent", "0.85.1"],
  ["apps/ruukoto-code", "@earendil-works/pi-coding-agent", "0.85.1"],
  ["worker", "@earendil-works/pi-coding-agent", "0.85.1"],
  ["apps/ruukoto", "@earendil-works/pi-ai", "1.3.0"],
  ["apps/ruukoto", "@earendil-works/pi-durable", "1.3.0"],
];
const results = trees.map(tree => {
  assert.ok(path.isAbsolute(tree));
  const digests = Object.fromEntries(assets.map(name => [name, createHash("sha256").update(fs.readFileSync(path.join(tree, name))).digest("hex")]));
  const resolved = imports.map(([location, name, expected]) => {
    const entry = fileURLToPath(import.meta.resolve(name, pathToFileURL(path.join(tree, location, "probe.mjs"))));
    let dir = path.dirname(entry);
    while (!fs.existsSync(path.join(dir, "package.json"))) {
      assert.notEqual(dir, path.dirname(dir));
      dir = path.dirname(dir);
    }
    const version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
    assert.equal(version, expected);
    return { location, name, version, entry: path.relative(tree, entry) };
  });
  return { digests, resolved };
});
assert.deepEqual(results[0], results[1]);
process.stdout.write(JSON.stringify({ equal: true, base: results[0], current: results[1] }, null, 2) + "\n");
