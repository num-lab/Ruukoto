# Desktop Client

## Responsibilities and Boundaries

`apps/desktop/` provides graphical clients, primarily on macOS, for two **product targets**: local Coding and remote Personal. Coding connects to its Unix socket and exposes workspaces, conversation tabs, diffs, SubAgents and a terminal. Personal connects over Tailscale HTTPS/WSS to main conversation and background work.

The Node `DesktopHost` owns backend credentials. An allowlisted preload/IPC bridge exposes specific operations to React rendering, not arbitrary OS access. Shared projection belongs to [view](view.md), Coding execution to [runtime](runtime.md), and Personal persistence to [durable](personal-durable.md).

## Public Interfaces

| Host | Role |
| --- | --- |
| Electron + Chromium | Windows, Coding notifications and Dock badge, OS-protected credential storage |
| Experimental MyGo, Go + WKWebView | Native web rendering with stdio to the same Node host; also supports the Coding native browser panel |

MyGo has one native browser WebView per main conversation. Go's `browser.Manager` owns lifecycle, placement, navigation generations and input gating. Private stdio frames carry Go→Node `browser_event` facts and control→Go `kind:"request"`/`kind:"response"` commands. Node uploads screenshots/snapshots through `desktop_browser_chunk` in ≤256 KiB pieces; the backend assembles by `command_id` and SHA256. The control connection fixes task provenance. Electron does not provide this channel.

| UI entry | Behavior |
| --- | --- |
| Spotlight, `⌘K` / search icon | Search this instance's workspace conversation titles and message bodies; highlight and navigate |
| Workspace sidebar | Add directories, select conversations, access mode and model |
| Timeline | Stream input, thinking, tools and question cards; completed Agent messages offer copy/branch; branches restore source-task traces; the server-selected latest recallable owner message offers recall and restores text/attachments to this client's draft |
| PA conversation | Request-keyed owner bubbles remain visible from acceptance; completed Agent messages use the same house bubbles, with one timestamp per role group and inline operation decisions, recovery and owner questions |
| PA work and decisions | Commit events update child progress, canonical decisions across enabled families, independent work questions, superseded cards, whole-assignment cancellation and validated publication; partial prose, traces and OS notifications stay hidden |
| PA composer | Starts at one line and grows to at most one third of window height; no mode selector; the attachment button is disabled while PA file upload remains unavailable |
| Scheduled | Lists Active/Archived plans as cards with title, Instructions summary, repeat rule and next-trigger progress; details separate overview and run records; create/edit uses one centered four-step column with separate model and Effort selectors, and successful saves return to details without a success notice |
| Composer | Grows to at most one third of window height; steering targets the running task's next boundary; post-interrupt input is an ordinary new task |
| Queue above composer | Shares the composer surface; drag or use arrow keys to reorder, turn input into guidance, retrieve any eligible unstarted message and announce position |
| Inspector sidebar | Diffs, SubAgent progress, Git graph, read-only files and background logs |
| Terminal drawer | xterm.js terminal in the selected workspace |
| Code/PA Skills settings | Read-only paged catalog and diagnostics from that backend account's `$HOME/.agents/skills/` |
| Code/PA MCP settings | Coding instance services; Personal remote services, effect classes and original calls |
| Computer settings | Select fixed computer program/Linux sandbox, pause, verify stop and accept a fresh recovery image |

## Data and State

```mermaid
stateDiagram-v2
  [*] --> connecting
  connecting --> online: Authenticate and install snapshot
  connecting --> failed
  online --> reconnecting: Connection lost
  reconnecting --> online: Recover by sequence
  reconnecting --> failed
  failed --> [*]
```

Coding state binds to local `controlDir` and `ViewState`; drafts stay client-side. Queued retrieval saves its original request key before sending and restores text/attachments from that receipt independently of historical edit pause. It preserves the remaining queue and current execution. Original pending continue/old-answer requests remain inspectable under their original instance without conversion or replay.

Coding question cards stay at their original `ask_user` operation, including repeated batches in one task. Answers return receipts for that task; closing a card window does not cancel it. The activity indicator shows pending-answer waiting. Interruption persists an owner pause; resume confirms retained stopping separately when required.

Personal state binds to the remote HTTPS origin and WSS protocol, with pairing credentials protected by OS storage. Its cards retain the original family, operation, admission and displayed occurrence; backend records determine current state and allowed choices.

