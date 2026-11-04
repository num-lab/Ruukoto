# Agent Note: Bind Personal ordinary operations to requirements the SubAgent actually received

Status: implemented

## Problem

[Same-SubAgent note supervision](2026-11-02-personal-work-note-supervision.md) preserves accepted additions through active and subsequent runs, but an old prepared operation can still wait for approval while new requirements are accepted. Operation-admission time alone cannot distinguish a delayed old model response from one that saw the update. Main also needs bounded canonical progress and decision facts without gaining approval authority or copying credential-bearing operation records into its context.

## Decision

Every valid instruction append supersedes the same work's older ordinary operations that have not started and have no terminal observation. This includes approved-but-unconsumed operations; rejected operations retain their original refusal. Supersession and the note admission commit together, retain exact original parameters and decisions, and add immutable `requirements_changed` and known-not-executed observations. Started operations retain their actual effect, stopping and recovery requirements. File jobs still need their own exit evidence before releasing capacity or work ownership.

WorkTask version 3 keeps the existing supervisor and native keys. Each actual child generation request records a versioned snapshot of the original submission, all accepted notes placed through its request cutoff, and that generation's native inputs. A dedicated reference includes the original work and those note bodies in admission order, including previous runs' requirements after native compaction. The original input need not remain among a note-only run's native inputs. Request preparation, actual payload recording, operation admission and consumption verify the selected snapshot; admission and consumption also reject any accepted note absent from that actual request. A late old response cannot gain freshness from a later operation-admission timestamp.

Native compaction requests remain recorded but do not identify business-tool responses. Model-request lookup uses existing product identity sections to distinguish generation requests from concurrent summarization captures in the same session. Recovery verifies the request's instruction reference against its persisted original inputs and note admissions, not merely a matching document pointer. Version-1 sequential and version-2 supervised terminal work retain their original verifiers; old active work or unfinished old tool operations require handling with their original program before activation.

Main's `background_work` queries return bounded facts from the canonical operation ledger: target, parameters without credential references, approval, effect, stopping and supersession. Query identity determines whether the owner can decide through the original native or IM entry; the model gains no affirmative operation authority. Redisplay records a distinct immutable intent for each owner-source/model-call pair. Replaying that call returns its original intent, while later requests create another display of the same operation and decision. The latest pointer is a projection convenience; all intents and original decisions remain verifiable. Desktop presentation of these facts belongs to [Issue #40](https://github.com/num-lab/Ruukoto/issues/40).

Main's system reference names the configured child file/network tools even though main's own tool offer excludes them. Direct `write_file` requires no command capability. That distinction lets main delegate an authorized file requirement without falsely declaring the capability unavailable or requesting broader command authority.

If completion wins an amendment race, the model-facing append registers an explicitly linked new work in the same idle SubAgent and original delegation. The predecessor must have completed safely with original resources stopped and no unresolved effects. The new work retains original source permissions, independently records the current owner instruction and its actual append call, and only executes the new requirements. Terminal task, note, answer and publication records stay unchanged. Its analysis admission makes coordinator cutoff cancellation target the new work, not its completed predecessor. Low-level host append keeps its existing `accepted: false` terminal result.

This partially supersedes [work notes](2026-10-17-personal-work-notes.md), [analysis delegation](2026-10-17-personal-analysis-delegations.md) and [ordinary tools](2026-10-17-personal-tools-access-artifacts.md) only for requirement freshness, canonical main queries and safe terminal continuation. Their original source, permission, exact-target, artifact, stopping and unknown-effect rules remain. [Host report publication](2026-11-04-personal-report-publication.md) has its own decision.

## Alternatives considered

- Preserve apparently compatible approvals: saves a repeated approval for additive changes, but requires host semantic interpretation of arbitrary instructions. The owner chose conservative invalidation in [Issue #34](https://github.com/num-lab/Ruukoto/issues/34).
- Stamp requirements at operation admission: small, but falsely blesses a delayed response from an older request. Persist and verify the actual request selection instead.
- Read only the latest child input: matches a note-only run but loses the original assignment and earlier accepted amendments after compaction. The persisted cutoff snapshot reconstructs the complete applicable requirements.
- Reopen completed work or silently create unrelated work: reuses a task or delegate path, but changes immutable results or loses continuation provenance. Register a new linked task under original authority.
- Store separate pending decisions or infer redisplay from prose: simpler projection, but creates a second authority or cannot prove which source requested it. Query and project the existing ledger and immutable display intents.

## Consequences

An additive append can replace an approval even when the old operation would have remained useful. Misclassifying a progress question as append has the same cost; model guidance directs status questions to queries, and scenario acceptance must test that routing. An amendment cannot undo a started operation. New request snapshots increase retained evidence and context size, while operation facts and text pages remain bounded. The file-focused M1 profile keeps ordinary HTTP/search capabilities; optional execution families require their separate M2 freshness integration before a fully configured profile can claim the same guarantee.

The narrow regressions cover held file/HTTP approvals, both consumption orders, delayed responses, shared and note-only runs, actual parallel compaction, rejected-operation preservation, same-source redisplay/replay, corrupted links, started-operation SIGKILL and continuation cutoff/reopen. Mock provider results establish host and OS ordering; real model routing and desktop/IM presentation remain distinct acceptance evidence in [Issue #39](https://github.com/num-lab/Ruukoto/issues/39).
