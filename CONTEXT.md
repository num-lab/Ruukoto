# Ruukoto Domain

Ruukoto contains the development tool `ruukoto-code` and personal assistant `ruukoto`. Coding runs on a development machine, primarily through a TUI; Personal runs on a dedicated Linux server, primarily through IM. See [architecture](docs/architecture.md) and [usage](docs/usage.md).

## Domain Terms

**Desktop client**: The Ruukoto macOS application. Code and Personal are product targets, not modes.

**Workflow definition**: A named, versioned Coding orchestration script. Updates retain previous versions and history; Personal does not use this definition library. A definition is not a run.

**Workflow run**: One background orchestration, explicitly started by the owner or by a model within task authorization, with fixed script version, parameters and source permissions. Its lifecycle differs from the initiating task.

**Workflow step**: Work registered under a stable key within a run. It is not a work-checklist item.

**Step attempt**: One actual Agent execution of a step. Cache reuse and host operations are not attempts.

**Host-operation task**: A short-lived task derived from a workflow run and executed by the host without a model call. Distinct from its initiating task and step attempts.

**Overlay**: TUI interaction placed over content while the main screen remains visible. Distinct from a window.

**Window**: A fully bordered TUI interaction that hides the main screen while open. Not an overlay.

**Coding Agent (`ruukoto-code`, formerly `ruukoto-dev`)**: An agentic coding tool on the development machine. It supports multiple workspaces, multiple conversations per workspace and one level of SubAgent collaboration. Distinct from the retired coding role, the `dev` conversation category and this repository's development instances.

**Personal Agent (`ruukoto`)**: A general personal assistant on a dedicated Linux server, reached mainly through IM, with an expanding range of tasks. It is not limited to coding or QQ group chat; general purpose does not require every capability in its first release.

**Product composition**: Each product's entry points and business wiring. Durable owns Personal conversations/execution; Coding uses the shared foundation. Sharing a repository does not require a shared runtime, storage or client protocol. This differs from development-profile isolation.

**Capability declaration**: Host-code facts in Coding/legacy `product.ts`: identity, owner IM, personal scheduling, service management, exclusive tool families, default execution backend, legacy-project write eligibility and import direction. Models, task arguments and configuration pages cannot change these declarations.

**Main Agent**: The Agent interacting directly with the owner in a user conversation, delegating to SubAgents and collecting results. Personal calls it `main`. It is not the repository or the Coding product itself.

**SubAgent**: A subordinate Agent with an independent work context, available in both products. It communicates with its parent and other SubAgents participating in the same work, not directly with the owner, and cannot create its own SubAgents. After task completion it normally becomes idle, retaining identity/context for further work from the same main Agent in the same user conversation. The main Agent or owner explicitly closes it. A SubAgent is neither one child task nor the retired fixed coding role; task completion is not Agent closure.

**SubAgent role**: A named responsibility, tool requirement, permission policy and prompt definition. Distinct from Agent identity, work, access mode and legacy main/coding/chat roles. Configuration is not authorization.

**Main conversation**: Personal's one persistent owner conversation shared by its entries. Main can keep responding while long work is delegated; one conversation does not imply one execution or forbid independent child contexts.

**Owner IM entry**: The owner's private channel to Personal on one platform, sharing main. The host pins destination and expected sender. Any configuration/credential change starts a new generation; old-generation messages, approvals and sends become invalid rather than being redirected. Webhooks and retired group-chat entries are not owner IM entries.

**Shared memory**: Owner-approved personal preferences and general experience intended for both products; changes to cross-product preferences also need owner confirmation. Distinct from history, schedules and task progress. Existing instance-local Personal memory does not establish cross-instance sharing.

**Plugin**: An extension unit through which the owner adds/customizes Personal capability. Its precise boundary remains open; a plugin marketplace/developer platform is not a project goal.

**QQ group-chat extension**: An independently runnable/stoppable extension owning group conversations, history and send state, supplying results through a limited interface. Not the core chat role or a main SubAgent; a group member is not the owner.

**Conversation history**: The complete messages already produced in a conversation, available for inspection. It is not necessarily all the content in each model request.

**Model context**: Input assembled for one model call, possibly containing or referencing history. A message absent from this request is not thereby forgotten or deleted.

**Reference block**: Marked host-injected reference content: project instructions, skill catalog, memory, continuation source, plan guidance and work checklist. The first three precede history and remain stable across tasks; continuation/plan references belong to the current task, while the checklist retains conversation step state, and these three precede current input. Plan guidance is host-authored; the checklist comes from existing dialogue; other references come from owner configuration or earlier tasks. They are neither conversation history nor new owner instructions. Compaction summaries/removal markers are lossy annotations, not reference blocks. Skill bodies loaded by tools or explicit invocation belong to history, not references.

