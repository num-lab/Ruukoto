/**
 * 校验仓库内 Markdown 的相对链接、图片与引用定义。
 * 目标文件必须存在；指向 Markdown 的 `#锚点` 必须命中真实标题 slug 或
 * 显式 `<a id>`。外部 URL、根绝对路径与模板占位符不判。
 *
 * 用法：npm run verify-md-links
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Nodes } from "mdast";
import { anchorCache, collectMarkdown, parseMarkdown, visitMarkdown } from "./markdown-scan.ts";

const root = resolve(import.meta.dirname, "..");

/** 纳入扫描的仓库自写 Markdown。归档笔记不作为源，但其锚点仍可被指向。 */
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

/** 归档笔记只读且冻结，不作为扫描源；依赖目录不是仓库自写文档。 */
const isExcluded = (rel: string): boolean => rel.startsWith(".agents/notes/archived/") || rel.includes("node_modules/");

/** 一处断链：目标文件不存在，或目标文件里没有该锚点。 */
interface Violation {
  file: string;
  line: number;
  url: string;
  reason: "target" | "anchor";
}

/** 外部、协议相对与根绝对路径不由本门禁判断。 */
function isExternal(url: string): boolean {
  if (url.startsWith("//") || url.startsWith("/")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/**
 * 去掉 `#fragment` 与 `?query` 后做百分号解码，让编码过的目标能在磁盘上找到；
 * 非法转义（如 `%zz`）保留原文，随后按断链报告而不是抛错。
 */
function pathPart(url: string): string {
  const raw = url.replace(/[#?].*$/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 百分号解码后的 `#fragment`，无片段时为 null。 */
function fragmentPart(url: string): string | null {
  const hash = url.indexOf("#");
  if (hash === -1) return null;
  try {
    return decodeURIComponent(url.slice(hash + 1).replace(/\?.*$/, ""));
  } catch {
    return url.slice(hash + 1).replace(/\?.*$/, "");
  }
}

/** 模板占位符（如 `<yyyy-mm-dd-topic>`、含省略号的示范路径）不指向真实文件。 */
function isPlaceholder(url: string): boolean {
  return url.includes("<") || url.includes(">") || url.includes("…");
}

/**
 * 找出一份 Markdown 里全部断链。
 * @param absPath 要扫描的文件绝对路径。
 * @param anchorsOf 跨文件共享的锚点查询。
 * @param scanRoot 诊断用的仓库根。
 */
export function findLinkViolations(absPath: string, anchorsOf: (abs: string) => Set<string>, scanRoot: string = root): Violation[] {
  const file = relative(scanRoot, absPath).split("\\").join("/");
  const dir = dirname(absPath);
  const source = readFileSync(absPath, "utf8");
  const tree = parseMarkdown(source);
  const out: Violation[] = [];

  const check = (url: string, node: Nodes): void => {
    if (isExternal(url) || isPlaceholder(url)) return;
    const target = pathPart(url);
    const resolved = target === "" ? absPath : resolve(dir, target);
    if (!existsSync(resolved)) {
      out.push({ file, line: node.position?.start.line ?? 0, url, reason: "target" });
      return;
    }
    const fragment = fragmentPart(url);
    if (fragment === null || !resolved.endsWith(".md")) return;
    if (!anchorsOf(resolved).has(fragment)) {
      out.push({ file, line: node.position?.start.line ?? 0, url, reason: "anchor" });
    }
  };

  visitMarkdown(tree, (node) => {
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && "url" in node) check(node.url, node);
  });
  return out;
}

const files = collectMarkdown(root, PATTERNS, isExcluded);
const anchorsOf = anchorCache();
const all = files.flatMap((file) => findLinkViolations(file.abs, anchorsOf));

if (all.length === 0) {
  console.log(`verify-md-links：${files.length} 个文件的相对链接与锚点均可解析。`);
  process.exit(0);
}

console.error("verify-md-links：发现断链：");
for (const v of all) {
  const detail = v.reason === "target" ? "目标不存在" : "目标没有该锚点";
  console.error(`  ${v.file}:${v.line}  ${v.url}  （${detail}）`);
}
process.exit(1);
