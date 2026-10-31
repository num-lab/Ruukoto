# Agent Note: Demo inspector tools

Status: implemented

[Markdown HTML rendering](../simplification/2026-10-25-desktop-markdown-html.md) supersedes the mutable demo's raw-HTML ban; frozen versions retain historical behavior.

## Problem

The owner wanted browser, file tree and previews in the mutable demo. The [previous approved design](../architecture/2026-10-15-desktop-shadcn-demo.md) supplied only diffs/SubAgents, while production prohibited direct workspace reads and remote content. A demo experiment must not silently change Electron or control-plane behavior.

## Decision

Add three inspector tab types using existing [header tabs](2026-10-16-demo-header-model-menu.md) and session isolation, not a permanent mode bar. Each workspace gets independent static file fixtures rather than reconstructed diff fragments or local filesystem access. File previews and diffs have distinct IDs. Source/text are read-only; Markdown uses the already-maintained react-markdown version, initially with raw HTML disabled. Images use explicit fixture resources. Empty files remain empty source areas; unsupported/missing files have explicit results.

The browser uses a sandboxed iframe, address-bar history and remount-based refresh, accepting only credential-free HTTP(S). As [iframe documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) explains, `load` is not proof of success and sites may refuse embedding. The [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) prevents reading cross-origin content, so do not invent titles, final URLs or internal page history. Navigation state is per tab. Switching tabs within a session retains the frame; switching sessions reloads it. Grant no `allow-same-origin`, top navigation, popups or downloads; add neither a proxy nor Electron webview.

A local default fixture supports offline verification. Before iframe creation, the parent detects same-origin root and `/index.html` entries and explains the restriction: sandbox-origin module CORS fails before React can prevent self-nesting. Opening/switching/resizing reveals the active tab by scrolling only its tab group, without changing focus or remounting the page.

## Alternatives considered

- Electron webContents and real directories offer full history/workspaces but exceed the demo. Production protocols/isolation require their own design; a visual experiment does not authorize relaxed CSP.
- Deriving full files from diffs saves fixtures but confuses removed/missing lines with complete content.
- A handwritten Markdown parser or `innerHTML` avoids dependencies but increases format/script-handling risk. Reuse the maintained renderer and the applicable HTML policy.

## Consequences

Historical acceptance for navigation, isolation, file types, dangerous addresses/text, narrow widths and themes remains in the offline inspector-demo work item. Existing diffs, Agents, approval cards and single-line composer remain. Engineering results and owner experience acceptance are distinct.

An iframe is not a full desktop browser: sites can refuse embedding and internal navigation does not become address-bar history. Static files are not real workspace contents. The later authorized [Desktop migration](../architecture/2026-10-16-desktop-current-demo.md) wires real read-only files and isolated browsing under its own contracts, while this note retains demo facts.

Later [source highlighting/input refinements](2026-10-16-demo-input-preview.md) belong only to the mutable demo unless explicitly migrated. The [Git graph](2026-10-17-demo-git-graph.md) reuses session-isolated tabs and repository fixtures. [File-tree loading feedback](2026-10-17-desktop-file-tree-loading.md) narrows the new-tab display and removes empty-directory prose without changing preview/browser authorization.
