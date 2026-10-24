import { parse, type DefaultTreeAdapterTypes } from "parse5";

export class WebFetchError extends Error {
  constructor(readonly code: "encoding_unsupported" | "content_unsupported" | "body_missing", message: string) { super(message); }
}

const OMIT = new Set(["script", "style", "template", "noscript", "nav", "footer", "aside", "form", "svg", "canvas"]);
const BLOCK = new Set(["address", "article", "blockquote", "br", "dd", "div", "dl", "dt", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul"]);
type Node = DefaultTreeAdapterTypes.Node;
function omitted(node: Node): boolean {
  return "tagName" in node && (OMIT.has(node.tagName) || node.attrs.some(attr => attr.name === "hidden" || attr.name === "aria-hidden" && attr.value === "true"));
}

function textOf(root: Node): string {
  const pending: Array<{ node: Node; pre: boolean } | string> = [{ node: root, pre: false }], parts: string[] = [];
  while (pending.length) {
    const item = pending.pop()!;
    if (typeof item === "string") { parts.push(item); continue; }
    const { node } = item;
    if (omitted(node)) continue;
    if ("value" in node) { parts.push(item.pre ? node.value : node.value.replace(/\s+/gu, " ")); continue; }
    if (!("childNodes" in node)) continue;
    const block = "tagName" in node && BLOCK.has(node.tagName);
    if (block) { parts.push("\n"); pending.push("\n"); }
    const pre = item.pre || "tagName" in node && node.tagName === "pre";
    for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push({ node: node.childNodes[index], pre });
  }
  return parts.join("").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

// Note: 见 .agents/notes/implemented/feature/2026-10-25-code-web-fetch.md
export function webPageText(bytes: Uint8Array, headers: Record<string, string>, partial: boolean): { title?: string; text: string } {
  const encoding = headers["content-encoding"]?.trim().toLowerCase();
  if (encoding && encoding !== "identity") throw new WebFetchError("encoding_unsupported", "网页使用了不支持的压缩编码；browser 可用时可打开页面，否则请报告拥有者此限制。");
  const contentType = headers["content-type"] ?? "", mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const html = mediaType === "text/html" || mediaType === "application/xhtml+xml";
  if (!html && mediaType !== "text/plain" && mediaType !== "text/markdown") throw new WebFetchError("content_unsupported", "响应不是支持的 HTML 或文本正文；请用 http_request 读取原响应，browser 可用时也可打开网页。");
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1].toLowerCase();
  if (charset && !["utf-8", "utf8", "us-ascii"].includes(charset)) throw new WebFetchError("encoding_unsupported", "网页字符编码不受支持；browser 可用时可打开页面，否则请报告拥有者此限制。");
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial }); }
  catch { throw new WebFetchError("encoding_unsupported", "网页不是有效的 UTF-8 文本；browser 可用时可打开页面，否则请报告拥有者此限制。"); }
  if (body.includes("\0")) throw new WebFetchError("content_unsupported", "响应包含二进制内容，无法作为网页正文；请用 http_request 核实原响应。");
  if (!html) {
    if (!body.trim()) throw new WebFetchError("body_missing", "响应没有正文；请核实来源 URL；browser 可用时可查看页面，否则请报告拥有者。");
    return { text: body.trim() };
  }
  const document = parse(body), pending: Node[] = [document];
  let title: string | undefined, main: Node | undefined, article: Node | undefined, fallback: Node = document;
  while (pending.length) {
    const node = pending.pop()!;
    if (omitted(node)) continue;
    if ("tagName" in node) {
      if (node.tagName === "title") title ??= textOf(node).slice(0, 512);
      if (node.tagName === "main") main ??= node;
      if (node.tagName === "article") article ??= node;
      if (node.tagName === "body") fallback = node;
    }
    if ("childNodes" in node) for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]);
  }
  const text = textOf(main ?? article ?? fallback);
  if (!text) throw new WebFetchError("body_missing", "网页没有可读取的静态正文，可能需要脚本渲染；browser 可用时可打开页面，否则请报告拥有者此限制。");
  return { ...(title ? { title } : {}), text };
}
