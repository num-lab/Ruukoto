# Agent Note: GitHub-First, English-First Development

Status: implemented

## Problem

Repository-local work records mixed current requirements with obsolete status, raw evidence and maintained fixtures. Agent instructions inside human documentation were hard to discover, and repeated defensive prose obscured the system's purpose. A historical Git cleanup reduced the object store but did not establish a durable current-tree organization.

## Decision

[Issue #1](https://github.com/num-lab/Ruukoto/issues/1) tracks the owner-approved migration. GitHub Issues own work goals, plans, progress and acceptance. Features, behavior fixes, architecture changes and continuing or handed-off work need an Issue; mechanical edits do not. Native Issue/PR states are sufficient. The repository holds durable knowledge and executable assets, not a second tracker or raw execution evidence.

`AGENTS.md` and existing skills own development instructions. `docs/` serves human readers. Decisions stay in `.agents/notes/`; postmortems live in `.agents/postmortem/`. Required test inputs and approved frozen baselines live under `test/`; maintained desktop previews live under `verification/`. Historical work and one-off evidence remain in the existing offline backup. Migration changes the current tree, not Git history, and does not publish code or rebuild the remote repository.

English is authoritative for maintained documentation, instructions, skills, notes, comments/JSDoc and agent-authored Issue/PR bodies. Active documents migrate together; code comments migrate when their code is touched. Optional Chinese translations use sibling `.zh.md` files and are updated or removed with semantic source changes. Sealed archives, frozen/third-party material, quotations and test samples preserve their original bytes. Chat follows the human's language; product UI and runtime prompts remain outside this language migration.

Communication follows Grice's maxims: enough relevant information, evidence-backed claims and clear expression. Chat explains the outcome and reason, expanding details for the actual question. Issues and PRs retain auditable acceptance and evidence. Independent plan/implementation review and required real-environment verification remain intact; empty fields and repeated disclaimers do not add assurance.

The globally installed `code-review` skill prefers the repository-declared tracker workflow, retaining its legacy path/setup fallback. Only those two entry assumptions change; plugin caches and product behavior are untouched.

## Validation And Retention

The pre-migration base is `155ba39f85ce25a3fcd230f6459d18ef2f910c7c`. A verified bundle and per-file frozen hashes preserve recovery in the owner's offline governance archive. Frozen assets are checked against the hashes captured before relocation, rather than regenerated to satisfy a comparison. Sealed note hashes remain unchanged.

Documentation gates include relocated postmortems. Retained demo projects keep their own check commands; the root checks exclude frozen/independently built sources rather than accidentally changing their compiler or lint contract. A regression test exercises ignored scratch files, the current directory layout, baseline bytes and negative postmortem-link/wrapping/source-reference cases. Native probe instructions select fresh external output directories; the historical launchd probe runs from an isolated copy because it has no output argument. Legacy probe defaults are unchanged, so bare invocations are not the documented rerun procedure.

English expresses the same technical content with more non-whitespace characters than Chinese. Resident-document ceilings are recalibrated to the reviewed English texts with modest headroom; the metric and failure behavior remain unchanged. Removing obsolete tracker entries is not a reason to remove the budgets of retained documents.

## Alternatives considered

- Keeping local Markdown tickets would preserve offline convenience, but duplicate GitHub state and preserve the ambiguity between live requirements and historical progress. The offline archive supplies provenance without a second writable tracker.
- Moving all scratch content under another directory would simplify migration but retain obsolete prototypes and one-off evidence. Retain only executable consumers, maintained previews and useful frozen baselines; triage backlog against current code.
- Mandatory equal-authority bilingual pairs would improve language parity but add a second normative source and require every change to carry translations. English authority with optional synchronized translations avoids that cost without banning Chinese readers' copies.
- Dropping review and verification requirements would shorten process text but remove actual assurance. Simplify communication and record ownership instead; evidence requirements remain.
- Rewriting history again would further remove historical scratch material but exceed the approved current-tree migration and complicate recovery. Preserve the already-cleaned history.

## Consequences

Current requirements have a single work entry and durable knowledge has a clear home. English conversion requires semantic review; link and language checks cannot prove equivalent meaning. Historical references in immutable files retain their old layout and are interpreted against the original snapshot, not as live links.

The owner controls publication and production acceptance. Local static/demo checks do not prove real model, IM, Keychain or native GUI behavior. Backlog triage retains valid missing acceptance rather than treating implemented code or old status labels as completion.

This decision supersedes the tracker placement, Chinese-authority and communication prescriptions in [agent conventions](2026-10-10-agents-md-conventions.md), [human/agent document separation](2026-10-09-split-agent-and-human-docs.md), [development workflow](2026-10-12-agentic-development-workflow.md), and [history/evidence retention](../../proposed/process/2026-10-30-git-history-evidence-retention.md) where they conflict. Their independent engineering and historical rationale remains applicable.
