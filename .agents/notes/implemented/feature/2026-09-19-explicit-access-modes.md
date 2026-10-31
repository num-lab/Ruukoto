# Agent Note: Enforce access modes technically and require explicit full access

Status: implemented

Original identifier: ADR 0003

[Operation-specific checks](../bug-fix/2026-10-24-operation-specific-checks.md) replaces owner workspace-registration restrictions; restricted execution still checks protected paths. [Native execution](../architecture/2026-10-12-personal-native-sandbox.md) replaces backend/deployment choices. [Current-account full access](2026-10-12-full-access-current-account.md) supersedes the original dedicated-account isolation, remaining approval exceptions, and confirm-only host-task propagation. This note retains mode selection, concrete approval scope, single use, and authenticated control requests.

## Problem

The owner requires technical limits on Agent actions. Free shell and descendants can bypass prompt instructions and command-name checks such as git push/gh interception. Confirming every action would prevent useful autonomous workspace edits/tests; some work should use the account's existing authority with explicit consent. A separate risk is execution code reading owner authentication or modifying authorization state: mode labels alone cannot prevent impersonation when OS identity permits it.

## Decision

File, command, network, and credential limits must be enforced by execution facilities, not model cooperation or special publishing tools. Confirm mode performs already authorized workspace work autonomously and requests concrete approval for out-of-scope actions. Full access is explicitly chosen authority to use the launch account's existing permissions without per-operation approval; it grants no new OS privilege and does not claim file isolation within that account.

The initial two modes were `confirm` and `full_access`; [auto review](2026-09-22-auto-review-mode.md) added `auto-review` using the same restricted execution as confirm, not a larger grant or full-access upgrade. `AccessMode` has those three values. Session `plan` is not a fourth access policy: its tasks use auto-review under [Plan mode](2026-10-08-plan-session-mode.md). New session defaults are confirm.

Effective `accessMode` and `permissionVersion` belong to each task. Session defaults affect later tasks created without an explicit choice, not existing tasks. Only authenticated owner operations submit/continue/switch_mode/set_session_mode select modes; no model tool approves or promotes itself. A continued interrupted task does not inherit an old one-use approval. Host-derived authority now follows the current-account decision rather than this note's original rule that every inbound/SubAgent task was confirm. Platform identity does not become general control authentication or arbitrary session access.

Restricted backend unavailability rejects admission with `execution_unavailable` instead of silently running unrestricted. Both products' official restricted entries now accept native only; old local/container flags or overrides fail with migration guidance. Library local supports current-account full access and offline tests. Full access need not fail merely because restricted native artifacts are unavailable. The old personal local default and Code container default are historical, not current deployment instructions.

### Authenticated control plane

Authentication was introduced in protocol v2; consult current protocol code for its version, not the original note's v16 snapshot. The first request must be `auth` with the owner token. Before success, no snapshot or business request is allowed; return `unauthorized`. Compare tokens with `timingSafeEqual`.

Create the control directory with 0770 and a missing `owner.token` from 32 random bytes encoded as hex, file mode 0600; reuse an existing valid token (minimum 32 characters). Clients select `RUUKOTO_OWNER_TOKEN`, then `RUUKOTO_OWNER_TOKEN_FILE`, then control-directory owner.token. Backend validates rather than choosing client sources. Never put the token in argv, worker environments, logs, or approval records. `control.sock` normally resides in sibling `control/`, separate from backend data. Strip `RUUKOTO_*` control variables from workers; dev launchers do not inherit daily-instance owner-token variables. QQ/Telegram messages are inbound events, not control authentication.

Control/data/agent/service-code roots remain protected in restricted execution. A granted path must be neither inside a protected root nor its ancestor (`assertGrantNotProtected`); workspace registration itself now follows operation-specific checks. Token authentication still checks application entry identity, but under current-account full access it does not isolate backend-owned readable files or tokens from that same account. Do not preserve the original three-account security claim after adopting the superseding policy.

### Mode transitions

Only owner `switch_mode` changes a task, never into/out of Plan. Queued or approval-waiting tasks without active tools switch only after the old execution unit is stopped and verified. Then persist mode/version increment and `task.mode_switched`; invalidate waiting approvals and re-evaluate later operations. Switching to full access does not automatically execute an old pending operation. If stopping cannot be verified, interrupt with `mode_switch_unverified` and retain directory occupancy.

For a running tool, persist `task.mode_switch_requested` and apply at the next tool boundary. The active call retains its starting scope. Refuse terminal-task changes. A new mode affects future actions, not effects already produced.

### Historical security policy

Originally full access used `ruukoto-exec`, distinct from owner and `ruukoto-backend`. The owner had a 0400 token copy; backend held data/credentials/original token; the execution account shared neither group. This sought to prevent owner impersonation and authorization-state writes. The original note also required separate approval for destructive app data, outbound schedules/sends, privileged service management, and structured file/HTTP access, with MCP writes the only full-access exemption. These are retained as historical rationale only: the current-account decision intentionally replaces account/environment/approval policy. Native migration also removes the old container image, dedicated execution identity, privileged launcher, and ACL deployment requirements.

## Alternatives considered

- Prompt-only rules or publishing-command interception are cheap and cover familiar outbound commands, but free shell bypasses string matching; hiding selected credentials is not a comprehensive external-write restriction. Enforce the execution boundary.
- Downgrade confirm to full access when isolation is unavailable: improves availability, but lies about the owner's selected restriction. Fail explicitly instead.
- Rely solely on directory/socket permissions: Unix permissions restrict accounts, but cannot distinguish an owner terminal and a full-access command under the same UID. Token authentication remains required; its same-account limits must be explicit.
- Run full access as the owner: convenient toolchain/files and an OS identity separate from backend, but it could read the CLI token and impersonate the owner. The initial decision rejected this for a dedicated third identity. The later current-account policy deliberately revisits this tradeoff; the old rejection is not a current deployment mandate.
- Ship automatic approval in the first version: fewer interruptions, but owner confirmation limited initial scope to confirm/full access. Auto review was added later as its own decision, not silently inferred from autonomous in-scope actions.

## Consequences

Mode choice is inspectable per task; concrete approvals remain parameter-bound, single-use, and independently authenticated. Restricted authority does not depend on the model obeying instructions. Current full access intentionally exposes what the launch account can access, including backend state/credentials; do not claim it cannot impersonate an owner holding the same readable token. A deployment needing stronger OS separation must design and verify it explicitly.

Current narrow regression entry is `test/10-access-modes.test.ts`: mode/scope idempotency, continue choice, tool-boundary switching, terminal refusal, missing restricted artifacts versus full access, pre-auth refusal, model inability to call control-only operations, and protected-root checks. `test/40-qq-private.test.ts` covers platform IDs not replacing tokens. This rewrite did not rerun them.

Historical Linux foundation reports and tx issue 23 demonstrated EACCES for task-UID access to backend 0600 state and Permission denied reading owner tokens as `ruukoto-exec`. They prove that historical multi-identity deployment only, not current-account full access. Original specs/issues under `.scratch/personal-agent/` are offline provenance, including the first-version approval choice and three-identity rationale. They are not maintained setup or acceptance instructions.
