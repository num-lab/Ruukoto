# Agent Note: Ruukoto is the sole software-work assistant

Status: implemented

## Problem

The repository maintained independently operated Coding and Personal products, with separate runtimes, clients, deployment and formats. The owner retired Personal and selected the existing Coding behavior as the sole product in [Issue #58](https://github.com/num-lab/Ruukoto/issues/58). Reusing the name `ruukoto` alone cannot distinguish a fresh instance from historical Personal data with the same identity.

## Decision

Ship one software-work assistant named `ruukoto` through `apps/ruukoto`, root `start` and `dev`, the TUI, Electron and MyGo. Remove the former Coding name and aliases, Personal composition, IM/remote pairing and service-management business, PA-only workers, and legacy instance import. This is a clean cutover, not a dormant second product or a port of Personal capabilities.

Preserve workspaces, conversations, one-level SubAgents and work copies, workflows, scheduling, MCP/Cua, browser, native execution, permissions, questions, queueing, context and configuration. A Main Agent is the owner-facing Agent in an ordinary conversation, not the retired Personal main identity. Linux user-systemd execution prerequisites and both native desktop hosts remain.

Core owns named raw `ProfileSelection` and activated `ProfilePaths`. All stateful entries share bootstrap, including offline configuration before model readiness; help and read-only discovery create no state. [Fresh-profile identity](2026-11-10-single-product-profile.md) owns resolution, preparation/activation, old-profile admission and socket binding; [atomic lock publication](../bug-fix/2026-11-10-atomic-lock-publication.md) owns the required ownership primitive. Children receive the complete raw tuple; in-process callers receive resolved paths. [Usage](../../../../docs/usage.md#6-fresh-profiles-and-old-data) owns operational locations, not a second resolver.

Fresh activation never imports history, settings, credentials, pending requests or execution authority. Recognized stopped predecessors remain in place; unknown/newer layouts, live or unverifiable ownership and unresolved managed execution reject. Backend exit alone is not stop proof. Coherent temporary SQLite inspection under compatible exclusion is admission only, not old business recovery. No signals, replay or automatic service operation resolves a rejected predecessor. Committed sessions and actual workspace/work-copy sources stay untouched.

Queue resumption keeps each task's recorded model; the legacy missing-model backfill parameter and client confirmation path are removed. Explicit stop confirmation still gates release of terminal execution occupancy. Acceptance cleanup waits for the backend process and both instance/configuration locks to finish, not merely socket disappearance or the first lock release.

Current pending journals admit only current request formats: submissions require their original model selection, and owner answers carry question identity/version and answers without new-task authority. Remove retired `continue` admission, old answer receipt fallbacks and missing-model draft restoration in TUI/Desktop. Malformed files remain visible and untouched; reconciliation never converts them into new input. Valid lost submissions still reconcile or retry by their original key on the original instance; answers query the full parameter-bound receipt without automatic resend. This supersedes the pending-format compatibility described by [Coding user queue](../feature/2026-10-30-coding-user-queue.md); predecessor journals remain outside the new profile rather than becoming a supported recovery format.

A separately verified source archive precedes deletion. Git history and already sealed decision records stay unchanged. Retiring unfinished Personal work means not planned, not acceptance passed. Repository changes authorize neither publication nor changes to existing installations, services or accounts.

## Supersession and Dependent Decisions

This reverses [two products](../../archived/architecture/2026-10-02-two-agent-products.md), [Personal entry](../../archived/simplification/2026-10-18-personal-product-entry.md) and [legacy development import](../../archived/architecture/2026-10-04-legacy-instance-import.md), including [Personal import](../../archived/architecture/2026-10-05-personal-instance-import.md) and [legacy organizational mapping](../../archived/architecture/2026-10-03-legacy-workspace-org-attribution.md). Their completed rationale is sealed history, not a supported command surface.

PA-only implemented runtime, business-data, IM, service-helper, desktop pairing/settings, worker, recovery and delivery records move to the archive through the lifecycle tool. Shared constraints remain active: immutable history and reconstructible context, source-bound authorization, unknown-effect non-replay, verified stopping before occupancy release, native execution, SubAgent/workflow lifetimes, original-key client recovery, and host/renderer isolation. Mixed records explicitly supersede their retired-product portions; historical evidence is not current acceptance. [Personal durable](../../rejected/architecture/2026-10-17-personal-pi-durable.md) and [cross-product configuration](../../rejected/architecture/2026-10-25-operation-scoped-configuration.md) are rejected; implemented model/configuration constraints remain with their shared owners. Desktop, settings, background and question proposals retain only software-work scope.

## Alternatives considered

- Keep two products or a hidden compatibility entry: preserves old entry availability, but contradicts retirement and keeps unused runtime, protocol and deployment obligations.
- Rename without a new layout: minimizes path churn, but historical Personal already used the same name and root. A fixed fresh generation distinguishes identity before writes.
- Import old instances: retains history continuity, but introduces credential, execution and rollback obligations explicitly excluded by the owner. Preserve old bytes instead.
- Remove all scheduler, service or remote-named code: superficially simplifies deletion, but removes retained scheduling, MCP/Cua or Linux native execution. Trace actual consumers instead.

## Consequences

The maintained product and documentation have one composition, while fresh instances require explicit new model configuration and do not provide old-history continuity. Conservative admission can require separate owner resolution of old execution; it never claims an unverifiable resource is stopped. Source readability is not a runnable-PA restoration promise. Required integrated builds, behavioral checks, Linux/native/model evidence and actual TUI/Electron/MyGo interaction remain acceptance work under Issue #58; this note records the decision, not a passing verification result.
