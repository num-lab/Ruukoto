# Agent Note: Require branch membership and hosted image provenance together

Status: implemented

## Problem

The image check in `snapshotSources` combined independent requirements as alternative grants. A valid inbound image from another conversation could authorize a forged history reference; conversely, a source task's arbitrary image artifact could pass without an inbound or attachment record. Both counterexamples reproduce in `test/102-branch-session.test.ts` during [CI repair #5](https://github.com/num-lab/Ruukoto/issues/5).

## Decision

Restore the bounded-source contract in [session branch snapshots](../feature/2026-10-11-branch-session-snapshot.md): a non-inherited image must both belong to a task represented in the snapshot (directly or through a verified joined-guidance entry) and have a matching hosted attachment or inbound-image record. Immutable artifact metadata, project access and inherited-source checks remain required. This shared check applies to ordinary branches and side-chat snapshots.

## Alternatives considered

- Accept a matching inbound or attachment record alone: it proves the image exists and was admitted, but not that this conversation contributed it to the captured history.
- Accept snapshot task membership alone: it proves task ownership, but permits arbitrary task artifacts to masquerade as admitted user images.

## Consequences

Forged or unbound references reject before publishing a new conversation or making a model request. Legitimate image inheritance and joined guidance still work; corrupt or missing bytes still stop model execution. Existing published histories are not rewritten. Offline tests cover both rejected conjunctions, repeated branching, guidance and the side-chat consumer; real-model behavior is outside this local CI repair.
