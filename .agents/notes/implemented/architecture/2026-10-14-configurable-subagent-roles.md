# Agent Note: Separate SubAgent roles from workflow ownership and execution targets

Status: implemented

This note owns the approved overall choice, first-release boundaries and alternatives. [Role snapshots](2026-10-14-subagent-role-snapshots.md), [persistent source capabilities](2026-10-15-subagent-source-capabilities.md), [current-workspace snapshots](2026-10-15-current-workspace-snapshots.md) and [workflow interfaces](2026-10-15-workflow-role-interface.md) own individual mechanisms. The original joint product/real-model acceptance remains in the offline `.scratch/subagent-roles/issues/05-acceptance.md`; implemented status does not establish that acceptance. The original shared-runtime Personal assembly is now retired by [the durable product entry](../simplification/2026-10-18-personal-product-entry.md); shared-runtime contracts here remain applicable to Coding and retained historical data, not a claim that the current Personal runtime uses this assembly.

## Problem

During workflow wait/sidebar acceptance, the owner requested shell-based directory investigation. Although the task had full access, the model received no bash tool. Ordinary delegation and workflows both defaulted to analyze but supplied different tool sets. The same mode also controlled directory preparation and result handling, conflating role responsibilities, tools, access mode and workflow identity. Original investigation evidence is retained offline at `.scratch/subagent-roles/evidence/source.md`.

## Decision

The original two-product shared assembly uses instance-level Markdown SubAgent roles, with built-in general and reviewer. A role specifies description, tool requirements, permission policy and prompt. Dispatch parameters select the target directory; workflows retain orchestration, frozen verification and integration. Ordinary delegation and workflows use host-persisted, revalidated source capabilities. Workflow identity grants no extra tools and copies neither main identity nor one-use approval.

The existing GitHub host-fixed reviewer retains a trusted execution definition and read-only restrictions rather than selecting overridable general/reviewer roles. Its completed-source eligibility, fixed prompt, read-only MCP, no-messaging rule and recovery remain in the shared delegation manager; no public role or additional capability is introduced.

General permits shell within source capabilities. Reviewer protects the source workspace through restricted execution and checks in a separate copy or temporary directory. Permission policy declares mode and protect_source separately: explicit protection input is necessary to avoid hiding permissions behind the reviewer name. Missing explicitly required tools fail before start, rather than repeatedly attempting work with an insufficient tool set. Only omitted tools inherit the available set. Access mode may inherit or tighten the source. Neither role name nor prompt provides isolation. Protection incompatible with effective full access is rejected; a custom role whose owner explicitly disables protection and selects full access retains current-account trust and cannot claim source protection.

Instance `<agentDir>/agents/*.md` files override built-ins or add roles; the first release does not auto-load repository files. SubAgent creation pins role body/version; workflow start pins the role catalog. Edits affect only new objects, while each execution still revalidates source authorization. Applicable project instructions, skills and effective tools enter reconstructable records without copying the entire parent chat. Configuration has only the required fields, not model overrides, inheritance or templates.

Without target, execution retains a separate directory and approved materials; research and personal work need no Git repository. Code work explicitly supplies target. Git copies capture current contents at delegation, including uncommitted changes and non-ignored new files, without modifying the source index. Results are deltas against that captured baseline, never a second integration of the owner's existing changes. Ordinary non-Git general execution remains serialized in place; protected code copies and workflow modification/verification require Git in the first release.

The old dispatch mode interface is replaced directly. Old definitions/history remain, without automatic reinterpretation, migration or rerun. The original specification and implementation plan are offline at `.scratch/subagent-roles/spec.md` and `.scratch/subagent-roles/implementation-plan.md`; they own interactions/acceptance and call sites/failure handling/order respectively. The owner confirmed Q1-Q14 and the overall plan. Engineering implementation and independent review for 01-04 were delivered; 05 retains required real-environment and subjective acceptance.

## Related decisions

