# Agent Note: Record established code conventions in root AGENTS.md

Status: implemented

[Development standards](2026-10-31-development-standards.md) updates language and task locations while preserving the evidence-based rule-selection principle here.

## Problem

Root AGENTS originally contained commands, navigation and four skill links, totaling 1,420 non-whitespace characters. Rules such as core dependency direction, coded errors, the three permitted type-escape boundaries and transactional state/events existed only as habits inferred from source. Repeated inference costs time and can invent rules. One proposed claim that execution was the only out-of-backend tool boundary was disproved by nine child_process-using files, including core instance-lock and the development launcher.

## Decision

Add six convention groups: module boundaries, errors, types, persistence, testing and language/form. Each concise rule says what to do and links its detail owner, including architecture, core, development and CONTEXT.

Admission requires evidence, not plausibility. At the original audit, core's 26 files had no outgoing references to other source areas; all 550 relative imports used `.ts`; there were no empty catches; console.log occurred only in the three TUI entry files; all filenames were kebab-case. These counts are historical observations, not permanent numerical requirements.

Rules with explicit exceptions state their boundaries. The original 406 `any` occurrences clustered in SQLite row mappings, wire parsing and SDK boundaries, including 29 rowToXxx signatures. Error classification used instanceof/code comparisons; three message parses handled SQLite unique-constraint fallback. The resulting rule names permitted escape boundaries instead of banning any everywhere.

Reject unsupported generalizations: TUI has type-only agent references; channels can invoke adapters; 42 test files deliberately inspect SQLite; not every error subclass had a code; not all exports had JSDoc; test numbers repeated; layering was not simply strict one-way. Do not convert these observations into invented prohibitions. Explicitly preserve deliberate raw-SQL layout assertions and disabled noUncheckedIndexedAccess rather than rewriting them toward generic preferences.

## Alternatives considered

- Continue inference with no documentation: zero maintenance, but proven capable of producing uncorrected false rules.
- Put conventions only in a design document: saves resident context, but requires agents to know to read the missing rule before changing code.
- Attach evidence counts to every root rule: auditable but turns resident instructions into an inventory report. Keep evidence in notes/historical work records.
- Admit only exception-free rules: safe but excludes the most useful bounded type/error rules.
- Publish every inventory conclusion including disproved ones: complete-looking but propagates false instructions.
- Add mechanical semantic consistency checks immediately: keyword scans cannot classify boundary semantics reliably; evaluate targeted checks separately when drift warrants them.

## Consequences

Conventions become pre-change guidance rather than repeated reverse inference. Disproved claims stay out of resident instructions. Root instructions grew historically from 1,420 to 2,456 non-whitespace characters/86 lines; [resident depth](2026-10-12-agents-md-resident-depth.md) later defines the must-know-before-change criterion and raises its then-budget.

Code/rules can still drift; structural changes must synchronize their owners. Counts are snapshots; boundaries are the commitment. Established practice does not imply an ideal recommendation: raw SQLite assertions and disabled unchecked-index access are explicit local choices.

## Verification

The original audit independently checked dependency edges, import extensions, catches, console locations, monotonic schema use, transactional calls, row mappings and code/error comparisons, and check:static passed. Those historical counts/version values are not assertions about the current tree. Historical counterexamples and commands remain in the offline conventions work item.
