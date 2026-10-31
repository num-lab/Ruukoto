# Architecture

Ruukoto delivers two products from one repository. **Personal Agent (`ruukoto`)** uses the durable runtime's persistent conversations and tasks for daily assistance. **Coding Agent (`ruukoto-code`)** uses the shared runtime for software work, queued tasks and delegation. They operate independently.

Detailed designs and contracts live in [modules](modules/).

## Module Map

Applications compose the packages; dependencies flow toward the shared foundations. Some entries below describe a subsystem within a package, not a separate workspace package.

| Module | Responsibility | Main dependencies and callers |
| --- | --- | --- |
| [products](modules/products.md), `apps/` | Product composition and CLI entry points | Assemble packages; neither product depends on the other |
| [personal-durable](modules/personal-durable.md) | Personal conversations, work, IM/local/remote entries and tools | Pi 1.3.0 and system facilities; production and development share composition |
| [runtime](modules/runtime.md) | Coding task lifecycle, per-conversation queues and SubAgents | `core`, `agent` and execution; driven by control and channels |
| [core](modules/core.md) | Data layout, SQLite schema, task states and conversation identity | No workspace dependencies |
| [workflows](modules/workflows.md) | Versioned definitions, persistent runs and step controls | Core transactions and the agent script sandbox |
| [agent-context](modules/agent-context.md) | Model context, history selection, reference snapshots and memory | Core storage; called by the runtime |
| [agent-tools](modules/agent-tools.md) | Tool availability, approvals and immutable operation records | Core and execution |
| [execution](modules/execution.md) | Native sandbox, tool workers and verified process exit | Part of the agent execution layer; uses core |
| [control](modules/control.md) | Unix socket, owner-token authentication and RPC | Runtime and core; serves clients |
| [view](modules/view.md) | Browser-safe state and history projections | Browser-safe core/control contracts |
| [desktop](modules/desktop.md), `apps/desktop/` | Native hosts and desktop rendering | Node host connects to local control and remote HTTPS/WSS |
| [tui](modules/tui.md) | Terminal UI, shared CLI and offline configuration | Control protocol, with standalone management commands |
| [channels](modules/channels.md) | Shared QQ/Telegram entries, inbound images and GitHub events | Register core events and trigger runtime tasks |
| [scheduler](modules/scheduler.md) | Time rules and notification outbox | Core, runtime and channel senders |
| [deploy](modules/deploy.md) | systemd units, privilege helpers and OS permissions | Deployment configuration, not an in-process layer |

At package level, `core` underpins `agent`, which supports `runtime`; `control` exposes runtime operations to clients. Product composition supplies callbacks where runtime dependencies would otherwise point backward.

## Flow 1: Task Lifecycle

Coding input and scheduled execution are persisted before being queued. Task state and its events commit together; broadcasts follow the commit. JSONL history is a separate authority, not part of that SQLite transaction.

```mermaid
sequenceDiagram
  participant Client as TUI / CLI
  participant Runtime as Runtime
  participant Store as Core SQLite
  participant Driver as Driver + context
  participant Control as Control events
  Client->>Runtime: submit(conversation, requestId, input, mode)
  Runtime->>Store: Check idempotency; persist queued task and event
  Runtime->>Control: Broadcast committed event
  Runtime->>Runtime: Select task and freeze executionProfile
  Runtime->>Store: queued → running
  Runtime->>Driver: Assemble context and stream model output
  Driver-->>Control: Output, thinking and tool fragments
  Driver-->>Runtime: Tools and approval requests
  Runtime->>Store: Commit terminal state, release occupancy, invalidate approvals
  Runtime->>Control: Broadcast terminal event
```

- `(sessionId, requestId)` is unique: identical replay returns the original task; changed parameters are rejected.
- `executionProfile` fixes identity, write target and access policy when execution starts.
- Terminal states are `completed`, `failed`, `canceled` and `interrupted`; finalization is transactional.
- After an unexpected backend restart, unfinished shared-runtime tasks become `interrupted` with `backend_restart` rather than silently remaining active.

## Flow 2: Incoming Message to Reply

