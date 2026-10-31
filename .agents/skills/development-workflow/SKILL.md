---
name: development-workflow
description: "Use when starting a Ruukoto change, taking over work, planning or reviewing. Establish effective requirements and independently verify engineering and product acceptance in proportion to impact."
---

# Development Workflow

This workflow governs development of Ruukoto, not the products' runtime tasks or approvals. A role defines responsibility; the owner chooses the model. The input may be a new request or an existing Issue and next role.

## 1. Take Over And Choose Scope

Read `AGENTS.md` and [CONTEXT.md](../../../CONTEXT.md), then the referenced Issue, specifications and related decisions. Check the current source before trusting a ticket: later decisions, changed dependencies and new code may invalidate its plan or review. The Issue body is the current record; comments preserve history. Resolve factual contradictions from their sources; ask the owner only about unresolved choices.

Use the lightweight path for local mechanical changes or repairs restoring a clear existing contract, provided they do not affect permissions, data safety, persistence or cross-module behavior. Implement, run [scoped checks](../pre-push-checks/SKILL.md), and report the result and real gaps. No full template or new Issue is required unless handoff/tracking needs it. [maintain-notes](../maintain-notes/SKILL.md) separately determines whether a decision note is needed.

Use the full path for new behavior, architecture, contracts, development process, test strategy and high-impact repairs. If scope grows, switch paths. The Issue is the single work entry: a successor must be able to find the effective goal, confirmed boundaries, current results and next action there.

## 2. GitHub Issues And Planning

Use [num-lab/Ruukoto Issues](https://github.com/num-lab/Ruukoto/issues). Fetch the user's URL or number directly, for example `gh issue view <number> --repo num-lab/Ruukoto --comments`. Features, behavior fixes, architecture changes and work needing tracking or handoff require an Issue before implementation. Use GitHub's native open/closed Issue states and draft/open/merged PR states; an open Issue can explain its current blocker or next action without custom status labels or a Project automation system. Do not maintain a repository-local mirror.

Keep the body useful to the next contributor: goal and confirmed non-goals, scope and dependencies, verifiable acceptance criteria, current plan/results, evidence locations and next responsibility. Include only applicable fields. Record new owner decisions in the Issue; link shared requirements rather than copying them. Agent-authored bodies use English. Raw logs, credentials, screenshots and session captures stay outside Git; publish only sanitized conclusions and accessible evidence references.

Planning records the confirmed goal, non-goals, key contracts and acceptance criteria, with the source of owner approval. Decision notes hold durable reasons and alternatives; the Issue holds steps, affected callers/tests/docs and verification methods. For exploratory research, track questions and dependencies in Issues; resolve them with a concise answer and evidence instead of maintaining a separate local map.

An independent plan review precedes full-path implementation. The reviewer reads the original request, current code and decisions, checks omitted callers and failure paths, and asks whether the proposed checks can prove the outcome. Proceed when confirmed scope is clear and no blocking finding remains. Do not request confirmation again for already approved choices.

## 3. Implement And Document

The implementer may change file choices and implementation steps within the approved goal. Changes to confirmed goals, non-goals, key contracts or acceptance criteria go back to the owner first. An unsound design returns to planning and affected review; lowering the acceptance bar is not a fix.

The implementer owns changes, regression tests, observable results and unverified items. Update human docs from actual code and evidence using [writing-docs-for-human](../writing-docs-for-human/SKILL.md); unclear facts go back to their source rather than becoming invented decisions. A separate documentation role is optional.

One writer owns a working copy. Parallel implementation uses isolated copies; integration gets checks appropriate to the actual combined change. Reviewers are read-only by default.

## 4. Independent Review And Rework

Independence means a separate execution context reading the requirements, rules, diff and evidence directly. It may use the same model; an author's self-check is not independent review. If no reviewer is available, keep the Issue awaiting review rather than inventing approval.

| Review | Required evidence |
| --- | --- |
| Plan | Original requirements, authorized choices, callers, failure paths and credible acceptance methods |
| Implementation | Actual behavior against each criterion, soundness of the plan, callers/tests/docs and scope |
| Verification | Exact checked content/environment, commands actually run, what a pass proves and missing real-environment evidence |

Reviewers run the smallest relevant checks for doubts and acceptance, reusing valid evidence rather than mechanically repeating the suite. For fixes, confirm that the regression check detects the original problem, using a counterexample or isolated removal of the fix when needed. State inability to run a check. A green suite does not prove a sound implementation or plan.

Record review object, conclusion, evidence and uncovered scope in the Issue/PR. A blocking finding names a violated requirement, reproducible counterexample or necessary evidence gap and the next responsible role; preferences remain optional. Implementation faults return to implementation, plan faults to planning, and factual prose errors to documentation. Resolve technical disputes with requirements, source or experiments; escalate only choices that need the owner.

When rework reveals a reusable process fault, update its owning instruction or check. Write a [postmortem](../../postmortem/README.md) only when its criteria apply.

## 5. Acceptance And Handoff

Engineering acceptance maps requirements to evidence and, for the full path, has no unresolved blocking implementation-review finding. Product acceptance covers only specified subjective experience and product choices; omit empty sections when none apply. Missing required real-environment verification remains a gap with a recovery condition, not an exemption.

Evidence is valid only for the reviewed content. Mark affected conclusions stale when requirements, code or documents materially change; recheck that scope, including behavior introduced by integration. Unrelated edits do not invalidate everything.

Keep the Issue open while implementation, review or required acceptance remains. Close it after acceptance, or with an explicit not-planned reason; reference the closing PR when applicable. Handoff states the outcome, evidence, remaining action and responsible role. Acceptance does not grant permission to commit, merge, deploy or publish.

Method: [development decision](../../notes/implemented/process/2026-10-12-agentic-development-workflow.md); tracker and language policy: [development standards](../../notes/implemented/process/2026-10-31-development-standards.md).
