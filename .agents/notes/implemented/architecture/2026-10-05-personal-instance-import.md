# Agent Note: Import into a fresh personal instance and transfer platform and scheduler ownership

Status: implemented

Original identifier: ADR 0023.

Historical decision: [the personal product entry](../simplification/2026-10-18-personal-product-entry.md) retired this importer and the old personal runtime. Current Personal starts with an empty profile, copies no old credentials, and takes over neither old platform bindings nor schedules. The original migration guarantees and evidence remain recorded here; the commands below are not current instructions.

## Problem

[The Coding importer](2026-10-04-legacy-instance-import.md) moved old development data into `ruukoto-code`. The opposite direction needed to move main history, application data, schedules, platform bindings, and necessary credentials into a fresh personal instance while retaining coding/chat data and sending facts as inspectable read-only archives. Unlike development import, this transferred live platform and scheduler execution ownership. It reused the source-read-only snapshot, offline target, receipt/ledger idempotency, revision hashes, backup, and rollback blockers rather than introducing a general import framework.

## Decision

The retired implementation lived in `packages/channels/src/personal-import.ts` and `ruukoto legacy-import`. Both directions reused `packages/core/src/import-support.ts` and owned separate `TABLE_POLICY` definitions.

Preview, apply, revert, and list ran locally under the target instance lock, not through the control plane. Both source and target had to be stopped, belong to ruukoto or be unregistered, and have different data directories and instance IDs; a copied instance with the same ID was also rejected. The historical syntax was `ruukoto legacy-import preview --from <source> [--plan <file>]`, `apply --plan <file>`, `revert <importId>`, and `list`.

The target had to be fresh. Role rows not attributable to an earlier same-source import caused refusal, because starting a target had already created its own roles and main session. The importer never overwrote unverified target data. Role session cwd, `agent_roles.work_dir`, and project roots moved to target `<dataDir>/../agent-work/<role>`, with target dev/ino/realpath captured at apply; `ensureRoles` skipped existing roles on startup.

### Data and settlement

Import units were role sessions and QQ group sessions, including main's one-level SubAgents. IDs stayed unchanged to preserve `app_audit.task_id`, memory `source_refs`, sending `source_key`, and standing-permission approval/event references. Main/coding/chat role rows, projects, sessions, and all four group-archive tables were imported. Ordinary dev sessions and their projects/SubAgents were excluded and listed for the Coding importer instead. Every table required an explicit import/exclude policy and reason; a new unclassified table stopped import.

A memory qualified only if every version's sources were imported or `owner_note`. Personal memories did not need plan selection: same-product continuation was not cross-product publication. Both ends of a data grant had to be imported; otherwise only the receipt retained it as ineffective cross-instance provenance. MCP/Jev configuration was copied but disabled if its credential binding was absent. Application data used file-level, sha256-verified copying of `agent-data/main.db` and WAL, with `app_data.main_instance_id`; `github_retirement_done` prevented re-running retirement. Model catalogs, API keys, and other agentDir configuration were not copied.

No unfinished operation was replayed. Nonterminal tasks became canceled/interrupted with migration provenance; operations that might have started without a result, and their tasks, became effect unknown under the runtime recovery rules. Unconsumed approvals became stale, open schedule runs received `closed_at`, pending sends became canceled as known unsent, sending became effect unknown, and registered/queued inbound events became failed. SubAgents were closed. Main's access mode stayed unchanged, unlike the cross-product Coding downgrade. Startup therefore found settled records, not work to redispatch, resend, or rerun.

### Live ownership transfer

QQ/Telegram configuration retained its version and Telegram `last_update_id`; complete inbound deduplication records prevented rereading old input. Fixed target versions were not bumped merely by changing instance. Active schedules continued on the target, with overdue work handled once by runtime recovery and merged into an unfinished run where applicable; canceled old pending sends were not recreated.

