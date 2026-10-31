# Agent Note: Bind each child inspection and wait for its original execution to stop

Status: implemented

## Problem

[Durable inspection](2026-10-17-personal-durable-inspection.md) initially allowed only main-session tools and preapproval service inspection; [long-lived child work](2026-10-17-personal-background-work.md) had empty tools. Simply exposing inspection would mistake child input for owner provenance and release identity after framework stop without helper proof. Pi abort-handler errors become faulted, whose terminal abort cannot rerun cleanup, so throwing cannot represent waiting for verification.

## Decision

Add only fixed read-only service_inspect and same-session evidence reads to children, not arbitrary commands, MCP, redelegation, standing authority, or initially service writes. Each new inspection's original acceptance transaction verifies active WorkTask, single-work occupancy, cancellation, original entry, delegation suspension, and current generation/tool. Current child inputs must come from stable keys accepted for this work's initial/input-note content, not Submission backlinks written later. All three modes use the host's read-only allowlist; neither history context nor new defaults expand authority.

Immutable acceptance saves work, original authority/entry, actual child inputs, and mapped main-session sources: owner input, this delegation instruction, and then-accepted input notes. New notes have immutable acceptance; recovery reconstructs only notes preceding inspection admission, excluding later additions. Evidence stays in the original child session. Recovery checks each session's latest acceptance, work/authority, tool, and inputs; missing relations are not guessed.

Normal completion/cancellation first collects child-session/background execution, then observes unresolved inspection documents. Recheck after subscribing and again in the final release transaction. Original WorkTask waits until occupancy can clear; shutdown/restart reattaches that Task. Harness commits stop evidence without using a canceled tool invocation. Model cancel only registers intent and returns current state, avoiding main-chat waits for external stop. Trusted host work.cancel waits for verified final stop. Whole-request cancellation/reporting naturally wait on original WorkTask/provenance while unrelated chat/delegations continue.

Register personal-subagent-service-inspect in main and child sessions; old code missing it refuses. Idle legacy profiles upgrade all child configurations/main marker in one commit. Unresolved old input/work rejects upgrade rather than partially applying it. Children without service configuration keep empty tools.

This supersedes only empty-child-tool/no-inspection portions of durable/background/model-work decisions. Input-note rounds retain their owner. [Child service operations](2026-10-17-personal-subagent-service-operations.md) later adds controlled restart through WorkTask authority/cancellation/unknown-effect rules; other tools and independent host operations keep their boundaries.

## Alternatives considered

Releasing on framework idle/tool terminal is smallest but can reuse identity while the original helper still runs after crash or untrusted stop replies. Throwing on unverified stop then aborting again fails because Pi saves faulted and no longer calls a terminal Task's abort handler. A generic external-execution state machine anticipates command/MCP consumers without their real descendant/receipt/authority needs; reuse fixed inspection and WorkTask instead.

## Consequences

Children gain controlled read-only external tools with reconstructable original provenance/stop evidence; cancellation/restart does not silently inspect again. Unverified execution can occupy identity indefinitely until trusted deployment repair and recheck through [owner controls](2026-10-17-personal-inspection-stop-controls.md). Same-group fixed-inspection proof cannot cover arbitrary commands or escaped descendants. Unknown writes/whole-service-write ownership and full acceptance remain separate. Historical implementation/review/environment evidence is in the offline copy of `.scratch/personal-pi-durable/issues/18-subagent-inspection.md`.
