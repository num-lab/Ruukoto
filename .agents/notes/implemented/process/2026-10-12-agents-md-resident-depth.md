# Agent Note: Increase root instruction budget for one-rule-per-item guidance

Status: implemented

[Development standards](2026-10-31-development-standards.md) supersedes the original language/layout budget where necessary. This note retains the resident-versus-linked criterion and rationale for changing a budget explicitly.

## Problem

The root budget was 2,800 non-whitespace characters with 2,735 used. [Structural gates](2026-10-10-docs-and-instructions-gates.md) protected resident context and allowed justified increases in the same change. The owner requested DSH's concise linked-rule style; the measured reference used 1,937 of 1,960 words. No rule yet explained what belongs in resident instructions versus linked knowledge.

[Established conventions](2026-10-10-agents-md-conventions.md) showed that resident rules improve discovery: a pre-change rule must be encountered before editing. They do not guarantee truth: a wrong resident rule repeats on every change, while linked documents have an explicit owner/synchronization obligation. The disproved child-process exclusivity claim illustrated this distinction.

## Decision

The original change raised AGENTS.md's manifest budget from 2,800 to 4,300 non-whitespace characters, rounding for about 5% headroom around the 4,112-character rewrite. Budget and rewrite changed together; a larger limit alone is not justification for more content.

Use rule density rather than prose density: start topics with an actionable conclusion and link details to docs, skills or notes. A document-destination table merges repeated guidance across development, conventions and skills. Make preexisting newline enforcement, CI prerequisite policy, monotonic schema/committed-record preservation, frozen notes and recorded model input explicit. The CI matrix mentioned in the original rewrite is historical and later changes independently.

The resident layer contains only rules needed before a change whose omission once would cause a mistake. Reasons, algorithms, history and long examples stay linked. When crowded, move misplaced material before compressing. The limit is a guardrail, not a reduction target; merge before appending. This original change did not otherwise alter development/module/task content.

## Alternatives considered

- Stay within 2,800: unchanged guardrail, but conflicts with the requested structure and leaves negligible room, forcing repeated unjustified increases.
- Move new conventions to docs/agents: smaller resident text but repeats the previously rejected discoverability problem.
- Raise beyond 5,000 preemptively: saves future updates but weakens the guardrail without a demonstrated need.
- Replace all rules with scripts: robust for mechanically defined behavior, but boundary/error semantics need more than keyword matching. Existing import/EOL checks remain; further gates require separate evaluation.

## Consequences

One-rule items are scannable, previously implicit obligations become explicit, and future increases have an ownership/justification rule. The historical rewrite grew resident cost from 2,735 to 4,112 characters per chat. Counts/budget values describe that decision, not current limits; current manifest and later standards govern. The change introduced no unverified convention, deriving rules from package scripts, pre-commit and development docs. Structural gates do not prove semantic code consistency. If merging cannot solve renewed crowding, revisit the rationale rather than merely increasing a number.

## Verification

The original `verify-doc-budgets -- --list` reported 4112/4300. Link/wrap/reference checks preserved targets/anchors, and check:static passed. The change was Markdown plus one manifest number; no runtime behavior was involved.
