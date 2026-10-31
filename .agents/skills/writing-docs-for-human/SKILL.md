---
name: writing-docs-for-human
description: "Use when writing or reviewing human-facing docs such as architecture, modules, usage and development. Build a clear mental model with accurate, readable prose, useful tables and focused diagrams."
---

# Human Documentation

`docs/` helps users and developers understand the system and solve a problem. Explain what it does, why the mechanism matters, and how to use it. Accuracy, readability and visual hierarchy all matter. Decisions and rejected alternatives live in notes; documents link to them without copying discussion history.

## Choose The Home

| Document | Purpose | Detail to keep elsewhere |
| --- | --- | --- |
| `docs/architecture.md` | Module map, dependency direction and main end-to-end flows | Individual functions and exhaustive database fields |
| `docs/usage.md` | Prerequisites, operation, configuration and troubleshooting | Wire encodings and lock implementation |
| `docs/modules/<module>.md` | Responsibilities, interfaces, entities, state and invariants | Private helper walkthroughs and every error branch |
| `docs/development.md` | Setup, feedback loops, test navigation and timing | Duplicated deployment instructions |
| `.agents/notes/` | Design reasons, alternatives and tradeoffs | Work progress and user operation steps |
| `.agents/postmortem/` | Reusable systemic failure mechanisms | Routine review history |

## Explain The Mechanism

Begin with the normal path, then the important limits and failure guarantees. Describe concepts, collaboration and data flow rather than translating code line by line. Summarize key entities; the schema and types already own exhaustive field definitions. Place a guarantee once where readers need it instead of repeating defensive caveats in each paragraph.

Use tables for comparable interfaces, settings and states; use focused Mermaid diagrams for topology, sequences or transitions when they explain more clearly than prose. Headings, short paragraphs and lists provide hierarchy. Emphasis should help scanning, not decorate every sentence.

One paragraph per physical line does not mean one giant paragraph: separate ideas with blank lines, lists or table rows. `verify-md-wrap` checks physical wrapping, not readability.

## Module Structure

Keep the existing six-section module pattern, adapting detail to the module:

1. Responsibilities and boundaries: role and ownership, with links to neighboring modules.
2. External interfaces: callers and core entry points in a concise table.
3. Data and state: key entities, persistence and lifecycle; use a state diagram when useful.
4. Main flows: the normal sequence and important branches, preferably a focused diagram.
5. Invariants and failures: guarantees for timeout, cancellation, crash and recovery.
6. Design references: links to owning notes with a brief reason for each.

See [the template](templates/module.md) and [prose guidance](references/prose.md).

## Synchronize And Check

Observable module changes update the module document. Package/module changes update the architecture map. Entry points, configuration and troubleshooting changes update usage. Changed decisions update notes, with docs linking to them.

Check whether a quick scan establishes the module's mental model, whether code-level detail has crowded out the explanation, and whether the layout makes relationships visible. Verify facts against current code and run `npm run check:docs` for links, references, budgets and paragraph layout. The gates cannot prove semantic accuracy. English and optional `.zh.md` translations follow the root language policy.
