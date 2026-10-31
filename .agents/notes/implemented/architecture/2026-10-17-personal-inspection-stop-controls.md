# Agent Note: Pin inspection stop checks to the original accepted request

Status: implemented

## Problem

[Durable inspection](2026-10-17-personal-durable-inspection.md) and [child inspection](2026-10-17-personal-subagent-inspection.md) retain occupancy when stop is unverified, but only a trusted host API could recheck. Owners need real controls. Looking up the current inspection by Task ID lets an old menu affect a later attempt. Calling the helper inside Telegram's acceptance transaction blocks all incoming messages, while the local client's five-second reply limit is shorter than the stop protocol.

## Decision

CLI and Telegram menus save a named `PersonalInspectionRef`, pinning both original Task and immutable accepted entry. Do not accept a recheck while the original inspection is executing. Validate at acceptance and execution separately, capture the original inspection, then call existing stop-inspect outside the transaction. Original machine/ID, acceptance CAS, and exit evidence remain the sole basis for releasing occupancy. Never call inspect/restart, infer service-write effects, or force-release.

Each request creates a framework-owned durable background `ruukoto.inspection-stop` Task. CLI POST and Telegram's fixed receipt acknowledge registration only. A request performs one bounded stop observation; invalid evidence/failure retains occupancy without polling. After repairing helper deployment, the owner can select again. Crash recovery rechecks the same identity only and makes no external call when original exit evidence already exists. Canceling the recheck does not prove original inspection exit.

Local authentication retains whole-profile authority, including old-entry inspections. Telegram lists only inspections whose every source Submission traces to direct owner input at the current bot/owner/generation. Local, mixed, old-entry, or unproven origins are excluded. Forwarded/quoted text, ordinary model replies, and undelivered host menus cannot authorize recheck. Input, original reference, recheck Task, and fixed receipt commit together. Platform redelivery reuses the original input rather than creates another request.

The main session selects `personal-inspection-controls`. New code may add this management-only extension while preserving old unresolved work, without model tools/prompt changes; old code lacking it refuses recovery. Recovery verifies historical menu acceptance/provenance, recheck Task version/ownership, and bidirectional links between Telegram control input and the delivered original detail menu. A historical menu need not still name the current attempt, but executing a stale menu must fail.

Existing durable/child inspection, local management, Telegram authority, and work controls retain their independent guarantees. This closes the missing CLI/IM stop-recheck entry only, not helper evidence or unknown-write verification.

## Alternatives considered

Waiting in local request/Telegram acceptance is smallest but blocks input and times out locally before stop completes. Task ID alone fits the trusted API but lets replay advance to another attempt. Repeated polling or force-release reduces manual steps but can call a broken deployment indefinitely, and owner choice cannot substitute for exit evidence from the original machine.

## Consequences

After repair, owners can release verified inspection occupancy through actual entry points, allowing existing work/report document observers to continue. Registration uses no model call. The cost is a specific background Task and control-provenance validation. Telegram manages only its current entry; old entries need local authentication. Real platform, systemd, and subjective acceptance remain separate, as do arbitrary commands, MCP, child writes, and final product cutover. Historical evidence is in the offline copy of `.scratch/personal-pi-durable/issues/19-inspection-stop-controls.md`.
