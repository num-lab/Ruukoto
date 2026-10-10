/**
 * 拒绝跨多条物理行的 Markdown prose 段落：约定是一段一物理行，靠编辑器软换行。
 * 代码块、表格与列表结构不受影响（mdast 的段落节点只在真正并段时报错）。
 * 本门禁只报告，从不改写。
 *
 * 用法：npm run verify-md-wrap
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectMarkdown, findHardWrappedParagraphs } from "./markdown-scan.ts";

const root = resolve(import.meta.dirname, "..");

/** 与 verify-md-links 相同的扫描范围。 */
const PATTERNS = [
  "README.md",
  "AGENTS.md",
  "CONTEXT.md",
  "docs/**/*.md",
  ".agents/notes/**/*.md",
  ".agents/skills/**/*.md",
  "deploy/**/*.md",
  "verification/**/README.md",
];

/** 归档笔记冻结不可改，依赖目录不是仓库自写文档。 */
const isExcluded = (rel: string): boolean => rel.startsWith(".agents/notes/archived/") || rel.includes("node_modules/");

const files = collectMarkdown(root, PATTERNS, isExcluded);
const violations = files.flatMap((file) =>
  findHardWrappedParagraphs(readFileSync(file.abs, "utf8")).map((paragraph) => ({ file: file.rel, ...paragraph })),
);

if (violations.length === 0) {
  console.log(`verify-md-wrap：${files.length} 个文件无跨行段落。`);
  process.exit(0);
}

console.error("verify-md-wrap：以下 prose 段落跨了多条物理行（一段写成一行，用编辑器软换行）：");
for (const v of violations) {
  const text = v.text.length > 80 ? `${v.text.slice(0, 80)}…` : v.text;
  console.error(`  ${v.file}:${v.line}  ${text}`);
}
console.error(`\n共 ${violations.length} 处，分布在 ${new Set(violations.map((v) => v.file)).size} 个文件。`);
process.exit(1);
