# Agent Note: Verify Personal app-data outcomes across two databases by native tool identity

Status: implemented

## Problem

[Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) keeps separate application SQLite storage, while old adapters bind core Task/ApprovalGate. Business commit and durable tool result share no transaction. Reentering write APIs may duplicate effects or fail to read an old result after directory changes.

## Decision

Six app-data tools reuse shared parameters, AppDataStore, and bounded queries. Each durable tool Task is a stable logical-operation identity, with full parameters, original provenance/authority, and application-DB identity pinned in an acceptance snapshot before execution. After writes, verify audit by the original key. Full parameter fingerprint and complete receipt validation commit with the business receipt. Neither model round nor owner input is an operation key. Recovery records already-committed/known-uncommitted outcomes only; started mutations are never replayed.

Opening a bound DB validates file, storage version, instance identity, directory, and audit; query subprocesses recheck identity. First creation commits fixed DB identity/initialization intent with the main extension, initializes the same identity in the application transaction, then clears the marker. Recovery completes that same initialization; no business call executes meanwhile. Existing mismatched DBs are never adopted.

Missing/replaced DB or corrupt receipts stop app-data, retaining started operations as unknown and pausing their source, child work, delegation/scheduled report, while independent chat/work continues. Owners restore the original DB and recheck original records; a new DB cannot prove the old operation never happened. Manual recheck accepts only a terminal original tool, avoiding premature not-committed before a started tool enters SQLite. Internal verification occurs only after the current synchronous write returns or before startup scheduling. An absent receipt also requires audit count/max revision and business revision checks; a missing audit row alone is not proof of noncommit.

Destructive migrations, multirow update/delete, and rewrites follow [current full access](../feature/2026-10-12-full-access-current-account.md): confirm/auto-review require individual human approval; full_access does not. Approval binds full parameters, original entry, authority, and schema/revision. Consumption/start share one durable commit; business transaction rechecks revision. No business lock spans approval waiting. Approval/results are durable entries; recovery verifies bidirectional index, call, provenance, and evidence links and rejects unknown record versions.

Main and independent scheduled sessions have business eligibility. Child work needs explicit delegated appData, checked against current work rather than inherited on identity reuse. Schedule creation pins DB identity. Sealed-group summaries expose only app_data_query through an active read-only tool and original schedule scope, never writes. Platform menus/local guided controls use program-retained original-operation references, not owner-entered internal keys.

[Legacy app-data space](2026-09-23-main-app-data-space.md), [provenance tools](2026-10-17-personal-tools-access-artifacts.md), and [independent schedules](2026-10-18-personal-durable-scheduled-work.md) retain shared storage, sources, and scheduling. Other memory/service/MCP/import/runtime consumers keep their decisions.

## Alternatives considered

The old adapter saves approval wiring but imports old task/project state and another SDK version; share stateless storage/parameters/query only. Write-API idempotency simplifies ordinary retries but older receipts lack full parameters and current directory/capacity checks run before receipt lookup. Recovery therefore queries original receipts directly. Combining business/durable DBs enables one transaction but destroys business isolation and couples upstream schema.

## Verification

Real SQLite tests cover complete-parameter same-key matching, distinct calls, destructive/batch operations in three modes, authority/revision invalidation after approval, query budgets/relations, and native provenance. Killing after business commit but before result commit leaves exactly one mutation after restart. Missing/replaced DBs/corrupt receipts are neither recreated nor replayed. Child reuse eligibility and scheduled read-only summaries have separate coverage. Real-model/IM/experience evidence remains external.

## Consequences

There is no cross-DB atomicity. Corrupt business storage leaves unknown outcomes until the trusted original is restored. Host protection guards directories; API eligibility is not file isolation from the backend account. Offline substitutes cannot close real-environment gaps. Historical checks/independent review are in `.scratch/personal-pi-durable/issues/34-app-data.md` offline. New receipt fields fit existing operation JSON; legacy calls without fingerprints retain prior format/idempotency, and business SQLite schema version does not change.
