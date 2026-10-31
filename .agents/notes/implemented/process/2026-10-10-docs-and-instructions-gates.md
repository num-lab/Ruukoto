# Agent Note: Check documentation structure without coupling it to implementation

Status: implemented

[Development standards](2026-10-31-development-standards.md) supersedes local-tracker/Chinese-authority organization and recalibrates English resident budgets. Gate semantics remain; current scans include relocated `.agents/postmortem/` and the maintained frozen-baseline README. Historical counts/timings below describe this decision's introduction.

## Problem

Documentation synchronization relied only on writing-docs-for-human triggers. [Human/agent separation](2026-10-09-split-agent-and-human-docs.md) had rejected link tests because old test/67 tied ten visual HTML pages to source/deployment details and failed isolated checkouts on untracked references. That burden was real, but did not justify leaving purely structural failures unchecked.

The audit found seven old scratch links to deleted docs/runtime.md and a compaction note linking agent-context.md to a heading that never existed. Notes readers had no directory guide unless they opened skill references. Resident instructions also had no size guard, despite consuming context on every task.

## Decision

`npm run check:docs` runs four text-structure checks inside check:static:

- verify-md-links checks relative links/images/reference definitions for existing targets and Markdown fragments for heading slugs/explicit anchor IDs. External/root-absolute URLs and template example paths are excluded.
- verify-doc-refs extracts Markdown documentation-path tokens from source files and checks existence, not source semantics. It is a textual scan, not a requirement to compile examples or prove the referenced explanation correct.
- verify-doc-budgets compares manifest-listed resident documents against nonwhitespace-character ceilings.
- verify-md-wrap requires one physical line per prose paragraph.

These checks do not encode how runtime code ought to work. A source edit only fails them when it changes a checked path/reference or structural fact, unlike the removed visual-doc assertions. Documentation correctness still needs semantic review.

`scripts/markdown-scan.ts` shares mdast-util-from-markdown/mdast-util-gfm parsing, traversal, heading slug/anchor caching, multiline-paragraph detection, and glob collection. Scan scope covers root docs, docs, active notes, skills, deployment Markdown, verification READMEs, and governance-added postmortem/baseline entrances; exclude sealed note archives/node_modules. Current verify-doc-refs walks packages/apps/scripts and recognizes docs plus notes/postmortem Markdown paths. Source-layout names and scan additions should follow the actual scripts, not the original single-package src/bin description.

Heading slugs lowercase, remove characters outside letters/numbers/underscore/space/hyphen, then replace spaces. At introduction, comparison against github-slugger covered all 576 headings, including Chinese, with zero differences. This supported using the small existing algorithm without another dependency; it is not proof against future GitHub changes.

### Character budgets and one-time wrapping

Use nonwhitespace characters, not wc -w. The original Chinese architecture document had 316 words but 3957 nonwhitespace characters; CONTEXT had 422 versus 9160. Word counts barely tracked prose growth. Keep ceilings in scripts/doc-budgets.manifest.json for resident/structural documents, not every growing reference manual. English migration retains the metric and adjusts justified ceilings; historical eight-document membership is not fixed forever.

The initial wrapper found 214 violations in 15 files, including channels 75, CONTEXT 56, development 20, and release acceptance 19. An mdast-range script merged 212 in 13 files, skipped hard-break nodes, reparsed, and asserted each paragraph's nonwhitespace sequence unchanged. Two blockquotes needed manual merging because automated replacement would consume their `>` markers. Preserve those safeguards, not a promise that all prose rewrites are whitespace-only.

Notes gained a reader README for layout/closed categories/format/search/ownership, a directory AGENTS for one decision per note/prewrite audit/frozen archives/status alignment, and an implemented AGENTS for fact synchronization versus changed decisions. Current placement follows the governance migration rather than preserving obsolete instruction duplicates.

## Alternatives considered

- Keep skill-only checks: zero tooling, but broken targets/never-valid anchors already escaped repeatedly. Mechanical structure is worth checking.
- Copy DSH doc-typecheck: compiles fenced TypeScript, but its workspace paths/project references did not fit the then-single-package repo; transplant cost outweighed value.
- Require JSDoc on every export: useful coverage discipline, but the audit found 179/298 documented functions (60%); nearly 120 additions needed a separate evaluation, not an abrupt gate.
- Use wc -w for upstream consistency: misleading for Chinese (CONTEXT differed by about 22 times). Retain character measurement even after English migration.
- Add github-slugger: less handwritten logic/algorithm risk, but the tiny implementation matched every observed heading. Revisit actual divergence rather than add a zero-difference dependency.
- Skip wrapping: avoids 214 edits, but one-paragraph/one-line was already the repo convention and otherwise drifts.
- Rewrite all violations blindly: fast, but hard breaks/blockquotes can be damaged; actual refusal of two blockquotes validated the guarded approach.
- Set ceilings barely above current size: immediate growth pressure, but ceilings are guards, not reduction targets. Originally allow roughly 9-10% headroom; [resident-depth revision](2026-10-12-agents-md-resident-depth.md) later raised AGENTS from 2800 to 4300 with about 5% rounded headroom and a simultaneous rewrite.
- Check code/document semantic agreement mechanically: broader apparent coverage, but degrades into expensive keyword false positives. Keep human-doc triggers and independent semantic review.

## Consequences

Historical check:docs took 1.25 seconds, raising static checks from roughly 8 to 9.3 seconds, while catching broken targets/anchors and bounding resident prose. The initial whitespace-only migration preserved content, tables, code blocks, and AST except separately identified preexisting edits. Current semantic English rewrites need their own review and must not borrow that whitespace proof.

Unbudgeted usage/release/module references may still grow; forcing them into resident ceilings would compress content that needs space. Gates do not detect obsolete behavior or missing explanations. Slug drift may create anchor false positives. Source-reference checking only recognizes its specific Markdown path forms, not arbitrary relative/extensionless references. Added development dependencies were mdast-util-from-markdown, mdast-util-gfm, micromark-extension-gfm, and @types/mdast.

Historical positive/negative tests showed bad target/anchor/source reference and excess budget exiting 1, while budget --list exited 0. The gates caught an as-yet-uncreated notes README and another bad anchor during development. Slug comparison was 576/576; channels retained 12 code blocks, 61 table rows, and 25 headings. Nonwhitespace content was unchanged; AST differed only in three files with unrelated edits. check:static and verify-notes passed then. [Independent workflow review](2026-10-12-agentic-development-workflow.md) remains necessary: passing structural gates never proves task completion.
