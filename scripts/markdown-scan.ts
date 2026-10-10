/**
 * Markdown 解析与遍历，供文档门禁共用。
 * 只依赖 mdast 与 GFM 扩展；不做任何改写。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes } from "mdast";

/** 一个解析出的标题：源码行号、原始行、渲染后的文本。 */
export interface MarkdownHeading {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** 1 起的源码行号。 */
  line: number;
  raw: string;
  /** 渲染后的标题文本，不含原始 HTML 注释。 */
  text: string;
}

/** 一处多行段落：段落跨了多条物理行。 */
export interface HardWrappedParagraph {
  /** 1 起的段落起始行号。 */
  line: number;
  /** 起始行的原文，供诊断显示。 */
  text: string;
}

/** 以本仓库的标准扩展解析 GitHub 风格 Markdown。 */
export function parseMarkdown(source: string): Nodes {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/**
 * 深度优先遍历 Markdown 树。
 * @param node 当前节点。
 * @param visitor 进入子节点前调用；返回 false 时不进入其子节点。
 */
export function visitMarkdown(node: Nodes, visitor: (node: Nodes) => boolean | void): void {
  if (visitor(node) === false) return;
  if ("children" in node) for (const child of node.children) visitMarkdown(child, visitor);
}

/** 一个 Markdown 节点呈现给读者的文本；原始 HTML 本身不贡献文本。 */
function renderedText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return " ";
  if ("children" in node) return node.children.map((child) => renderedText(child)).join("");
  return "";
}

/** 返回全部标题及其渲染文本与源码行号。 */
export function markdownHeadings(source: string): MarkdownHeading[] {
  const rawLines = source.split("\n");
  const headings: MarkdownHeading[] = [];
  visitMarkdown(parseMarkdown(source), (node) => {
    if (node.type !== "heading" || node.position === undefined) return;
    headings.push({
      depth: node.depth,
      line: node.position.start.line,
      raw: rawLines[node.position.start.line - 1] ?? "",
      text: renderedText(node),
    });
  });
  return headings;
}

/**
 * GitHub 的标题锚点算法：转小写，去掉字母、数字、下划线、空格与连字符之外
 * 的全部字符，空格替换为连字符。下划线保留，中文字符属于字母，一并保留。
 * @param heading 渲染后的标题文本（Markdown 语法已消失）。
 * @returns 该标题首次出现时 GitHub 赋予的锚点。
 */
export function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replaceAll(" ", "-");
}

/**
 * 一份文档暴露的全部锚点：每个标题的 GitHub 锚点，加上真实 HTML 流中出现的
 * `<a id="…">`（代码块与注释里的不算）。重复锚点按 GitHub 的占用集追加
 * `-1`、`-2`。匹配区分大小写。
 */
export function documentAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const heading of markdownHeadings(source)) {
    const base = githubSlug(heading.text);
    let result = base;
    let bump = occurrences.get(base) ?? 0;
    while (anchors.has(result)) {
      bump += 1;
      result = `${base}-${bump}`;
    }
    occurrences.set(base, bump);
    anchors.add(result);
  }
  visitMarkdown(parseMarkdown(source), (node) => {
    if (node.type !== "html") return;
    const html = node.value.replace(/<!--[\s\S]*?-->/g, "");
    for (const match of html.matchAll(/<a id="([^"]+)"/g)) anchors.add(match[1] ?? "");
  });
  return anchors;
}

/** 按绝对路径缓存某文件的锚点集，跨文件共享时每个目标只解析一次。 */
export function anchorCache(): (absPath: string) => Set<string> {
  const cache = new Map<string, Set<string>>();
  return (absPath) => {
    const hit = cache.get(absPath);
    if (hit !== undefined) return hit;
    const anchors = documentAnchors(readFileSync(absPath, "utf8"));
    cache.set(absPath, anchors);
    return anchors;
  };
}

/**
 * 找出全部跨行段落：一段 prose 占用了多条物理行。约定是一段一物理行，
 * 代码块、表格与列表结构不受影响。
 */
export function findHardWrappedParagraphs(source: string): HardWrappedParagraph[] {
  const lines = source.split("\n");
  const found: HardWrappedParagraph[] = [];
  visitMarkdown(parseMarkdown(source), (node) => {
    if (node.type !== "paragraph" || node.position === undefined) return;
    const { start, end } = node.position;
    if (end.line > start.line) {
      found.push({ line: start.line, text: (lines[start.line - 1] ?? "").trim() });
    }
    // 段落子节点都是行内节点，不会再嵌段落。
    return false;
  });
  return found;
}

/** 一份被扫描的 Markdown 源文件。 */
export interface ScannedFile {
  /** 相对仓库根、以正斜杠分隔的路径。 */
  rel: string;
  abs: string;
}

/**
 * 按 glob 模式收集仓库内的 Markdown 文件。支持 `**`、`*`、`?`；
 * 以 `.` 开头的目录默认跳过，`**` 可跨任意层。
 * @param root 仓库根的绝对路径。
 * @param patterns 相对仓库根的 glob 模式。
 * @param exclude 收到相对路径、返回 true 时排除（归档树用）。
 */
export function collectMarkdown(root: string, patterns: readonly string[], exclude?: (rel: string) => boolean): ScannedFile[] {
  const seen = new Map<string, ScannedFile>();
  for (const pattern of patterns) {
    for (const abs of expandGlob(root, pattern)) {
      const rel = relative(root, abs).split(sep).join("/");
      if (exclude?.(rel) === true) continue;
      seen.set(rel, { rel, abs });
    }
  }
  return [...seen.values()].sort((left, right) => left.rel.localeCompare(right.rel));
}

/** 把一条 glob 模式展开为匹配的文件绝对路径。 */
function expandGlob(root: string, pattern: string): string[] {
  const segments = pattern.split("/");
  let current = [root];
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    const next: string[] = [];
    for (const dir of current) {
      if (segment === "**") {
        // `**` 匹配零层或多层目录；按 glob 默认规则跳过点目录。
        next.push(dir);
        for (const child of listDirectories(dir)) {
          if (basename(child).startsWith(".")) continue;
          next.push(child, ...walkDirectories(child));
        }
        continue;
      }
      if (isLast) {
        for (const name of listFiles(dir)) if (matchSegment(segment, basename(name))) next.push(name);
      } else {
        for (const name of listDirectories(dir)) if (matchSegment(segment, basename(name))) next.push(name);
      }
    }
    current = next;
  }
  return current;
}

function listDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** 递归列出目录自身与其全部子目录（跳过点目录）。 */
function walkDirectories(dir: string): string[] {
  const out: string[] = [];
  for (const child of listDirectories(dir)) out.push(child, ...walkDirectories(child));
  return out;
}

/** 单段 glob 匹配：支持 `*` 与 `?`，不匹配以点开头的名字。 */
function matchSegment(pattern: string, name: string): boolean {
  if (name.startsWith(".") && (pattern.startsWith("*") || pattern.startsWith("?"))) return false;
  let expression = "";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(name);
}

/** 相对仓库根解析一个 Markdown 目标的绝对路径。 */
export function resolveTarget(fromAbs: string, target: string): string {
  return resolve(fromAbs, "..", target);
}

/** 文件是否存在且是普通文件。 */
export function isFile(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}