**Context compaction**: Shared assembly substitutes placeholders for older tool results and rolling summaries for older dialogue, marking coverage and how to recover originals. History is unchanged. Summaries are not history, memory or owner instructions. Shared assembly disables Pi's own compaction; Personal durable uses native compaction while retaining original entries.

**Compaction point**: One compaction result, including summarized/cleaned ranges and summary text. At most one is active per conversation and is reused unchanged until the next compaction. Not a history checkpoint or branch.

**Selection record**: Pre-send shared-assembly facts: selected/removed messages and memories, instruction/skill versions, compaction point, estimates and budget. The owner can inspect it; failed persistence blocks the call. Personal durable records selection through actual request snapshots. A selection record is not the sent prompt text, which has a separate snapshot, or the history itself.

**Long-term memory**: Sourced preferences, conventions, confirmed decisions and experience accumulated through use. Entries can be revised/revoked and are stored separately from history. Neither all history nor temporary progress is memory.

**Workspace**: An owner-selected development root and its conversations, possibly containing several repositories. A SubAgent work copy is an execution copy within that workspace's work, always retained without a delete entry. It need not become a separately managed user workspace.

**Project (legacy)**: The pre-migration boundary grouping development work and history, possibly with conversations in different directories. Current products use workspace/conversation organization; legacy data and permissions need explicit mapping.

**Workspace organizational membership**: Owner-set display grouping of legacy conversations under workspaces. Explicit mapping wins; otherwise original grouping applies. Data identity/configuration remain the original project's, and task identity/execution/content do not move. Do not use this display mapping as AccessScope, tool identity or credential scope.

**Instance import**: One-time import of old development data into a Coding profile, with receipts and an item ledger. Personal starts blank and keeps old data archived in place. The owner previews read-only, confirms a plan file, then applies/reverts with the target offline. Source data remains untouched on every path. New source content is reported and can be imported later; this is not cross-product synchronization. Organizational mapping is not data movement, and the target backup is not an online rollback tool.

**Source-data grant**: An explicit, inspectable and revocable owner grant through a trusted entry, scoped by source project, target project and history/artifact/memory category. Revocation affects subsequent queries/context injection; ownership follows the migration mapping. `grantedPaths` and full access do not implicitly broaden data-API scope.

**Project instructions**: Explicitly configured workspace instruction files supplied as references. They change neither control identity nor approvals/access policy. Legacy-project configuration follows migration mapping. They are not automatically discovered context files; runtime discovery is off by default.

**Skill**: Owner-supplied Agent Skills instructions and references, loaded on demand or explicitly invoked. Skills add neither tools nor permissions and cannot change control identity, approvals or access mode. Distinct from plugins, project instructions and Agent-writable long-term memory.

**Conversation**: Persistent interaction with independent history. User conversations contain owner/main-Agent dialogue; one work assignment may span several turns. A SubAgent work context is not a new user conversation.

**Conversation branch**: An independent conversation created at a consistent persisted-history point of an ordinary development conversation, retaining applicable settings and verified source references. Parent and child then evolve independently. It is not a Git branch, work copy, file snapshot or SubAgent. Reading the source does not authorize management of its original tasks/work.

**Conversation identity**: Host-bound eligibility for entries and execution: ordinary development (unbound Coding user conversation; active Code schedules are host-managed), `main`, independent Personal scheduled conversation, SubAgent, tool-free Coding side conversation, or retired archive (old QQ group/chat/coding, read-only). Side chat fixes its first snapshot and is excluded from ordinary lists and Agent data. Task parameters/model output cannot change identity. Identity differs from stored categories such as `dev`/`qq_group`; Code schedule provenance is not Personal scheduled identity.

**Work delegation**: An owner assignment carried across turns and multiple main/child tasks. Canceling work affects its active/queued tasks, not a currently running wakeup round, and does not close the SubAgent or destroy identity/history/artifacts. Work, task and SubAgent lifecycles are separate.

**Task**: One accepted execution with its own state, outcome and authority. Client disconnect does not cancel it. Coding interruption is owner-controlled; Personal automatically recovers only safe work and requires verification of unknown effects.

**Work checklist**: Steps and pending/in-progress/completed state maintained by an Agent across tasks in a conversation. Not the owner's business-data todo list, a schedule, memory or an authorization source.

