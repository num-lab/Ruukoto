/**
 * 校验仓库自写 TypeScript 注释里引用的 docs 与 notes 路径确实存在。
 * 路径按仓库根解析，必须带 `.md` 扩展名。
 *
 * 用法：npm run verify-doc-refs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** 扫描范围：源码与入口脚本可能引用文档。 */
const DIRECTORIES = ["src", "bin", "scripts"];

/** 根相对、带扩展名的文档路径令牌。 */
const DOC_REF = /(?:\.agents\/notes|docs)\/[A-Za-z0-9._/-]+\.md/g;

/** 排除构建产物与第三方源码。 */
const isExcluded = (rel: string): boolean => rel.includes("node_modules/") || rel.endsWith(".d.ts");

/** 接口：一处失效的文档引用。 */
interface Violation {
  file: string;
  line: number;
  ref: string;
}

/** 递归收集目录下全部文件（跳过 node_modules）。 */
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
  console.log(`verify-doc-refs：${sources.length} 个源码文件里的文档引用均可解析。`);
  process.exit(0);
}

console.error("verify-doc-refs：源码注释引用了不存在的文档：");
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.ref}`);
process.exit(1);
