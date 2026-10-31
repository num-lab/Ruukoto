# Agent Note: Give postmortems, prose, and error handling distinct maintained homes

Status: implemented

[Development standards](2026-10-31-development-standards.md) moves postmortems from docs/postmortem to `.agents/postmortem/`, makes maintained prose English-first, and replaces local task records with GitHub. This note retains the separation rationale, evidence-based standards, and newline-check decision; original audit counts are historical, not current inventory.

## Problem

Instruction/gate work left three gaps. Lock-owner misidentification and Node22 SQLite-placeholder incidents appeared as incidental development-baseline prose rather than searchable failure analysis; task plans/evidence did not explain escape mechanisms. Writing-docs-for-human covered human documents but not comments/JSDoc/notes/skills/prompts/diagnostics. Error conventions existed in code (over forty coded Error subclasses, instanceof/code discrimination, three message-parsing SQLite uniqueness fallbacks, no truly empty catches) but had no shared written standard.

## Decision

### Postmortems

Use [postmortems](../../../../.agents/postmortem/README.md) when all three hold: nonobvious mechanism, systemic gap, and costly rediscovery. Notes explain a choice; postmortems explain why something believed safe was not. A numbered NNNN-slug.md starts with an executive summary, then impact/timeline/root cause/why it escaped/safeguards. Cross-link design choices instead of forcing incident narratives into decision/alternatives structure.

The first incident reconstructed `looksLikeBackend` treating "ruukoto" in argv as process identity. A checkout without that name could steal a live lock. Tests always used a ruukoto-named checkout and never exercised the unsafe branch. Record only repository-supported facts and why the supposed safeguard missed them.

### Prose and failures

Prose-standard preserves every factual proposition before shortening: actor/action, condition/order/modality, negative guarantee/exception, ownership/failure/consequence. Give each explanation a home and tailor necessary content to JSDoc/internal/module/test/human-doc/note/skill/prompt/diagnostic use. Words such as contract/boundary/shape need precision, not a blanket ban. Remove code narration, author reasoning/review history, stale implementation labels, inflated emphasis, and mixed-rule walls.

Error-handling is based on this repository, not copied package rules: coded types, instanceof plus .code, deliberate literal unions versus broad strings, nonempty catches, retry ownership/budgets, actionable reports, and prefixed stderr. The original audit had zero `{ cause }` use, so a blanket inherited DSH rule would have described no actual practice. Later code legitimately preserves causes at specific boundaries; that historical observation is not a prohibition on Error.cause or an excuse to drop underlying failures.

FIXME means release-blocking, TODO near-term, XXX deferred. These were newly introduced semantics with zero uses at the time, initially placed in development documentation rather than presented as established root conventions. Current authoritative placement is root instructions/skills. Markers need a concrete action, not ceremonial labels; an unused convention should be reconsidered rather than preserved for its own sake.

### Staged newline guard

A minimal-repository experiment showed git diff --cached --check catches trailing whitespace/extra EOF blank lines but not a missing final newline. Add scripts/check-staged-eol.mjs alongside it in pre-commit to enforce exactly one final newline. The introduction also fixed two trailing-whitespace instances and four missing-newline files. Current pre-commit runs both then static checks; this note does not replace that command source.

## Alternatives considered

- Leave failures in development.md: no new directory, but operational instructions and escape narratives have different readers/structures. Keep failure analysis separate.
- Put postmortems in notes: reuses infrastructure, but decisions/alternatives do not naturally represent failure and missed safeguards. Cross-link instead.
- Copy upstream prose/error skills wholesale: convenient quality baseline, but vendor exclusions, bilingual pairing, package structure, and cause policy reflected another repo. Adapt to local facts.
- Put prose rules in root AGENTS: visible, but detailed judgment exceeds resident scope. Keep a pointer.
- Put all error policy in short root conventions: avoids a skill, but ownership/containment/guarantees need more than one or two lines.
- Use only git diff --check: one fewer script, but misses the measured no-newline case.
- Use an ESLint newline rule: reuses tooling, but would need another plugin and Markdown/JSON coverage for a problem served by a small script.
- Complete all JSDoc first: comprehensive, but 179/298 coverage meant a separate near-120-comment change rather than a prerequisite for these standards.

## Consequences

Failure analysis, prose judgment, and error handling have distinct homes and evidence-based rules. The first postmortem made a reproduced/fixed failure searchable, with four explicit reasons it escaped. Staged newline checking fills git diff's measured gap.

The first postmortem was reconstructed from commit `4d5379c`, test/101, and development notes, not written during the incident; unsupported timeline details were omitted. Skill judgments rely on triggers/semantic review, not a keyword gate. Potential mechanical failure-pattern checks were not added here. The staged script does not retroactively scan untouched historical files. Four report JSON newline fixes included two Linux probe outputs whose generators were not updated then; rerunning those generators could recreate the failure and pre-commit would catch it. This historical limitation is not a claim about every current generator.

Historical validation exercised positive/missing-newline cases (negative exits 1), independently confirmed git diff's blind spot, found zero remaining trailing-whitespace/missing-newline files in that scan, and passed check:static. Those counts/results describe the original change, not fresh repository-wide validation after migration.
