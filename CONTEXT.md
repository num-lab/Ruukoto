# Ruukoto Domain

Ruukoto is a software-work assistant on macOS and Linux, reached through a TUI or native desktop client. See [architecture](docs/architecture.md) and [usage](docs/usage.md).

## Domain Terms

**Desktop client**: The native Ruukoto application, hosted by Electron or MyGo and connected to the local backend.

**Workflow definition**: A named, versioned orchestration script. Updates retain previous versions and history. A definition is not a run.

**Workflow run**: One background orchestration, explicitly started by the owner or by a model within task authorization, with fixed script version, parameters and source permissions. Its lifecycle differs from the initiating task.

**Workflow step**: Work registered under a stable key within a run. It is not a work-checklist item.

**Step attempt**: One actual Agent execution of a step. Cache reuse and host operations are not attempts.

**Host-operation task**: A short-lived task derived from a workflow run and executed by the host without a model call. Distinct from its initiating task and step attempts.

**Overlay**: TUI interaction placed over content while the main screen remains visible. Distinct from a window.

**Window**: A fully bordered TUI interaction that hides the main screen while open. Not an overlay.

**Ruukoto**: The sole software-work assistant. It supports multiple workspaces, multiple conversations per workspace and one level of SubAgent collaboration. A coding task is a kind of work, not a second product or this repository’s development instance.

**Product composition**: Application entry points and business wiring assembling the runtime and clients. This differs from development-profile isolation.

**Profile selection**: The complete raw choice of data, configuration, control and pending locations. Distinct from the activated profile’s resolved storage paths.

**Profile**: One activated instance with bound storage, configuration, control and pending state. A fresh profile does not import a predecessor’s history or authority.

**Main Agent**: The Agent interacting directly with the owner in a user conversation, delegating to SubAgents and collecting results.

**SubAgent**: A subordinate Agent with an independent work context. It communicates with its parent and other SubAgents participating in the same work, not directly with the owner, and cannot create its own SubAgents. Task completion normally leaves it idle with retained identity/context for further work in the same user conversation. The main Agent or owner explicitly closes it; task completion is not Agent closure.

**SubAgent role**: A named responsibility, tool requirement, permission policy and prompt definition. Distinct from Agent identity, work and access mode. Configuration is not authorization.

**Conversation history**: The complete messages already produced in a conversation, available for inspection. It is not necessarily all the content in each model request.

**Model context**: Input assembled for one model call, possibly containing or referencing history. A message absent from this request is not thereby forgotten or deleted.

**Reference block**: Marked host-injected reference content: project instructions, skill catalog, memory, continuation source, plan guidance and work checklist. The first three precede history and remain stable across tasks; continuation/plan references belong to the current task, while the checklist retains conversation step state, and these three precede current input. Plan guidance is host-authored; the checklist comes from existing dialogue; other references come from owner configuration or earlier tasks. They are neither conversation history nor new owner instructions. Compaction summaries/removal markers are lossy annotations, not reference blocks. Skill bodies loaded by tools or explicit invocation belong to history, not references.

**Context compaction**: Assembly substitutes placeholders for older tool results and rolling summaries for older dialogue, marking coverage and how to recover originals. History is unchanged. Summaries are not history, memory or owner instructions; assembly disables Pi’s own compaction.

**Compaction point**: One compaction result, including summarized/cleaned ranges and summary text. At most one is active per conversation and is reused unchanged until the next compaction. Not a history checkpoint or branch.

**Selection record**: Pre-send assembly facts: selected/removed messages and memories, instruction/skill versions, compaction point, estimates and budget. The owner can inspect it; failed persistence blocks the call. It is not the sent prompt text, which has a separate snapshot, or the history itself.

**Long-term memory**: Sourced preferences, conventions, confirmed decisions and experience accumulated through use. Entries can be revised/revoked and are stored separately from history. Neither all history nor temporary progress is memory.

**Workspace**: A registered development root and its conversations, possibly containing several repositories. The owner selects an ordinary root; a chat started without directory selection gets its own managed root under the current instance's `workspace/<workspace-id>` on first send. Independent managed chats have separate workspace/data identities; branches reuse their source workspace and files. Closing, restarting and archiving retain roots and history. A SubAgent work copy is an execution copy within that workspace's work, always retained without a delete entry. It need not become a separately managed user workspace.

**Source-data grant**: An explicit, inspectable and revocable owner grant through a trusted entry, scoped by source workspace, target workspace and history/artifact/memory category. Revocation affects subsequent queries and context injection. Filesystem grants and full access do not implicitly broaden data-API scope.

**Project instructions**: Explicitly configured workspace instruction files supplied as references. They change neither control identity nor approvals/access policy. They are not automatically discovered context files; runtime discovery is off by default.

**Skill**: Owner-supplied Agent Skills instructions and references, loaded on demand or explicitly invoked. Skills add neither tools nor permissions and cannot change control identity, approvals or access mode. Distinct from project instructions and Agent-writable long-term memory.

**Conversation**: Persistent interaction with independent history. User conversations contain owner/main-Agent dialogue; one work assignment may span several turns. A SubAgent work context is not a new user conversation.

**Conversation branch**: An independent conversation created at a consistent persisted-history point of an ordinary development conversation, retaining applicable settings and verified source references. Parent and child then evolve independently. It is not a Git branch, work copy, file snapshot or SubAgent. Reading the source does not authorize management of its original tasks/work.

