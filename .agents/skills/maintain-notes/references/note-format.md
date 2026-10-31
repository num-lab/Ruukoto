# Note Format

## Header

```markdown
# Agent Note: <title>

Status: <lifecycle>
```

Use `proposed`, `implemented`, or `rejected — <reason>`, matching the containing lifecycle directory. Status carries no date or parenthetical; the file name contains the original proposal date. A migrated ADR may retain `Original reference: ADR NNNN` after the header, including the named source subsection when split from a larger ADR. New notes do not need a legacy identifier.

## Sections

Proposed records begin with `## Problem`, followed by `## Proposal`, optional detail, `## Alternatives considered`, `## Acceptance criteria`, and `## Risks`. Motivation stands independently of the proposed solution; acceptance names observable completion, and risks include known tradeoffs.

Implemented records begin with `## Problem`, followed by `## Decision`, optional detail, `## Alternatives considered`, and `## Consequences`. Use present tense. The validator rejects proposal-era H2s (`Proposal`, `Plan`, `Migration plan`, `Acceptance criteria` and legacy Chinese forms). Factual `Testing` or `Verification` sections are allowed; present-tense accuracy is a review responsibility.

Rejected records preserve the proposal structure, with the conclusion in `Status:`. Do not rewrite the old proposal into its opposite.

## Alternatives

`## Alternatives considered` is required. Record only choices actually weighed, one paragraph or named subsection per alternative, explaining its strongest argument before rejection. Doing nothing or reusing the existing approach counts only if it was genuinely considered.

A migrated ADR dated before 2026-10-10 whose alternatives cannot be recovered from the historical record may use this marker instead of the section; the marker and section cannot coexist:

```markdown
<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
```

The validator accepts some legacy translated headings for compatibility, but maintained English-authoritative notes use the exact English forms above. Templates live in `../templates/`. Optional `.zh.md` translations follow the root language policy and the same semantic structure.

## References

Keep mechanism names and meaningful must/may/never ordering constraints searchable. Explain a fact once and link to it elsewhere. Use relative Markdown links between notes, not bare numerical references. A superseding decision gets a new note and explicit links; in-place updates repair facts without reversing the decision.

Format lineage: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
