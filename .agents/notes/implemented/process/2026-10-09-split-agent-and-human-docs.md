# Agent Note: Keep decisions in .agents/notes and human design documents in docs

Status: implemented

[Development standards](2026-10-31-development-standards.md) supersedes the original tracked local-task directory, Chinese-authority rule and docs/agents exception. [Retiring visual documents](../simplification/2026-10-12-remove-visual-docs.md) supersedes retaining unmaintained snapshots in place. The reader-oriented separation and original rationale remain.

## Problem

Four audiences/content types were mixed in docs. Twenty-five ADRs lacked alternatives, and core records accumulated supplements/revisions that readers had to reconcile. Rejected alternatives existed only in then-untracked task files. A 2,606-line operations document mixed manuals, mechanisms, numbered implementation history and verification lists; CONTEXT entries also embedded implementation detail.

Ten HTML visualizations had tests requiring updates for source/deploy changes and had failed Linux checks on untracked task links. Decisions, release acceptance and test comments also linked those untracked records. Agents reconstructed one decision from four places; humans extracted design from implementation chronology.

## Decision

The owner approved the original restructuring in two design interviews on 2026-10-09. Its implementation map and work items now remain in the offline `docs-restructure` record.

### Reader separation

- `.agents/notes/` replaces ADRs with Agent decision records maintained by the project maintain-notes skill.
- `docs/` holds human architecture, module design, usage, development and release acceptance. The original exception kept agent configuration in `docs/agents/` because the global code-review skill hardcoded its tracker path; AGENTS identified that exception.
- The original decision moved tasks/evidence into tracked `.scratch/`, including logs previously excluded by `*.log`, while excluding it from deployment rsync, Docker context and ESLint. The new development-standards decision replaces this policy.

### Project note skill

Adapt global write-notes-like-deepseek and vendor only Node-standard-library verification, archive and anchor scripts. The original six customizations were Chinese bodies/headings; migration-day format adoption with grandfather comments rather than invented alternatives; allowed local-task links; plans in tasks and reasons in notes, updated together for nontrivial decisions; verify-notes in check:static/CI; and a project override while retaining the global skill for other repositories.

### ADR migration

Each ADR became an implemented note with revisions reconciled into present-tense decisions. Independent supplements became linked notes; factual renames/ownership updates merged into current prose; fully superseded records were removed/archived under the archive rules. Recover actual alternatives from original specs/tasks, not invention. Retain original ADR-number aliases for historical lookup. Roughly forty source/test/verification/deploy anchors changed to note paths; byte-frozen verification archives stayed untouched. Delete the old ADR directory and make the domain entry use notes only.

### Human documentation

Remove the split operations document after assigning mechanisms to modules, rationale/history to notes, commands/configuration to usage, and acceptance to release/development documents. README retains introduction/quick start rather than duplicate TUI/command/data manuals. Initial modules were runtime, core/schema/layout, agent-context, agent-tools, execution/worker, control, TUI/configuration, channels, scheduler/outbox and deploy.

The initial six-section module shape covered responsibility, interfaces, data/state, flows, invariants/failure and design references. Describe current behavior without numbered-history headings; reasons/alternatives belong in notes and design references point there. Mermaid illustrates state/sequence, not decorative snapshots. A writing-docs-for-human skill owns templates/prose and behavior-change/new-module synchronization triggers. CONTEXT becomes definitions plus Avoid terms, with implementation detail moved out.

### Visual-document pause

The original decision deleted visual coverage tests, skill and resident/development instructions. HTML pages initially remained with a dated unmaintained-snapshot banner and unrepaired ADR links. The later retirement decision removes those pages.

## Alternatives considered

- Freeze ADRs and write only new notes: cheap migration, but permanently splits decision search and leaves Agent material under docs.
- Move all ADRs unchanged into archived: fast, but freezes still-current core decisions.
- Vendor upstream skill unchanged: easy updates, but misses required language/adoption/link/task distinctions. Project customization costs manual upstream merges.
- Rely solely on global installation: no repository work, but other agents/CI cannot obtain it.
- Forbid local-task links: notes become self-contained, but the original owner-approved tracked-task policy made them available and avoided copying task content. The later standards decision revisits this premise.
- Organize docs by visualization mechanisms: potentially easier conceptual reading, but one change affects several documents with unclear ownership. Use module ownership.
- Keep the operations manual during gradual absorption: less immediate work, but two current factual sources.
- Delete visual pages immediately: cleanest search results, but the original request was pause, not retirement. This was later changed explicitly.
- Keep unrun visual tests outside npm test: reusable if maintenance resumes, but unrun tests rot.
- Move docs/agents or inline it in AGENTS: cleaner audiences, but the then-hardcoded global skill and resident size argued against it; the newer standards decision resolves both.
- Keep old code anchors with aliases only: smaller, but leaves two reference forms permanently. Dropping aliases instead makes historical numbered records unsearchable.
- Put the full manual in README: one entry but over 900 lines. Put it in module docs: colocated design/configuration, but users must know module ownership before configuring a feature.
- Add content-linked visualization-style tests: too much maintenance. [Structural documentation checks](2026-10-10-docs-and-instructions-gates.md) subsequently adopts text-only links, references, budgets and wrapping without source-content coverage tests.
- Only repair CONTEXT links: small, but retains duplicate implementation facts.

## Consequences

[Development workflow](2026-10-12-agentic-development-workflow.md) later adds role handoff, current-body/history-comment separation and independent acceptance. The original migration covered ADR 0001-0025, with independent splits and retained original-number/source aliases; 0014 was replaced by retirement. One decision source and module-based human reading replace four-way reconstruction. Current task/language locations follow the newer standards note, not the superseded original layout.

Reconciliation can lose details or turn history into current claims. Historical task maps recorded destinations and pre-deletion commits; source remains recoverable from Git/offline backups. Splitting 2,606 lines required assigning every section. Structural checks now catch links/references/budgets/wrapping, not semantic drift, which still requires skill triggers and review. The original tracked-task policy also exposed server details to Git history; private-repository status never removed credential review obligations.

Frozen visualization links and old-number references in concurrent commits were historical migration concerns; aliases supported lookup. Documentation guards must move with their documents: test/65's command-table guard moved from README to usage, rather than silently inspecting the old location. Search-gate patterns themselves belong in operational records because embedding them in notes makes them self-match.
