# Development Timing Records

Historical timings help choose feedback paths; they do not prove the current checkout passes. Original revision identifiers below describe the measured snapshots and may belong to pre-cleanup history. The [workspace-package note](../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md) records the later package layout.

## 2026-10-09 Baseline

The initial batch used `36c55dbe06d8e55e3ec52687c39dfab0d5762181`. Linux was an independent tx checkout without local scratch material.

| Environment | Command at that time | Result | Wall time |
| --- | --- | --- | --- |
| macOS / Node24.15.0 | Old `npm test` (application) | 1009 pass, 1 skip, 0 fail | 167.32 s |
| macOS / Node24.15.0 | Foundation test | 9 pass, 1 skip, 0 fail | 2.08 s |
| Linux / Node24.21.0 | Old `npm test` (application) | 1007 pass, 1 skip, 2 fail | 495.22 s |
| Linux / Node24.21.0 | Foundation test | 9 pass, 1 skip, 0 fail | 7.06 s |

Both Linux failures were `67-visual-docs`: source anchors/links referenced untracked local files unavailable in the independent checkout. That batch tracked necessary scripts/archives and pointed diagrams at available sources.

Final isolated-checkout measurements with locked dependencies were:

| Environment | Setup | Static | Full check |
| --- | --- | --- | --- |
| macOS / Node22.19.0 | 7.50 s | 9.10 s | 192.71 s |
| macOS / Node24.15.0 | Reused same install | 7.81 s | 198.46 s |
| Linux / Node24.15.0 | 22.31 s | 34.01 s | 529.63 s |

All three full checks had application 1024 pass/1 skip and foundation 9 pass/1 skip, no failures; real-model checks were explicitly disabled. macOS used temporary snapshot `95ace397`; Linux used `f8c61b9`, followed only by a collaboration-test readiness condition rechecked with Linux static/targeted tests. Application source, checks and dependencies did not change afterward. The then-new four-cell CI matrix had not run remotely; local evidence did not replace it.

Docker smoke 04/13/15/18 passed 27/27 with mock models/platforms, and its image/container resources were removed. Linux Node24.15 upgrade from `60fa19e` passed 4/4 in 65.40 s; temporary installs, backends, profiles and compilation cache were removed. Real models, real IM and sudo/systemd acceptance were not run in this batch.

Two compatibility fixes emerged: process-start identity replaced lock command-line matching ([postmortem 0001](../.agents/postmortem/0001-instance-lock-identity-by-command-line.md)), and Node22 SQLite interpreted numbered `?1` parameters as named bindings, requiring named binding in two ledger queries. The then-current Node22 matrix covered that support range; current supported versions are defined in [development](development.md).

Other failures were fixtures: wait for `reviewStatus=asked_owner`, actual model-request readiness and release callbacks; select grants by ID rather than tie-sensitive ordering; shorten temporary HOME/socket prefixes; clean up failed-start listeners and report early exit. Controlled-order reproductions justified these changes without permanent fixed sleeps or retries. One Linux install hit ENOSPC from this batch's duplicate dependencies; removing only reinstallable batch dependencies allowed setup. Diagnostic/aborted runs are excluded from the table.

Formatting, isolated privileged verification and evidence-led structural changes were separate future batches, preserving commands, formats and permissions. A historical audit reported four existing dependency advisories (one moderate, three high); it did not justify an unreviewed Pi major upgrade. Current backlog is tracked through the repository's [workflow](../.agents/skills/development-workflow/SKILL.md), not this timing page.

## 2026-10-22 CI Repair

Based on `94bc0932` plus the prerequisite repair, macOS/Node24.15.0 full check exited 0 in 1911.804 s: application 3320 pass/24 skip, foundation 9 pass/1 skip, no failure/cancellation. Exclusive fixtures were serial, other files at most two concurrent. This replaced the old roughly 200-second daily estimate, but did not measure clean install or GitHub runner speed.

Linux/Node24.21.0 targeted script/workflow verification passed 69/69 across five files in 276.4 s using isolated source and matching cached dependencies, not a clean setup. The then-current macOS/Linux × Node22.19/24.15 matrix had not rerun; its job limit changed from 30 to 45 minutes. Those were historical settings, not today's CI contract.

## 2026-10-24 Test Reduction

Starting from `28c033f7`, necessity review covered 294 application and seven foundation files; the candidate retained 290 and six. Measurements retained file concurrency two and macOS exclusivity. Setup reused an install or was not independently timed. The [decision](../.agents/notes/implemented/testing/2026-10-24-test-suite-reduction.md) records rationale; original logs and source fingerprints remain historical evidence.

| Environment / snapshot | Full command | Wall time | Result |
| --- | --- | --- | --- |
| macOS arm64 / Node24.15, original | `npm run check` | 1510.395 s | Exit1; application 3460 pass, 4 fail, 24 skip; foundation not reached |
| macOS arm64 / Node24.15, `8025120` | `npm run check` | 1125.163 s | Exit0; application 3387 pass/22 skip, foundation 7 pass/1 skip; no failures/cancellations |
| oracle-4c24g Linux arm64 / Node24.15, frozen `97d1794` | `npm run check` | 2459.331 s | Exit0; application 3375 pass/31 skip, foundation 7 pass/1 skip; no failure/cancellation/residue |

macOS was 18m45s with the same source fingerprint before/after. Application wall time was 1075.592 s (exclusive39.506, ordinary1035.846); foundation Node summary2.480 s. Since the original failed before foundation, this is not a strict green-to-green speedup ratio.

Linux application took2248.675 s, foundation6.613 s, full40m59s: below45 minutes but above the30-minute goal. This predates Personal token publication, PTY synchronization, mock response-connection closure, cleanup diagnostics and macOS startup-marker fixes. Token-publication increments later passed38/38 entry/CLI cases on Node22.19/24.15 in100.924/71.153 s. One diagnostic run needed manual failed-fixture cleanup and had different observation overhead; it is not a comparable acceleration denominator.

| Slow retained Linux file | Complete-process seconds, including setup/cleanup |
| --- | --- |
| personal-tools | 223.340–223.575 |
| 84-subagent-integrate | 209.514–209.958 |
| personal-command-work | 205.984–206.217 |
| 112-workflow-real-steps | 196.466–196.689 |
| 83-subagent-worktrees | 184.952–185.171 |
| workflow-role-integration | 171.578–171.799 |
| workspace-snapshot-runtime-boundaries | 115.472–115.697 |

Intervals come from approximately200ms external sampling. These files retain unique review-result, real-stop/corrupt-recovery, permission/commit-conflict, execution and cold-snapshot coverage and cannot simply be removed for being slow. Sampling captured289 application processes; history-recovery appeared in argv and five unique pass lines but escaped sampling, so this is not exact timing for all290 files. The then-current four-cell GitHub matrix still required a run of the same candidate; local/isolated Linux results did not replace it.
