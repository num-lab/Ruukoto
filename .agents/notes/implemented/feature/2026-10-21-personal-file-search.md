# Agent Note: Personal file search reads data in a separate read-only execution unit

Status: implemented

## Problem

Personal file tools required known paths; child-command directories are separate from data roots, so commands cannot replace data search. Coding already had schemas/scanners but its ToolRouter depends on the old Store. Running the scanner directly in the host would bypass restricted reads.

## Decision

Personal `list_files`/`search_files` reuse shared schemas, arguments, rg scanner and budgets. `personalTools` native records retain source/configuration/grants/start/observation without importing old business runtime. Default directory is `tools.json.workspace`. Restricted out-of-scope directories need existing data grants, not a new recursive-approval protocol; full access follows existing file permissions. Recheck target identity, original work and configuration/data revisions before start.

A separately built worker accepts one bounded input; logical cwd/roots identify data. Native workspace is a private temporary directory and data are read-only readRoots, avoiding the launcher's default workspace write grant. Linux reuses persistent user scope. macOS persistent supervision wraps the same read-only Seatbelt profile from outside; restricted environment comes from preparation, full access inherits account environment. Persist identity/fingerprint before start. Recovery stops the original unit, never replays; changed temporary directories can block new starts, not stopping by original identity.

Store stdout then stderr as one immutable artifact up to 8 MiB, with segment byte counts in `rawStreams`. Previews show structured matches; `read_artifact` retrieves raw content. Scan completeness, preview truncation and partial raw capture are distinct. Unverified stop keeps the original source paused; reopening verifies original execution and adds stop evidence without replacing observations/artifacts.

Persist the `personal-file-search` extension marker with main/child/scheduled tool configuration. Old code rejects unknown extensions. Settle old pending work before first enable; archives with search tools/operations but no marker fail recovery rather than invent provenance. Scheduled plans retain creation-time tool lists and do not gain newly added tools.

## Related decisions

[Controlled search](2026-10-21-controlled-file-search.md) owns shared semantics/Coding scope; [Personal tools](../architecture/2026-10-17-personal-tools-access-artifacts.md) owns grants/artifacts; [native execution](../architecture/2026-10-10-native-execution-sandbox.md) owns constraints; [session backgrounds](2026-10-21-coding-background-processes.md) owns separate background work. Their decisions remain distinct.

## Alternatives considered

Old ToolRouter reuses wiring but reintroduces Task/Store/ArtifactStore. Host rg is shorter but lacks native read-only confinement. Using the data directory as workspace grants unwanted writes; use private workspace/readRoots. Another business Task/store duplicates existing tool acceptance/observation/artifact state.

## Consequences

Main, child and scheduled work search with the same source/data scope. Cancellation has no write effect; unknown stop remains visible. Requirements include a self-contained worker, rg and native-platform prerequisites. There is no index or stable pagination; narrow path/glob for large data. Real models, platforms and IM require separate evidence, not extrapolation from offline tests.
