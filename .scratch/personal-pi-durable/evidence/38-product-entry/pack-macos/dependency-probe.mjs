import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
const work = fs.realpathSync(process.argv[2]);
const sha256 = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const scopes = [
  ["personal", "apps/ruukoto", ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord"], "1.3.0"],
  ["coding", "packages/agent", ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"], "0.85.1"],
];
const dependencies = [];
for (const [product, scope, specs, expected] of scopes) {
  for (const spec of specs) {
    const resolved = fileURLToPath(import.meta.resolve(spec, pathToFileURL(path.join(work, scope, "package.json")).href));
    const manifestPath = fileURLToPath(new URL("../package.json", pathToFileURL(resolved)));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.version, expected);
    assert.ok(resolved.startsWith(work + path.sep));
    dependencies.push({ product, scope, spec, resolved, version: manifest.version, manifestSha256: sha256(manifestPath) });
  }
}
const source = path.join(work, "apps/ruukoto/src/personal-command-config.ts");
const matches = [...fs.readFileSync(source, "utf8").matchAll(/workerPath:\s*fileURLToPath\(new URL\("([^"]+)", import\.meta\.url\)\)/g)];
assert.equal(matches.length, 1);
const workerPath = fileURLToPath(new URL(matches[0][1], pathToFileURL(source)));
assert.equal(workerPath, path.join(work, "worker/personal-command-worker.mjs"));
assert.ok(fs.statSync(workerPath).isFile());
process.stdout.write(JSON.stringify({ returncode: 0, dependencies, personalWorker: { source, sourceSha256: sha256(source), literal: matches[0][1], workerPath, workerSha256: sha256(workerPath), bytes: fs.statSync(workerPath).size, method: "Static resolution of the literal in the unpacked personalCommandEnvironment plus actual built-worker execution in personal-command-worker.test.ts; Linux-only environment function was not invoked on macOS." } }, null, 2) + "\n");
