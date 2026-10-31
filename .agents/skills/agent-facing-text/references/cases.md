# Historical Calibration: Repeated Calls During A Web Test

This case describes behavior at `c1f5041`, not current acceptance. Source session: `2026-10-14T06-22-58-602Z`; diagnosis originally lived at `.scratch/agent-browser/evidence/owner-session-diagnosis.md` and remains in the offline archive. Session contents are not reproduced here. Rule IDs refer to [the skill](../SKILL.md).

Keep this file out of blind reviews: reviewers use only the skill to see whether its rules independently reveal the defects. Generalize a newly demonstrated omission in the skill rather than growing this case list.

| Observed behavior | Interface defect | Rule |
| --- | --- | --- |
| `open file://...` returned `invalid_params` | HTTP(S)-only validation existed in code but not the `url` description | J1 |
| `nohup ... &` server died when the call returned; double-fork then kept bash pipes open until timeout | Bash description omitted cleanup and return conditions | J7 |
| `outcome_unknown` said to inspect the page, then `tabs list` returned `browser_not_ready` | Suggested next step was blocked in the current state | J2, J3 |
| `browser_not_ready` asked to verify the original execution and explicitly close | "Verify the original execution" had no corresponding model action | J2 |
| `resume` returned `browser_paused` | Text explained owner-message resume but omitted automatic pause after unknown outcome/unavailability | J3 |
| After `close` then `start`, the model issued another `open` | No-replay rule lacked a positive next step and scope after rebuilding a session | J4 |
| Model read manager source to infer recovery, spending about 12 calls | Consequence of the preceding recovery defects, not a separate finding | J2-J4 |
| Status/start/close returned about 1.4 KB of binding JSON | Results exposed pid, pgid, socket directory and CDP transport detail | J5 |
| Model reasoned about whether it was main or a development session | Description repeated eligibility already satisfied by tool assembly | J8 |
| Every bash result appended capture guidance, even for four bytes | Guidance was unconditional | J6 |

The [background lifecycle proposal](../../../notes/proposed/feature/2026-10-14-bash-background-lifecycle.md) addresses the historical return/cleanup behavior; the J7 classification remains useful after implementation. Unknown navigation outcome itself was not a defect: without structured upstream outcomes, the manager conservatively paused rather than replaying.

## Illustrative Corrections

These examples demonstrate the rules, not a current repair prescription. Verify actual behavior before using their wording.

- Describe `url` as an HTTP(S) page; serve local files through an appropriate local HTTP service when direct file navigation is unavailable.
- State when command children are reclaimed and how to run a service that must outlive the call, according to the actual lifecycle.
- In a blocked state, name the available action, such as close or report to the owner, rather than suggesting an unavailable inspection.
- Describe automatic pause triggers and who may resume, not only the manual-login use case.
- State the scope of no replay and how to verify or recover without resending an operation with unknown effects.
- Return status and needed entity identifiers instead of internal bindings; omit satisfied whole-tool eligibility conditions.
- Append complete-output retrieval instructions only after actual truncation.