Personal owner display commits with native input admission and associates one request/submission with eventual history. Identical text under different requests remains separate. The sending client retains complete text under either receipt/event ordering; paired clients read the same canonical body and queued state. Reconnect inspects cached inputs and decisions outside the newest page. Completed-only Assistant rendering excludes internal report inputs and unpublished drafts.

Settings drafts and original MCP calls are separate reads. Personal ordinary tools have owner-selected disallowed/read/write/unknown-effect states; new allowed tools and migrated ordinary tools default to unknown. The explicit v4 migration preserves service and credential references plus history; original computer recovery remains available.

| Managed object | Behavior |
| --- | --- |
| Private credential file | Ordinary editing retains binding; explicit rebind is submitted with the settings save |
| Unknown ordinary call | Original timeline card and Calls section expose original parameters/result and explicit work finalization retaining uncertainty |
| Computer observation | Acceptance belongs only to the currently fully displayed fresh image; another observation or failed image load clears eligibility |

## Main Flows

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant Bridge as Preload
  participant Host as DesktopHost
  participant Backend
  UI->>Bridge: Allowlisted request
  Bridge->>Host: Validated IPC
  Host->>Backend: Unix socket / remote protocol
  Backend-->>Host: Snapshot and events
  Host-->>UI: Projected state
```

Startup discovers the local Coding backend and starts it on demand when absent. Conversation switching loads history in bounded segments. Approval cards expose operation details before approve/reject.

### PA Work and Decisions

Main delegates assignments and stays available for queries, amended requirements and whole-assignment cancellation. Decisions or recovery choices for ordinary tools, app-data, MCP/Cua, service restarts and inspections, commands, browsers and managed processes arrive through the authenticated event stream, including before main finishes its prose. Every redisplay retains the same decision. Amendments leave the old card visible with its original approval and a changed-requirements/not-executed reason; the same SubAgent prepares the current exact operation.

Before approval, the desktop reads all immutable parameter pages and the full prepared target. The host journals each native choice's exact card, payload and request ID before dispatch. After a lost response, it inspects the original canonical receipt; a missing, admitted or unverified receipt keeps that card locked through reconnect and application restart. Reopening does not resend the choice. Work progress separates accepted, actually model-read and answered instructions; stopping, publication and delivery retain their own states. The composer stays usable during waits.

Published final-file cards offer native preview and save in Electron and MyGo. The host reads authenticated 128 KiB chunks, verifies immutable metadata, exact length and final SHA-256, and holds at most 8 MiB. Partial or oversized output stays visible with complete delivery unavailable. Renderer requests contain the original origin/profile/publication/output identity, never bytes or filesystem paths. Native save selection waits for the owner's choice, then checks authentication again before an atomic local write; Quick Look uses private temporary files with viewer cleanup on replacement, connection change and exit. Transfer failure never starts another business operation.

Work questions appear inline while their original work waits. Each question batch keeps its own selection, navigation and free-text draft. A single-question single choice submits directly; multi-select waits for Done; a multiple-question batch ends with review. Free text belongs to the exact question, and canonical cancellation or version changes prevent old drafts from submitting. An unresolved answer locks only that question. IM-origin questions remain answerable through their original verified entry, with native inspection and cancellation available.

Recovery cards distinguish original receipts, current observations and immutable owner applied/not-applied claims. A claim needs no freeform evidence and does not establish stopping or delivery. Fixed checks and cleanup use the recorded target or execution; available choices come from the original family's current records. [Durable recovery](personal-durable.md#native-recovery-choices) owns the family-specific effect and resource rules.

One delegation item groups its visible member labels, progress and inspection actions with whole-assignment cancellation. It uses the original request as a fallback when members are outside the loaded page, and independently paged members still appear when their delegation is outside that page. Presence shows main processing, pending decisions or active work before report preparation; a report waiting for active members does not claim to be preparing the result. Cancellation with unverified stopping remains visible even without loaded members.

### PA Configuration Saves

Model, MCP and computer edits save directly. Refresh retains drafts; save uses the current connection and latest revision, so another entry's simultaneous edits to the same object may be overwritten. Leaving settings is allowed while the result is unknown: the desktop retains the original submission and queries save/apply outcomes when reopened. Verification, withdrawal and recovery actions appear for exceptions or unapplied changes rather than every save.

Personal model settings offer compatible installed provider/model presets while preserving the custom editor. Selection edits the draft and retains existing save/application receipts. Connection settings show shared desktop/local/Telegram and independent QQ default permissions, explain granted-scope execution, and confirm full access. Permission reads and writes bind the original connection; a save or lost response is followed by inspection, with controls locked if current values cannot be verified.

### MCP Call Finalization and Computer Recovery

Personal's original timeline card and Calls section expose explicit work finalization for an unknown ordinary MCP call. The result stays unknown; durable owns local stopping and final reporting. After a lost timeline action response, the native host checks the original choice's receipt. The timeline refreshes that original card or question before enabling further choices, including cached records outside the newest page; a failed read keeps the choice locked. Calls refreshes the original operation before further management.

The native computer recovery card verifies original CLI stopping, obtains a fresh scene, accepts that exact scene and resumes the corresponding pause:

```mermaid
sequenceDiagram
  participant Owner
  participant UI as Recovery card
  participant Backend
  Owner->>UI: Stop and verify original execution
  UI->>Backend: Clean original CLI
  Backend-->>UI: Stopped
  Owner->>UI: Inspect and recover
  UI->>Backend: Fresh read-only screenshot
  Backend-->>UI: Observation and original image
  UI-->>Owner: Display full image
  Owner->>UI: Accept this observation
  UI->>Backend: Accept current observation
  Owner->>UI: Continue this work
  UI->>Backend: Resume exact accepted pause
