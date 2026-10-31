# Agent Note: Service management uses a root-owned fixed helper

Status: implemented

Original identifier: ADR 0019.

## Problem

The original main assembly needs explicitly authorized server management without bash. Restricted workers cannot manage host systemd; the former full-access launcher neither handled confirm tasks nor gave its execution UID service authority. Free commands or broader sudo would collapse the execution/control identity split. Personal must work independently on its server and accept approval from the original owner IM entry. The retired container/account premises are historical; [current-account full access](../feature/2026-10-12-full-access-current-account.md) owns subsequent account/environment/approval rules.

## Decision

Service management goes through root-owned `deploy/systemd/ruukoto-service.mjs`, installed 0700 and callable only by the backend through a fixed sudoers path. Verify ownership/write permissions of helper, policy, operation markers, and parents. Neither model input nor retained environment chooses executable, configuration path, execution identity, or systemd arguments.

The protocol is fixed to `inspect`, `restart`, and `stop-op`. Root-owned policy fixes host identity, execution UID/GID, exact canonical `.service` units, and allowed actions. Reject aliases, template instances, wildcards, paths, option injection, and extra arguments; deny backend, Docker, execution-worker, helper-operation, dbus, and similar infrastructure targets. Inspect drops to the policy execution account and returns fixed status fields, not entire units, environments, or arbitrary logs. Restart uses `systemd-run --pipe --wait` to create a short-lived root command unit running fixed absolute-path `systemctl --system restart` with structured argv, no shell/free arguments. Approval explains that restarting an inactive service starts it and trusted unit dependencies still propagate.

Host operation ID determines `ruukoto-service-op-<hostOpId>.service`, bounded runtime, and `KillMode=control-group`. Atomic mkdir in a fixed root operation directory claims execution once; an existing same-ID marker rejects. Failed claims are not automatically removed; markers outlive transient units and prove claim, not restart success. `stop-op` can stop only that ID's command unit. Managed registration covers startup and late creation. Release occupancy only after proving launcher/process group and command unit/cgroup exited; query failure is not exit.

`claim.json` v2 records helper PID, Linux starttime, process group, and boot ID. Stop writes a stop marker, observes/stops the unit, verifies original launcher identity and process-group absence via `kill(-pgid, 0)`, then checks the unit again. Response remains `v:1`, with `launcherExited` distinguishing launcher proof. Unit not-found alone misses a helper between stop-marker check and dispatch; helper PID alone misses surviving systemd-run descendants. PID/starttime prevents PID reuse; boot ID separates boots. Unreadable/missing/corrupt/old claims prove nothing. A claim atomically created by stop itself proves no dispatch; cross-boot state excludes old processes/requests. More stop-marker checks cannot eliminate the check/dispatch race; process-group disappearance can, conservatively retaining occupancy for unrelated group members or zombies.

Even a gone process group cannot rule out a D-Bus create request queued but not processed by PID 1; cross-connection stop/show provides no ordering guarantee. Therefore the helper writes `launcher-completed.json` durably only after `systemd-run --pipe --wait` exits 0 and before response. Nonzero/abnormal exit is not settlement proof. Stop writes `unit-observed.json` only after a successful query actually sees `LoadState=loaded`. Both proofs bind operation, unit, and complete launcher identity. With group gone and unit not-found, at least one proof is required for `exited:true`, except preemptive stop-claim or cross-boot cases. Missing/partial/corrupt/mismatched proof retains occupancy even if the command probably finished and its receipt was lost. `launcherExited:true` alone is insufficient; restart effects still need separate verification.

The original shared tools are read-only `service_inspect` and restart-only `service_manage`, assembled/called only for trusted main tasks on explicitly configured Personal/Linux. Model arguments are exact allowlisted unit and fixed action; host/identity/task/operation IDs are host-assigned. This grants neither bash to main nor sudo/Polkit or unrelated deployment-file access to the execution account.

Originally every service_manage mode, including full access, required owner approval unless a valid [standing permission](../feature/2026-10-03-standing-permissions.md) matched; auto-review also asked the owner. The helper root branch was new backend privilege, not ordinary account rights. That bounded exception does not automatically extend to destructive application data, notifications, or MCP writes; subsequent mode policy belongs to the full-access successor.

