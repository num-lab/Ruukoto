# Agent Note: Verify workflow provenance and integrate frozen results

Status: implemented

[Role/interface versions](2026-10-15-workflow-role-interface.md) supersedes role selection/host verify semantics/old interface upgrades. [Current-workspace snapshots](2026-10-15-current-workspace-snapshots.md) owns actual content baselines, zero-write capture, preparation, whole-file conflicts, and bad-baseline isolation. [Configurable roles](2026-10-14-configurable-subagent-roles.md) separates role/source/target; [durable source capabilities](2026-10-15-subagent-source-capabilities.md) owns shared authority/project-context rules. Frozen results, stopping, and controlled integration remain here.

## Problem

[Workflow runtime/store](2026-10-13-workflow-runtime-and-store.md) could persist steps/executions without proving real Driver source capabilities. A work copy's live diff is not a verified result. The approved requirements need intersected provenance, ordinary-delegation isolation, separate modification/verification, and a verdict bound to the actual bytes integrated.

## Decision

Runtime installs real WorkflowSteps by default, retaining executor injection for tests. Host resolves a step profile jointly from execution/run/source/work/SubAgent/Session/Task, never identity supplied by parameters. Pin actual assembly category, startup data-grant IDs, workspace identity, and configuration digests, with run-pinned model/mode. Before model send, tool intent, actual call, and host-requested Git, recheck current grants/configuration/entry generation/directory identity. New grants cannot expand old runs; revocation blocks cached-result reuse through the dependent closure. Configuration stores hashes, not copied credentials. App instance identity is configuration; business schema revision is not a permission generation.

Ordinary SubAgents retain their profiles; steps cannot delegate another layer. Personal coding eligibility comes only through existing controlled coding delegation, not by copying the whole coding category to main. Analyze reads pinned source workspace. Coding writes first need an independent Git copy; non-Git modification fails before worker/model, while analysis/allowed business tools remain available. Each step has independent JSONL. Explicit data reads, skill catalogs, parameters, dependency values, and host workdir are reconstructible from task/selection/prompt records, not a copied main conversation. Workflow skill exceptions require persistent execution binding; ordinary restricted sessions still normalize skills empty rather than accepting an injected library as authority.

After modification, prove both Driver and host task stopped, then extract original patch bytes under copy occupancy. Persist final artifact, SHA-256, length, baseline, and run/step/work/task provenance. Verification uses a new Agent and independent copy built from the same baseline/frozen patch with only coding-verification tools. Its worker always uses native restrictions even from full-access provenance; extra source paths become read-only and host-file-write bypasses are disabled. Missing native execution fails with results retained, not unrestricted fallback.

Verification records bind the independent real Task's completion/tool ledger to frozen digest/baseline/artifact/verifier task. Tool failure or unknown effect cannot be overridden by model `passed:true`. Malformed JSON retains original output; existing writes are not automatically rerun. Script-provided pass text, ordinary subagent_integrate, continue, or reuse cannot authorize workflow integration.

The integration host task derives authority from the run and holds source/copy/target occupancy throughout frozen apply and combined checks. Before each patch, compare current copy bytes to frozen bytes, then apply the frozen file. Changes require reverification. A conflict rejects that patch only; earlier applied patches remain. Combined-check failure is visible, not a rollback claim. Recheck copy digest afterward.

Register a stoppable handle before launch; actual identity updates that same handle. Save a late identity even after cancellation. A false stop result retains original task/ledger/all occupancy. Unknown host preparation/freezing effects also block Agent retries.

Schema 38 introduced provenance snapshots/freeze/verification fields under strict old-format refusal, not invented authorization backfill. [Whole-work delivery](../feature/2026-10-13-workflow-owner-input-and-delivery.md), [library/controls](../feature/2026-10-13-workflow-library-and-controls.md), and [joint acceptance](../testing/2026-10-13-workflow-joint-acceptance.md) own subsequent input/report/entry/evidence concerns.

This partially extends [overall workflows](../feature/2026-10-12-agent-workflows.md) and [work copies](2026-10-04-subagent-worktrees.md). [Full access](../feature/2026-10-12-full-access-current-account.md)/[native execution](2026-10-12-personal-native-sandbox.md) are narrowed only for independent verification, not ordinary delegation. MCP/services/schedules retain approval/effect classification; copy neither credentials nor standing approvals. No archive changes/full-note absorption were required.

## Alternatives considered

- Broaden ordinary SubAgent allow-lists: less wiring, but expands existing delegation/history scope too. Assemble separately through explicit workflow binding.
- Regenerate diffs at integration: reuses ordinary integration, but later edits/follow-ups let old verdicts approve new bytes. Freeze original patches and verify current digests.
- Let verifiers retain full-access source environment with another cwd: closest to modifier conditions, but absolute paths/host file tools can mutate reviewed results. Native verifier restrictions and no host-write bypass are necessary.
- Release copy occupancy after each worker: matches ordinary integration, but opens write windows between patches/checks. One short host task owns the entire integration interval.

## Consequences

Real Driver/approval code is shared while ordinary delegation keeps its scope. Frozen artifacts and independent validation prevent scripts from inventing integration eligibility. Multiple copies/artifacts/host tasks/native verifier environments cost storage and execution; model claims or a returned script cannot establish whole-work success.

Former `.scratch/agent-workflow/spec.md`, implementation-plan.md, and issue 04 contain offline historical requirements/evidence. Simulated models with real workers prove engineering paths, not real-model or IM acceptance. Current behavior/evidence responsibilities are linked above rather than delegated to removed task paths.
