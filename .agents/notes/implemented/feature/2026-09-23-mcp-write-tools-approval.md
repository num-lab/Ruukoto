# Agent Note: MCP write tools share approval and single-use consumption

Status: implemented

Original identifier: ADR 0008.

[MCP host responsibility reduction](../simplification/2026-10-26-mcp-host-responsibilities.md) supersedes protocol execution, signature comparison, and HTTP/client-error classification. Single-use approvals, immutable parameters, local effect declarations, and no replay remain. HTTP status or a client exception alone is not a complete remote result. [Cua](../architecture/2026-10-23-cua-official-mcp.md) additionally commits original request/approval consumption before stdio writes and freezes the computer after an unresolved sent write. [Desktop settings](../../proposed/feature/2026-10-21-desktop-settings-management.md) is a partially delivered proposal, not a reason to relax these controls.

## Problem

Initial [MCP support](../architecture/2026-09-23-mcp-client.md) admitted only owner-declared reads; writes/unknown effects needed concrete approval scope, once-only consumption, and unknown-result recovery. Retiring the [dedicated GitHub module](../simplification/2026-09-23-retire-github-module.md) temporarily removed GitHub writes. Remote readOnly hints are unverifiable; service/credentials/arguments/permissions may change while awaiting approval; timeout/disconnect/cancel/restart may follow a real remote write. Per-service publish implementations would split authorization again.

## Decision

1. Use one generic MCP write path, with no GitHub-specific publish intention, adapter, draft state machine, or runtime branch by service name.
2. The owner declares `read`, `write`, or `unknown` in the allowlist. String entries mean read for compatibility; `{ name, effect }` is explicit. Conflicting classifications reject configuration. Historical CLI syntax is `ruukoto mcp configure ... --tools a,b:write,c:unknown`; check/tool descriptions show classification. Remote readOnly annotations never grant authority. Current entry/configuration scope follows the successor notes.
3. Non-allowlisted tools are neither registered nor executable. Authorized reads run in all modes. Write/unknown require per-call approval in confirm/auto-review; unknown is treated as write. Full access skips per-call approval but never service-enabled, allowlist, or credential-scope checks.
4. Reuse `ConfirmationRequest`, `tool_ops`, permission versions, `ApprovalGate.request`, and `Store.consumeApproval`. `mcp_tool` fixes service identity/config version, remote name, task-pinned authorization-relevant definition, normalized parameter digest, credential binding name, and effect category. Secrets never enter approval views/events.
5. Recheck before invocation and again before send in the approval-consumption path: removed/reassigned/disabled service, changed pinned version, removed tool/changed effect, revoked or wrong-host credential, changed task permission, or finished task invalidates old approval and sends nothing. Recheck/consumption failure marks approved -> stale transactionally. SQLite configuration/consumption is atomic, but file credentials are not in that transaction.
6. Execute the approval's immutable parameter snapshot, not fresh arguments bearing an old approval ID. Changed arguments or another invocation require new approval. Auto-review's deterministic policy excludes `mcp_tool` and asks the owner.
7. Never automatically replay unresolved writes on reconnect, repeated control request, or restart. Unconsumed approval is known not executed. Once begun/sent without a trustworthy terminal result, write/unknown remains `effect_unknown`. Remote terminal errors and client/transport failures must be distinguished using the successor's provenance rules, not HTTP status or exception class alone.
8. Original framework acceptance used mock services only. It did not authorize or certify any real write tool. Enabling one requires owner-selected service/target/scope and separately bound service/project/operation credentials, not Tavily/old GitHub/unscoped credential reuse, followed by real-service acceptance. Later Cua or other service evidence is separate and cannot retrospectively certify this original delivery.

## Scope, versions, and credentials

Original `mcp_tool` fields are `serviceId`, display-only `serviceName`, userinfo-free `endpoint`, `configVersion`, `remoteName`, `toolSignature`, `paramsSha256`, nullable credential binding name, and `operationCategory=write|unknown`. Model-visible name is `ConfirmationRequest.toolName`. Existing approval JSON stores the scope; no service-specific table/migration is needed.

The original signature was the first 16 hex characters of sha256 over remote name, description, inputSchema, and effect, discovered/pinned at task start; new definitions took effect in the next rebuilt session/task and old approvals never crossed tasks. The successor retains model-seen evidence and schema/eligibility/authorization checks, but descriptions/unrelated metadata alone no longer reject calls. Equal schema never proves unchanged service implementation. `paramsSha256` hashes canonical key-ordered JSON for audit/display; execution uses saved parameters directly.

