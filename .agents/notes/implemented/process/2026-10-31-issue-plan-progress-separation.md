# Agent Note: Separate Issue plans from progress updates

Status: implemented

## Problem

The development workflow placed current plans, results, evidence and next responsibility together in the Issue body. Routine progress updates therefore rewrote the same document as scope and acceptance changes, making it harder to distinguish a changed plan from new execution evidence.

## Decision

The owner requests this separation while creating [the CUA improvement Issue](https://github.com/num-lab/Ruukoto/issues/32): the body holds the current plan and changes only when the plan changes; progress updates are appended as new comments. The plan includes goals, scope, contracts, acceptance criteria, implementation steps and verification methods. Comments record completed work, results, evidence, blockers, reviews, acceptance and handoffs. A plan change also gets a comment explaining its reason and any required owner approval.

Takeover reads both the body and relevant comments. Native Issue/PR states remain unchanged; this adds no local tracker or body-level status mirror. Root instructions state the rule, and the development-workflow skill owns its application.

This partially supersedes the current-body/history-comment prescription in [development workflow](2026-10-12-agentic-development-workflow.md), not its independent review or owner-confirmation requirements. [Development standards](2026-10-31-development-standards.md) continues to govern GitHub-first tracking and knowledge placement.

## Alternatives considered

- Keeping a live progress summary in the body makes a single-screen handoff convenient, but mixes execution updates with changes to the agreed plan and requires repeated body edits. Read the plan and chronological comments instead.

## Consequences

Readers can distinguish plan revisions from progress without reconstructing routine body edits. Handoff requires reading relevant comments as well as the body; concise evidence-backed updates keep that history usable. This is an authoring rule, not a GitHub permission restriction or automatic enforcement mechanism.
