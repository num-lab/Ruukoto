# Agent Note: Share controlled read scope for file discovery and content search

Status: implemented

[Configuration checks](../simplification/2026-10-25-configuration-checks.md) owns per-call rg rediscovery/install diagnostics. Read scope and native-execution boundaries remain.

## Problem

Coding can run rg in Bash but lacks stable discovery/search APIs for read-only research. Personal reads known files; main cannot use a separate child-command directory to discover granted material. Upstream grep/find would also download rg/fd during invocation and spawn on host outside existing execution ownership.

## Decision

Code and Personal expose list_files/search_files with the same parameters/results. [Personal integration](2026-10-21-personal-file-search.md) retains independent durable provenance and read-only native execution. Literal text and one glob cover initial discovery/location needs without indexing or mutation. Original schema/budget/eligibility provenance is the archived `.scratch/agent-tool-completion/spec.md` file-search section.

Use installed rg through existing worker/native boundaries with argument arrays. Never download during invocation or fall back to host traversal. Disable parent/global/config influence so an authorized root does not depend on HOME configuration. Without glob, honor root-local ignores and skip hidden files. Explicit glob follows rg semantics and may override ignore/hidden filtering, but never follows links, accepts binary files, or expands authority. Descriptions/results state this distinction. Capture raw streams before trimming model preview; incomplete scanning differs from display truncation so omissions cannot look like no match.

Shared file-search owns parameters, schema, argv, and decoding. Coding worker owns scanning/parsing; router owns provenance, authority, and artifacts. Personal never imports legacy Store, and data directories are not command directories. Recursive reads remain within original native read-only scope. Verify directory identity, links, and authority changes before start. Results grant no future reads and are not file snapshots. Native alias checking enumerates/stat's Buffer paths to preserve non-UTF-8 names; worker reports named encoding failure for unrepresentable results instead of prechecks mistaking replacement characters for another path.

[Native execution](../architecture/2026-10-10-native-execution-sandbox.md), [Personal tools](../architecture/2026-10-17-personal-tools-access-artifacts.md), [Personal references/history](../architecture/2026-10-18-personal-memory-skills-history.md), and [workers](../architecture/2026-09-20-tool-worker-per-task-container.md) retain isolation/stop, native acceptance/grants/bytes, historical identity, and in-boundary execution. File search is not history search.

## Alternatives considered

Bash/child commands need no new API, but Personal main lacks the same directory/authority and read-only roles should not need arbitrary shell. Pi grep/find/ls has schemas/output but downloads tools and grep spawn bypasses custom file Operations. Standard-library traversal avoids rg prerequisites but reimplements ignores, encoding, binaries, and performance. Persistent semantic indexes add update/revocation/index identity contracts before demonstrated need; scan actual files.

## Consequences

Coding ordinary/Plan/read-only or modifying SubAgent/host-review/workflow capabilities can search. Explicit legacy role snapshots retain their original tools/authority; changed host-review definition hashes fail old fixed definitions rather than migrate them silently. Regressions cover out-of-root, links, replacement, parent/global ignores, explicit-glob overrides, missing rg, and nonzero exit without host bypass. Full captured evidence remains readable after preview trimming; capture/time termination is partial. Cancellation has no write effect but still needs verified execution stop.

Setup checks rg without downloading. Because rg --files does not filter binary data, worker scans ordinary candidates in chunks for NUL to EOF. Content matches wait for matching end without binary_offset so later binary detection discards earlier hits. Extra reads use the same budget, making large text-heavy trees more likely to time out. Raw rg evidence may contain later-rejected binary records; model preview/capturedCount include accepted text matches only.

Real macOS/Linux restricted execution and model-loop evidence are separate. Historical Coding evidence is `.scratch/agent-tool-completion/issues/01-coding-file-search.md`; Personal owns separate acceptance. Large scans have time/output limits, not stable paging or full snapshots. Revisit indexing for demonstrated sustained need, not by raising budgets or dropping authority checks.