Personal QQ, Telegram, terminal and PA desktop inputs enter the same durable main conversation. Acceptance persists the original source; replies retain it.

```mermaid
sequenceDiagram
  participant Entry as QQ / Telegram / desktop
  participant Adapter as Personal adapter
  participant Harness as Durable Harness
  participant Main as Main conversation
  participant Reply as Reply task
  Entry->>Adapter: Message and source credentials
  Adapter->>Harness: Persist admission
  Harness->>Main: Submit input and advance conversation
  Main-->>Harness: Corresponding model answer
  Harness->>Reply: Fix platform, account and entry generation
  Reply->>Entry: Verify original destination and send
```

Platform message IDs deduplicate acceptance. Reply tasks verify the original entry and credential generation instead of redirecting to a newer destination. A closed client or temporary network outage does not cancel already accepted conversations or analysis work.

## Flow 3: Tool Execution and Approval

Availability checks first restrict the model's tool set. The access policy then determines which operations require approval. An approval is valid for one fixed operation, not a general permission increase.

```mermaid
sequenceDiagram
  participant Driver as Model driver
  participant Tools as Tool availability
  participant Gate as Approval
  participant Exec as Execution
  participant Ledger as Operation ledger
  Driver->>Tools: Tool call and operation fingerprint
  Tools->>Tools: Check identity, mode and allowlist
  alt Approval required
    Tools->>Gate: Persist immutable request; suspend task
    Gate->>Gate: Receive owner decision; consume once
  end
  Tools->>Exec: Execute under the selected policy and snapshot
  Exec->>Ledger: Record outcome and artifact identity
  Ledger-->>Driver: Bounded result; oversized output becomes an artifact
```

Tool availability can narrow with conversation identity, plan mode and access mode. Targets, parameters and command fingerprints remain bound to the approval. Restricted execution uses the native sandbox; full access instead uses the starting account without a task sandbox. Stopping must verify the execution unit is gone before releasing its occupancy.

## Flow 4: SubAgent Delegation

A main Agent can delegate to independent child contexts and collect their results. The product supports one delegation level: its SubAgents do not create their own SubAgents.

```mermaid
sequenceDiagram
  participant Main as Main Agent
  participant Manager as SubAgent manager
  participant Store as Core
  participant Sub as SubAgent conversation
  participant Delivery as Parent delivery
  Main->>Manager: subagent_delegate(parameters, role, target)
  Manager->>Manager: Prepare work copy and source snapshot
  Manager->>Store: Persist work, child and task in one transaction
  Manager->>Sub: Execute serially in child context
  Sub-->>Store: Persist task outcome
  Manager->>Delivery: Register parent notification
  Delivery->>Main: Wake parent and supply result
  Main->>Manager: Explicit integration or close
```

Code-writing delegation uses an isolated work copy where required. `subagent_integrate` explicitly brings reviewed changes into the parent. Completing a task does not destroy its SubAgent: identity, history and artifacts remain available until explicit closure, and the work copy is retained.

## PA Desktop Connection

The remote path is **Tailscale Serve (HTTPS/WSS) → private Remote service → exclusive durable Harness**. The service verifies owner identity and application credentials. Initial pairing is explicit in the server's local management wizard; credentials can be revoked. See [desktop security](modules/desktop.md) and [deployment](../deploy/systemd/README.md).

## Design Rationale

- [Backend tasks and terminal separation](../.agents/notes/implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md): event recovery and request idempotency.
- [Two products](../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md): independent runtime, profiles and locks.
- [Workspace packages](../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md): package ownership and imports.
- [Tool workers](../.agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md) and [native execution](../.agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md): execution boundaries and verified stopping.
- [History and context](../.agents/notes/implemented/architecture/2026-09-19-preserve-session-history.md): separate authorities.
- [Work, SubAgents and tasks](../.agents/notes/implemented/architecture/2026-10-03-work-delegation-subagent-task.md): delegation identity and lifecycle.
- [Human docs and decisions](../.agents/notes/implemented/process/2026-10-09-split-agent-and-human-docs.md): documentation audiences.
