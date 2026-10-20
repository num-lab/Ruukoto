import hljs from "highlight.js/lib/core";
import xml from "highlight.js/lib/languages/xml";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import rust from "highlight.js/lib/languages/rust";
import python from "highlight.js/lib/languages/python";
import swift from "highlight.js/lib/languages/swift";

for (const [name, grammar] of Object.entries({ xml, javascript, typescript, json, markdown, rust, python, swift })) hljs.registerLanguage(name, grammar);

const languages: Record<string, string> = { ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", json: "json", md: "markdown", markdown: "markdown", rs: "rust", py: "python", swift: "swift", html: "xml", xml: "xml" };

// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-input-preview.md
export function highlightSource(path: string, content: string): string | null {
  const language = languages[path.split(".").at(-1)?.toLowerCase() ?? ""];
  return language ? hljs.highlight(content, { language, ignoreIllegals: true }).value : null;
}
