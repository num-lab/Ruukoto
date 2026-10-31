# Agent Note: Reuse the fixed helper for Personal durable service inspection

Status: implemented

[Durable inspection ownership](2026-10-17-personal-durable-inspection.md) supersedes identity-free replay wiring. Original rationale remains, while byte capture, paging, and trusted configuration boundaries still apply.

## Problem

[Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) retains service management, but old service-tools.ts binds Task, ApprovalGate, and ArtifactStore. Importing it would retain old runtime authority. Restart-first wiring would lack durable work ownership, approval consumption, and scoped unknown-effect suspension.

## Decision

Reuse only fixed helper read-only inspect initially. Extract transport/response types into same-app service-helper.ts for both assemblies. Only owner-configured trusted host code provides helper/sudo/policy paths; the model chooses a service unit, not restart or arbitrary command.

Persist original stdout/stderr as durable entries with base64 preserving bytes, <=1MiB total. Oversize stops inspection, saves truncation, and reports failure rather than a service state. Model output contains fixed state, observation time, and evidence ID. read_service_inspection pages committed same-session originals in 4096-character pages without revisiting services. Malformed fields, non-JSON, and multiple response prefixes fail while retaining bounded capture. Storage failure closes through Harness rather than generates success.

The original read-only tool used replay:safe to observe again after recovery, rechecking current policy/target through helper. Durable inspection now replaces that identity-free replay with original-attempt verification. Fixed-field hashes of helper/sudo/policy/useSudo live in ruukoto.service-config. Missing config, changed paths, unsupported document versions, or an enabled extension without its record rejects before resume. Active service state and policy content are not frozen; past observation is not current state. Copy configuration before assembly so caller mutation cannot retarget it.

Register personal-service-inspect in session configuration so old code rejects the new profile. An empty-tool profile enables inspection only without pending inputs/tasks and explicitly configures existing main, rather than relying on root creation parameters. Trusted host API or the [stopped wizard](2026-10-17-personal-service-configuration.md) enables it.

[Child inspections](2026-10-17-personal-subagent-inspection.md) later replaces empty-child-tool scope for configured fixed read-only checks. [Child service operations](2026-10-17-personal-subagent-service-operations.md) later adds controlled restart through original WorkTask authority/cancellation/unknown effects. Unconfigured children and other tools retain their boundaries. [Fixed helper](2026-10-03-service-management-helper.md), [standing authority](../feature/2026-10-03-standing-permissions.md), [profile foundation](2026-10-17-personal-durable-foundation.md), and [local management](2026-10-17-personal-local-management.md) keep their independent rules.

## Alternatives considered

Old service tools already support approvals/artifacts but import the old Store/Task/SDK. Adding restart simultaneously tests more capability but cannot yet prove unknown effects pause only their own work. Reading fresh helper config on every recovery is flexible but retargets unfinished calls/execution identities. Pin original configuration and reject differences; later safe-update decisions own replacement.

## Consequences

Personal reduces old Task/approval/artifact dependencies while sharing real helper transport. Costs are durable raw output, a configuration fingerprint, and an explicit extension. Initial wizard configuration is fixed; deleting its record cannot bypass recovery checks. Historical identity-free safe replay could observe changed state/time; later durable ownership replaces it. Never report unpersisted success or truncated capture as complete.

[Transport exit handling](2026-10-17-service-helper-exit.md) waits for live-call close on interruption, but backend kill can leave a helper, so it proves no stop by itself. This original slice did not establish write effects, unverified-stop occupancy, or work isolation. Service state is not business health; sudo/allowlist deployment remains separate. Historical evidence in `.scratch/personal-pi-durable/issues/04-service-inspect.md` includes real SQLite, mock model, subprocesses, and kill/reopen, with actual Linux helper/deployment results separately recorded rather than conflated with full service-management acceptance.
