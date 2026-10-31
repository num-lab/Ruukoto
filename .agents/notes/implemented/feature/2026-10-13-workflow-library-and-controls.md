# Agent Note: Version workflow definitions behind trusted launch and control entries

Status: implemented

[Role/interface versions](../architecture/2026-10-15-workflow-role-interface.md) supplements named-file/run versioning. Original-key recovery, protected paths, and non-atomic file/SQLite commits remain here. [Progressive controls](2026-10-14-workflow-progressive-controls.md) supersedes the initial TUI text-window and user-entered-key UX, not authorization or unknown-effect rules.

## Problem

The [coordinator](../architecture/2026-10-13-workflow-runtime-and-store.md) and [trusted answers](2026-10-13-workflow-owner-input-and-delivery.md) already owned durable execution, but named scripts, explicit starts from idle sessions, and complete controls needed a common entry. Neither UI nor model parameters may manufacture authority.

## Decision

`<agentDir>/workflows/<name>.js` is the current named definition. Read/save rejects traversal, symlinks, nonregular files, invalid UTF-8, oversize content, and syntax errors; compileOnly uses the same QuickJS wrapper as execution. Core retains immutable script text/digest and named historical references/save-key receipts. Save compares the expected digest. Original-key replay returns the archived version without overwriting a later current file. Files and SQLite commit separately; current digest and original-key facts resolve ambiguous outcomes.

Model tools use a per-call HostToolContext for documentation/save/start/query/cancel. Host verifies source-session/run ownership; models may only narrow default budgets. Plan, ordinary child identities, and workflow steps cannot nest runs. Documentation is a recorded tool result; tool input/fixed script text is reconstructible without unrecorded model input.

Explicit CLI/TUI/IM starts need no model task already running. In the run-creation transaction, Runtime records a short-lived host initiation task fixing current session model/mode, source event, and authority. It ends after registration; the run owns subsequent execution. New requests preflight source and execution, whereas same-key replay returns the original run before choosing anything anew. Definition edits/default changes cannot alter an accepted version.

CLI `workflow` and TUI `/workflow` expose definitions/versions/runs, parameterized start/answer/pause/resume/cancel/budget. Named history pages independently at 100 entries. List/detail contain delivery summaries; full final facts/report bodies come from paged stage logs. Initial TUI used existing scrollable text windows and bounded progress-event notes; progressive controls now owns sidebar interaction and program-managed keys. Reconnect reads durable facts rather than maintaining another run state.

IM parses the entire original command and verifies sender, original entry, and run target. Intent, inbound event, and fixed receipt commit together before stopping in-flight execution. Resume still obeys unknown effects, invalid source, timing, and verified-stop requirements.

### Failure and recovery constraints

A file written without a receipt is not known unwritten: verify digest/key and never replace the key automatically. An incomplete model operation receipt stays unverifiable. After asynchronous compile, recheck active task/cancel/permission version. After IM asynchronous preflight, the registration transaction rechecks original text/identity/target. Every receipt family compares all parameters; an old same-key row is not proof that different parameters were accepted. Compile stack exhaustion maps to a fixed code and releases the VM while refusing save/start. IM error handling advances its offset only from the actually committed fixed event, not an ID temporarily allocated in a rolled-back transaction.

The [overall workflow decision](2026-10-12-agent-workflows.md) retains joint acceptance; coordinator/isolation/step-capability/answer-delivery notes retain their own safety rules. The original audit found overlap but no fully absorbed or archived note.

## Alternatives considered

- Expose sourceTaskId directly: smaller change, but idle sessions have no trusted active task and UI-provided provenance could expand authority. Create a host initiation task instead.
- Validate with V8 or trial execution: reuses Node, but syntax can differ from QuickJS and trial execution can register steps. Compile only in the actual interpreter.
- Keep only the current file: less metadata, but edits would change original-key replay/accepted work. Preserve immutable versions and name references.
- Build a visual workflow editor: convenient overview, but beyond the first approved scope; existing commands/presentation supported the required controls.

## Consequences

Model and explicit owner launches share runtime/authority/resource rules, and idle launches avoid an unnecessary model call. Definition edits cannot mutate old runs. Costs are named-version history, save receipts, short initiation tasks, and transactional source/key checks. Schema 39/protocol 22 were the introduction versions; strict compatibility rejects unsupported old data/clients without authorization backfill, preserving data for matching code.

Initial TUI durable command history used owner-supplied keys and same-instance bounded event notes that did not regress on replay; current interaction delegates those details to progressive controls. Reopening queries list/show/logs/question, not local run state. Historical issue 06, formerly `.scratch/agent-workflow/issues/06-library-and-ui.md`, held real Runtime/two-product Driver, platform substitutes, real CLI, fake terminal, and Python PTY evidence. It is offline provenance. Real model, real IM, and subjective product acceptance belonged to joint acceptance issue 07; substitutes did not establish them.
