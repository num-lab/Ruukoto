# Scheduled Work

## Responsibilities and Boundaries

Scheduling activates software work from one-shot, daily or weekly rules in a fixed IANA timezone. It retains an independent conversation and result for each run. The [runtime](runtime.md) coordinator owns admission and cancellation; [core](core.md) persists plans/runs; [time utilities](channels.md) calculate due times. There is no IM notification outbox.

## Public Interfaces

Desktop Scheduled lists active and archived plans, opens run history and creates/edits plans. Each plan selects title, instructions, workspace, model, effort and access policy. Owner questions, approvals, backgrounds and workflow work use their retained runtime interfaces.

## Data and State

A run is unique by schedule/version/original due time. Its fixed source and authority outlive later plan edits; at most one unfinished run exists per schedule. Missed occurrences coalesce rather than generating a backlog of automatic replay.

## Main Flows

The coordinator checks a due plan, reserves its run, creates the independent conversation and admits work with the pinned source. Derived tasks, questions and reports belong to that run. Completion records a result; future plan edits affect later runs. Cancellation retains facts and verifies execution stopping before releasing occupancy.

## Invariants and Failure Handling

- Instructions are not authorization; scheduled execution uses fixed source permissions.
- Restart does not grant authority to repeat an unknown write or release unverified execution.
- Plan edits do not rewrite current-run identity, model or permissions.
- A fresh profile does not adopt or replay a predecessor’s plans, queued runs or pending answers.

## Design Rationale

- [Scheduled work](../../.agents/notes/implemented/feature/2026-10-25-code-scheduled.md): plan versions, independent run context and whole-run lifecycle.
- [Desktop Scheduled](../../.agents/notes/implemented/feature/2026-11-01-desktop-scheduled-interface.md): current interaction.
- [Single product](../../.agents/notes/implemented/architecture/2026-11-10-single-product.md): retained scheduling without PA transport.
