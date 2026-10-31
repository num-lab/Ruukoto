# Agent Note: Pin service configuration through the Personal setup wizard

Status: implemented

[Command/service configuration versions](2026-10-25-personal-execution-configuration-versions.md) supersedes permanent binding and validating all history against current configuration. Other permission, identity, and deployment rules remain.

## Problem

[Service inspection](2026-10-17-personal-service-inspect.md), [operations](2026-10-17-personal-service-operations.md), and [Telegram authority](2026-10-17-personal-telegram-permissions.md) had host APIs, but the isolated wizard injected only model/Telegram configuration. Owners could not configure services. Existing durable profiles pin fingerprints, so unrestricted replacement/disable would break recovery.

## Decision

The stopped, instance-lock-holding wizard initially saves versioned `service.json`, strictly parsing absolute helper/policy/sudo paths and fixing production `useSudo:true`. It accepts neither legacy environment configuration nor test parameters. Standard paths follow deployment documentation. Only Linux can enable through the wizard; saving neither installs nor proves healthy deployment. The original slice permits viewing/preserving existing configuration, not changing/disabling it; later versioning owns those changes. The new ordinary file enters the allowlist so old code refuses safely.

Backend configuration injects existing inspection/service-operation extensions. Model tools are read-only; trusted host writes and original Telegram approvals retain their authorization paths. Local status says whether wiring exists, not whether a service is healthy. Missing/changed fingerprints fail existing recovery before resume. Before first save, the same lock protects Storage checks for business format, existing fingerprint, and unfinished tasks/inputs. Pending work blocks first enablement without writing a file, allowing the old empty-tool configuration to start.

A matching existing service fingerprint with operations already enabled permits restoring a missing file despite pending work. Adding operations to a read-only profile still counts as first enablement. Harness checks first enablement before committing any new authority, so rejected direct host API calls leave no half-enabled state and start no second Harness. Configuration files and durable state are not atomic; other failures preserve evidence and report.

[Local management](2026-10-17-personal-local-management.md) retains its entry lifecycle; [fixed helper](2026-10-03-service-management-helper.md) retains deployment protection. The [migration proposal](../../proposed/architecture/2026-10-17-personal-pi-durable.md) owns complete capability/cutover acceptance. [Child service operations](2026-10-17-personal-subagent-service-operations.md) later adds controlled restart through original WorkTask authority, cancellation, and unknown-effect completion; independent host operations and other tools keep their rules.

## Alternatives considered

Legacy RUUKOTO_SERVICE_* settings already exist but would implicitly import old assembly into an explicitly configured new instance. Simultaneous disable/path update is convenient but needs a separate protocol for operations pinned to the old fingerprint. Model restart/delegation offers end-to-end business use but additionally requires work ownership, child authority, and fixed reporting. This slice closes independently verifiable configuration first.

## Consequences

Configuration/backend wiring reuses service execution/authority without the legacy runtime state machine. The original policy requires fixed paths and storage verification before new configuration; subsequent versioning owns supported migration. Rejected first enablement leaves neither a half-enabled file nor new authority and preserves use of the original configuration. Separate file/durable commits mean file existence alone is not proof of enablement.

Historical evidence and environment gaps are in the offline copy of `.scratch/personal-pi-durable/issues/09-service-configuration.md`. Command stubs prove neither sudoers, systemd, nor business health. The overall work retains real-platform and owner-experience acceptance.
