# Agent Note: Verify fixed inspection exit through a protected claim

Status: implemented

[Persistent Linux execution claims](2026-10-17-native-linux-execution-identity.md) owns arbitrary-command stop proof; it does not reuse this fixed inspection's same-process-group descendant assumption.

## Problem

[Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) requires verified child stop before releasing occupancy. [Live helper calls](2026-10-17-service-helper-exit.md) wait for close, but backend SIGKILL may leave detached helpers. A fresh identity-free inspect cannot prove original execution exit. [Native launcher](2026-10-10-native-execution-sandbox.md) owns fixed worker preparation/in-memory closures, not a directly durable handle.

## Decision

The fixed helper accepts separate inspection identity and machine parameters. Before launch it claims a root-protected record with bootId, PID, starttime, and process group; the same ID never executes twice. Stop checking first creates an irreversible stop marker. It reports true only when stop won before execution, boot changed, or both original launcher and whole original process group are gone. Unknown claims/observation errors remain unverified. Persisted PID/PGID never authorize kill signals.

The caller creates a separate inspection group but does not require elevated helper to be its leader: sudo may keep a same-group monitor. Absence of the whole group proves original members exited; extra members only delay verification. A real Linux sudo identity probe exposed the leader restriction, so nonleader execution and surviving same-group monitors have regressions.

Proof covers only helper-controlled, privilege-dropped, same-group systemctl show. It creates no systemd command unit and dispatches no writes. It does not cover arbitrary commands, MCP, or deliberately detached descendants. Existing three verbs and restart cross-connection verification remain. Inspection/restart use distinct ID prefixes and claim types, never interchangeable evidence.

This slice provides the helper primitive only. Durable consumers must commit machine, original inspection identity, and work ownership before spawn, verify old execution before any new observation after recovery, and retain occupancy while unverified rather than bypass it with a new ID. Unsupported old-helper protocol refuses enablement. [Service inspection](2026-10-17-personal-service-inspect.md), [service operations](2026-10-17-personal-service-operations.md), and [fixed helper](2026-10-03-service-management-helper.md) retain their protocols/ownership. Native worker/cgroup contracts remain separate.

## Alternatives considered

Re-inspecting after recovery is harmless as a read but proves nothing about original stop. A systemd unit per check constrains arbitrary descendants but adds cross-connection creation/receipt/late-stop state unnecessary for fixed show. Signaling saved PID/PGID can collect orphans but has a reuse race between starttime lookup and signal. Observation may block conservatively rather than risk killing another process. Opening child tools in the same slice additionally requires durable attempt identity, provenance, and whole-request cancellation; helper-only validation is not full-lifecycle acceptance.

## Verification

Historical evidence in `.scratch/personal-pi-durable/issues/16-inspection-identity.md` covers real Linux backend kill, separately surviving helper/same-group descendants, claim-to-launch windows, duplicate IDs, and stop-first ordering. Wrong identity/machine, bad records, or observation failure must never falsely prove stop. Legacy protocol regressions remain, with independent counterexample review.

## Consequences

Stubborn processes, reused process-group numbers, or corrupted claims can stay unverified indefinitely and require operator investigation; there is no force-release. The primitive does not constrain generic detached descendants and cannot be reused for Bash/MCP proof. Identity-free legacy inspect gains no recovery guarantee from new verbs. The original slice did not establish production helper deployment. [Durable inspection](2026-10-17-personal-durable-inspection.md) separately owns attempts, provenance, and recovery without widening this OS proof.
