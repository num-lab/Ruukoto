# Native Execution Setup

## Responsibilities and Boundaries

`deploy/native` documents OS prerequisites for the local software-work backend. [Execution](execution.md) owns live sandboxes and stopping; [core](core.md) owns activated storage. Retired Personal service units and privileged service-management helpers are not deployment options for this product.

## Public Interfaces

Follow [native setup](../../deploy/native/README.md) for macOS Command Line Tools/Seatbelt or Linux bubblewrap, cgroup v2 and systemd user-manager/delegated-scope prerequisites. Backend entry is `ruukoto server`; ordinary clients start it on demand and `ruukoto stop` stops it explicitly.

## Data and State

Backend configuration, locks, logs and tokens use the selected activated profile. Native execution identity and process/scope evidence remain distinct from backend PID ownership and application data.

## Main Flows

Prepare prerequisites as the intended ordinary account, build native supervisors/workers, configure a fresh profile and start the backend. Restricted execution checks required platform facilities and fails when unavailable; full access uses the starting account without a task sandbox.

## Invariants and Failure Handling

Linux user-systemd is retained native infrastructure, not retired Personal business. A stop request is not proof the complete execution unit exited; unverified stopping retains occupancy. Account, linger, service or installation changes require explicit operational authorization and are not implied by repository verification. Use an isolated Linux development host, never an existing Personal service as a test target.

## Design Rationale

- [Native execution](../../.agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md): restricted platform boundary.
- [Current-account full access](../../.agents/notes/implemented/feature/2026-10-12-full-access-current-account.md): account rights and stop limits.
- [Single product](../../.agents/notes/implemented/architecture/2026-11-10-single-product.md): retired deployment business and retained prerequisites.
