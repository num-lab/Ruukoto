# Agent Note: Concluding work calls yield the round and are recognized from persisted facts

Status: implemented

## Problem

Personal `background_work` calls that conclude arrangement (report/append/cancel/cancel_delegation/close, plus the authority errors that already instruct the model to end the round) previously returned an ordinary tool result. The model then had to produce prose echoing the result before the run could end, which wasted a provider round and produced tool-call-only or empty assistant answers that callers treated as missing answers. The Personal assistant plan needs a durable main handoff: conclude work, end the run without sealing too early, and keep later owner inputs as distinct runs — without mutating `LiveDoc`, fabricating history or forking the dependency.

## Decision

The `background_work` tool result carries `control: { terminate: true }` for `report`, `append`, `cancel` (both cancel paths), `cancel_delegation` and `close`, and for the `work_tool_inactive`/`work_source_ambiguous`/`work_source_invalid` errors whose text already tells the model to end the round. `delegate`, queries (`list`/`result`/`progress`/`report_result`/`delegations`) and recoverable input/state errors carry no control so repeated arrangement stays legal. Pi durable settles the tool result as `{ kind: "model", entryId, control }` in the persisted tool task record, so the yield is reconstructible from durable records, not transient live state.

`personalWorkHandoff(tx, answerEntryId)` recognizes a tool-call-only answer: every call slot's persisted `pi.tool` task result must be terminal `kind: "model"` with `control.terminate === true`; any text part or any call without that control means unexplained. When recognized, the owner-facing text is derived from the persisted call arguments (delegation/work/agent ids) — e.g. "本轮以工具调用让出：已登记委托 N 的最终汇总安排…" — never canned prose pretending the model wrote it. `answer()` in personal-harness returns handoff text when the assistant message has no text but persisted facts prove the yield; unexplained empty text still returns the empty answer, and a genuinely missing assistant entry still throws `answer_missing`. The `/input` status path in personal-control and the Telegram receipt apply the same recognition before their error/canned paths. Report tasks already reject textless answers as `unanswered`, so a yielded report-attempt round cannot masquerade as a report body.

Pi 1.3.0/1.4.0 exposes no general post-tools round yield: `control.terminate` requires unanimity across every tool slot of the round, so a mixed round with an invalid or unavailable call vetoes termination and the run continues — accepted work stays placed, never polled by the tool itself. `control.handoff` ends the run but appends a `pi.reset` boundary that drops prior context, so it is a context cut, not a yield. `afterTools` is `void` and cannot request termination, and `LiveDoc`/generation internals are private. The implementation therefore only requests the supported bounded yield on conclusion-oriented calls; the general host-forced yield remains an upstream contract request (a post-tools round yield that settles current inputs done without all-slot unanimity and without a reset entry). `test/personal-handoff.test.ts` proves both directions against the minimal pi fixture and the assembled host.

## Alternatives considered

- `control.handoff` on concluding calls: ends the round, but the persisted `pi.reset` cuts model context — later owner input would lose the conversation. Rejected; it changes history visibility rather than yielding.
- Mutating `LiveDoc` or replaying the generation to force round end: violates the private-state boundary and risks corrupting run accounting. Rejected.
- Host-arranged reporting (forging a report call): the issue permits it only with explicit provenance while retaining model-report verification; a forged call is provably unverifiable against `modelCall` recovery checks. Rejected; report stays model-initiated with its existing verification.
- Recognizing yield from `LiveDoc` or transient run state: works only in-process. Persisted tool-task results carry `control`, so recognition survives restart and works in `/input` status and recovery paths.
- Yielding on `delegate` too: repeated delegation in one round is legitimate work arrangement, so it must not conclude the round.

## Consequences

Conclusion-oriented rounds no longer spend a provider call on mandatory echo prose, and every consumer of a done input (`answer()`, `/input` status, Telegram receipts, report answer extraction) sees honest handoff text or the genuine empty-answer error. Mixed rounds keep the documented upstream behavior: the run continues and committed effects are retained; the run never starves because the tool task itself is already terminal. Later owner inputs are unaffected — each `followUp` is its own durable run with its own requestId/source. Crash between the admission commit and the tool-result commit replays the tool safely (idempotent requestIds, `replay: "safe"`); crash after the yielded round reopens with work/report intact and recovery-verified. M1 remains gated on the upstream general yield for cases where a non-concluding mixed round would need a host-forced end.
