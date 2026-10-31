---
name: prose-standard
description: "Use when writing or reviewing repository prose: comments, JSDoc, docs, notes, skills, prompts and diagnostics. Choose what readers need and put each explanation in its proper home."
---

# Prose Standard

Explain what something is and why it matters, then supply the detail needed for the reader's next action. Preserve the contract, not the author's reasoning transcript.

## Relevance, Evidence And Clarity

Apply Grice's maxims to both documents and conversation:

- **Quantity:** provide enough information for the current purpose. Put auditable verification in the Issue/PR; chat gives the outcome, reason and necessary next decision, not every template field.
- **Quality:** distinguish observed facts, assumptions and unverified claims. Keep evidence for claims of success, recovery, safety or improvement.
- **Relation:** report meaningful progress, blockers and requested decisions. Repeated status, irrelevant caveats and explanations of work nobody asked for add noise.
- **Manner:** use concrete subjects and actions, clear order and familiar terms. Explain concepts and mechanisms rather than translating code line by line.

State the normal path first. Put relevant safety limits and failure guarantees where they affect a decision, rather than surrounding every sentence with defensive exceptions. A real uncertainty remains explicit; reducing noise never means concealing it.

## Preserve Meaning, Remove Redundancy

Before compressing, identify the factual claims: actor/action, conditions and order, must/may/never, exceptions, ownership, effects and failure consequences. Keep the claims the reader relies on. Move implementation detail to its owning code or note rather than deleting a necessary guarantee or repeating it everywhere. Fewer characters alone is not an improvement.

Each explanation has one maintained home. Call sites may restate the contract callers need; deeper rationale, algorithms, history and long examples are linked. A shared helper's reason belongs with the helper, not every sibling method.

## Choose Content By Location

| Location | Content that earns its place |
| --- | --- |
| Public JSDoc | Non-obvious return distinctions, rejection, effects, ownership, ordering, cancellation and durability |
| Internal comments | Invariants, race ordering, security/ownership and surprising failure behavior that code does not explain |
| Module headers | Non-obvious role or dependency constraints, with links to design rationale |
| Tests | The regression or constraint motivating an unusual fixture/assertion, not a narration of the test |
| `docs/` | Current concepts and operation, using [writing-docs-for-human](../writing-docs-for-human/SKILL.md) |
| `.agents/notes/` | Decisions, reasons, real rejected alternatives and consequences, using [maintain-notes](../maintain-notes/SKILL.md) |
| Skills/instructions | Actionable target behavior and necessary hard guardrails; disclose conditional detail through references |
| Product model-visible text | Apply [agent-facing-text](../agent-facing-text/SKILL.md) to the model's actual input |
| Diagnostics | The affected operation, actionable failure and safe next step |

Prefer precise names such as response fields, JSON validation or ESM exports to vague uses of contract, boundary, shape, surface or seam. Keep those terms when they name an actual technical contract or process, wire, transaction or security boundary.

Remove code narration, review history, progress transcripts, decorative emphasis and stale implementation-status claims. Necessary sequencing and provenance are facts, not narration to delete. Use short paragraphs, lists and tables when they clarify distinct ideas.

## Language And Layout

English is authoritative for technical documents, instructions, comments/JSDoc and agent-authored Issue/PR bodies. Chat follows the human's language. Optional Chinese translations use sibling `name.zh.md`; update or remove the affected translation with any semantic source change. Frozen/sealed archives, third-party text, quotations and test samples keep their originals. Existing comments migrate when their code is touched; product UI and runtime prompts have their own language requirements.

Use [CONTEXT.md](../../../CONTEXT.md) terminology. Prefer an existing term before adding a concept. One paragraph occupies one physical line, with soft wrapping; `npm run verify-md-wrap` checks authored Markdown. End files with exactly one newline.
