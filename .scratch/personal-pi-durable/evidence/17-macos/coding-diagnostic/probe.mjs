import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, transform, version as esbuildVersion } from "esbuild";

const root = process.cwd();
const evidence = path.dirname(fileURLToPath(import.meta.url));
const base = "a8fd60c";
const entry = "test/122-workflow-code-acceptance.test.ts";
const helper = "apps/ruukoto/src/service-helper.ts";
const digest = value => createHash("sha256").update(value).digest("hex");
const baseline = execFileSync("git", ["show", `${base}:${helper}`], { cwd: root, encoding: "utf8" });
const current = fs.readFileSync(path.join(root, helper), "utf8");
const options = { loader: "ts", format: "esm", target: "node24", sourcefile: helper };
const [before, after] = await Promise.all([transform(baseline, options), transform(current, options)]);
assert.equal(before.code, after.code, "service-helper 的运行时 JavaScript 已变化");

const graph = await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  write: false,
  metafile: true,
  treeShaking: false,
  platform: "node",
  format: "esm",
  target: "node24",
  logLevel: "silent",
  plugins: [{ name: "external-dependencies", setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => args.path.startsWith("@ruukoto/") ? undefined : { path: args.path, external: true });
  } }],
});
const inputs = Object.keys(graph.metafile.inputs).sort();
assert.ok(inputs.includes(entry));
assert.ok(inputs.includes(helper));
assert.ok(inputs.includes("apps/ruukoto-code/src/product.ts"));
const tracked = execFileSync("git", ["diff", "--name-only", base, "--", "apps", "packages", "test"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "apps", "packages", "test"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const changed = [...new Set([...tracked, ...untracked])].sort();
const changedInGraph = changed.filter(name => inputs.includes(name));
assert.deepEqual(changedInGraph, [helper], "Coding 验收加载了新增的行为变更文件，需要重新判断作用面");
const sourceManifest = inputs.map(name => ({ path: name, sha256: digest(fs.readFileSync(path.join(root, name))) }));
const result = {
  recordedAt: new Date().toISOString(),
  baseSha: execFileSync("git", ["rev-parse", base], { cwd: root, encoding: "utf8" }).trim(),
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  esbuildVersion,
  entry,
  inputCount: inputs.length,
  changedSourcePaths: changed,
  changedInputs: changedInGraph,
  personalInputs: inputs.filter(name => name.startsWith("apps/ruukoto/")),
  helperTransform: { path: helper, baselineSourceSha256: digest(baseline), currentSourceSha256: digest(current), baselineJavaScriptSha256: digest(before.code), currentJavaScriptSha256: digest(after.code), identicalJavaScript: before.code === after.code, options },
  scope: "静态可解析的仓库运行时 import 图；第三方依赖视为 external，未执行测试或模块顶层代码。类型 import 经 esbuild 擦除。new URL 指向的执行产物不在此图内，另核对原生源码与产物状态。",
};
fs.writeFileSync(path.join(evidence, "scope.json"), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(path.join(evidence, "import-graph.json.gz"), gzipSync(`${JSON.stringify({ inputs: graph.metafile.inputs, sourceManifest }, null, 2)}\n`));
fs.writeFileSync(path.join(evidence, "service-helper-emitted.js"), after.code);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