`CredentialStore` is file-backed. Binding re-read precedes SQLite consumption, and the actual-send authentication provider calls `getForUse` for project, MCP operation scope, and host again, so revocation after precheck does not authorize sending. No anonymous fallback follows revoked credentials. IM-origin approval consumption additionally checks its original fixed identity, without replacing MCP configuration checks.

Mode change/cancellation while awaiting approval stales it and sends zero calls; later execution uses the new mode. [Plan](2026-10-08-plan-session-mode.md) and host [GitHub review](2026-09-24-github-event-review.md) expose only locally declared read tools.

## Original result-classification design and successor

The original router classified write timeout/connect_failed/canceled as possibly sent and unknown, remote JSON-RPC errors/isError as known results, and read timeout as ordinary failure. It also treated several HTTP error classes as known. That last assumption is superseded: admitted-response loss can become a client-synthesized JSON-RPC error indistinguishable by message/code alone. The current host observes actual response provenance before Pi receives bytes; absence of proof remains unknown.

Originally calls passed pinned name/inputSchema without outputSchema to avoid SDK local validation or list-refresh resends; the router checked pinned structuredContent itself, recording a remote-success/schema-mismatch as a known local error without replay. Official Pi execution and current output/error handling now belong to the successor. Preserve this as rationale, not current SDK instructions.

The original restart ledger lacked persisted MCP effect classification, so missing-result reads could also be labeled unknown; the successor explicitly reuses owner-confirmed read/write/unknown classification and removes that blanket read-failure behavior. Started writes still do not replay, including full-access calls without approval. No cross-restart original-SSE recovery or generic URL-wide blocking is promised by the current simplified host.

## Alternatives considered

- **Keep GitHub publication intentions/drafts/repository adapters:** stronger dedicated publish guarantees (trusted intention, inspectable draft, repository/target/body/version/revision checks), but the owner chose GitHub as ordinary MCP. Accept that generic calls do not automatically reproduce the old workflow's guarantees.
- **Trust remote readOnly hints:** automatic classification is convenient, but an untrusted server could bypass approval. The owner must declare effects; unknown remains approval-bound.
- **Treat all JSON-RPC errors as transport-unknown:** the old SDK used the same ProtocolError for real remote errors and local output-schema validation, so this was conservative but unnecessarily demanded owner reconciliation of known errors. The original workaround moved validation to the router. Later Pi's synthetic-response ambiguity required the successor's narrow read-only provenance observer rather than pretending all ProtocolErrors are remote.

Historical offline provenance: `.scratch/personal-agent/issues/06-github.md`, `17-replace-github-module-with-mcp.md`, `18-mcp-write-tools.md`; `.scratch/architecture/issues/04-approval-gate.md` and `05-tool-op-ledger.md`.

## Consequences

All services share authorization/consumption/result/recovery instead of bespoke logic. Rejection sends zero calls; one approval sends at most one; configuration/argument/credential changes cannot substitute targets unnoticed. Credential values stay out of records. Costs include trust in the owner's classification: registering a write as a read string bypasses approval, and full access still skips per-call write confirmation. Auto-review does not automate MCP writes. Unknown writes require human/business verification, not automatic retry.

File credentials cannot co-commit with SQLite, so send-time recheck remains necessary. Definition changes have task/version semantics, revised by the successor's narrower checks. Historical mock acceptance does not establish real HTTPS writes, credentials, models, or platforms. [Current-account full access](2026-10-12-full-access-current-account.md) owns its broader mode rules.

## Verification

`test/25-mcp-write.test.ts` originally used two mock services through real host paths for classification/check display, zero-before/one-after approval, immutable parameters/redaction, rejection, duplicate responses, config changes, fresh approval for changed params, full-access allowlist limits, auto-review fallback, unknown effects, same-name service isolation, waiting/in-flight cancellation, timeout/disconnect, mode changes, next-task signatures, crash recovery without replay, remote errors, and output-schema mismatch. `test/63-approval-gate.test.ts` / `test/64-tool-op-ledger.test.ts` map shared consumption/recovery. Those original expected error/signature behaviors must be read with the successor, not as current guarantees. Real writes need separately authorized targets/credentials. No runtime tests are rerun in this migration.