```

Acceptance requires every current image to be complete, hash verified and successfully displayed. A new observation invalidates the old images and their load callbacks. Timeline image reads use the bound profile's current MCP revision for every page; the original operation and observation still identify the image. Timeline and computer settings share image verification; Calls and computer settings remain available for management. There is no separate public begin-recovery action, and old recovery-started records can still obtain a new image. Cleaning the original CLI keeps the Linux sandbox running. Stopping the recorded whole sandbox is a separate confirmed choice identifying loss of memory and unsaved application state.

## Invariants and Failure Handling

- Rendering has no arbitrary filesystem/process access; the host/preload mediates operations.
- Pairing secrets use OS-protected storage rather than plaintext client configuration.
- Closing/crashing the desktop does not cancel backend work or question waits. Coding backend restart interrupts its task and makes unanswered questions stale; Personal reopens safe original waits after canonical verification.
- Manual MCP finalization preserves original uncertainty and is distinct from computer-stop verification/image acceptance.
- Lost write responses are resolved from original records, not automatic resubmission. Incomplete or failed fresh-image display cannot authorize recovery.
- Personal decisions share canonical operation identity across cards and paired devices. Pending response-loss records block connection switching and survive restart; late results cannot clear another profile's record.

## Design Rationale

- [Desktop client](../../.agents/notes/proposed/architecture/2026-10-15-desktop-client.md)
- [Shared history recovery](../../.agents/notes/implemented/architecture/2026-10-23-shared-history-recovery.md)
- [Desktop message actions](../../.agents/notes/implemented/feature/2026-10-28-desktop-message-actions.md)
- [Desktop Personal message bubbles](../../.agents/notes/implemented/feature/2026-11-01-desktop-personal-message-bubbles.md)
- [Personal desktop file loop](../../.agents/notes/implemented/feature/2026-11-04-personal-desktop-file-loop.md)
- [Personal desktop canonical choices](../../.agents/notes/implemented/feature/2026-11-05-personal-desktop-decisions.md)
- [Personal work questions](../../.agents/notes/implemented/feature/2026-11-05-personal-work-questions.md)
- [Personal native recovery facts](../../.agents/notes/implemented/architecture/2026-11-05-personal-desktop-recovery.md)
- [Personal final-file delivery](../../.agents/notes/implemented/architecture/2026-11-05-personal-final-outputs.md)
- [Personal setup presets and defaults](../../.agents/notes/implemented/feature/2026-11-05-personal-setup-presets.md)
- [Desktop Scheduled interface](../../.agents/notes/implemented/feature/2026-11-01-desktop-scheduled-interface.md)
- [Desktop spotlight search](../../.agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md)
- [Personal tailscale https](../../.agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md)
- [Home skills discovery](../../.agents/notes/implemented/simplification/2026-10-28-home-skills-discovery.md)
- [Mcp host responsibilities](../../.agents/notes/implemented/simplification/2026-10-26-mcp-host-responsibilities.md)
- [Desktop personal direct save](../../.agents/notes/implemented/simplification/2026-10-28-desktop-personal-direct-save.md)
- [Coding user queue](../../.agents/notes/implemented/feature/2026-10-30-coding-user-queue.md)
- [Same-task owner questions](../../.agents/notes/implemented/feature/2026-10-30-coding-owner-question-wait.md)
