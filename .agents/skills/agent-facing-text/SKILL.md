---
name: agent-facing-text
description: "Use when writing or reviewing product model-visible tool names, descriptions, schemas, results, errors, system/reference prompts and host-appended guidance."
---

# Model-Visible Text

Host-authored text is the model's operating interface: it determines what to call, how to interpret a result and what to do after failure. Evaluate whether the model can act correctly, not whether the text narrates the implementation.

Review the actual model input. Source definitions pass through assembly, filtering and truncation; request snapshots establish what was visible. Source establishes behavior, rejection conditions and results/errors not yet observed in a session.

## Audit

1. Capture a real request's full tool definitions and system prompt, not only the named tool. Read results/errors from the same session event stream; inspect source for untriggered cases. Host-generated text in other layers also counts. Identity, access mode and task kind select the interface, so capture each materially different assembly. Mark unavailable evidence as uncovered.
2. Walk the model's actions: parameters, rejected combinations, ordering and viable actions after failure. Follow typical multi-tool sequences; one tool's effects can invalidate another tool's suggested next step.
3. For each finding, identify snapshot field or producing source, rule and concrete wrong or unnecessary call. A finding is not established if it cannot produce such a call or if other text the model necessarily reads already supplies the missing instruction.
4. Capture the updated request after editing; a changed source constant is not proof that the model receives it.

## Rules

- **J1: Preconditions at the action.** Required inputs, ranges, mutual exclusions and sequencing belong in the parameter/action description, not only validation code.
- **J2: Executable next steps.** Results and errors suggest actions actually available in that state. If none exist, tell the model to stop and report to the owner. Avoid undefined internal terminology or work no tool can perform. Ending the turn and awaiting a host notification is a valid next step when stated explicitly.
- **J3: Explain blocking states.** Describe entry conditions, including automatic host transitions, available actions, exit conditions and who may trigger them. Include each use of a shared mechanism.
- **J4: Pair prohibitions with the correct action.** State scope, viable next step and the changed condition under which the restriction ends.
- **J5: Return decision-relevant facts.** Keep only the identifier needed to reference each entity. Omit internal process/transport plumbing unless the model must use it next or pass it to the owner. Facts promised by the description must actually appear in the result.
- **J6: Truncation guidance is conditional.** Append it only when content was really truncated; unconditional notices become noise.
- **J7: Explain invisible lifecycle effects.** State resource cleanup, return conditions and whether resources survive across calls when the model cannot infer them from results.
- **J8: Describe actionable constraints, not satisfied assembly conditions.** A visible tool already met its whole-tool eligibility rule. Keep action-specific preconditions under J1. If parameter rules differ by identity, expose the model's identity or assemble distinct descriptions so it can choose correctly.

## Measurements And Scope

When changing descriptions, schemas or system prompts, record before/after `toolSchemas` and `systemPrompt` token estimates in the Issue evidence. There is no token ceiling; saving text does not justify an extra wrong call.

TUI `/prompt` exposes complete request snapshots. `ruukoto-code selection-records --session <id>` exposes estimates under `systemPrompt` and `toolSchemas` for the applicable shared runtime.

This skill decides the content of product model-visible text; [prose-standard](../prose-standard/SKILL.md) governs expression. Developer instructions and skills use prose-standard and global `writing-for-agents`, not this product-interface audit. Historical calibration cases are in [references/cases.md](references/cases.md); keep them out of blind-review input.
