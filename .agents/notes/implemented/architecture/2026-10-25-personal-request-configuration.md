# Agent Note: Preserve request configuration and publish later versions per object

Status: implemented

[HOME skills](../simplification/2026-10-28-home-skills-discovery.md) supersedes skill sources/current managed-state checks. Original request snapshots and model/MCP/search selection rules remain.

## Problem

Personal backend captured model/MCP/search at startup. Mutating a provider under the same ID or replacing all effective choices from a candidate file can retarget old requests, publish unrelated pending services early, or let a search update revoke unrelated file/HTTP work. Skills already had body snapshots yet sending compared the current manifest, letting normal disable invalidate a prepared request.

This note owns runtime selection for model/Skills/MCP/search only. Save, format migration, IM, and command/service migration remain with [operation-scoped configuration](../../proposed/architecture/2026-10-25-operation-scoped-configuration.md); original spec provenance is `.scratch/configuration-updates/spec.md` offline, not a claim that all work is complete.

## Decision

A new immutable model-configuration version generates a nonreusable provider ID. Register it in existing MutableModels first, then configure main/child/scheduled sessions' future model choices in one short transaction. Cold start restores every durable configuration version and the pre-migration personal-provider baseline. Started generations recover original provider/modelId rather than routing through the current file. Auto-review, image eligibility, and new delegation use current effective selection. Retain old providers until shutdown for poll/abort/recovery references.

After Skills prepare, immutable snapshotEntry proves original body/references without requiring today's manifest. Under the original managed-source rules, new loads still check enabled package/content version/original directory, while saved loads return original text. Disable affects future requests/new loads rather than erases old references. HOME discovery now owns fixed-source replacement.

MCP publishes a named service while preserving others' actual selections; an unpublished candidate service in the file does not hitchhike on another save. Original calls save config version; new calls in a model response take that service version from original request evidence and cannot silently target a new endpoint. Presend/plan checks use immutable saved chains, excluding only label and host generation. Any intervening endpoint, authority, service-set, or tool-definition change cuts eligibility even if later reverted. Derive indexes from verified versions rather than a second compatibility ledger. Without a complete legacy chain, accept only exact original configuration.

Unknown ordinary HTTP MCP results do not block new save/publication. Preserve original request, credential reference, unknown effect, and same-source/endpoint occupancy; new configuration neither resends nor releases it. Computer target/tool changes wait for that connection and related actions' stop boundary, not all services/backend.

MCP services share one selection object. Reading actual config, composing a service candidate, committing selection, and replacing memory serialize in a short commit section; computer stop/connection close waits outside it. Rechecking an original operation whose service already matches the candidate confirms only that service, never rewrites global config or reuses another service's consumed generation.

Web Search has a separate file/current choice, using original ToolDoc, native Task, quotas, and artifact evidence independently of data directories. Old tools.search seeds initial selection; new saves change search only. Unstarted calls from old responses must match original search version; in-flight search keeps original credentials/results. File/HTTP operations retain their original config/authority. Internal saved versions enter request evidence, not extra ordinary tool-result inputs.

Unverified save intent/unpublished candidates pause new acceptance only for affected objects: model/Skills before next prepare, MCP per service, search at new search acceptance. Prepared/started original operations finish with original selections. Shared Storage failures propagate, never swallowed as single-object connection errors.

[Personal references](2026-10-18-personal-memory-skills-history.md), [managed skills](../feature/2026-10-21-managed-skills.md), [MCP](2026-10-17-personal-durable-mcp.md), [data/network tools](2026-10-17-personal-tools-access-artifacts.md), and [schedules](2026-10-18-personal-durable-scheduled-work.md) retain provenance, authority, unknown effects, and evidence.

## Alternatives considered

Overwriting personal provider is smallest but generations save only provider/modelId and would recover using new address/auth. Publishing a whole MCP file makes saving B prematurely publish pending A. Separate search tool state avoids adjusting optional data-config types but duplicates native ownership/quotas/artifact recovery. Current-manifest presend checks immediately withdraw old references but reject already fixed requests on unrelated changes. Versioned providers, per-service publication, existing ToolDoc, and original skill snapshots avoid those failures.

## Consequences

Online save need not stop the whole backend and old models/calls/artifacts keep verifiable config identity. Costs are retaining providers for backend lifetime and validating history chains during recovery. No physical history collection or automatic business retry is added. Real models, MCP/IM, and client experience need separate environments; loopback/failure injection proves only corresponding paths.
