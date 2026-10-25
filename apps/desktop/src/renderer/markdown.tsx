import { Streamdown, defaultUrlTransform, type Components, type ControlsConfig, type StreamdownProps, type StreamdownTranslations, type UrlTransform } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

// Note: 见 .agents/notes/implemented/feature/2026-10-25-desktop-streamdown.md
// Streamdown 默认管线先用 rehype-raw 解析原始 HTML（使 skipHtml 失效）且把 img src 限在 http/https；
// 这里替换为仅含 rehype-sanitize 的管线：原始 HTML 仍跳过，img src 放行 file、blob 与 data。
// 数学插件的核心会追加在 sanitize 之后，KaTeX 输出不经过滤；单美元记法保持关闭以免误伤普通文本。
const markdownRehypePlugins: StreamdownProps["rehypePlugins"] = [[rehypeSanitize, { ...defaultSchema, clobberPrefix: "", protocols: { ...defaultSchema.protocols, src: ["http", "https", "file", "blob", "data"] } }]];
const markdownPlugins = { code, math, mermaid };
const imageUrlTransform: UrlTransform = (url, key, node) => node.tagName === "img" && key === "src" ? url : defaultUrlTransform(url, key, node);
const markdownControls: ControlsConfig = { code: { copy: true, download: false }, image: { download: false }, mermaid: { fullscreen: true, panZoom: true }, table: { copy: true, download: false, fullscreen: true } };
const markdownTranslations: Partial<StreamdownTranslations> = { close: "关闭", copyCode: "复制代码", copied: "已复制", copyLink: "复制链接", copyTable: "复制表格", copyTableAsCsv: "复制为 CSV", copyTableAsMarkdown: "复制为 Markdown", copyTableAsTsv: "复制为 TSV", errorMermaid: "图表渲染失败", exitFullscreen: "退出全屏", imageNotAvailable: "图片不可用", mermaidAriaLabel: "Mermaid 图表", openLink: "打开链接", resetView: "重置缩放与平移", viewFullscreen: "全屏查看", zoomIn: "放大", zoomOut: "缩小" };

export function MarkdownText({ children, mode = "streaming", components }: { children: string; mode?: "static" | "streaming"; components?: Components }) {
  return <Streamdown skipHtml mode={mode} urlTransform={imageUrlTransform} rehypePlugins={markdownRehypePlugins} plugins={markdownPlugins} linkSafety={{ enabled: false }} controls={markdownControls} translations={markdownTranslations} components={components}>{children}</Streamdown>;
}
