# Agent Note: Async tests await actual phases and distinguish registration from final outcomes

Status: implemented

## Problem

In [CI 38114738658](https://github.com/num-lab/Ruukoto/actions/runs/38114738658), review cancellation asserted a model request immediately after approval became in_progress; actual request count was zero. Work-message tests treated historical pending in the send event as final non-delivery, despite message/delivery-task facts proving delivery. These assume scheduling order; isolated passes do not prove behavior under full-suite load.

[CI 38127175560](https://github.com/num-lab/Ruukoto/actions/runs/38127175560) failed macOS/Node 22 unknown-orphan heartbeat assertions after an 80-ms fixed wait. The first heartbeat could precede Python-parent exit, so supervisor recovery could still legitimately observe/reap the chain. A short window cannot exclude scheduling delay, and a three-second natural lifetime cannot prove the fixture remained alive during observation; this alone did not prove an erroneous kill.

In [CI 38129294407](https://github.com/num-lab/Ruukoto/actions/runs/38129294407), fixed unknown-orphan tests passed both macOS matrix cells, but adjacent owned-descendant tests failed their pre-stop 100-ms heartbeat-growth assertion in both versions. Post-stop 80-ms frozen-heartbeat observation also could not prove exit.

Personal durable stream-SIGKILL tests allowed five seconds from spawn to persisted partial, including tsx/static imports. Successful Node 22 diagnostics approached that deadline, consuming time intended for profile opening, admission and stream waiting. Successful diagnostics cannot retrospectively explain every original failing run.

## Decision

Tests synchronize on actual start/end signals for the phase under test, not previous-phase database state or fixed delays. Mock responders use gates to force required ordering and finally releases gates so assertion failures cannot block cleanup. Synchronization stays in tests, without new production waiting APIs.

- Review cancellation, human-first decisions, permission changes and restart wait for the responder to receive the review request before changing state. After release, await generated response and superseded approval, then verify late approval neither takes effect nor consumes authorization/executes tools.
- Keep message sender busy so reply registration is deterministically pending. After release, verify the same message's unique delivery Task/source. subagent_message.sent retains the decision at send time; flushing neither rewrites nor duplicates history. Read message rows for final delivery.
- Unknown macOS orphan fixtures call setsid, confirm ppid == 1, signal ready, then restore the supervisor. After stop receipt, await a new heartbeat within the existing five-second deadline while strictly requiring unverified reason/reaped:false. Deliberate 500-ms heartbeats exceed the old 80-ms window. A release file controls normal lifetime. Finally releases first; ready orphans must close the heartbeat file and publish finished before directory deletion. Missing completion retains the directory. A 20-second lifetime cap only cleans up interrupted test hosts, not extends acceptance, and unknown PIDs are never signaled.
- Owned macOS descendants use long-lived detached Node, reporting parent PID after installing a TERM handler. Await a new 500-ms heartbeat before stopping; require stopped:true and a TERM marker proving the descendant received/ignored TERM. It inherits only stdout and never closes it itself. Shared-pipe EOF within the existing five-second deadline independently proves exit, followed by frozen heartbeat after stop. release is written only in finally, never helping the tested stop pass; 20 seconds is abnormal-test cleanup fallback.
- Personal stream-SIGKILL children signal IPC ready after static imports but before Harness.open, then await parent start. Parent bounds ready separately and installs the original five-second persisted-partial wait before start. Real nonempty LiveDoc text proves partial. Ready is capped at ten seconds and the whole test remains fifteen. Startup failure, early exit or missing ready fails with stderr retained. Register after before profile fixtures; kill/join every test child before deleting profiles. Branch finally blocks remain. launch refuses creation after t.signal cancellation so timed-out async continuations cannot spawn children. Local self-checks cover nonzero early exit and started-but-never-ready timeout.

[Automatic review](../feature/2026-09-22-auto-review-mode.md), [work messages](../feature/2026-10-05-subagent-messaging.md) and [native sandbox](../architecture/2026-10-10-native-execution-sandbox.md) retain production semantics, including ownership, signals, observation windows and reaping conclusions.

## Alternatives considered

- Increase fixed waits/timeouts: tiny change and fewer local failures, but no proof of request start/delivery and renewed races under different load.
- Extend orphan lifetime/80-ms window only: tolerates pauses, but proves neither parent exit nor fixture liveness. Use ready/release/finished signals.
- Keep finite shell descendants with longer windows: fewer edits, but natural exhaustion and short waits still cannot establish exit. Use persistent Node/pipe EOF, not new production status APIs.
- Increase Personal's five seconds or prewarm: mixes startup/behavior timing or bypasses real new-process locking/crash premises. Ready after Harness.open/submit would remove profile/admission work from the tested budget, so place it after imports only.
- Accept any historical delivery value: easy assertions, but misses busy-time misdelivery/history rewrites. Gate order and assert registration/final facts separately.
- Update production events to final state: event-only readers see current outcomes, but loses send-time facts and changes behavior beyond the fixture repair. Retain message/event ownership.

## Consequences

Tests no longer infer ordering from machine speed and cover registered-but-unsent requests, busy pending delivery and invalid late results. Fixtures explicitly manage/release phases. Mock-responder signals prove actual mock calls, not real-model or OS isolation.

Unknown-orphan checks use real processes/file writes to prove post-stop survival, paying for slow-heartbeat/cleanup waits. Missing readiness/completion fails. Polling still is not a definitive kernel membership set. Owned-descendant EOF depends on controlled processes never closing stdout deliberately, so it is neither a general production reaper nor independent exit-cause proof.

Personal changes synchronization only: Harness opening, actual requests/persisted partial, lock exclusion, SIGKILL, unique reopened input and completed/aborted history assertions remain. Five seconds begins when the parent installs waiting before start; imports have ready/whole-test deadlines. This is not a five-second product cold-start guarantee. Local IPC adds neither Coding fixtures nor new recovery interfaces.

## Verification

A pre-send gate reproduces old review `0 !== 1`; corrected checks pass under the same gate. Holding the sender active breaks the old all-sent-are-task assertion; corrected checks prove pending, later delivery and unchanged history. Original commands/results are offline at `.scratch/ci/2026-10-11-previous-ci-failures.md`.

Slowing orphan heartbeats to 500 ms and separately delaying parent exit/creating an observation gap both break the old post-stop heartbeat assertion; new synchronization passes the same perturbations. Evidence is offline at `.scratch/ci/2026-10-11-native-orphan-ci.md`. Slowing old owned-descendant shell heartbeats to 500 ms reproduces its pre-stop failure; final fixtures use the same interval plus TERM/real EOF proof. Evidence is offline at `.scratch/ci/2026-10-11-native-descendant-ci.md`.
