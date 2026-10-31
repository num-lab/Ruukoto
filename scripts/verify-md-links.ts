import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Nodes } from "mdast";
import { anchorCache, collectMarkdown, parseMarkdown, visitMarkdown } from "./markdown-scan.ts";

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

interface Violation {
  file: string;
  line: number;
  url: string;
  reason: "target" | "anchor";
}

function isExternal(url: string): boolean {
  if (url.startsWith("//") || url.startsWith("/")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

// Malformed percent escapes remain literal so they produce a broken-link report.
function pathPart(url: string): string {
  const raw = url.replace(/[#?].*$/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function fragmentPart(url: string): string | null {
  const hash = url.indexOf("#");
  if (hash === -1) return null;
  try {
    return decodeURIComponent(url.slice(hash + 1).replace(/\?.*$/, ""));
  } catch {
    return url.slice(hash + 1).replace(/\?.*$/, "");
  }
}

function isPlaceholder(url: string): boolean {
  return url.includes("<") || url.includes(">") || url.includes("…");
}

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
  console.log(`verify-md-links: relative links and anchors verified in ${files.length} files.`);
  process.exit(0);
}

console.error("verify-md-links: broken links:");
for (const v of all) {
  const detail = v.reason === "target" ? "target does not exist" : "target has no matching anchor";
  console.error(`  ${v.file}:${v.line}  ${v.url}  (${detail})`);
}
process.exit(1);