Standing permissions retained their machine, unit, action, main-session, and fixed-entry binding. Same-machine continuity could preserve validity; another machine or changed revision failed closed during per-use verification. Only credential bindings referenced by platforms and those with purpose `github_webhook` were merged from `credentials.json`: same name/value skipped, different value refused, missing copied. Reports stored whole-binding sha256, never secrets. MCP/Jev credentials and working-directory contents were outside scope.

The source was never modified, including to disable old connections. Preview and receipt carried the handoff checklist; the owner had to keep the old instance stopped after import so it could not consume the same platforms or schedules. External webhook URLs and other platform reconfiguration remained owner responsibilities.

### Idempotency and rollback

The plan derived a request key: same key/parameters returned its receipt; changed parameters caused `request_conflict`. Revision covered canonical whole-row hashes for the import set and target conflict state; relevant source or target changes after preview caused `revision_conflict`. `VACUUM INTO` created `<dataDir>/migration/<importId>/target-before.db`, files used temporary names plus rename, and one final transaction installed rows. This did not make files and SQLite atomic together.

The v30 ledger added `agent_role`, `schedule`, `platform_config`, `standing_permission`, and `credential`. Schedule runs, sends, inbound events, group archives, and GitHub archives used a receipt manifest of row IDs and hashes of the transformed target rows, rather than individual ledger entries. Settlement timestamps made these differ from source hashes. Only an applied same-source receipt with matching target hash proved that a row was safe to skip on continuation; other same-key rows caused `id_conflict`.

Rollback rechecked each manifest row and every credential/file hash. New inbound events, sends, schedules/runs, or grants; changed imported rows such as sent status, schedule advance, offsets, or retraction; application-data writes; and credential rotation all blocked rollback and were listed individually. Cutover execution facts could not be erased. Rollback removed the import only when no target activity intervened; it retained `product.type` and the backup, returning to an empty but product-registered instance. Whole-database restoration was a separate manual path, not permission to replay side effects.

## Alternatives considered

- Compare target rows directly with source snapshot hashes: one hash scheme is simpler, but settlement adds `closed_at`/`settled_at` timestamps. The applied receipt's transformed manifest is the evidence of same-source writes; anything else remains a conflict.
- Include credential copy/skip actions in the preview revision: this would pin the action, but a partial copy turns copy into skip on rerun and makes revision conflict permanent. Exclude the action while retaining apply-time same-name/different-value rejection.

The alternatives and implementation deviations were recorded in retired `.scratch/agent-direction/issues/22-migrate-personal-instance.md`, retained as offline provenance rather than a live link.

## Consequences

The old same-product migration preserved data identity, platform offsets, schedule ownership, and audit references. It required a fresh target and owner-enforced source shutdown. Necessary credential transfer was deliberately minimal, and target activity made rollback refuse rather than erase cutover facts. It was one-time import, not online import, control-plane import, incremental synchronization, or the shared-memory mechanism contemplated by [the product decision](2026-10-02-two-agent-products.md).

Historical evidence records test/86 at 5/5, related regressions, typecheck, and diagram checks. Of 894 full-suite cases, 890 passed; three existing environment issues concerned DNS, directory naming, and test/83 parallel load (13/13 in isolation), with remaining gated coverage skipped. Original smoke-22 passed 6/6 on macOS and Linux via `ssh tx`: real processes, sockets, SQLite, JSONL, locks, and mode-0600 credentials; stub models and Telegram HTTP. It checked offset 101 continuation, one overdue run, zero old pending sends, same-source rerun, and rollback blockers.

A real local old instance completed preview/apply/startup inspection/clean rollback with all 52 source-file hashes unchanged, but had no platforms, schedules, or memories; those transfer cases relied on tests and smoke. Real tx data was not exercised. This evidence does not authorize current-profile migration or production handoff. Current archival guidance belongs to the [usage manual](../../../../docs/usage.md); later shared scheduling rules belong to [generic scheduled tasks](../feature/2026-10-12-generic-scheduled-tasks.md).
