# Agent Note: Display Markdown images directly in Desktop

Status: implemented

[HTML rendering](2026-10-25-desktop-markdown-html.md) supersedes the former raw-HTML skipping rule. Image and link rules remain.

## Problem

Desktop replaced Markdown images with text, preventing screenshots and illustrations in normal replies from displaying. The owner explicitly requested removal of these restrictions. Removing the placeholder alone would still leave URL transformation and CSP blocking images.

## Decision

Code main/child conversations, Personal chat, file preview, and both products' skill bodies render native img elements. Image src goes unchanged to the browser; other URLs retain the renderer's default transformation, now supplied by the [Streamdown pipeline](../feature/2026-10-25-desktop-streamdown.md). The original change kept raw HTML skipped; the later HTML decision replaces that rule. Development and production `img-src` allow network, file, data, and blob sources, with images scaled to container width. Reuse the library/browser without adding an image proxy, path mapper, permission, or switch.

This supersedes image placeholders/source restrictions in the [Desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md) and [Code Skills](../feature/2026-10-21-desktop-code-skills.md), not their other decisions. [Current-demo migration](../architecture/2026-10-16-desktop-current-demo.md) still reads preview files through the backend; only images embedded in Markdown load differently. [Local page preview](../feature/2026-10-17-desktop-local-browser.md) owns a separate iframe resource service.

## Alternatives considered

Placeholders avoid image requests but violate the request to display normal replies. Proxying all images through file-preview interfaces could check workspace/artifact origins and handle remote paths, but requires new parsing and asynchronous loading. Removing only the placeholder is insufficient: default URL conversion clears file/data/blob and CSP still blocks network images.

## Consequences

Browser-native loading and failures replace application placeholders/source restrictions. Local paths refer to the Desktop machine; relative paths resolve against the page URL; network images contact their servers. These are approved native behaviors. HTTP development pages and MyGo file access may still face engine restrictions. Remote workspace paths are not mapped automatically to the local machine; cross-host display needs separate work.

Actual-component SSR regressions cover seven address classes, alt text, and dangerous-link filtering across main/child, Personal, files, and shared skill bodies. The original tests also checked raw-HTML skipping; later HTML tests update that behavior. The old placeholder fails the image regressions. CSP and both skill pages retain their existing checks. Historical engineering/native-load evidence is in the offline copy of `.scratch/desktop-markdown-images/issues/01-remove-image-restrictions.md`.
