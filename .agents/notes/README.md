# Decision Notes

Agent Notes preserve reasons and rejected alternatives that code and human documentation cannot express well. This page explains the layout; [maintain-notes](../skills/maintain-notes/SKILL.md) owns the writing and review workflow.

## Layout

Each path is `{lifecycle}/{class}/yyyy-mm-dd-topic.md`. The date is when the decision was first proposed, not its most recent update.

| Lifecycle | Meaning |
| --- | --- |
| `proposed` | Proposal awaiting implementation |
| `implemented` | Delivered decision with facts maintained alongside code |
| `rejected` | Rejected proposal retained to prevent a plausible repeated mistake |
| `archived` | Sealed historical record; immutable and not authority for current behavior |

The six classes are `feature` (observable behavior), `bug-fix`, `simplification` (removing code or capability), `architecture` (module structure and vocabulary), `process` (tooling and workflow), and `testing`. Additional classes require a validator change. Create only directories that are used.

## Structure

The first three lines are fixed:

```markdown
# Agent Note: <title>

Status: <lifecycle>
```

Use these English sections, with optional detail between the decision and alternatives:

- Proposed: `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, `Risks`.
- Implemented: `Problem`, `Decision`, `Alternatives considered`, `Consequences`.
- Rejected: the original proposal structure; the `Status:` line contains the rejection reason.

Alternatives are real choices that were considered, not invented filler. The [format reference](../skills/maintain-notes/references/note-format.md) describes migrated ADR exceptions. [Implemented notes](implemented/AGENTS.md) describe current facts in present tense; a changed decision requires a new note and supersession links rather than reversal of the old rationale.

## Navigation And Ownership

Search by mechanism or browse the class/lifecycle tree. Source anchors use `Note: See .agents/notes/<path>`; module docs link to notes from their design references. There is no central index to duplicate path metadata.

GitHub Issues own goals, plans, progress and acceptance. `docs/` owns human-facing explanations of current operation. Notes own decisions and tradeoffs; `.agents/postmortem/` owns reusable failure mechanisms. Search existing active notes before adding a new one. Frozen archives retain their original language and bytes.
