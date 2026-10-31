# Agent Note: Personal commands recover under original work and verify external facts

Status: implemented

## Problem

The [command host](2026-10-17-personal-command-execution.md) saves complete stdout/stderr, receipts and original-reference stopping, but knows nothing about work source, permissions or single-work occupancy. Direct model-tool wiring could repeat execution after cancellation, restart or failed result persistence, or bypass an unknown-effect pause through another member/service tool.

## Decision

Restricted commands are supplied only to long-lived child conversations. The original WorkTask owns an independent durable command Task. While any original execution's stopping remains unverified, the profile's shared command directory rejects new commands from other sources; pure analysis/chat continues. Tool admission, Task, execution reference and immutable entry commit together, binding original tool/generation, work input, all mapped owner sources, permissions and entry. [Stopped configuration](2026-10-17-personal-command-configuration.md) pins the trusted directory. The tool accepts command text, not path grants, execution identity or mode parameters. Confirm/auto-review use the same native restricted boundary without network access. The initial slice rejected full access before admission rather than silently restricting it; [full-access commands](2026-10-17-personal-full-access-commands.md) now supersedes that limitation.

After prepare, complete spec/input, expected fingerprint and immutable start entry commit with recovery phase before dispatch. Only the current invocation may launch. Recovery only reads the original receipt, verifies its expected fingerprint and stops the original reference. Strict stopping needs both original private request and original native launch claim. Missing claims, fingerprint mismatch or a stop-first claim cannot prove original exit and cannot create a replacement launch claim. Receipts prove execution returned; nonzero exit/stderr does not prove non-execution or business health. No receipt conservatively remains unknown; unverified stopping also pauses. Immutable human effect statements retain their entry separately from original stop proof. Both facts must be complete to clear the pause; the command never resends.

Model-result verifiedEffect plus stopped=true reports both facts complete while original effect_unknown retains interruption history. Tool/report guidance does not demand repeat verification; incomplete output capture cannot overwrite human verification. run_command and work queries use the same pure result projection. requiresVerification directly reflects the original unknown-state gate. Only human effect verification plus stopping establishes both facts; return still does not prove business success. Queries do not merely repeat historical child answers.

Normal work cleanup, cancellation and final release transactions all check command facts. Abnormal terminal state cannot release unknown occupancy. Original input, delegation instructions and additional sources share a pause gate across members, covering child model calls, continuation, append, service request/consumption and fixed checks. Reports observe the original command document; pause recovery verifies immutable command admission. Main chat and independent sources continue. Original command recovery/stopping verifies original relationships without re-entering active-work gates that its own unknown state would block.

Before Harness resumes, bidirectionally verify configuration, Task, document, admission, original model tool, execution intent and work source. Idle old profiles atomically gain main/child extensions; pending old work rejects first activation. Locally authenticated CLI queries commands, pages original bytes and verifies effect/stopping. Both IM platforms' `/命令` menus complete the same original-operation loop. IM shows UTF-8 previews; local reads preserve original bytes. Models cannot clear pauses. Menus pin the original work entry; effect evidence records the original control receipt. Stop Tasks pin their original receipt and check entry liveness before execution/abort verification; inactive entries end the Task without external calls. Repeated clicks may reference the same in-flight stop Task; each Task retains one original control basis. Recovery checks menus, effect actor, native stop Task and admission bidirectionally. Main's personal-owner-controls marker makes old code reject unrecognized control semantics. Stream pages contain at most 3072 original bytes in base64. Unknown output is explicitly partial; damaged output still permits fact inspection and human evidence recording.

## Related decisions

The original audit searched Personal commands, durable, unknown effects, source pauses and service cancellation. Migration, command host/worker, native persistent identity, background work, child services and reports retain separate decisions. This note supplies the command host's durable caller, not a replacement OS-receipt contract. The background Bash proposal concerns a shared long-lived terminal, not one-shot Personal commands. No note was wholly absorbed or invalidated.

[Personal conversation background processes](../feature/2026-10-21-personal-background-processes.md) separately admits and owns cross-turn execution; it does not extend run_command lifetime. Background starting and ordinary command prepare/start share transactional directory claims.

## Alternatives considered

- Let the child tool own execution: direct lifecycle, but cancellation ends waiting before unknown effects/original-work occupancy can be handled. Use a native owned Task in the same conversation.
- Forbid retries only in prompts: little code, but models can change arguments, members or service tools. Enforce pausing at all relevant host admissions/releases.
- Prepare and launch again on recovery: valid for pure computation, not arbitrary commands that may already have effects. After start intent, verify only the original reference.
- Tell IM users to switch to local management: simplest wiring, but original-entry unknown verification remains incomplete. Reuse original operations/stop Tasks without another execution state machine.
- Use full-access local launcher directly: existing account execution, but an in-memory process group cannot prove stopping across backend SIGKILL. The initial slice rejected it pending independent persistent stopping support.

## Consequences

Native durable Tasks own waiting/cancellation without a parallel runtime state machine. External files/database are still not atomic: a crash after execution intent but before external request/launch claims, or lost original claims, conservatively retains unknown effect/stopping. A new stop-first claim cannot substitute for original proof. Crashes between prepare and intent commit may leave undispatched temporary directories. Preserve the original machine, TMPDIR, evidence and directory identities; missing data retains the scene.

Original real-Linux, model, IM and product evidence is offline at `.scratch/personal-pi-durable/issues/25-durable-commands.md`. This slice does not establish complete migration acceptance.