**Conversation identity**: Host-bound eligibility for entries and execution: ordinary development, SubAgent or tool-free side conversation. Scheduled runs are host-managed ordinary conversations with fixed provenance. Side chat fixes its first snapshot and is excluded from ordinary lists and Agent data. Task parameters/model output cannot change identity.

**Work delegation**: An owner assignment carried across turns and multiple main/child tasks. Canceling work affects its active/queued tasks, not a currently running wakeup round, and does not close the SubAgent or destroy identity/history/artifacts. Work, task and SubAgent lifecycles are separate.

**Task**: One accepted execution with its own state, outcome and authority. Client disconnect does not cancel it. Interruption is owner-controlled; unknown effects require verification rather than automatic replay.

**Work checklist**: Steps and pending/in-progress/completed state maintained by an Agent across tasks in a conversation. Not the owner's business-data todo list, a schedule, memory or an authorization source.

**Confirmation mode**: Execute within granted permissions; wait for owner approval when an operation exceeds them. The execution environment enforces the boundary.

**Full-access mode**: Explicit owner permission to use the backend account's existing files, network and tools without a task sandbox or per-operation approval. It inherits that account's environment except internal Ruukoto control variables, including access to same-account backend data/credentials/tokens. It grants no additional OS rights. Derived work uses source authority fixed at registration; unverified stopping retains occupancy. It does not promise to reclaim deliberately detached processes or external services.

**Auto-review mode**: The same restricted execution environment as confirmation mode. An independent tool-free review evaluates out-of-scope external file reads and credential-free HTTP reads as approve/reject/ask_owner. Uncertainty or review failure asks the owner. It neither broadens authorization nor becomes full access; instructions in review input are not authority.

**Conversation default mode**: The owner's choice for later new tasks: confirmation, full access, auto-review or plan. It persists until changed but does not rewrite existing tasks. A later message creates a new task using its submission's choice; queue resumption does not rerun an interrupted task. Four UI choices do not mean four distinct access policies.

**Plan mode**: Owner-selected ongoing research/planning in an ordinary development conversation, using auto-review's restricted environment and approval policy with narrower tools and plan guidance. It is not a comprehensive read-only guarantee, a separate security boundary, approval of specific operations or a scheduled task.

**Approval request**: A task's request for permission for one specific pending operation and stated scope. Code/storage `ConfirmationRequest` names this same concept.

**Approval consumption**: Atomic one-time use immediately before execution, requiring an active task, unchanged permission version and unused approval. Consumption marks execution start; an unknown result is not retried. Failed post-approval revalidation/consumption invalidates approval and records known-not-executed. Approved-but-unconsumed does not mean executed.

**Effect unknown**: Execution started but its effect cannot be established, including unfinished operations at stop/restart and sent writes with timeout/disconnect/abort. The owner verifies; automatic replay is forbidden. Committed receipts can establish the actual result. Unconsumed approval or an unsent request is known not executed; interrupted reads have no write effect. Tool-operation uncertainty and send-operation `effect_unknown` share semantics but are separate records.

**Lost response**: A control request was sent but no conclusive response is available because of timeout, disconnection, response limits or backend failure. Never retry a write with a new key automatically. Idempotent submissions/workspace entries are checked by original key and resent only with that key after known nonacceptance; other writes require state inspection and owner choice. Unsent requests and explicit rejection are not lost responses. Do not restore a draft as if the write failed; this is distinct from tool-effect uncertainty.

**MCP service**: Owner-configured external tools shared across this instance’s workspaces. Ordinary services use HTTPS and credential references; Cua uses a fixed managed stdio program/target. Allowlists, enabled state and versions constrain calls. Writes/unknown effects follow operation approval policy; remote read-only hints grant no authority. Cua is not arbitrary local command execution.

**Orchestrator**: Host component coordinating delegation and result return. Not an Agent interacting directly with the owner.

**Delivery**: A SubAgent result or work message enters a main-Agent model call. Trusted internal reports may enter the active task’s next request after the current tool batch settles; ordinary unwaited results retain next-task injection. Registration alone is pending, not delivered. Canceled work blocks delivery while preserving inspectable facts.

**Child task**: A concrete task assigned to a SubAgent for work whose result returns to the main Agent. Neither the executing SubAgent nor the whole assignment.

**Configuration center**: An authenticated UI for providers, model catalog/keys/defaults/summary model, project instructions, instance Web Search, source grants, conversation defaults and MCP. Concurrent saves validate revisions/versions. Provider/catalog/key changes apply only with no affected running or queued tasks. Offline setup activates new storage before configuring models; it does not substitute for task approval.

**Development instance**: This repository’s checkout-isolated profile. `npm run dev` owns this run’s backend/UI and stops them on exit. It is not a production replacement or a reason to weaken protected-root checks.

**Schedule**: A one-shot, daily or weekly rule with fixed timezone, title, workspace, model, effort and creation authority. Configuration edits affect future work. Description is not authorization; a schedule is not a work-checklist item.

**Schedule run**: One execution covering initial task, derived work, questions and result, unique by schedule/version/original due time. At most one unfinished run exists per schedule; missed times coalesce. Each run retains an independent conversation and result, not a replay obligation for every missed time.
