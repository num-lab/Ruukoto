---
name: maintain-notes
description: "Maintain Ruukoto decision notes for non-trivial behavior, architecture, contracts, process/tooling, tests and data formats, including alternatives and supersession. Skip purely mechanical changes."
---

# Maintain Decision Notes

`.agents/notes/` records durable reasons, rejected alternatives and consequences. GitHub Issues hold work plans, progress and acceptance; `docs/` explains current operation to humans; `.agents/postmortem/` records systemic failure mechanisms. This repository skill takes precedence over the generic `write-notes-like-deepseek` method.

## 1. Decide Whether A Note Is Needed

Skip notes for formatting, typos, unambiguous renames, behavior-preserving styling/dependency patches, version tags, routine CRUD and local fixes whose intent is evident in the diff. Record choices that future maintainers may need to revisit: behavior, architecture, cross-file contracts, workflows/tooling, test strategy and persisted/wire/config formats. Small size does not make a meaningful choice mechanical.

A note earns its place by establishing a shared rule, explaining a non-obvious compromise, or recording the limit and reintroduction condition of a simplification. Write it with the implementation, not as a later documentation task.

## 2. Find The Owning Decision

Before adding a note, inspect entry-point `Note: See .agents/notes/...` anchors, the relevant class directory, module-document design links, and keyword matches:

```sh
rg --hidden --glob '!.agents/notes/archived/**' '<mechanism-or-module>' .agents/notes/
```

Old ADR identifiers remain searchable in migrated notes. Classify each relevant match now: unrelated, partial overlap (cross-link), fully absorbed (remove or archive after preserving unique reasons), or obsolete proposal (reject or remove). Do not defer known matches to a future cleanup. Facts are researched locally; only unresolved goals or tradeoffs require the owner.

Update facts such as paths, names and defaults in the existing owning note. A reversed decision or rationale needs a new cross-linked note; do not rewrite the old Decision into its opposite. See [when-to-write](references/when-to-write.md).

## 3. Layout And Format

Use `.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`. The date is the first proposal date and survives lifecycle moves. Create directories only when used; do not add a central index duplicating path metadata.

| Lifecycle | Meaning |
| --- | --- |
| `proposed` | A proposal not yet delivered |
| `implemented` | Delivered decision; facts stay synchronized with code |
| `rejected` | Rejected proposal whose reason still prevents repeated mistakes |
| `archived` | Completed historical record, sealed and immutable |

Classes are `feature`, `bug-fix`, `simplification`, `architecture`, `process` and `testing`; adding a class requires updating validation. Refactoring is classified by its effect, not a separate class. See [classification](references/classification.md).

The first three lines are `# Agent Note: <title>`, a blank line, and `Status: <lifecycle>`. Rejected status adds ` — <reason>`. Use English sections:

- Proposed: `Problem`, `Proposal`, optional detail, `Alternatives considered`, `Acceptance criteria`, `Risks`.
- Implemented: `Problem`, `Decision` in present tense, optional detail, `Alternatives considered`, `Consequences`.
- Rejected: preserve the proposal structure and record rejection in `Status:`.

Use only genuinely considered alternatives, giving each its strongest argument before the rejection reason. Migrated pre-2026-10-10 ADRs with no recorded alternatives may use the existing grandfather marker; see [note-format](references/note-format.md) and `templates/`. Do not fabricate options to fill a quota.

## 4. Update, Supersede Or Archive

For proposed-to-implemented, move the file without changing its date, update status, replace Proposal with Decision, fold acceptance/risks into Consequences or factual Verification, and remove planning sections. Do this with the delivered change.

Partially superseded notes remain active and cross-linked. For full replacement, preserve unique rationale, alternatives, safety/ownership guarantees, reintroduction conditions and verification gaps in the new note before removing the old one. Repair inbound links and code anchors. Archive only records that still warrant historical retention; pointers belong in the new note. See [archiving](references/archiving.md). Already sealed archives are never edited, translated, moved or deleted.

Ask the owner only when an unconfirmed goal, non-goal, key contract or acceptance criterion needs a choice. Research facts first, present related choices together with a recommendation, and honor existing confirmation. More than five open decisions usually means the proposal needs splitting. Technical rework within approved scope follows [development-workflow](../development-workflow/SKILL.md).

## 5. Write And Verify

Keep one decision per note. Consequences include costs as well as benefits. Use relative Markdown links between notes and durable references to current code or GitHub Issues. Historical evidence stays in the offline archive; identify provenance without pretending a removed path is a live link. Decision-bearing code uses `Note: See .agents/notes/<path>`, one note per line.

Apply [prose-checklist](references/prose-checklist.md) and [quality-gate](references/quality-gate.md). These are semantic checks, not reasons to recite a checklist to the owner. English is authoritative; optional `.zh.md` translations follow the root language policy.

```sh
npm run verify-notes
npx tsx .agents/skills/maintain-notes/scripts/archive-agent-note.ts <note-path> [--superseded-by <new-note-path>]
npx tsx .agents/skills/maintain-notes/scripts/verify-archived-agent-notes.ts --write
npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts
```

`verify-notes` checks the tree, classes, file names, note links, headers, required sections and archive seals, and is part of `check:static`. Archive comparison uses `AGENT_NOTE_ARCHIVE_BASE_REF`, default `HEAD`; CI currently performs hash self-checks without a prior archive base. The archive command inserts `Archived:`, moves and seals the record, and reports inbound links. `--write` adds missing seals without changing existing ones. `check-note-anchors` is an advisory report with exit code zero; unresolved anchors still require attention.
