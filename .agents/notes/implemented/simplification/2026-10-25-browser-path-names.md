# Agent Note: Remove filename blacklists from local document preview

Status: implemented

## Problem

Local preview rejected names such as `.env*`, `.git` and `.ssh` both for explicit opening and relative resources. On 2026-10-25 the owner confirmed that classifying sensitive names is not this previewer's responsibility and requested removal.

## Decision

Delete the name blacklist. Direct regular-file opens and resource reads share the same remaining constraints: directory capability root, links, userData protection, formats, read budgets and page isolation. Add no option or approval. The owner explicitly accepted that page scripts can now read formerly name-blocked files inside the preview directory.

This partly supersedes [local-document capabilities](../feature/2026-10-17-desktop-local-browser.md). Terminal, backend browser, present and preview-access decisions do not use this name classification. Historical implementation/verification remains in the offline browser-path-names work item.

## Alternatives considered

Keeping/narrowing the blacklist blocks some common credential names, but still makes preview maintain sensitive-name classifications and falsely reject valid paths, contrary to the approved responsibility.

## Consequences

`.env.local`, `.git/config` and `.environment/index.html` can be read as ordinary files. The blacklist no longer reduces within-directory secrets being read/exfiltrated by page scripts. The capability still covers only the selected document's real parent and descendants, never arbitrary host files.
