# Agent Note: Continue Personal main from a real answer's provenance

Status: implemented

[Online IM switching](../architecture/2026-10-25-personal-im-updates.md) serializes continuation acceptance, original send-handle selection, and configuration versions. Original question/answer identity remains.

## Problem

Personal main shares an input queue, so a tool waiting for answers blocks their acceptance. Ordinary chat lacks question versions, original entry, and consumption facts. Coding's question tables, Task Store, and control protocol are outside Personal durable and must not be reintroduced for tool reuse.

## Decision

personal-questions owns question documents, creation entries, answer admissions, and one background continuation Task. ask_user returns without blocking; one pending batch is allowed per session, with repeat host-tool retrieval returning the same result. For the original model input, eligibility narrows to background-state/output queries. Pi replaces generation Tasks after each tool round, so initial generation is not the whole owner turn; intersect current LiveDoc.run.inputs with saved question inputs instead. personal-tool-policy filters all system.toolsAdded at provider preparation, verifies normalized-input/payload boundaries, and rejects unapproved invocations at the hook. Later ordinary input does not inherit this narrowing.

Reuse Coding's pure parser for single/multiple choice, descriptions/recommendations, free text, Skip, and skip-all. Pure types/errors/parsing live in packages/core/src/owner-question-input.ts, reexported unchanged by Coding owner-questions.ts. Personal imports the pure module, not workflow eligibility or old Store. This supersedes the [shared proposal's](../../proposed/feature/2026-10-21-persistent-owner-questions.md) initial Personal single-choice/free-text limit. Recommendations are not preselected; empty answers omit selection fields. Answers do not approve tools.

Answer and unique Task share one durable commit. Continuation admits to main with stable `personal-question:<task>` and recovers only the original Submission. ruukoto.question-answer preserves original questions/options/actual answers. personal-source explicitly validates new provenance, admission, Task, original Submission/Inbox, and real answer authority. Tools, delegation, notes, services, reports, schedules, and browser consume that actual authority/entry, never forged IM text or fallback defaults. Existing request recording persists real model requests.

Local menus collect/review answers step by step, saving original parameters/stable key before send and querying the receipt after lost replies. IM accepts answers only through original delivered host menus. Drafts and each choice are durable. Questions/options/batch review use complete 3000-character paging; confirmation replies only to the last-page menu. Lists are bounded previews; answered records also page fully. Recovery validates platform/account/owner/generation and every menu backlink. Answers pin actual reply-time authority and original entry. Trusted local controls may query/cancel IM questions, not answer on another entry's behalf. Continuation delivery uses pending/sending/sent/effect_unknown; unknown sends never replay or retarget after reopen.

Ordinary chat, natural completion, disconnect, and restart retain pending questions. Explicit abort of original input or IM generation replacement invalidates unanswered batches. Question/receipt/creation/answer entries and original tool/background Task have bidirectional checks, including a full immutable-entry reverse scan so deleting both index/document cannot hide a question. Original assistant arguments are renormalized through the actual SDK tool schema before comparison, allowing SDK-accepted numeric/boolean conversion. New extension identity makes old code reject unknown ownership; first enablement rejects unresolved legacy work, and the wizard recognizes pending questions.

[Coding questions](2026-10-21-coding-owner-questions.md) and [choice types](2026-10-21-owner-question-choice-types.md) share pure input/interaction only. [Personal entry](../architecture/2026-10-17-personal-telegram-entry.md), [local management](../architecture/2026-10-17-personal-local-management.md), and [reports](../architecture/2026-10-17-personal-delegation-reports.md) retain acceptance/stop/unknown-send rules.

## Alternatives considered

Coding storage/control reduces wiring but imports excluded old runtime authority. Treating answers as old IM text loses control-input/actual-answer identity. Permanently altering AgentDoc tools is easy but also restricts ordinary chat while waiting. Saving only final confirmation reduces recovery checks but cannot detect replacement of an earlier draft. Independent durable storage, explicit provenance, per-input eligibility, and each-step reconstruction avoid those failures.

## Consequences

A continuation model request and background Task are added, while main stays available during waiting. Questions/answers remain and cannot be bypassed by deleting records. Offline persistence, invocation gates, real local-socket CLI, simulated two-platform menus, and negative tests at both recording boundaries verify distinct properties. Real-model and actual QQ/Telegram credential checks remain separate; simulated menus are not real-platform acceptance.
