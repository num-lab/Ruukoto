/**
 * 按 `scripts/doc-budgets.manifest.json` 的字符上限校验常驻文档。
 * 计数单位是**非空白字符数**（中文语境的「字数」），不是 `wc -w` 的词数：
 * 中文词数几乎不随正文增长（实测同一份文档词数与字符数相差 10~22 倍）。
 *
 * 文件缺失、上限非正整数、超限分别失败。`--list` 打印当前用量并始终退出 0。
 *
 * 用法：npm run verify-doc-budgets [-- --list]
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = resolve(root, "scripts/doc-budgets.manifest.json");

/** 计数单位：去掉全部空白字符后的长度。 */
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
    failures.push(`${path}：上限必须是正整数，收到 ${ceiling}`);
    continue;
  }
  const abs = resolve(root, path);
  if (!existsSync(abs)) {
    rows.push(`MISS  ${"—".padStart(7)} / ${String(ceiling).padEnd(7)} ${path}`);
    failures.push(`${path}：受预算约束的文件不存在（改名或删除了？同一改动里更新 scripts/doc-budgets.manifest.json）`);
    continue;
  }
  const chars = countChars(readFileSync(abs, "utf8"));
  rows.push(`${chars <= ceiling ? "ok  " : "OVER"}  ${String(chars).padStart(7)} / ${String(ceiling).padEnd(7)} ${path}`);
  if (chars > ceiling) {
    failures.push(`${path}：${chars} 字符超过 ${ceiling} 的上限——按 .agents/notes/README.md 的规则先搬走属于其他层的内容，再压缩；提高上限要在同一改动里说明理由`);
  }
}

if (listOnly) {
  console.log(rows.join("\n"));
  process.exit(0);
}

if (failures.length > 0) {
  console.error("verify-doc-budgets 失败：\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\n上限是护栏，不是缩减目标；先搬运、再压缩、最后才提高。");
  process.exit(1);
}

console.log(`verify-doc-budgets：${Object.keys(manifest).length} 份常驻文档均在上限内。`);
