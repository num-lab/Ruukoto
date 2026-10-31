# Agent Note: Workflows share roles and persist an explicit dispatch-interface version

Status: implemented

## Problem

The configurable-role specification requires ordinary delegation and workflows to share responsibilities, source capabilities and current target contents. Old analyze/modify/verify modes combined capability selection with result handling, preventing shared roles and safe host-owned verification. Interpreting an old default analyze as general would enlarge historical tool permissions; deleting mode alone would lose frozen verification and recovery evidence. The original specification is offline at `.scratch/subagent-roles/spec.md`.

## Decision

Ordinary subagent_delegate and workflow agent share role, defaulting to general on first creation. Ordinary identities keep their pinned definition; workflow steps select from the complete catalog pinned at run start. target independently selects a code target; without it, source tools run in a separate directory. Workflow targets require Git and [current-workspace snapshots](2026-10-15-current-workspace-snapshots.md) for baseline capture and frozen child deltas. Ordinary delegation and workflows still own their respective scheduling, cancellation, result consumption and final reporting.

verify references a frozen target step in the same run, requires a declared dependency and excludes target. Its role may be general, reviewer or custom, but the host adds confirm, source protection and the five coding verification tools. Explicit role requirements conflicting with the step's narrowed capabilities fail before start. Verification uses a fresh copy of the same captured baseline plus frozen patch; role overrides do not authorize writes to the original directory.

Verification eligibility requires an independent Task, frozen artifact/digest/baseline, valid output and a nonempty actual coding-tool ledger. passed:true cannot override any failed operation, missing result or unknown effect. Integration revalidates both Tasks' role/source/target, work/run ownership, stop facts and verification ledger, then uses frozen integration to compare actual bytes, complete affected target files and combined checks. Ordinary integration, continuation and reuse cannot take over workflow results.

Recovery, queued startup and result consumption also verify completed Agents' definitions, execution snapshots and target baselines, rather than waiting for the next Driver startup. Missing/corrupt records pause the affected run and preserve original Tasks, attempts, ledgers and results. They are not repaired from current role files and old steps do not rerun. Private baselines and persistent snapshots retain their specific error codes.

Host-injected workflow executors keep their own execution/ledger contracts and do not fabricate Driver records. Driver-only snapshot verification reaches recovery, invocation and consumption through the same trusted assembly callback as preflight. Default real Drivers always install strict validation; missing records cannot trigger a temporary bypass. Frozen integration still directly verifies both steps' actual Driver evidence. An injected passed string cannot qualify.

## Interface version and named files

Dispatch-interface version 2 is persisted as interfaceVersion in definitions and runs. New-definition digests include version and script; the old interface retains its original script digest. Explicitly saving the same body under the new version creates a distinct definition without overwriting referenced records. Named-file saving writes `// ruukoto-workflow-interface: 2` as the first line followed by the complete script. Metadata/body use one atomic file replacement, avoiding split versions across files.

An unmarked file registers as queryable old-interface history, not a new-interface runnable definition. The owner or model reads the original digest, updates to role/target/verify and explicitly saves a new version. The host neither scans arbitrary JavaScript strings to infer permissions nor rewrites scripts automatically. Old runs remain queryable/cancelable; new starts and recovery require matching versions and correct digests. Original-key receipts return accepted facts without replaying old effects.

Ordinary tools, Runtime delegation and workflow calls explicitly reject every old mode field. Temporary scripts fail at the concrete call's argument check without executing that call. Earlier completed steps retain their actual effects: the whole script is not effect-free, and unknown operations cannot be repeated with a new key. Role-file permissions.mode still names access policy and is distinct from removed dispatch mode.

This change introduced schema 45 and control protocol 26; these are historical versions, not current constants. Strict version policy rejects incompatible stores/clients without migrating authorization or historical JSONL. Both import directions still reject sources with workflow execution bindings; ordinary-data import excludes definition-only history. The version field does not introduce a compatibility path that discards bindings.

## Related decisions

The original active-note audit searched workflow, role, mode, freezing and interface version without modifying archives. This implements the dispatch-interface part of [roles versus targets](2026-10-14-configurable-subagent-roles.md); combined product acceptance remains separate. [Role snapshots](2026-10-14-subagent-role-snapshots.md), [shared source](2026-10-15-subagent-source-capabilities.md) and [current baselines](2026-10-15-current-workspace-snapshots.md) retain loading, authorization and capture decisions. [Real steps and frozen results](2026-10-13-workflow-step-capabilities.md) loses old modes/separate profile selection but retains freezing, stopping and integration. [Definition library and trusted entry](../feature/2026-10-13-workflow-library-and-controls.md) adds explicit versions while retaining path protection, original keys, non-atomic files/SQLite and progressive interaction. Other ordinary-delegation history, scheduling, approval and archive records remain separate.

## Alternatives considered

- Map old mode to default roles: fewest caller changes, but implicitly expands analyze to general, contrary to direct replacement without backfilled authorization.
- Search script text for mode: earlier warnings, but false positives/negatives for strings, dynamic properties and unrelated variables. Named definitions use explicit metadata; temporary calls reject at their argument boundary.
- Put versions in a sidecar: preserves the script body, but creates two-file races/crash combinations. A first-line header pins version/body through existing single-file replacement.
- Require Driver preflight for every injected executor: uniform records, but makes independent adapters implicitly depend on the model Driver and changes their contracts. Trusted host assembly chooses validation ownership; default real execution stays strict.
- Trust persisted passed records alone: fewer ledger reads, but zero-tool declarations and missing role/execution records after recovery could qualify. Require actual calls and recheck records/ledgers before consumption.

## Consequences

One role works for ordinary review and workflows, while the host retains frozen verification and separates current dirty source contents from child deltas. Old named files need explicit resaving/upgrading; old profiles require matching code for inspection. Missing records preserve evidence rather than recovering automatically.

The original development-doc change reached 9536 non-whitespace characters after adding shared-role/interface regression navigation; existing environment, entry and test guidance belonged on that page, so its budget rose from 9500 to 9600. README retained its budget by shortening equivalent navigation wording. These are historical measurements.

Offline real Driver/worker checks, independent review and uncovered scope are recorded in the offline `.scratch/subagent-roles/issues/04-workflow-integration.md`. Real-model, IM and combined product acceptance remain with joint acceptance; simulated models are not real-model passes.