**Confirmation mode**: Execute within granted permissions; wait for owner approval when an operation exceeds them. The execution environment enforces the boundary.

**Full-access mode**: Explicit owner permission to use the backend account's existing files, network and tools without a task sandbox or per-operation approval. It inherits that account's environment except internal Ruukoto control variables, including access to same-account backend data/credentials/tokens. It grants no additional OS rights. Derived work uses source authority fixed at registration; unverified stopping retains occupancy. It does not promise to reclaim deliberately detached processes or external services.

**Auto-review mode**: The same restricted execution environment as confirmation mode. An independent tool-free review evaluates out-of-scope external file reads and credential-free HTTP reads as approve/reject/ask_owner. Uncertainty or review failure asks the owner. It neither broadens authorization nor becomes full access; instructions in review input are not authority.

**Conversation default mode**: The owner's choice for later new tasks: confirmation, full access, auto-review or plan. It persists until changed but does not rewrite existing tasks. Continuing an interrupted task uses the current submission's choice. Four UI choices do not mean four distinct access policies.

**Plan mode**: Owner-selected ongoing research/planning in an ordinary development conversation, using auto-review's restricted environment and approval policy with narrower tools and plan guidance. It is not a comprehensive read-only guarantee, a separate security boundary, approval of specific operations or a scheduled task.

**Approval request**: A task's request for permission for one specific pending operation and stated scope. Code/storage `ConfirmationRequest` names this same concept.

**IM approval control message**: A control action from the original bound private chat. The host parses complete original text and persists decision plus fixed receipt intent in the receive transaction, without model execution or ordinary dispatch. Shared runtime uses commands; Personal durable accepts replies to host-generated menu choices and sends receipts through native background tasks. Lists/details/decisions are restricted to original platform, account, owner and generation; approval binds the original request/permission snapshot and is single-use. Forwarded/quoted text or natural language is not approval; accepted approval is not successful execution.

**Standing operation permission**: Owner-created, inspectable/revocable authority for an exact operation/target, saved from pending approval on the original IM platform. Its scope is immutable and versioned in protected backend storage. Revocation or failed verification increments the version and invalidates scope; later calls need individual approval. Only exactly matching operations pass after host revalidation. Models, child messages, TUI submissions, schedules and other platforms cannot create, broaden or inherit it. It is neither arbitrary root access nor cross-platform authority from sharing main; a candidate match must be verified before use.

**Approval consumption**: Atomic one-time use immediately before execution, requiring an active task, unchanged permission version and unused approval. Consumption marks execution start; an unknown result is not retried. Failed post-approval revalidation/consumption invalidates approval and records known-not-executed. Approved-but-unconsumed does not mean executed.

**Effect unknown**: Execution started but its effect cannot be established, including unfinished operations at stop/restart and sent writes with timeout/disconnect/abort. The owner verifies; automatic replay is forbidden. Committed receipts can establish the actual result. Unconsumed approval or an unsent request is known not executed; interrupted reads have no write effect. Tool-operation uncertainty and send-operation `effect_unknown` share semantics but are separate records.

**Lost response**: A control request was sent but no conclusive response is available because of timeout, disconnection, response limits or backend failure. Never retry a write with a new key automatically. Idempotent submissions/workspace entries are checked by original key and resent only with that key after known nonacceptance; other writes require state inspection and owner choice. Unsent requests and explicit rejection are not lost responses. Do not restore a draft as if the write failed; this is distinct from tool-effect uncertainty.

**MCP service**: Owner-configured external tools. Ordinary services use HTTPS and credential references; Cua uses fixed managed stdio program/target. Configuration has allowlists, enabled state and versions; writes/unknown effects follow operation approval policy. It does not authorize arbitrary command networking/credentials, remote read-only hints do not grant rights, and Cua is not arbitrary local command execution. Coding workspaces share instance services; Personal profiles and secrets remain separate.

**QQ group entry (legacy)**: The old core adapter grouped messages by login account/group, separate from personal development data. It is retired: ignore new group messages, preserve old history/send/receive/withdrawal records read-only, remove group-write entries and never convert group conversations into ordinary development conversations. The standalone extension is later work. QQ identity, including the owner speaking in a group, is not backend owner authentication; message text cannot supply project/access/management identity.

**Logical role (legacy)**: Old `main`, `coding`, `chat` identities for personal interaction, fixed delegation and group chat. Coding/chat are retired; setup only creates main, and old role rows/conversations/tasks are read-only. `dev` is not a fourth role and old roles are not current product boundaries.

