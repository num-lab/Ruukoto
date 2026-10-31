# Agent Note: Personal general tools use durable authorization and original-byte evidence

Status: implemented

[Request configuration](2026-10-25-personal-request-configuration.md) owns independent Web Search configuration/selection without switching unrelated file/HTTP operations. [Operation-specific checks](../bug-fix/2026-10-24-operation-specific-checks.md) removes unconditional material-directory checks: network/full-access operations check only actual dependencies. Original source, approval, permission revision and unknown-effect rules remain.

## Problem

Personal commands/MCP already recovered original work, while file, HTTP, search and artifacts still used old ToolRouter, approval ledger and ArtifactStore. Reusing those entries reintroduces old Db. Shell alone cannot preserve exact file grants/automatic review. Old HTTP converted/truncated responses upstream as text, unsuitable for original-byte evidence.

## Decision

Native pi.tool owns immutable admission, exact arguments, source, permissions and configuration snapshots. Business documents add only approval, start, observation and external-verification facts, not another Task state. Main/children share tool names and call gates. Main mutations require unique owner input; children use current original-work source/permissions, never old authorization from persistent context. Scheduled sources use the independent adaptation below.

tools.json originally included separate material-directory/object identities, named HTTP credential references and Tavily environment-variable names. Web Search now has its independent configuration under the linked decision. Trusted local controls individually create, retain and revoke read grants, incrementing grant version without implicit write grants. Before approval consumption, recheck configuration, materials, original entry and exact arguments. Revocation invalidates unstarted calls; default mode changes affect new sources only, not old child work.

Confirm/auto-review share file/HTTP execution limits and the existing command sandbox. Only out-of-scope file reads and GET/HEAD without credentials, custom headers or body are reviewable. Existing review policy/strict parsing runs once in an independent tool-less provider call. Normalized input and actual payload persist first. Invalid, failed, timed-out or interrupted review falls back to a human; late results cannot override human decisions/cancellation. Credentials are read only when sending; rotation invalidates original requests without anonymous fallback.

Files pin regular-object identity, original-content fingerprint and new-file parent. Restricted paths reject links, protected data, system execution and device trees. Path/device checks exclude system trees without recursively walking /proc, /sys or /dev. Linux creation uses a verified parent-directory handle against ancestor replacement after checking; platforms lacking that primitive reject creation, not fall back to a string path. Existing files use trusted executors; write loops handle short writes and retain unknown effects on failure after start.

HTTP pins URL, method, headers, body, DNS and credential reference, with no retries/redirects. Complete responses prove request return. Disconnected/canceled writes retain separately unverified effect and remote completion; local socket close proves neither remote exit nor business effect. Recovery can establish that synchronous local file execution ended, but cannot infer effect from a missing receipt. Started operations never resend. Unknown facts join original source, whole delegation, child cleanup and report waiting. The initial MCP/HTTP cross-endpoint occupancy check is narrowed for ordinary MCP by [host simplification](../simplification/2026-10-26-mcp-host-responsibilities.md); this note's general HTTP recovery requirements remain. Full-access commands retain arbitrary current-account access: these gates control original-work automation, not an account-wide firewall against independent sources.

Responses first publish to private immutable artifact files, then durable source references. File/HTTP capture is at most 8 MiB per operation; Tavily retains 256 KiB. Overflow/interruption marks partial. Pages contain 3072 original bytes in base64 with identity/length/hash checks. Main may read instance artifacts; children only their own conversation. Complete export publishes exclusively, rejecting overwrite/partial artifacts. Command streams/MCP responses retain their own readers without copied bodies. File publication/durable reference is not atomic: missing references after publication preserve file/start facts without repeating calls. Plaintext credentials, JSON/URL-encoded echoes and cutoff suffix fragments do not enter evidence; affected HTTP responses are rejected and search responses redacted. Export does not promise original bytes for secret echoes.

## Related decisions

[Conversation background processes](../feature/2026-10-21-personal-background-processes.md) shares directory claims with file-write approval consumption. Unknown write effects/stopping retain claims; human verification/release commits together. This note retains file grants/original-byte evidence.

[Automatic review](../feature/2026-09-22-auto-review-mode.md), [native restricted execution](2026-10-10-native-execution-sandbox.md) and [legacy artifact export](../feature/2026-10-14-artifact-file-export.md) retain Coding ownership. [Personal commands](2026-10-17-personal-durable-commands.md)/[MCP](2026-10-17-personal-durable-mcp.md) retain original-execution evidence; this extends shared pause consumers. [Migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) retains complete goals, not established product cutover from this slice. No note was wholly absorbed or obsolete.

[Browser/media](2026-10-18-personal-browser-media.md) owns Personal Pi assembly, binding, admission and recovery without changing general-tool grants/approvals/artifacts. [Scheduled work](2026-10-18-personal-durable-scheduled-work.md) uses real independent inputs through the same tools/recovery gates; artifacts belong to actual conversations. Creation pins tool/material ceilings and later grants cannot expand old plans. [Durable application data](2026-10-18-personal-durable-app-data.md) owns its native sources and dual-database receipts. [Controlled file search](../feature/2026-10-21-controlled-file-search.md) reuses grants/byte evidence; [Personal file search](../feature/2026-10-21-personal-file-search.md) reads in a separate read-only execution unit, not through the command directory.

## Alternatives considered

- Reuse ArtifactStore/ToolRouter: less wiring, but restores old projects, Db and tool-ledger dependencies against durable's sole authority.
- Store complete responses in durable documents: simpler transaction, but copies large binaries into the database instead of protected files owning original bytes.
- Use unrestricted bash for file/network calls: least code, but bypasses exact grants and tool-less automatic review.

## Consequences

Tools recover under existing main/child sources. Approval cannot cross arguments, configurations or revocation. Started calls without observations conservatively pause. Without a remote HTTP query protocol, the owner independently verifies rather than local close releasing automatically. No profile-wide artifact quota exists; orphan private files remain for verification. Real Linux, model, IM and operator acceptance require their own work-record evidence; offline substitutes do not establish product acceptance.
