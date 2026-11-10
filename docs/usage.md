# Usage Guide

Daily operation, configuration and troubleshooting for `ruukoto`, the software-work assistant. See [architecture](architecture.md), [module designs](modules/) and [development](development.md).

## 1. Prerequisites and Installation

Install Node ≥ 24.15.0, Bash, Git, ripgrep (`rg`) and Python 3 in PATH. Python supplies the OS interface for managed directory preparation and PTY support for development checks. Restricted execution uses native sandboxes; Docker is unnecessary.

| Platform | Native prerequisites |
| --- | --- |
| macOS | Command Line Tools/Clang and system Seatbelt |
| Linux | bubblewrap, cgroup v2 and a systemd user manager with delegated scopes |

See [native setup](../deploy/native/README.md) for the complete platform checks.

```bash
npm run setup       # Install dependencies, verify prerequisites, install Git hook
npm run build       # Build workers, native supervisors and product packages
npm link            # Optional: add ruukoto to PATH
```

## 2. Start and Run

The TUI and Electron/MyGo desktop clients connect to one local backend. Daily defaults activate fresh state under `~/.ruukoto/single-v1`; [profile selection](#6-fresh-profiles-and-old-data) also supports independent role locations.

### 2.1 Start the Backend

```bash
ruukoto server                         # Foreground backend
ruukoto --data-dir /path/data server   # Select a raw data location
ruukoto stop                           # Explicitly stop this backend
```

Production restricted execution defaults to native and rejects legacy `local`/`container` overrides. Full access uses the starting account without a task sandbox.

### 2.2 Software Work

```bash
ruukoto                     # Select a conversation or start with No workspace
ruukoto ~/code/my-project   # New conversation in this workspace
ruukoto config --offline   # Activate fresh storage and configure models without a backend
```

Without linking, use `npm start -- <arguments>`. The TUI discovers an existing backend or starts one on demand, logging to the profile’s `logs/spawn.log`. Instance locking coordinates competing starts. Closing the TUI or terminal does not cancel backend work; use `ruukoto stop` explicitly.

Choose No workspace in the TUI selector or send from Desktop New chat without selecting a directory. First send creates a persistent root under `<current-instance>/workspace/<workspace-id>`; an abandoned unsent draft creates nothing. Every independently started chat gets its own workspace and history/artifact scope. `/new` in a managed chat opens another such draft; `/new` in an ordinary workspace keeps that workspace. A branch shares its source files and permissions while its conversation history continues independently.

Managed conversations appear together as No workspace. Reopen them through the selector, sidebar or search, inspect Files, start a terminal, or reveal the folder to take files elsewhere. Close, restart and archive retain files and history. After creation, upload or submission failure, retry the retained draft to use its original workspace/session and request; reopening restores the input for explicit send. Full access and owner terminals retain the starting account's rights.

### 2.3 Development Instances

```bash
npm run dev                      # Checkout-isolated backend and TUI
npm run dev -- --config           # Configure that development profile
```

These use profiles separate from daily data. Their launchers own and stop the development backend/UI when they exit; [development](development.md#development-instances) explains environment cleanup and reload behavior.

## 3. Models and Configuration

`ruukoto config` manages providers, models, defaults and summary-model choices. `config --offline` activates storage before model readiness and writes only this fresh profile’s configuration. Saved provider/catalog/key changes apply only when no affected running or queued tasks prevent them; distinguish a saved revision from an applied one. A conversation model choice applies to later submissions, not a running task.

## 4. Clients

### Desktop Client

Electron and MyGo retain workspaces, conversations, queueing, owner questions, settings, schedules, terminal and mediated filesystem access. MyGo additionally provides the native Agent browser. Both use the same activated local profile; there is no product selector, remote pairing or Personal settings.

In conversations and New chat, type `/` to search [composer commands](modules/desktop.md#code-slash-commands). Select with the keyboard or pointer to complete the input, then submit to execute; `/help` shows commands and arguments. Model and access-mode changes in New chat stay local until first send. Manual compaction shows its original result and token estimates above the composer, with Stop while running; reconnect or reopen to inspect the same operation after a lost response.

## 5. Extended Capabilities

### 5.1 MCP Services

Pi provides Streamable HTTP services and fixed managed Cua programs. Ordinary services support anonymous access or configured Bearer references. Instance MCP settings choose allowed tools and local read/write/unknown-effect classifications. Authorized reads need no individual approval; writes and unknown effects follow the current approval policy. Remote read-only hints do not grant permission.

Use `ruukoto mcp cua` or Computer settings for managed computer configuration and recovery. Verify original execution stopped, inspect the complete fresh image, then accept that exact observation. Lost write replies retain uncertainty and never authorize automatic replay. See [tools and approvals](modules/agent-tools.md) and [control](modules/control.md).

### 5.2 Skills

Skills are discovered under the **backend account’s** `$HOME/.agents/skills/`. Daily and development instances under one account share that directory. Each skill package has a `SKILL.md` name, description and body; maintain files there directly, and use the read-only desktop catalog for diagnostics.

The model initially sees names/descriptions and loads bodies/references with `skill`; the owner can invoke `/skill:name arguments`. Task startup pins the body version. Skills supply references, not tools or permission. `bash` executes skill scripts by directory path under existing eligibility, approvals and sandbox rules; restricted native execution mounts selected skill directories read-only.

### 5.3 Browser

With browser capability enabled, the Agent can navigate, click, type, extract page text and capture screenshots using a visible or headless browser. Screenshots remain binary artifacts and are previewed on demand. Browser login/session access is the user's existing browser context, not an expansion of unrelated command permissions.

<a id="12-browser"></a>

### 5.4 Scheduled Tasks

Schedules are one-shot, daily or weekly rules in a fixed IANA timezone. Scheduled fixes title, workspace, model, effort and access policy for each run and retains an independent conversation/result. Future configuration edits do not change an active run. Missed occurrences coalesce rather than replaying every missed time. [Scheduling](modules/scheduler.md) explains run ownership.

### 5.11 Workflows, Questions and Reports

Coding workflows combine isolated Agent steps, dependencies, owner questions and checked integration. Use `/workflow` to inspect runs, start definitions and operate on the selected item. [Workflow design](modules/workflows.md) describes versioning and controls.

`ask_user` presents one to three structured questions and keeps the original task waiting. Answer or explicitly cancel through `/questions` or a desktop question card; closing the window leaves it pending. Answers return through the original tool call with its model and permissions. Ordinary messages queue, while explicit guidance cancels the pending question and enters the next request. Answers and reports do not approve tools.

Trusted Coding background reports enter the active task's next model request after the current request and tool batch finish. They wait while a question needs an answer. When the conversation is idle, report summaries run before queued owner messages; they do not appear in the user queue.

## 6. Fresh Profiles and Old Data

Directory flags `--data-dir`, `--agent-dir`, `--control-dir` and `--pending-dir` override corresponding `RUUKOTO_*_DIR` variables before stateful command dispatch. Raw data defaults to `~/.ruukoto/data`; omitted roles are its canonical siblings named agent, control and pending. Explicit equivalent defaults select the same instance.

For canonical raw data `D`, generation root `N` is `dirname(D)/single-v1` when `basename(D)` is `data`, otherwise `D + ".ruukoto-single-v1"`. Data is `N/data`; default roles map to `N/{agent,control,pending}`. An independent non-default role selection `B` maps to `B + ".ruukoto-single-v1"/<SHA-256 of D>/<role>`, keeping old contents separate. The complete raw tuple is fixed once preparation begins; changing one role then rejects with `profile_selection_conflict`. The [profile decision](../.agents/notes/implemented/architecture/2026-11-10-single-product-profile.md) owns the resolver and activation contract.

| Resolved location | Contents |
| --- | --- |
| `N/data` | Current database and runtime state |
| Resolved `agentDir` | New model/service configuration and configuration lock |
| Resolved `controlDir/owner.token` | Persistent owner authentication token |
| Resolved `pendingDir/tui`; `pendingDir/desktop` | Separate TUI and native desktop request journals; role metadata remains in their parent |
| `N/workspace`; `N/agent-work` | Managed chat roots and retained SubAgent work copies |
| `N/logs/{backend.log,spawn.log,dev.log}` | Profile-qualified runtime and launcher logs |
| `N/tui-command-history.json`; `N/reload-state.json` | TUI command and reload recovery |

Desktop drafts use `ruukoto-single-v1:<instanceId>:draft`. The authoritative socket is a private canonical system temporary endpoint, `/tmp/ruukoto-<uid>/<address>/control.sock` (`/private/tmp` on macOS), independent of long persistent control paths. Clients receive it from the resolver, never by appending a filename to controlDir.

Supply raw selections, not the qualified role directories shown above: a role marker rejects resolved-as-raw input and reports the recorded selection. Parent processes forward all four canonical raw slots; in-process clients use resolved `ProfilePaths`. Help and read-only discovery create no state. Offline configuration uses the same storage activation before model readiness, with no API key or network prerequisite to activation itself.

Recognized stopped old shared or durable profiles permit a new blank instance automatically. Nothing imports settings, credentials, committed sessions, old pending writes or execution authority. Old database/WAL/session bytes and actual workspace/work-copy source stay in place. The guard reads selected predecessor locations only; it does not search unrelated home directories.

Live or unverifiable ownership, unresolved execution/occupancy, unknown or newer formats, conflicting selections and changed directory identities reject before activation. A dead backend PID is not proof all execution stopped. Inspect the reported raw/effective paths and original resource facts; resolve old execution with its original program separately. Do not delete locks, stop old processes automatically, copy old files into the new roles or bypass identity errors with offline setup. A valid interrupted preparation resumes its reserved ID; corrupt or mismatched active roles reject instead of resetting.

## 7. Troubleshooting and Commands

### 7.1 Logs and Safe Recovery

Startup logs are profile-qualified under `N/logs`; task details and artifacts expose operation errors and oversized output. Use the effective locations reported by profile/startup errors, not an assumed global control directory.

For a `runtime.lock` or `config.lock` conflict, first inspect the actual profile and holder process. `pgrep -fl ruukoto` is a useful hint, not proof of ownership or absence: process identity must be verified. Do not delete a lock merely because its PID/name looks unfamiliar. An unverified live holder requires investigation, not takeover.

For `execution_unavailable`, check the [native prerequisites](../deploy/native/README.md), built supervisor/worker paths and delegated Linux user scope. macOS requires Clang/Seatbelt; computer-control permissions are a separate feature from command sandbox setup.

### 7.2 Commands

| Command | Purpose |
| --- | --- |
| `/help` | Commands and keys |
| `/todo` | Toggle work checklist |
| `/resume` | Switch conversations |
| `/project` | Workspace selection |
| `/new-session <directory>`, `/new` | New conversation in a workspace or a new managed draft |
| `/branch [name]` | Branch persisted ordinary Coding history and switch; no model call; names can contain spaces |
| `/side` | Toggle tool-free side chat; Esc retains its draft and generation |
| `/compact [prompt]` | Summarize an idle ordinary Coding conversation, optionally giving a focus |
| `/history` | Reload history; scrolling to the top fetches older pages |
| `/artifact <id-prefix>` | Read artifact body in byte pages |
| `/approvals` | Inspect decisions; `a` approves, `r` rejects; Esc/`q` closes without rejecting |
| `/interrupt [taskId]`, `/cancel <taskId>` | Pause ordinary Coding dispatch and interrupt the current task / cancel the selected task; side overlay interrupt affects side only |
| `/resume-queue`, `/queue` | Resume dispatch / inspect, reorder, retrieve or steer ordinary queued messages |
| `/steer <text>` | Route input at the running task's next boundary; queue at the head if missed |
| `/recall [verify]` | Recall the latest input into the draft; `verify` rechecks unresolved stopping under the original request |
| `/model`, `/mode` | Choose model/effort or default mode for later new tasks |
| `/status` | Current task details |
| `/search <text>` | Literal search of effective conversation history, excluding recalled contributions |
| `/memory <command>` | `list`, `show`, `revoke`, `restore` |
| `/context`, `/prompt` | Context composition and recorded model requests |
| `/skill <name> [arguments]`, `/skills` | Explicit invocation or catalog/diagnostics |
| `/workflow` | Runs, history, definitions and guided controls |
| `/processes` | Conversation backgrounds, paged output, stop and end controls |
| `/questions` | Answer, skip/cancel and review pending questions |
| `/quit` | Exit client while backend work continues |

Retrieving an unstarted message restores its text and attachments to the initiating draft without stopping the current task or changing the remaining queue's order or pause state. The draft-only `/detach` command removes restored attachments and is not listed in general help or completion. Historical `/recall` retains its stopping and edit-pause rules. If the latest owner input is a structured answer or Skip, historical recall rejects it rather than skipping back to the earlier requirement.

An owner pause persists across new messages, retrieval, reports and backend restart. Explicit resume starts queued work; it never reruns an interrupted task. If execution still holds directory occupancy, verify it stopped before confirming the separate stop-verification prompt. `ruukoto resume-queue <session> --stop-confirmed` records that explicit confirmation; ordinary `resume-queue` cannot release it. New messages after interruption are independent tasks in the same conversation.

A backend restart makes unanswered questions stale and interrupts the original task; client closure or reconnection alone does neither. Current profiles bind layout `ruukoto-single-v1`, schema 59, control protocol 50 and one instance ID. Pending journals accept only current requests and never read predecessor journals. Malformed current files stay visible for inspection; they are not replayed or restored as new input. Lost answers query the original receipt without automatically resending the answer.

A conversation branch shares its working directory, not ongoing model execution. Source read access does not grant management rights over the original work. For lost write responses, verify the original request/result before retrying; closing an approval UI is not rejection.
