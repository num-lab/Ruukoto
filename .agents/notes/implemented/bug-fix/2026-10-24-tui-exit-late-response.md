# Agent Note: Do not restart animation timers after TUI exit

Status: implemented

## Problem

TUI exit closes its connection and clears animation timers, but an outstanding `continue` reply can reach `submitText` afterward. Updating state notifies the view, and `refreshAll` calls `tickTiming` again. The closed connection no longer updates active-task state, so a newly referenced timer can keep the process alive forever. On Linux with Node 22.19 and 24.15, delaying a reply during a real running task and then exiting reproduced a passing test body whose file process never exited.

## Decision

`tickTiming` returns immediately after exit. `quit` still clears existing timers; late replies must not reacquire animation resources. Backend tasks, request acceptance, and persistence semantics remain unchanged. Guarding timer creation covers every refresh caller without intercepting each asynchronous caller separately.

The 32-dev reload/continue integration uses two promises to control model completion and reply delivery independently. It verifies that the task really runs, exits the client, then delivers the reply. After submission settles, it checks that no animation timer exists, releases the model, and checks independent backend completion. Failure cleanup collects any timer recreated by the counterexample so the assertion fails instead of hanging the entire suite.

This supplements [backend/terminal separation](../architecture/2026-09-19-detach-terminal-from-task-runtime.md) without stopping tasks on client exit. [Development launchers](../process/2026-10-09-dev-launchers.md) own a different lifecycle and still stop their managed backends. The defect was found during [test-suite reduction](../testing/2026-10-24-test-suite-reduction.md); it is a product race, not a consequence of test count.

## Alternatives considered

Waiting for every asynchronous reply at exit gives one cleanup sequence, but depends on network/backend latency and cannot prevent later notifications from creating other resources. Unref lets the process exit but still refreshes a closed client. Delaying test exit or forcibly killing its process hides the race. Guard the animation-resource owner instead.

## Consequences

Only post-exit animation is blocked; exiting is not cancellation of a backend operation. Late submissions settle according to the original request. Other resources retain their own lifecycle owners. Historical red/green, CI applicability, and complete-check results are in the offline copy of `.scratch/ci/issues/03-tui-exit-late-response.md`.