The original audit searched active notes by SubAgent, analyze/modify, workflow, full_access, source authorization and snapshots, following code anchors and module docs. No proposed/rejected note required consolidation; sealed archives were unchanged.

| Decision | Relationship |
| --- | --- |
| [Work delegation and SubAgents](2026-10-03-work-delegation-subagent-task.md) | Partly replaces fixed analyze/modify capabilities; retains separate work/identity/task, one-level delegation and source checks. |
| [SubAgent worktrees](2026-10-04-subagent-worktrees.md) | Partly replaces HEAD-only baselines and mode-based tool selection; retains no host execution of repository Git, isolated copies, occupancy and preserved results. |
| [Workflow step capabilities](2026-10-13-workflow-step-capabilities.md) | Partly replaces separate ordinary/step capability assembly and a special verification mode; retains frozen results, independent verification, native limits and controlled integration. |
| [Workflow decision](../feature/2026-10-12-agent-workflows.md) | Partly replaces capabilities enabled only through workflow ownership; retains orchestration, source permissions, limits and one final report. |
| [Full access](../feature/2026-10-12-full-access-current-account.md) | Retains current-account trust and trusted source propagation; roles may explicitly tighten permissions. |
| [Wait/report ownership](2026-10-14-agent-wait-and-report-ownership.md), [Personal native execution](2026-10-12-personal-native-sandbox.md) | Retains occupancy, stopping and internal-dialogue constraints. |

Application data, Personal import, GitHub review, explicit access modes and unverified-stop preservation retain their separate decisions. Their caller checks belong to the original implementation plan; none is absorbed or archived.

## Alternatives considered

- Add bash only to analyze: fastest directory search fix, but readScope constrains read alone and supplies neither occupancy nor write protection. It cannot meet configurable-role and restricted-review requirements.
- Keep separate ordinary/workflow role implementations: local changes preserve old wiring, but identically named roles still receive different tools by entry point, violating shared-role/source consistency.
- Keep HEAD-only copies: reuses workcopy directly, but misses uncommitted content under acceptance. Capture current contents and pay for delta baselines and zero-write capture.
- Reread role files for every task: immediate edits and skill-like loading, but prompt/capabilities drift during long runs and identity reuse. Pin definitions while rechecking authorization each time.
- Deliver repository discovery and a configuration TUI together: easier sharing/editing, but instance files satisfy the present requirement. Defer discovery trust, precedence and UI maintenance until project reuse is required.
- Preserve compatibility mapping for old modes: old scripts keep working, but analyze/general capability differences create implicit escalation or permanent dual paths. The owner chose explicit upgrades with preserved history.

## Verification

The original specification R1-R14 requires evidence for real default bash in ordinary/workflow execution; role override/addition; explicit missing-tool failure; no source escalation; reviewer inability to write source files/index under a full-access parent; dirty-workspace and new binary-file review with only child deltas integrated; pinned versions after edits/cold recovery; Personal business/MCP source checks; explicit old-interface rejection; and preserved agent_wait, cancellation, one report and occupancy. Simulated models, real workers, real models and owner experience remain separate evidence levels. macOS and Linux must each prove isolation.

## Consequences

Ordinary delegation and workflows share role/source rules while the host still owns frozen verification. Current-content capture and host copy registration are checked separately; freezing computes only child deltas. Mechanisms and actual entry-point evidence belong to original engineering records 03/04, not old HEAD-only copies or direct freezing of the source. Snapshots cost space and preparation time; dependencies are not copied automatically, so checks may need setup. Full-access processes can still edit same-account configuration: pinning prevents drift in created objects, not isolation from those processes.

Direct upgrade prevents new runs of old-interface definitions; incompatible stores are rejected. Preserved files do not imply new code can recover old runs. Non-Git ordinary writes are serialized in place, without isolation or rollback guarantees. Restricted checks with missing prerequisites retain results and report inability to execute, not downgraded success. Real models, external platforms, final combined dual-platform behavior and owner experience remain pending in acceptance 05; local offline passes do not cover these gaps.
