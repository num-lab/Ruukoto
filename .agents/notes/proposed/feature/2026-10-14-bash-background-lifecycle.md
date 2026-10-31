# Agent Note: Give background executions a lifecycle independent of a bash call

Status: proposed

The owner confirmed both-product planning on 2026-10-21, Code first, survival across messages, and stop-before-edit in the same directory. [Code backgrounds](../../implemented/feature/2026-10-21-coding-background-processes.md) and [personal backgrounds](../../implemented/feature/2026-10-21-personal-background-processes.md) now own their implementations. This retained proposal records the original cross-product tradeoffs and acceptance objectives, not a claim that personal integration is still unimplemented or that all real-environment acceptance has passed.

## Problem

After starting a dev server/watcher/test dependency, an Agent needs later browser/log/command calls. The original worker reclaimed the entire group when the main shell finished, so a nohup background HTTP server was reachable only inside that bash call. Real worker plus isolated browser reproduced the gap; tool documentation can explain it but cannot supply the missing execution capability.

Bash originally returned only command/timeout/final result, with no durable handle/log/continuation. Driver also stopped the worker at natural task completion. Relaxing command cleanup alone would help same-task calls but still fail the confirmed across-message lifetime.

## Proposal

Separate command return from background stopping with explicit process_start/status/output/stop, preserving foreground bash semantics. A separate session-owned execution unit retains its starting Task/op/authority and survives normal turn completion after successful handoff. A task-lifetime-only patch is not final delivery. Product-specific implemented notes own current schema/budgets/states; this proposal retains shared constraints.

Limit the first version to genuine full-access owner main sessions. Restricted native execution does not allow general networking and cannot promise restricted dev-server previews. Background execution owns independent directory occupancy. Other turns begin in an internal conversation stage allowing observation/stop/questions and browser use only with valid full-access provenance. Ordinary writes/same-directory delegation require stopping the background first. agent_wait releases only the current Task's temporary unit, never session-background occupancy. Same-session work is not an exception to one writer.

Persist registration first. At a serial tool boundary verify the original temporary worker stopped, transfer original Task occupancy to the independent unit without a gap, save the reference snapshot, and immediately narrow the current turn to observation before permitting one launch. New-turn admission restores from that record, without requiring a prior agent_wait. Return only after successful handoff. Host arbitrates cancellation/close/handoff; unverifiable start/stop must not transfer occupancy back and allow writes.

Restart only stops/verifies the original execution, never reruns its command. Linux uses original scope/invocation identity; macOS needs persistent unique supervisor identity/stop receipts. Bare PID/PGID is not sufficient post-restart signaling authority. Default-mode changes do not rewrite original authority; actual entry invalidation or authority revocation reclaims its background. Unverified stopping retains visible records and directory occupancy.

Window close/TUI exit/archive do not stop session work. Provide explicit End This Session's Backgrounds: persist a stop barrier blocking already-admitted old starts, verify all units stopped, then report while retaining session/history. Application-backend shutdown likewise gathers its executions. Status/logs/exit codes do not establish business effects.

Inherited stdout/stderr keeps child.close waiting for pipe closure, so independent backgrounds need their own pipes/bounded logs rather than detached descendants of the current worker. Logs/start results retain separate provenance, and model-visible fragments remain reconstructible from history/evidence. Disk-write failure, exhausted budgets, or missing stop proof cannot silently become completion.

Personal uses separate durable records, reusing low-level execution identity/output/stop rather than old Task Store. Background starting, ordinary command prepare/start, and file-write approval consumption share transactional directory claims, blocking both already-in-flight and later conflicting writes. Unknown stop/observation preserves claims. Main-session launch is an explicit new ability only for genuine full-access owner provenance; children/schedules/summaries gain no arbitrary shell. Neither product becomes a generic service manager. Full access does not promise reclamation of processes deliberately escaping supervision or external services.

Related [worker](../../implemented/architecture/2026-09-20-tool-worker-per-task-container.md), [full access](../../implemented/feature/2026-10-12-full-access-current-account.md), and [unverified stop](../../implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md) decisions retain execution/authority/stop rules. [Browser](../../implemented/feature/2026-10-14-agent-browser.md) owns its own cross-turn process; this proposal concerns services it visits. [Wait/report](../../implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md) retains Task resource yield/reacquire; [personal commands](../../implemented/architecture/2026-10-17-personal-durable-commands.md) retains run_command cleanup. The original audit found no fully absorbed old proposal.

## Alternatives considered

- Keep per-command reclamation with clearer docs: short scope/simple cleanup and fewer unsupported attempts, but no later access to dev servers/watchers/test services.
- Delete only normal-return cleanup: smallest patch and redirected-output services could survive, but inherited pipes, reused process identity, and task-terminal cleanup remain unresolved.
- Ask the owner to run a persistent external terminal: workable for local acceptance, but requiring intervention for each preview is not Agent autonomy. Nohup/double-fork/setsid are not product lifecycle escape hatches.
- Keep processes only until Task end: confines changes to worker/Driver with fewer session records, but fails approved cross-message survival.
- Share background/foreground occupancy inside a session: enables hot reload, but arbitrary shells may both write and existing rules cannot prove one writer. The owner chose stop-before-edit, not a new read-only-server sandbox.

## Acceptance criteria

- A real independent synthetic HTTP server remains browser-accessible after process_start, natural model-turn completion, and the next owner turn; directory writes become eligible only after explicit verified stop.
- Inherited stdout/stderr does not block tool return; output is bounded and tied to original execution. Main-PID exit is not whole-unit stop proof, and exit code is not business success.
- Start/handoff/cancel/close races, real authority revocation, log budget, and application shutdown cover owned executions. Recovery does not relaunch and unverified state retains occupancy.
- Identity mismatch/PID or PGID reuse never signals an unrelated process. macOS/Linux each need real background/stop evidence; offline substitutes cannot establish platform reclamation.
- New same-directory tasks, agent_wait, and child work cannot drop background occupancy or deadlock indefinitely. Default-mode change/window close/archive cannot masquerade as stop. Personal durable/original-entry recovery requires its own evidence, not Code's pass.

## Risks

Backgrounds extend resource/port/directory occupancy, and the first version cannot edit that directory while they live. Persistent platform identity, launch handoff, stop barriers, and log storage add maintenance. Real macOS/Linux evidence is required for delivery; implementation and acceptance statuses remain with their respective decisions/evidence rather than inferred from this proposal. Future hot reload needs explicit write-range design/proof, not a same-session occupancy bypass.

Original diagnosis/spec/issue material under `.scratch/agent-browser/` and `.scratch/agent-tool-completion/` is offline provenance. Current implemented decisions above replace those removed task paths as the maintained source for behavior; this proposal does not itself certify external acceptance.