**Group result**: Bounded summary and provenance of a completed old group task. Only explicit main acceptance makes its fixed snapshot available for synthesis/notification; receipt and external-send authorization are separate. No new core group results are produced. Accepted historical results remain inspectable; missing/inconsistent archive, unavailable main or withdrawn source cancels sending. A result is not full group history or permission to read raw group data, claim owner identity or send automatically.

**Orchestrator**: Host component coordinating inbound dispatch, delegation and result return. Not an Agent interacting directly with the owner; the old fixed coding delegation limit does not define general SubAgents.

**Inbound event**: Persisted shared-orchestrator acceptance of messages/timers and other sources, before task creation. `(source, external_id)` deduplicates it and prevents duplicate tasks. Registration does not authorize replay of unknown external effects.

**Inbound media staging**: Files and receive records bound to the original message before task-artifact promotion. State can indicate received, rejected, expired or assigned. An unassigned staged image is not a task artifact; rejection is not an ordinary inbound task.

**Delivery**: A SubAgent result/work message enters one main-Agent model call: at wakeup-task start for main, or injection at the next task start for ordinary development. Registration alone is pending, not delivered. Canceled work blocks delivery while preserving inspectable facts. Distinct from an external owner reply.

**Child task**: A concrete task assigned to a SubAgent for work whose result returns to the main Agent. Neither the executing SubAgent nor the whole assignment.

**Application data space**: Personal structured business storage declared by main, separate from core storage, used through host tools by main and independent scheduled conversations. Storage validates names, types, sizes, relations and versions. Nondestructive changes are automatic; dropping tables/fields/unique indexes, multirow writes and bulk rewrites require individual restricted-mode approval. Full access omits operation approval but still verifies task, permission version and parameters, recording authority. Every change has a task/version/reason audit receipt. Preferences/conventions/decisions belong in memory. This is not a general SQL engine or access to core task/approval/event/credential tables.

**Configuration center**: Coding's independent authenticated UI for providers, model catalog/keys/defaults/summary model, project instructions, instance Web Search, source grants, conversation defaults, MCP, QQ and service credentials. Concurrent saves validate revisions/versions. Provider/catalog/key changes apply only with no affected running or queued tasks. Limited offline mode cannot edit project/conversation/MCP/QQ records. It is not a substitute for task approval.

**Development instance**: This repository's isolated development profiles. `npm run dev` starts Personal; `npm run code` starts Coding and defaults to TUI. Each launcher owns this run's backend/UI and stops them on exit. See [development](docs/development.md#development-instances). It is not a production replacement or reason to weaken protected-root checks.

**Workspace entry (legacy)**: Old `ruukoto <path>` creation of a development conversation using existing project membership. Role/QQ-specific conversations did not supply ordinary-workspace ownership.

**Schedule**: A one-shot, daily or weekly rule with fixed timezone, description and creation authority. Personal pins tools, sources and optional reporting target and requires cancellation/recreation for changes. Coding pins title, workspace, model and effort while supporting future configuration edits. Description is not authorization; a schedule is not main's business-data todo/reminder row.

**Schedule run**: One execution covering initial task, derived work, questions and report, unique by schedule/version/original due time. At most one unfinished run exists per schedule; missed times coalesce or only the most recent is caught up. Personal reports to its fixed target; Coding retains an independent conversation and result. Each missed time is not a separate replay obligation.

**Send operation**: A host-recorded outgoing action with fixed target, content and ID; states are pending/sending/sent/failed/effect_unknown/canceled. The host owns its logical key; uncertainty never triggers a fresh-key retry. Only explicit rate-limit rejection proving no send allows sending→pending after delay. Unknown is not successful cancellation.

**QQ private entry**: The owner's configured friend-private-chat entry into main, shared with Telegram, including verified owner approval replies. Platform identity is not general control authentication; friend chat is not a temporary group conversation; sharing main does not open independent group data.

**Owner reply**: Main's response to an accepted owner assignment, including asynchronous final reporting, sent to the original entry/owner. Work finalization registers it against the initiating event's fixed destination; canceled work does not report, duplicate registration is idempotent, and changed/disabled destinations cancel rather than redirect. Arbitrary scheduled/child wakeups do not authorize sending; a conversation's latest answer does not identify one work item's final report.

**GitHub review entry (legacy composition)**: Owner-enabled PR events triggering read-only review by a host-fixed SubAgent, reported by main to a fixed owner for a specific PR revision. New Personal does not assemble it; old archives remain. A review result is not approval to publish a comment, and no observed change does not prove the remote revision is unchanged.
