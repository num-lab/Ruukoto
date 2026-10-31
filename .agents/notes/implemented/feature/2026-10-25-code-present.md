# Agent Note: Wire Coding preview requests through tool artifacts and the inspector

Status: implemented

[MyGo inspector browsing](2026-10-29-mygo-agent-browser.md) owns URL presentation/navigation ordering. [Preview access](2026-10-25-present-preview-access.md) supersedes the original full-access browser eligibility restriction; file capture, provenance and history remain.

## Problem

The owner wanted Agents to open files/pages in the inspector. Owner file-tree reads do not use Agent protected-directory restrictions; passing model paths to that interface would mix authorization sources.

## Decision

Main sessions expose `present` with mutually exclusive `path` or `url`. Files use the current task's `read` execution boundary to capture immutable artifacts; Desktop always displays that capture, even for workspace files. Zero-byte reads emit capture facts and create empty artifacts. Reuse Markdown/text/image previews; HTML displays source and unsupported formats state limits.

URLs accept only credential-free HTTP(S). The initial full-access browser eligibility is replaced by the linked preview-access decision. Display uses existing isolated browsing. Models cannot provide file URLs or obtain directory resources through the owner's local-document service. SubAgents/workflow steps cannot present; the main session chooses their results to show.

Existing tool_intent/tool_result store target, result and artifact. Only live successful results auto-open. If the source session is not current, retain its tab without switching sessions. Duplicate events never reopen a closed tab. Historical tool rows explicitly reopen; replay does not steal focus. Receipt proves only that the preview request was recorded, not client connectivity, page load or owner visibility.

This reuses [Read snapshots](2026-10-17-desktop-read-snapshot.md) and [complete transfer](2026-10-18-complete-reasoning-and-preview.md) pagination/ownership while adding empty captures. [Owner browsing](2026-10-24-owner-workspace-browsing.md) remains independently authorized; [local-document capabilities](2026-10-17-desktop-local-browser.md) are not granted to this tool.

## Alternatives considered

- Direct file-tree paths use fewer calls but borrow owner authority and lose call-time versions.
- A new event/control protocol models previews separately, but existing tool records reconstruct target/artifact already.
- Replaying all opens is proactive but reopens intentionally closed panels. Keep explicit history links.

## Consequences

Agents can present results with verifiable permissions, captured versions and source sessions. URL access follows the later preview-access rule; existing format limits remain and embedding restrictions are not bypassed. Requests remain in history without a desktop. Tool success is not visual acceptance. Historical tool/DOM evidence and real-client gaps remain in the offline Code tools work item.
