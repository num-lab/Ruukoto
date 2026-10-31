# Agent Note: Use Streamdown for Desktop Markdown bodies

Status: implemented

[Markdown HTML rendering](../simplification/2026-10-25-desktop-markdown-html.md) supersedes raw-HTML escaping and the sanitize-only pipeline. Other decisions remain.

## Problem

Code main/child chat, Personal chat, file preview, and both products' skills used full react-markdown rendering on every update. Incomplete streamed code blocks/tables flashed incorrect structures before reflow, and blocks/tables lacked copy controls. The owner requested Streamdown.

## Decision

All bodies use `MarkdownText` in `apps/desktop/src/renderer/markdown.tsx`. Chat defaults to streaming mode, with remend completing unfinished structures. File/skill bodies use static mode to reflect saved text. Conversation inline-code file references move to components.inlineCode. Streamdown's default block/table renderers own line numbers, language headers, and copying. Disable linkSafety because main-process setWindowOpenHandler sends external links to the system browser. Disable download controls because will-download blocks them; retain copy controls with Chinese UI strings.

## Rendering and filtering

Streamdown defaults to raw, sanitize, then harden. Raw parses HTML before skipHtml can act; default sanitization limits image src to http/https; harden rewrites relative addresses to root paths. The original migration therefore replaced that pipeline with custom sanitize-only handling, extending default src protocols with file/blob/data and setting clobberPrefix empty like the library. The later HTML decision adds the exported raw plugin before that same sanitizer. Nonimage URLs still use default transformation to filter javascript and similar schemes; images preserve src according to [direct-image behavior](../simplification/2026-10-25-desktop-markdown-images.md). Harden remains absent.

Code/math/mermaid plugins are enabled. Shiki uses pure-JS regex rather than wasm, so CSP need not loosen; Vite splits grammars/themes on demand. Math uses remark-math/rehype-katex. Streamdown appends KaTeX after sanitize, so generated KaTeX output is not filtered again. Single-dollar math stays disabled to avoid prices. Display math requires `$$` fences; `\(...\)` follows Markdown escaping as ordinary text, matching the react-markdown era. KaTeX styles/fonts bundle as same-origin resources through @import and default-src self. Mermaid loads lazily, including cytoscape chunks, with strict security. @streamdown/cjk is not installed.

## Alternatives considered

Keeping react-markdown with custom stream completion recreates Streamdown's core incomplete-block/reflow handling. Using the default pipeline plus allowedTags/components cannot recover image src already removed by sanitization, and would have changed the then-approved raw-HTML behavior. Explicit plugins preserve the chosen image/filter policy.

## Consequences

Streamdown's Tailwind classes own element styling. Old element rules in .markdown/.file-markdown are removed, retaining container/link baselines; style.css scans Streamdown dist with @source and maps --color-sidebar for code blocks. The original migration revised the approved-v4 base/delta chain for matching source scans and removed old file-Markdown typography, then aligned Demo on markdown.tsx and direct images. This was that chain's first revision after append-only changes; Git history retains its former state. Current frozen assets are not rewritten merely for later directory migration; build-time resolution must respect their new location.

Streaming no longer flashes incomplete structures and code/tables gain copy/fullscreen actions. Default visual differences include strong as a font-semibold span and larger headings; marked/remend and other transitive dependencies are added. Plugin source scans and KaTeX imports are aligned in the Demo/reference chain. Electron file pages were verified secure enough for clipboard copying. Seven image-address SSR cases remain, file markup assertions follow the new renderer, and `test/desktop-streamdown-plugins.test.ts` covers plugins. Actual asynchronous Shiki colors/Mermaid diagrams are not proven by SSR and require real Electron verification.
