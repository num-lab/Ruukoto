# Agent Note: Save Personal computer-recovery responses before validating screenshots

Status: implemented

## Problem

Personal owner recovery observations recorded complete responses only after successful image validation and storage. `isError`, missing-image and invalid-image responses remained only in memory while archives retained the screenshot request. Cold starts or later observations could not reread the original response from call details, violating [Cua response retention](../architecture/2026-10-23-cua-official-mcp.md) and conflating receiving a response with obtaining an acceptable screenshot.

## Decision

Recovery observations reuse stdio `recordCallProgress`. On receipt, one transaction appends a McpCuaRecovery `observe-response` event and a `responses` reference on the original operation, before `isError`, image validation or artifact storage. The event retains the original operation/old execution identity, the matching `observe-request` `requestEntry`, the new execution identity, and the complete request/response. The operation stores only EntryId, avoiding duplicate image base64. Local call details page through referenced response bodies; model reads retain the existing `includeHost` restriction.

`observe-reset` clears only `pendingObservation` and the valid observation, retaining all received responses. Failed responses create neither acceptable observations nor screenshot references. Acceptance still requires the original successful-observation and execution-identity checks. The original action's `effect_unknown` and `remoteEnded` remain unchanged. Another read-only observation uses the current execution generation without another sandbox stop/restart.

Recovery verifies bidirectional response-reference/event/request associations, order and new execution identity. JSON-RPC id must match the screenshot request. Clearing references cannot bypass verification of existing response events. Old archives without `observe-response` allow absent `responses`; unrelated archives/configuration formats are not upgraded.

This supplements [Cua integration](../architecture/2026-10-23-cua-official-mcp.md), [Personal MCP](../architecture/2026-10-17-personal-durable-mcp.md) and [MCP image results](../architecture/2026-10-23-mcp-image-results.md), retaining their integration scope, original-action ledger and image projection decisions.

## Alternatives considered

- Storing the complete response only in `pendingObservation` is smaller, but re-observation deletes pending state and loses failures again.
- Storing every full request/response on the original operation simplifies direct serialization, but duplicates image base64 already held by events. References suffice.
- Recording failure branches alone creates fewer events, but image validation, storage or SDK output checks can fail after response receipt. The transport callback covers all those exits.

## Consequences

Owners can reread recovery failures after cold start or subsequent successful recovery. Additional events/references cost storage; bodies retain Personal archive protection and never enter diagnostic output. Existing successful-observation evidence, screenshot acceptance and old-wait settlement remain unchanged.

Offline regressions cover full `isError` image responses, invalid/missing images, paged rereads, cold start, successful re-observation/acceptance, empty-reference tampering, missing IDs/null responses, preservation of unknown effects, and no repeated stop/restart of a running new generation. Real-model, desktop and production-entry acceptance remain separate external checks.