Approval fixes host, canonical unit, restart, and a revision fingerprint over policy contents, unit/drop-in contents, and loaded configuration. Active state/PID/InvocationID are observations, not revision inputs, so normal state changes do not expire approval. Unloaded new definitions or untrusted configuration reject. Store necessary identity/digests without leaking configuration contents. Before consumption recheck main/task/permission version, fixed original IM identity, and deployment revision; helper rechecks again before systemd dispatch. Changed revision/binding invalidates approval. Notifications, lists/details, decisions, receipts, consumption, and original-target replies reuse [IM approval](../feature/2026-10-02-im-approval-and-final-report.md), not another service ledger/page.

## Results and interruption

Approval consumption and systemd have no shared transaction. Unconsumed or trusted pre-request rejection is known not executed; interrupted inspection has no write effect. Consumed without trustworthy result is unknown and is never automatically resent with the same or a new ID; the owner verifies before another request. Nonzero exit may mean stopped-but-failed-to-start, not zero effect. Cancellation reaps the command unit, but a PID 1 job may continue; stopping the target is not an automatic rollback. Service-operation unknown and outbox-send unknown remain separate records.

Capture raw stdout/stderr in ArtifactStore before bounded model views. Normal capture is complete; interruption/capture failure is partial; references enter `task.tool_result`. Evidence includes operation ID, unit, actual identity, exit code, observation time, and before/after status. Distinguish command exit 0, service active, and business health. Failed post-inspection retains the known command result and states the verification gap. Missing Linux/systemd/helper/sudo fails explicitly, never free backend execution or exposing systemd bus/Docker/control sockets to workers.

## Alternatives considered

- **Give main bash.** Existing commands would be directly usable, but model tooling and privileged host control become one capability, and restricted execution cannot manage host systemd. Use fixed structured tools/helper instead.
- **Give the execution account sudo/Polkit or reuse its full-access launcher.** Reuses command plumbing, but the original account split forbids inheriting backend privilege, and that launcher did not serve confirm tasks. Do not turn confirm into full access or broaden account authority to satisfy service requests.

Historical offline provenance is `.scratch/agent-direction/issues/09-linux-service-management.md`; it is not the current task entry.

## Consequences

Root service authority is real and auditable, with fixed targets, revision binding, one-time claims, and no replay after unknown effects. Deployment must maintain trusted helper/policy/sudoers/units; SQLite and systemd cannot commit atomically, and cancellation cannot promise withdrawal. Logs, other actions, and remote hosts are excluded; extend a fixed protocol for demonstrated needs rather than build a general command framework. See [deployment](../../../../docs/modules/deploy.md).

[Durable service inspection](2026-10-17-personal-service-inspect.md) shares app transport for inspect/evidence only; inspection does not imply restart delivery. Its [inspection identity protocol](2026-10-17-service-inspection-identity.md) uses separate claim types/prefixes without changing restart stop/dispatch proof. [Durable service operations](2026-10-17-personal-service-operations.md) separately enables a trusted restart API with durable background work and one-shot approval; its original delivery did not yet expose a model write tool or old IM/standing-permission wiring. Later personal delegation/permission notes own their additions. Durable stop requires both `launcherExited:true` and `exited:true`; older helper responses are not proof.

## Verification

Historical issue 09: macOS mock dual-IM/helper tests, test/78 22/22 for identity/product/platform gates, all-mode approvals, tampering/revision invalidation, same-ID claims, cancellation windows, restart unknown, and artifact references. Required batches/typecheck/test/67 3/3 passed; full suite was 838 total, 837 passed, one gated real-model skip.

Offline `.scratch/agent-direction/smoke-09-linux-service-management.mts` ran real helper/sudoers/systemd/test service/isolated backend on tx with mock model/IM, three rounds 14/14. Evidence included changed InvocationID with exactly one additional start, execution-account denials, duplicate-ID rejection, policy/unloaded-unit revision invalidation, and post-dispatch kill -9 recovering unknown without resend. The test service was removed and daily backend untouched. Real QQ/Telegram was not tested.

Real smoke exposed sudo closing fd3; the protocol changed to prefixed single-line JSON on stderr. Post-dispatch errors no longer falsely mean unexecuted; actual identity and structured IM scope were added. Host policy path and helper fixed path are cross-checked and mismatch fails; [systemd setup](../../../../deploy/systemd/README.md) owns deployment requirements. This prose migration reruns no runtime/platform tests.
