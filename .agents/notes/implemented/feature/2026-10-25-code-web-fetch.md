# Agent Note: Reuse approved HTTP reads for webpage text

Status: implemented

## Problem

Coding had only generic `http_request`; HTML tags and scripts obscured page text. Transport truncation was recorded only in a message the router did not expose. The owner requested readable webpage content.

## Decision

`web_fetch(url, reason)` performs a fixed credential-free GET using existing HTTP URL/DNS pinning, approval, cancellation, and read-only effect classification. `http_request` remains. The project Web Search switch still controls only the search service. Fetching executes no scripts, follows no redirects, and retries nothing. A redirect returns only a valid credential-free HTTP(S) destination for a separate call.

Reuse installed `parse5`, declared as a direct agent dependency at the same version. Prefer main/article content, then body; remove scripts, styles, navigation, forms, and other non-body content while retaining paragraphs and preformatted text. UTF-8 HTML, plain text, and Markdown are supported. Unsupported encodings, compression, binary data, and empty extracted text fail explicitly rather than return gibberish as success.

Transport captures at most 1MiB, retaining the in-budget prefix of a crossing chunk and reporting structured truncation. Text preview is capped at 16KiB; longer text becomes an artifact with a byte continuation offset. Source truncation and preview paging are separate: an incompletely fetched source remains a partial artifact, never a complete original. `http_request` also exposes actual truncation. The 30-second timeout remains socket inactivity, not an absolute deadline.

[Tool execution](../architecture/2026-09-20-tool-worker-per-task-container.md) and [result paging](2026-10-16-tool-result-pagination.md) retain approval and artifact ownership. Web Search, MCP, and Personal durable have separate entry points.

## Alternatives considered

Returning raw HTTP maximizes reuse but leaves HTML noise and hides upstream truncation. A browser or remote extraction service supports dynamic pages but adds execution, credentials, and cost. Regex tag stripping is short but unreliable for entities, nesting, and malformed HTML; reuse the standard parser.

## Consequences

Static page text is readable with continuation for long output, while source permissions and non-replay rules remain. Script-rendered pages or other encodings still need a browser. Extraction is not comprehension and cannot identify every site's correct main section. Local HTTP fixtures exercise actual approvals, redirects, encoding, truncation, and artifacts. Historical internet/model evidence is in the offline copy of `.scratch/agent-tools-next/issues/01-code-tools.md`.
