# Agent Note: Select verification by change impact instead of always running everything

Status: implemented

[Development standards](2026-10-31-development-standards.md) replaces repository-local work/evidence ownership with GitHub and offline historical provenance. The impact-based evidence ladder remains; no old scratch exemption bypasses checks for retained executable assets or required documentation.

## Problem

AGENTS, development.md, and README required static/targeted checks during work and full npm check at the end. The measured baseline built workers, linted/typechecked, and ran all application/foundation tests: 1024 cases, 167 seconds on macOS and 495 on Linux. Every small change paid mostly unrelated cost. Existing test maps listed typical files per module but did not say which evidence level a change required, producing both wasteful full runs and missed relevant regressions.

## Decision

Default to the smallest credible checks for the affected behavior. Full npm run check is reserved for explicit owner request, CI-failure diagnosis, or genuinely repository-wide changes. Every behavior change needs a narrow check that would fail for the regression. Do not rerun unchanged passing checks merely because a commit is next; related changes invalidate their evidence and require affected rechecks.

### Explicit change scope

`scripts/change-scope.ts`, invoked by `npm run change-scope -- --base <ref>`, returns versioned JSON containing committed/staged/unstaged/untracked paths and resolved base/head/merge-base commits. The caller verifies/provides the base; the script neither guesses nor fetches it. Ambiguous references, nonunique commit resolution, or no unique common ancestor fail with a reason. Parse NUL-delimited paths so spaces/non-ASCII names survive.

The pre-push-checks skill maps impact to commands, linking development.md's module-to-test map rather than duplicating it. Package/app behavior, callers across contracts, tests, notes/docs/instructions/skills, scripts, verification, deployment, and package configuration each need appropriate evidence. Source paths changed after workspace migration; follow current tables, not this note's historical src layout. Raw SQLite/SQL assertions of storage layout are intentional and must not be rewritten under a generic behavior-only-testing slogan.

Original local task/evidence-only edits did not change runtime and did not require runtime tests. Current GitHub work records are likewise not code, but moving/retaining executable fixtures, demos, or verification sources is a real change requiring their checks. Documentation and skill edits still need their structural/semantic checks.

Root instructions, README, and development guidance point to the same impact-based method. Full check remains documented for CI/explicit reruns. Pre-commit continues mechanical static checks plus the separately added diff/newline guards, not an automatic full suite.

## Alternatives considered

- Keep full checks and optimize runtime: simplest instruction, but case count/process startup dominates and leaves scope reasoning unsolved.
- Leave everything to CI and run only pre-commit locally: fastest local path, but delayed remote failures lengthen feedback and miss targeted local behavior proof.
- Automatically map changed files to tests: no human selection, but tests and source are many-to-many (early lifecycle tests span core/runtime). False precision can omit callers; choose by impact.
- Embed the command table in AGENTS: one visible place, but roughly twenty rows turn resident instructions into a manual. Use skill/development references.
- Infer origin/main as base: saves an argument, but stacked branches/actual PR bases vary. Explicit verification and rescoping after merging a base are safer.
- Emit only readable text: convenient initially, but versioned JSON is reusable by scripts/skills and detects format changes.

## Consequences

Typical feedback becomes targeted-file latency rather than the historical full-suite baseline; static checks remain the mechanical commit gate. The author now owns evidence selection. Too narrow a set can leak regressions to CI, mitigated by impact-based guidance and caller tests for cross-module changes. An incorrect base misstates scope; explicit resolution/ambiguity rejection and rescoping after integration reduce that risk.

Maps can drift with new modules even when linked instead of copied. This change added no semantic map-to-directory validator; reassess if drift becomes material. It changed instructions and added the scope script without deleting existing tests/checks or changing full-check/CI entry semantics. [Suite reduction](../testing/2026-10-24-test-suite-reduction.md) separately governs which tests remain valuable. [Development workflow](2026-10-12-agentic-development-workflow.md) owns author versus independent acceptance and evidence invalidation, not this script.

Historical validation ran change-scope against verified main and obtained all four path categories/three commit IDs; missing --base and nonexistent refs exited 1 with reasons. Static checks passed. The old timing figures are historical measurements, not current performance guarantees or permission to skip required external evidence.
