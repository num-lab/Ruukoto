# Agent Note: Resume the original Personal work from verified question answers

Status: implemented

[Telegram cards and complete delivery](../architecture/2026-11-06-personal-telegram-delivery.md) presents the same original work question and draft records. Child answers still return through the asking ToolTask; the eventual validated report uses complete original-entry delivery without a new child continuation workflow.

## Problem

[Main questions](2026-10-21-personal-owner-questions.md) return pending and later admit a new owner input to main. That path keeps ordinary chat usable but cannot hold an independent work's execution or resources. It also limits the entire session to one unanswered batch and captures reply-time permissions. Letting a child use that path would complete its WorkTask before clarification and route its answers through another execution.

## Decision

The existing question record carries an optional version-1 work binding containing the exact WorkRef and the instructions from the asking model request. Root questions retain their original continuation task, authority and verification. Child questions retain the original work source and permission, admit one batch per work, and wait in the original replay-safe `ask_user` ToolTask. No root submission or new work is created for a child answer.

Answer acceptance, return intent and work completion remain separate facts. Acceptance commits the immutable answers, original actor and single-use request receipt. The original ToolTask appends one immutable return intent and returns the same answers as its actual tool result. Recovery after either commit reads the canonical answer; a completed tool result is verified against its original answer and return identity. Actual work completion still belongs to the WorkTask supervisor and its native submissions.

Cancellation can commit after the tool has selected its return but before Pi commits the actual tool result. The record retains both return intent and canceled continuation; the saved result may contain the actual answers or the canceled outcome. Verification accepts either exact result only with both immutable facts present. Neither result authorizes another request after work cancellation.

The work tool result returns the original questions and answers once, plus a short clarification reminder. It does not nest the same serialized question/answer body inside another JSON field. A fixed 256KiB tool-output limit covers the parser's maximum questions and answers, including JSON escapes; legacy root answer content remains unchanged.

Every pending question is bound to the exact work, original entry and asking generation. Cancellation of that work invalidates its pending questions; an accepted answer that has not returned is retained with a canceled continuation outcome. The asynchronous wait watches the question, original work and IM configuration. A terminal or replaced work, canceled tool, failed original source or inactive IM generation cannot acquire answer authority. Native may inspect or cancel an IM question but only its original verified IM menu can answer it.

Cancellation admission changes the work's existing document flags without appending question entries. Whole-delegation and schedule callers can therefore register several member cancellations in one transaction before their remaining table reads. Question watchers immediately derive the terminal question entries from those flags, and answer acceptance checks the original canceled work even before that projection arrives. The original WorkTask abort also invalidates its questions after reading its own ownership.

The asking generation cannot execute sibling business tools, including after answer acceptance or question cancellation. The shared instruction/origin admission gate enforces this rule during recovered ToolTask execution, which skips `beforeTool`. A later model request regains tools and reads the persisted question outcome. Arbitrary steered text cannot satisfy a question. Accepted amendments remain saved while the tool waits and enter the next request with the answer; returning a clarification does not require the old instruction snapshot to remain fresh, while every newly prepared effect does.

The startup verifier checks question, admission, original model call, instructions, source, work, answer, receipt and actual tool-result references in both directions. Historic root records and child identities without question capability remain readable. Question capability is installed when new work is assigned to an eligible child; startup normalization preserves the recorded capability and does not infer it from a current default. Work progress reuses bounded canonical question facts and the existing independent fact paging.

## Alternatives considered

- Sending child answers as a new root continuation reuses main's existing scheduler, but would change the execution and authority that own the question and could report completion before work resumes.
- Returning pending from the child keeps tool execution short, but the WorkTask supervisor would see a completed native answer and release resources before clarification. Holding the original safe tool preserves its existing lifecycle instead of adding a second continuation dispatcher.
- Treating any work amendment as an answer reduces UI actions, but cannot prove which question was answered or enforce single use. Binding actual question controls preserves those facts while ordinary amendments remain independently durable.
- Rechecking old instruction freshness before answer return appears conservative, but an amendment cannot enter the next request while the question tool is waiting. The generation fence and fresh next-request effects prevent stale execution without that deadlock.

## Consequences

Independent works can wait for answers concurrently while main stays available. A waiting question retains its original WorkTask and resource ownership; ordinary chat does not complete it. Every answer is a clarification rather than an approval or permission increase. A canceled answer remains inspectable, and fixed request receipts recover lost action responses without answering twice. Offline checks cover reverse answer ordering, amendments, cancellation, original permissions, old-batch writes, retained prior effects and strong kills at question admission, answer admission, return intent and tool-result commit. Real native, isolated Linux and configured-model acceptance remain separate evidence.
