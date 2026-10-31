# Agent Note: Use task entry points and independent review for cross-context development

Status: implemented

[Development standards](2026-10-31-development-standards.md) replaces local Markdown task/status configuration with GitHub Issues/native state and clarifies concise communication. It preserves independent plan/implementation review and separate engineering/product acceptance.

[Issue plans and progress](2026-10-31-issue-plan-progress-separation.md) supersedes the current-body/history-comment split: the body holds the plan, while new comments record progress, evidence and handoffs.

## Problem

Rules, notes, tasks and mechanical checks did not explain how a new chat finds effective requirements, which plans may change, who handles review failures, or what evidence proves completion. Stale executable-looking tasks could mislead successors. Multiple documents alone do not make a reliable handoff.

## Decision

Use one work item as the current entry, referencing shared specs and durable rules and recording stage, next responsible role, decisions and acceptance evidence. High-impact work proceeds through planning, independent plan review, implementation/documentation and independent implementation review. Lightweight changes implement/verify directly; local restoration of a clear existing rule is lightweight when it avoids high-impact boundaries. Owners select models; roles define responsibility, not vendors.

Owners confirm goals, non-goals, key contracts and acceptance. Roles may change steps and solve technical rework within that scope. Independent reviewers may challenge the plan against requirements. Record engineering and product acceptance separately; conclusions apply to specific reviewed content and substantial later changes invalidate affected parts only.

The original process centralized workflow in a repository skill and task formats/states in docs/agents. Root instructions trigger it, architecture supplies navigation and development docs orient humans. Current content belongs in task bodies, history in comments. Revalidate old tasks at takeover; an implemented note is not task acceptance. The original ready-for-human status covered human implementation, experience and environment acceptance, with separate Wayfinder exploration states. Current tracking replaces those original file/status mechanics under the linked standards decision.

Historical owner confirmation, implementation and evidence remain in the offline development-workflow task. This decision used existing documentation budgets and added no dependency, product scheduler or special frozen gate.

## Related decisions

[Reader separation](2026-10-09-split-agent-and-human-docs.md) retains knowledge ownership; [structural gates](2026-10-10-docs-and-instructions-gates.md) retain mechanical feedback while review judges meaning/requirements; [scoped checks](2026-10-10-pre-push-evidence-ladder.md) retains targeted verification and gains the author-check/independent-acceptance distinction. Product task/approval state is not repository development workflow.

## References

DSH's [document conventions](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/AGENTS.md) separates facts, decisions and procedures. Magpie's [code standards](https://github.com/yetone/magpie/blob/main/docs/code-standards.md) and [lessons](https://github.com/yetone/magpie/blob/main/LESSONS.md) inform independent verification and rework. Adopt testable methods, not project self-description as proof of unattended quality.

## Alternatives considered

- Full role chains for every change are uniform but impose needless planning/handoff on simple edits; the owner chose two levels.
- Handing off entire chat history retains detail but is not shared across clients and mixes exploration with current decisions. Effective requirements need a durable shared work entry.
- More rules/structural checks with author-only acceptance are cheap but miss wrong plans, tests duplicating wrong implementations and semantic documentation drift. Retain checks and independent review.

## Verification

Original exercises checked links/format, takeover in a new context and adversarial review. Takeover found stale paths/invalid old acceptance and restored zero-value display through the light path. Review found a plan contradicting count limits despite green tests and returned it to planning. Exact scenarios/results remain in the offline workflow verification record, not proof of all future behavior.

## Consequences

Work records/review cost time; light paths and on-demand reading contain it. Prose cannot enforce execution authority or guarantee model compliance. New omissions should improve ownership/evidence requirements, not accumulate permanent bans for every historical mistake.
