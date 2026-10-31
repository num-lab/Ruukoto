import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");

const DIRECTORIES = ["packages", "apps", "scripts"];

const DOC_REF = /(?:\.agents\/(?:notes|postmortem)|docs)\/[A-Za-z0-9._/-]+\.md/g;

const isExcluded = (rel: string): boolean => rel.includes("node_modules/") || rel.endsWith(".d.ts");

interface Violation {
  file: string;
  line: number;
  ref: string;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const sources = DIRECTORIES.flatMap((dir) => walkFiles(resolve(root, dir)))
  .map((abs) => ({ abs, rel: relative(root, abs).split(sep).join("/") }))
  .filter((file) => !isExcluded(file.rel));

const violations: Violation[] = [];
for (const file of sources) {
  const lines = readFileSync(file.abs, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(DOC_REF)) {
      const ref = match[0];
      if (!existsSync(resolve(root, ref))) {
        violations.push({ file: file.rel, line: index + 1, ref });
      }
    }
  });
}

if (violations.length === 0) {
  console.log(`verify-doc-refs: document references verified in ${sources.length} source files.`);
  process.exit(0);
}

console.error("verify-doc-refs: source references missing documents:");
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.ref}`);
process.exit(1);
