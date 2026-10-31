# Agent Note: Byte pagination for structured tool-result fields

Status: implemented

## Problem

Desktop `more` must read complete long Edit patches and Write inputs. `read_tool_result` previews stop at 64 KiB per field; `read_history_entry` pages ordinary result text but cannot restore separately stored patches or matching Write arguments. The owner authorized minimal backend support while preserving tool-success semantics.

## Decision

Calls without `field` retain all existing preview parameters/responses. Add `field: text | patch | writeContent`, optional UTF-8 byte `offset`, and one `content: BoundedText | null`. In paged mode legacy previews are fixed at 16 KiB while `content` uses requested length, keeping text/patch/page data within the 1 MiB response frame even under sixfold JSON escaping. `content` comes only from the requested original field: missing is null, empty is an empty zero-total page. Patches originally came only from Edit `details.patch`; Write content comes from the latest matching tool-call arguments, never inferred from result text.

Page length defaults to 16 KiB; explicit values are 4-65536 bytes, allowing progress for a four-byte character. Offset defaults to zero and must be a safe nonnegative integer on an exact UTF-8 character boundary. Past-end or split-character offsets are `invalid_params`; an empty end page is valid, while missing fields permit offset zero only. Core reports data-dependent offset failures as coded HistoryReadError, the control plane checks external parameter types, and Runtime retains session ownership checks.

Use `content.offset`, `totalBytes` and actual UTF-8 text length to verify continuity/end. Existing BoundedText `truncated` can remain true on the final page because the prefix is omitted; it is not a next-page flag. There is no server cursor. An immutable history field retains its total as later entries append; clients must not join different entries or fields. Raw content does not prove tool success: existing status, `effect_unknown` and `isError` still govern display.

This expands the [desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md)'s 64 KiB total restriction into a per-preview/page limit, preserving read eligibility, failure and empty-write behavior. [Desktop Trace migration](../architecture/2026-10-16-desktop-trace-migration.md) later extends patch sources to Write, retaining pagination/missing semantics.

## Alternatives considered

- Paging all three fields simultaneously offers parallel reads, but their differing lengths make shared offsets/endpoints ambiguous. The caller displays one field at a time, so expose one content page.
- Extracting patches/Write input from `read_history_entry` reuses pagination, but ordinary text lacks those structured fields and cannot distinguish empty writes from missing data.

## Consequences

Old TUI/desktop preview callers need no migration. Paged callers reuse authentication, session ownership and persistent entry identity. No new filesystem read, storage format, schema version or execution behavior is introduced. Each page still parses current session JSONL and carries old previews rather than caching full results; measure actual bottlenecks before changing that cost.

`test/11-history-read.test.ts` covers core plus real Runtime/ControlServer, Chinese/emoji boundaries, both structured fields beyond 64 KiB, stable totals after append, unchanged legacy previews, missing/empty fields, retained `isError`, invalid parameters and worst-case JSON escaping. Desktop loading/concatenation/stale-response behavior has separate caller acceptance.
