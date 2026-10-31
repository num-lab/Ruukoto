import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectMarkdown, findHardWrappedParagraphs } from "./markdown-scan.ts";

const root = resolve(import.meta.dirname, "..");

const PATTERNS = [
  "README.md",
  "AGENTS.md",
  "CONTEXT.md",
  "docs/**/*.md",
  ".agents/notes/**/*.md",
  ".agents/skills/**/*.md",
  ".agents/postmortem/**/*.md",
  "deploy/**/*.md",
  "verification/**/README.md",
  "test/fixtures/desktop-baselines/README.md",
];

const isExcluded = (rel: string): boolean => rel.startsWith(".agents/notes/archived/") || rel.includes("node_modules/");

const files = collectMarkdown(root, PATTERNS, isExcluded);
const violations = files.flatMap((file) =>
  findHardWrappedParagraphs(readFileSync(file.abs, "utf8")).map((paragraph) => ({ file: file.rel, ...paragraph })),
);

if (violations.length === 0) {
  console.log(`verify-md-wrap: no hard-wrapped paragraphs in ${files.length} files.`);
  process.exit(0);
}

console.error("verify-md-wrap: put each prose paragraph on one physical line and use editor soft wrapping:");
for (const v of violations) {
  const text = v.text.length > 80 ? `${v.text.slice(0, 80)}…` : v.text;
  console.error(`  ${v.file}:${v.line}  ${text}`);
}
console.error(`\n${violations.length} violations in ${new Set(violations.map((v) => v.file)).size} files.`);
process.exit(1);
