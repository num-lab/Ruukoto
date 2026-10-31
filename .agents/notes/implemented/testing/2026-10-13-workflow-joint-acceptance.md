# Agent Note: Prove workflow composition separately from real-service acceptance

Status: implemented

[Node24/CI budgets](2026-10-24-node24-ci-budget.md) supersedes the historical Node matrix/job limit. [Suite reduction](2026-10-24-test-suite-reduction.md) supersedes six-input scale, the old personal combined sample, and two-product real-model execution: current coverage retains Code's four-input composition and real-model acceptance. Platform safeguards, evidence distinctions, and historical findings below remain relevant.

## Problem

Passing narrow implementation checks does not prove the assembled two-product workflow, and model/network/IM substitutes are not real-service acceptance. Joint checks can reveal old fixtures or product regressions; preserve the first failure and exactly what later evidence covers.

## Decision

### Composition and external evidence

The original two six-input offline examples used real Runtime/Driver/SQLite/tool ledgers/independent contexts with one intentional failure. Personal used network/IM substitutes and checked eleven searches, six app-data queries, five independent verifications, and five actual rows. Code used real Git copies, frozen patches, five independent verifications, and post-integration byte checks. Final coverage retained the sixth failure and dependent skips: a returned script was not complete success. Current reduced scenarios are owned by the suite-reduction note.

Real-model checks require RUN_MODEL_CHECK=1 plus an explicit RUN_WORKFLOW_MODELS_FILE, selecting DeepSeek configuration into an isolated profile. Historical two-product checks verified model calls to named workflow tools, chat while waiting, business answers, real tools, and one final summary without real IM sending. Preserve failed profiles; remove successful profiles only after verified stopping. Ordinary application checks force real models off.

Record each platform/version cell's build assets, script processes, step permissions, and stop facts independently. Historical cells included macOS/Linux and Node 22.19/24.15, not current support policy. Missing install/native prerequisites remain gaps; failed signals/unknown identity remain unverified, never covered by another cell's success. Real IM and owner experience need independent acceptance.

### Calibrate fixtures, not product guarantees

Run native matrix files sequentially while hard-asserting three Agents actually execute concurrently inside samples. Do not create an artificial acceptance environment by running full-repo checks and native matrices together. Real multiworker fixtures wait 60 seconds for startup; the two-second product query budget, runtime limits, and assertions stay unchanged. The original Linux 15-second wait expired and an unchanged isolated run took 13.64 seconds. Query-result loss still reproduced in isolation and required a product race fix rather than another timeout increase.

The original six-input Code report wait became 180 seconds, distinct from its 60-second three-writer startup wait. Both full and isolated runs exceeded 90 seconds while still verifying/integrating. Diagnostic observation alone was extended: the sample completed at 110.375 seconds with unchanged byte checks, three shared slots, frozen verification, ledger, unique report, and stop assertions. Give that measured full path bounded margin, then verify default application concurrency. Do not change product query/script/workflow limits or retry failed tests. Keep initial failure, diagnostic differences, and formal results separately; an isolated diagnosis is not full-suite success.

### Platform process ownership

The application entry discovers all test/*.test.ts. On macOS, worker-stop, native-macos-helper, native-macos-identity, and session-background/recovery fixtures run exclusively before other files, waiting for process exit. The worker-stop orphaned Node descendants and helper's same-UID new-orphan detection can interfere; a controlled counterexample identified the same PID, while the original full-suite failed PID's source remained unproven. Isolate demonstrated fixture conflicts without weakening new-orphan refusal. [CI prerequisites](2026-10-22-ci-prerequisites.md) later capped the nonexclusive batch at two files, replacing original unrestricted file parallelism; within-test concurrency and failure propagation remain.

Missing fixed files, launch errors, unknown exits, signals, and nonzero status fail the entry. No retry/skip-batch success. Real models remain off. Release-model precondition failure before backend startup cleans temporary profiles because no execution began; actual execution failure/unknown stop/abnormal occupancy preserves them. Connectivity fixtures use a work subdirectory separate from control data, never the data root's ancestor as workspace.

The [workflow decision](../feature/2026-10-12-agent-workflows.md), [script isolation](../architecture/2026-10-13-workflow-script-isolation.md), [real steps](../architecture/2026-10-13-workflow-step-capabilities.md), and [final delivery](../feature/2026-10-13-workflow-owner-input-and-delivery.md) retain product/authority/effect semantics. This note owns combination fixtures/evidence levels only, not relaxed execution or acceptance requirements.

## Alternatives considered

- Rely on per-issue passes: cheaper, but cannot prove composed inputs, actual integrated bytes, or cross-product wiring. Add focused joint examples.
- Always run real model/IM with everything: closer to a whole product, but depends on credentials/platform/model output. Keep reproducible offline checks and explicit external acceptance.
- Limit all-file concurrency uniformly: simple but does not guarantee same-UID orphan fixtures are exclusive. Serializing every file avoids interference at excess latency; isolate proven conflicts and require the remaining batch to pass. Later two-file limits address separate prerequisite pressure.
- Keep the six-input 90-second report limit: faster hang detection, but measured valid completion took 110.375 seconds. Calibrate only that wait, not unrelated limits.
- Preserve profiles for every failure: useful generally, but prelaunch rejection only leaves temporary model material. Clean only when no backend started; retain executed failures.

## Consequences

Offline samples catch omissions, integration of failed output, and duplicate reporting. The historical 180-second report wait can detect a hang up to 90 seconds later. Real-model checks cost calls and model-output failures may safely pause a run. Platform cells and subjective experience still need their own evidence; implemented means the acceptance infrastructure exists, not every requirement passed.

Historical records formerly at `.scratch/agent-workflow/issues/07-acceptance.md` and `.scratch/subagent-roles/evidence/05-acceptance.md` are offline provenance. Their six-input/old-personal/Node22 evidence must not be presented as the current retained matrix or proof of real IM/owner experience.
