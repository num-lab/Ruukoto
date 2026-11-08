import { Streamdown, defaultRehypePlugins, defaultUrlTransform, type Components, type ControlsConfig, type StreamdownProps, type StreamdownTranslations, type UrlTransform } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

// Note: See .agents/notes/implemented/feature/2026-10-25-desktop-streamdown.md
// Note: See .agents/notes/implemented/simplification/2026-10-25-desktop-markdown-html.md
// The default sanitize drops file/blob/data image URLs; harden rewrites relative URLs.
// The math plugin core is appended after sanitize, so KaTeX output is unfiltered; single-dollar notation stays off to protect plain text.
const markdownRehypePlugins: StreamdownProps["rehypePlugins"] = [defaultRehypePlugins.raw, [rehypeSanitize, { ...defaultSchema, clobberPrefix: "", protocols: { ...defaultSchema.protocols, src: ["http", "https", "file", "blob", "data"] } }]];
const markdownPlugins = { code, math, mermaid };
const imageUrlTransform: UrlTransform = (url, key, node) => node.tagName === "img" && key === "src" ? url : defaultUrlTransform(url, key, node);
const markdownControls: ControlsConfig = { code: { copy: true, download: false }, image: { download: false }, mermaid: { fullscreen: true, panZoom: true }, table: { copy: true, download: false, fullscreen: true } };
const markdownTranslations: Partial<StreamdownTranslations> = { close: "Close", copyCode: "Copy code", copied: "Copied", copyLink: "Copy link", copyTable: "Copy table", copyTableAsCsv: "Copy as CSV", copyTableAsMarkdown: "Copy as Markdown", copyTableAsTsv: "Copy as TSV", errorMermaid: "Failed to render the chart", exitFullscreen: "Exit fullscreen", imageNotAvailable: "Image unavailable", mermaidAriaLabel: "Mermaid chart", openLink: "Open link", resetView: "Reset zoom and pan", viewFullscreen: "View fullscreen", zoomIn: "Zoom in", zoomOut: "Zoom out" };

export function MarkdownText({ children, mode = "streaming", components }: { children: string; mode?: "static" | "streaming"; components?: Components }) {
  return <Streamdown mode={mode} urlTransform={imageUrlTransform} rehypePlugins={markdownRehypePlugins} plugins={markdownPlugins} linkSafety={{ enabled: false }} controls={markdownControls} translations={markdownTranslations} components={components}>{children}</Streamdown>;
}
