# Agent Note: Standards for model-visible interface text

Status: implemented

[Development standards](2026-10-31-development-standards.md) changes documentation language/task locations, not this separation of content coverage from wording or the product-runtime scope.

## Problem

Tool names/descriptions, schemas, results/errors, system prompts and host-appended hints are the model's interface documentation, but no standard covered their decision-making needs. [Prose standards](2026-10-10-postmortem-and-prose-standards.md) addressed readability for humans/developer agents; model-visible text must explain what to call, how to interpret failure and what action is possible next.

A 2026-10-14 local webpage session repeatedly misused browser/bash tools. Diagnosis found missing parameter prerequisites, errors recommending actions impossible in the current state, and unstated background cleanup timing. These were interface defects, not solely model mistakes, but review lacked a checklist. Historical diagnosis remains in the offline owner-session browser record.

## Decision

Create `.agents/skills/agent-facing-text/` for what model-visible text must cover; prose-standard governs wording. SKILL.md contains triggers, audit steps, general rules J1-J8 and measurement requirements. Audit text the model actually receives in prompt snapshots, not merely source constants. Keep incident-specific browser/bash examples out of the general rules.

`references/cases.md` records symptoms, text defects and rule IDs without copying entire sessions. Changes to descriptions, schemas or system prompts record before/after toolSchemas/systemPrompt token estimates in work evidence: numbers, not a cap. Saving tokens must not require another erroneous call. Root's destination table and prose-standard link the skill. No keyword gate substitutes for semantic judgment.

### Keep rules separate from answers

A blind reviewer reads only SKILL.md and test material. Independently finding known defects tests whether the general rules work, rather than whether examples reveal answers. Cases stay in their reference file. Missed blind-review defects improve general rules, not an ever-growing answer table.

## Alternatives considered

- Merge into prose-standard: fewer skills, but combines prerequisite/state/action/lifecycle coverage with proposition-preserving wording and bloats the latter.
- Copy DSH agent-experience: established material, but bound to another tool vocabulary/incidents. Derive local rules from evidence, as with local prose/error skills.
- Cover definitions only: smaller, but misses equally common error/result/host-hint defects.
- Keyword bans catch spelling but not whether an action is possible/influential in the current state, and encourage literal workarounds.

## Consequences

Review gains a concrete audit checklist and token tradeoff records, potentially catching interface defects before live sessions. There is no automatic semantic gate; effectiveness depends on triggers/review. Initial evidence came from one session, limiting coverage. The original blind/generalization review reports remain in the offline agent-facing-text task; implemented means the files exist, not that every acceptance item passed. That original change recorded rather than repaired browser/bash defects, requiring separate work under the standard.

## Verification

The original case-leakage scan checked incident-specific strings were absent from SKILL.md; exact commands/output remain in offline evidence. check:static covers links, budgets, wrapping and note format, not semantic effectiveness or runtime correctness.
