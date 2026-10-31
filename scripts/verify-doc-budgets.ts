import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = resolve(root, "scripts/doc-budgets.manifest.json");

// Keep the language-independent non-whitespace metric; ceilings account for translation length.
function countChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, number>;

const listOnly = process.argv.includes("--list");
const failures: string[] = [];
const rows: string[] = [];

for (const [path, ceiling] of Object.entries(manifest)) {
  if (!Number.isInteger(ceiling) || ceiling <= 0) {
    rows.push(`BAD   ${"—".padStart(7)} / ${String(ceiling).padEnd(7)} ${path}`);
    failures.push(`${path}: ceiling must be a positive integer; received ${ceiling}`);
    continue;
  }
  const abs = resolve(root, path);
  if (!existsSync(abs)) {
    rows.push(`MISS  ${"—".padStart(7)} / ${String(ceiling).padEnd(7)} ${path}`);
    failures.push(`${path}: budgeted file is missing; update scripts/doc-budgets.manifest.json with the rename or removal`);
    continue;
  }
  const chars = countChars(readFileSync(abs, "utf8"));
  rows.push(`${chars <= ceiling ? "ok  " : "OVER"}  ${String(chars).padStart(7)} / ${String(ceiling).padEnd(7)} ${path}`);
  if (chars > ceiling) {
    failures.push(`${path}: ${chars} non-whitespace characters exceed ${ceiling}; move misplaced detail before shortening, and justify any ceiling increase in the same change`);
  }
}

if (listOnly) {
  console.log(rows.join("\n"));
  process.exit(0);
}

if (failures.length > 0) {
  console.error("verify-doc-budgets failed:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\nBudgets are guardrails, not shortening targets: relocate detail, then compress, then justify an increase.");
  process.exit(1);
}

console.log(`verify-doc-budgets: ${Object.keys(manifest).length} resident documents are within their ceilings.`);
