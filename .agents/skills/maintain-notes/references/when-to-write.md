# Updating And Superseding Decisions

A note is maintained design rationale, not a one-time blog post or progress log. Update the owning note's facts whenever its implementation changes; create a new note only when the decision or its rationale changes.

| Situation | Action |
| --- | --- |
| Refactor, rename, move or default change with the same rationale | Update the owning note's facts in place |
| New design or technical choice | Write a proposal with motivation, real alternatives and acceptance before implementation |
| Adding any note | Search active notes and resolve unrelated, overlapping, absorbed and obsolete matches now |
| Implementation complete | Move to implemented with the code, preserving the original date |
| Partial supersession | Keep both notes active, cross-link and update still-valid facts |
| Rejected proposal | Keep in rejected only if its reason prevents a plausible future mistake |
| Full supersession | Absorb unique rationale, repair references, then delete or archive as appropriate |
| Mechanical formatting, tags or behavior-preserving patches | No note required |

## Fact Updates

Replace stale names, paths and defaults directly rather than appending a dated update. Implemented notes describe current facts in present tense. Necessary historical rationale and measured provenance stay explicit; they are not change-log noise.

## Completing A Proposal

In the delivered change, move the file to `implemented/<class>/`, retain its date, change status, and replace Proposal with Decision. Fold acceptance criteria and risks into Consequences or factual Verification and remove plans/open planning questions. Remaining required acceptance must be recorded honestly in the Issue; a note's lifecycle alone does not close it.

## Supersession

For a partial replacement, keep both notes and link them. For a full replacement, inventory unique safety and ownership guarantees, rejected alternatives, reintroduction conditions and verification gaps. Preserve them in the new note before deleting the old one. If the old record still has distinct historical value but no current authority, archive it using the script. Keep current constraints active and discoverable.

Repair inbound Markdown links and source anchors. `--superseded-by` validates the new note and adds a link from it to the sealed historical record; it never edits the archived body.

## Source Anchors

Decision-bearing entry points link from the repository root:

```typescript
// Note: See .agents/notes/implemented/architecture/2026-10-03-work-delegation-subagent-task.md
```

Use one line per note. A rename, deletion or archive move includes all referring anchors. `check-note-anchors` is advisory and does not run in CI.
