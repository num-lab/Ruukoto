# Agent Note: Preserve task tool selection during MCP publication

Status: implemented

## Problem

Pi rebuilds its tool registry when an MCP tool is published and activates declarable tools matching the session's original allowlist. A later publication can therefore reactivate host tools that the current task excluded. In [CI run 42208095188](https://github.com/num-lab/Ruukoto/actions/runs/42208095188), an ordinary task following a restricted task was interrupted because its outgoing declarations unexpectedly contained `process_start`, `browser` and `desktop_browser`. The final send check correctly blocked them, but the task never completed its permitted operation.

## Decision

The Driver's MCP registration callback refreshes its registry names and immediately intersects SDK active names with the current task's selected tools. It does not recalculate source eligibility while asynchronous discovery is still building a pinned catalog. Initial task preparation continues to own that selection. The execution and final send checks remain independent, so a later invalid SDK mutation still fails closed.

This repairs publication ordering within [official MCP responsibilities](../simplification/2026-10-26-mcp-host-responsibilities.md); official discovery, deferred tools, source/configuration pinning and task permissions keep their existing owners.

## Alternatives considered

- Filtering every final request to allowed tools would hide invalid SDK state from the final send check and weaken the deliberate leaked-tool regression. Apply the selection at the registration event that invalidates it instead.
- Recreating the SDK between tasks would reset valid session/discovery state and leave publications during a task exposed to the same race.
- Recomputing all task eligibility in the registration callback could reject a pinned role before its required MCP tools finish registering. Intersect the already selected set instead.

## Consequences

MCP publication no longer broadens the current SDK loadout. The existing policy regression explicitly publishes a real MCP registration after task selection and before prompting; it still checks same-SDK reuse, permitted execution, hidden undiscovered writes and final rejection of an intentionally leaked tool. This is an offline SDK/host integration guarantee, not real-service acceptance.
