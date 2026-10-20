import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { anchorCache, findHardWrappedParagraphs, parseMarkdown, visitMarkdown } from "../../../../scripts/markdown-scan.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const files = [
  ".scratch/personal-pi-durable/remaining-work.md",
  ".scratch/personal-pi-durable/issues/01-migration-plan.md",
  ".scratch/personal-pi-durable/issues/30-browser-media.md",
  ".scratch/personal-pi-durable/issues/31-qq-owner-entry.md",
  ".scratch/personal-pi-durable/evidence/30-macos/README.md",
  ".scratch/personal-pi-durable/evidence/30-macos/independent-review.md",
  ".scratch/personal-pi-durable/evidence/30-linux/README.md",
];
const anchors = anchorCache();
let links = 0;
for (const file of files) {
  const abs = path.join(root, file), text = fs.readFileSync(abs, "utf8");
  assert.match(text, /[^\n]\n$/, file);
  assert.deepEqual(findHardWrappedParagraphs(text), [], file);
  if (file.includes("/issues/")) assert.equal(text.match(/^Status:/gm)?.length, 1, file);
  visitMarkdown(parseMarkdown(text), node => {
    if (!(node.type === "link" || node.type === "image" || node.type === "definition")) return;
    if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/)/.test(node.url)) return;
    const [target, fragment] = node.url.split("#"), resolved = target ? path.resolve(path.dirname(abs), decodeURIComponent(target)) : abs;
    assert.ok(fs.existsSync(resolved), `${file}: ${node.url}`);
    if (fragment && resolved.endsWith(".md")) assert.ok(anchors(resolved).has(decodeURIComponent(fragment)), `${file}: ${node.url}`);
    links++;
  });
}
const sha256 = (filename: string) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "implementation-manifest.json"), "utf8")) as { records: { path: string; bytes: number; sha256: string }[] };
for (const record of manifest.records) {
  const abs = path.join(root, record.path);
  assert.equal(sha256(abs), record.sha256, record.path);
  assert.equal(fs.statSync(abs).size, record.bytes, record.path);
}
const linux = path.resolve(import.meta.dirname, "../30-linux");
const original = JSON.parse(fs.readFileSync(path.join(linux, "source-manifest.json"), "utf8")) as { records: { path: string; sha256: string }[] };
const comparison = JSON.parse(fs.readFileSync(path.join(linux, "final-source-comparison.json"), "utf8")) as { differences: { path: string; currentSha256: string }[] };
let unchanged = 0;
for (const record of original.records) {
  const current = sha256(path.join(root, record.path)), changed = comparison.differences.find(value => value.path === record.path);
  assert.equal(current, changed?.currentSha256 ?? record.sha256, record.path);
  if (!changed) unchanged++;
}
const archive = JSON.parse(fs.readFileSync(path.join(linux, "local-archive-verification.json"), "utf8")) as { archiveSha256: string; files: { path: string; sha256: string; matches: boolean }[] };
assert.equal(sha256(path.join(linux, "records.tar.gz")), archive.archiveSha256);
for (const record of archive.files) {
  assert.equal(record.matches, true);
  assert.equal(sha256(path.join(linux, "records", record.path)), record.sha256, record.path);
}
process.stdout.write(JSON.stringify({ passed: true, markdownFiles: files.length, relativeLinks: links, implementationFiles: manifest.records.length, linuxSourceFiles: original.records.length, linuxUnchanged: unchanged, linuxDescriptionChanges: comparison.differences.length, archiveFiles: archive.files.length }, null, 2) + "\n");
