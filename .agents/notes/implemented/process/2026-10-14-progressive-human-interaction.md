# Agent Note: Use progressive interaction for human operations

Status: implemented

The related [Desktop settings proposal](../../proposed/feature/2026-10-21-desktop-settings-management.md) makes products, workspaces, configuration, and stop/save/start selectable while the program manages IDs, revisions, and request correlation.

## Problem

Workflow queries and controls exposed run IDs, versions, request keys, and JSON command templates directly to the owner. Operations worked, but required remembering command syntax and copying internal identifiers. On 2026-10-14 the owner approved a global UI/UX principle, initially applied to workflows.

## Decision

Design human entry points as selecting an object, inspecting state, choosing an action, and entering business content. The program obtains and manages internal IDs, versions, hashes, and request keys; people need not memorize or copy them. Each step provides a way back, current state, the result, and a viable next action. Pair icons/color with text rather than relying on color alone.

Root AGENTS.md applies this rule to new and modified interaction. Existing entry points are migrated through tracked work, not declared universally compliant. The original workflow-TUI and IM work was tracked in `.scratch/agent-workflow/issues/08-workflow-sidebar.md` and `12-im-progressive-controls.md`, now retained offline. Machine CLI, API, and model tools may carry identifiers; their raw parameters are not human operation tutorials.

Simpler interaction preserves identity, version, and idempotency checks. Readable choices explain unknown replies, stale state, and recovery. The program retains the original request needed for verification; it must not automatically replay an unknown effect merely to remove a step.

[Workflow definitions/entry](../feature/2026-10-13-workflow-library-and-controls.md) and [progressive controls](../feature/2026-10-14-workflow-progressive-controls.md) own product replacement. [Root conventions](2026-10-10-agents-md-conventions.md) owns placement of standing instructions. This principle does not supersede data, permissions, delegation, or scheduling mechanisms.

## Alternatives considered

Aliases or shorter IDs are inexpensive and faster for experts but still require understanding the command protocol. Migrating every entry point at once makes policy uniform but exceeds the owner's workflow-first scope. Keeping the principle only in chat/issues avoids a standing document but hides a global requirement from future designers. Root instructions therefore retain one rule and this link; feature issues hold implementations.

## Consequences

Design/review gains an actionable principle and the program owns protocol complexity. Interaction clients must retain selection, version, and pending-request state; recovery/deduplication cannot depend on user input history. Implemented status means the principle is effective, not that every sidebar or wait tool has shipped. [Structured owner questions](../../proposed/feature/2026-10-21-persistent-owner-questions.md) applies the same principle to questions, choices, and answer receipts.
