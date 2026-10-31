# Usage Guide

Daily operation, configuration, service management and troubleshooting for Personal (`ruukoto`) and Coding (`ruukoto-code`). See [architecture](architecture.md), [module designs](modules/) and [development](development.md) for other audiences.

## 1. Prerequisites and Installation

Both products use native execution; Docker is unnecessary. Install Node ≥ 24.15.0, Bash, Git and ripgrep (`rg`) in PATH. Development checks also require Python 3 with PTY support.

| Platform | Native prerequisites |
| --- | --- |
| macOS | Command Line Tools/Clang and system Seatbelt |
| Linux | bubblewrap, cgroup v2 and systemd user manager; persistent Personal service needs linger |

See [native setup](../deploy/native/README.md) for the complete platform checks.

```bash
npm run setup       # Install dependencies, verify prerequisites, install Git hook
npm run build       # Build workers, native supervisors and product packages
npm link            # Optional: add both commands to PATH
```

## 2. Start and Run

| Product | Main interfaces | Default profile |
| --- | --- | --- |
| Personal | Menu, QQ/Telegram private chat, PA desktop | `~/.ruukoto-durable/` |
| Coding | TUI and Coding desktop | `~/.ruukoto-code/` |

### 2.1 Start the Backend

```bash
ruukoto serve                          # Personal foreground backend
ruukoto serve --directory /path/to/dir # Explicit independent profile
ruukoto-code server                    # Coding foreground backend
ruukoto-code stop                      # Stop Coding backend
```

Production restricted execution defaults to native and rejects legacy `local`/`container` overrides. Full access uses the starting account without a task sandbox.

### 2.2 Coding Agent

```bash
ruukoto-code                     # Open an existing conversation
ruukoto-code ~/code/my-project   # New conversation in this workspace
ruukoto-code config              # Model and parameter configuration
```

The TUI discovers an existing backend or starts one on demand, logging to `<controlDir>/spawn.log`, then connects when ready. Instance locking coordinates competing startup attempts. Closing the TUI or terminal does not cancel backend work; stop the service explicitly when intended.

### 2.3 Development Instances

```bash
npm run dev                      # Watched Personal development backend
npm run code                     # Coding development backend and TUI
```

These use profiles separate from daily data. Their launchers own and stop the development backend/UI when they exit; [development](development.md#development-instances) explains environment cleanup and reload behavior.

### 2.5 Personal Agent Management

`ruukoto` or `npm start` opens guided model configuration, backend controls, pairing, work and questions. `--directory` or `RUUKOTO_PERSONAL_DIR` selects a separate profile. Choose a new directory for production durable operation; old profiles stay archived.

| Command | Purpose |
| --- | --- |
| `ruukoto settings` | Bounded JSON online/offline model/MCP management and read-only skills |
| `ruukoto maintenance` | Verify and explicitly start/stop the original system service |
| `ruukoto remote` | Local pairing and credential management |
| `ruukoto remote serve` | Private remote service behind Tailscale Serve |

Settings writes use original-key receipts to distinguish saved, applied and uncertain outcomes. Closing the daily menu does not stop an already running production backend; choose its stop action. IM `/帮助` lists available commands; `/后台` shows logs and controls Personal session background work.

## 3. Models and Configuration

Personal's capability/model menu guides provider selection, credential environment-variable references and explicit connection tests. Environment references avoid copying credentials into a new profile, but the selected backend process must actually receive those variables.

Coding's `ruukoto-code config` manages providers, models, defaults and summary-model choices. Saved provider/catalog/key changes apply only when no affected running or queued tasks prevent them; distinguish a saved revision from an applied one. A conversation model choice applies to later submissions, not an already running task.

## 4. Channels and Clients

### 4.1 QQ and Telegram

For Telegram, create a BotFather bot, configure its token in Personal's pairing menu, then send the generated pairing phrase from the intended owner account. QQ uses a configured OneBot WebSocket endpoint such as NapCat and its guided owner pairing. Use dedicated owner-private entries; group membership is not owner authentication.

IM defaults to auto-review. Sensitive operations require explicit approval through the original bound entry. A platform/account/credential change creates a new generation; old approvals and sends cannot move to the new destination.

### Desktop Client

On the server, use `ruukoto remote` to manage pairing, then connect the PA desktop to the verified Tailscale HTTPS origin using the generated one-time code. HTTPS/WSS terminates at Tailscale Serve and reaches the private remote service; the local Unix socket is not a public network endpoint. See [deployment](../deploy/systemd/README.md) for backend/remote-service ownership and [desktop](modules/desktop.md) for credential isolation.

## 5. Extended Capabilities

### 5.1 MCP Services

Both products use Pi 1.3.0 for Streamable HTTP services and fixed managed Cua programs. Ordinary services support anonymous access or existing Bearer references. The owner chooses allowed tools and local read/write/unknown-effect classifications.

| Operation | Entry and behavior |
| --- | --- |
| Configure service | Coding's instance MCP settings; Personal's desktop or native management |
| Migrate old Personal configuration | Explicitly migrate to v4, preserving original references/history before new business calls |
| Change credentials | Explicitly rebind and save; newline-only changes do not change new token identity, while a changed token invalidates old unstarted approval |
| Inspect/end unknown call | Personal Calls section; explicitly end work while retaining uncertainty; after a lost response, refresh the original call first |
| Recover computer | Verify original stop → obtain fresh image → view and accept that observation |

Authorized reads need no individual approval; writes/unknown effects follow the current approval policy. A lost reply to a sent write stops that source's automatic business execution. Manual finalization retains uncertainty; new independent work can use the same service. Computer recovery still requires real stop evidence and fresh-image acceptance; see [the desktop flow](modules/desktop.md#mcp-call-finalization-and-computer-recovery).

### 5.2 Skills

Both products discover skills under the **backend account's** `$HOME/.agents/skills/`. Production and development under one account share that directory; remote PA uses the server account's HOME. Each package has a `SKILL.md` name, description and body. Maintain files there directly; desktop and Personal menus provide read-only catalogs/diagnostics.

The model initially sees names/descriptions and loads bodies/references with `skill`. The owner can explicitly invoke `/skill:name arguments`. Coding pins the body version at task start; Personal refreshes and snapshots before each model request. Skills supply references, not permissions or additional tools.

Coding `bash` or a Personal child's `run_command` executes skill scripts by their directory paths under existing eligibility, approvals and sandbox rules. Restricted native execution mounts selected skill directories read-only. Source is not read by default; `skill` with `path` remains available for audit/debugging.

Existing files/managed packages remain in place, but current discovery uses only the fixed directory. Move skills still needed into it. Old history uses its original snapshots; schedules bound to other sources require original-run verification followed by cancellation/recreation.

### 5.3 Browser

With browser capability enabled, the Agent can navigate, click, type, extract page text and capture screenshots using a visible or headless browser. Screenshots remain binary artifacts and are previewed on demand. Browser login/session access is the user's existing browser context, not an expansion of unrelated command permissions.

<a id="12-browser"></a>

### 5.4 Scheduled Tasks

Schedules are one-shot, daily or weekly rules in a fixed IANA timezone. Coding's Scheduled interface fixes title, workspace, model, effort and access policy for a run and retains its independent conversation/results. Personal schedules fix tools, sources and optional original reporting targets; changes require cancellation/recreation. Missed occurrences coalesce rather than blindly replaying every missed run. [Scheduling](modules/scheduler.md) explains outcome and sending semantics.

### 5.11 Workflows, Questions and Reports

Coding workflows combine isolated Agent steps, dependencies, owner questions and checked integration. Use `/workflow` to inspect runs, start definitions and operate on the selected item. [Workflow design](modules/workflows.md) describes versioning and controls.

`ask_user` presents one to three structured questions. Answers resume their original work; they do not approve unrelated tools. `/questions` supports choices, free text and cancellation. Personal background analysis lets main keep chatting, query progress and receive a report when the original work completes.

## 6. Import and Archive

### 6.1 Import a Legacy Instance

Coding imports development data through a read-only preview and an explicitly reviewed plan. Keep the target offline when applying or reverting.

```bash
ruukoto-code legacy-import preview --from /path/to/source-data --plan /path/to/plan.json
# Review and confirm the generated plan before applying it.
ruukoto-code legacy-import apply --plan /path/to/plan.json
ruukoto-code legacy-import list
ruukoto-code legacy-import revert <import-id>
```

The source remains read-only. The target is backed up before application, and conflicts reject overwriting. Receipts and item ledgers track the import; a source's later additions are not automatic synchronization. Revert uses the recorded import ID, not the source path.

### 6.2 Personal Archive

Personal uses a new durable profile. Preserve old-format data read-only in place; it is not imported into the new Personal runtime.

## 7. Troubleshooting and Commands

### 7.1 Logs and Safe Recovery

Coding startup logs are in `<controlDir>/spawn.log`; Personal foreground output and systemd journal record service startup. Task details and artifacts expose operation errors and oversized output.

For a `runtime.lock` or `config.lock` conflict, first inspect the actual profile and holder process. `pgrep -fl ruukoto` is a useful hint, not proof of ownership or absence: process identity must be verified. Do not delete a lock merely because its PID/name looks unfamiliar. An unverified live holder requires investigation, not takeover.

For `execution_unavailable`, check the [native prerequisites](../deploy/native/README.md), built supervisor/worker paths and delegated Linux user scope. macOS requires Clang/Seatbelt; computer-control permissions are a separate feature from command sandbox setup.

### 7.2 Commands

| Command | Purpose |
| --- | --- |
| `/help` | Commands and keys |
| `/todo` | Toggle work checklist |
| `/resume` | Switch conversations |
| `/project` | Workspace/legacy-project selection |
| `/new-project <name>`, `/new-session <directory>`, `/new` | Legacy project, current-project conversation, or current-workspace conversation |
| `/branch [name]` | Branch persisted ordinary Coding history and switch; no model call; names can contain spaces |
| `/side` | Toggle tool-free side chat; Esc retains its draft and generation |
| `/compact [prompt]` | Summarize an idle ordinary Coding conversation, optionally giving a focus |
| `/history` | Reload history; scrolling to the top fetches older pages |
| `/artifact <id-prefix>` | Read artifact body in byte pages |
| `/approvals` | Inspect decisions; `a` approves, `r` rejects; Esc/`q` closes without rejecting |
| `/interrupt [taskId]`, `/cancel <taskId>`, `/continue [taskId]` | Task interruption/cancellation/continuation; side overlay interrupt affects side only |
| `/resume-queue`, `/queue` | Resume, inspect or reorder pending input |
| `/steer <text>` | Route input at the running task's next boundary; queue at the head if missed |
| `/model`, `/mode` | Choose model/effort or default mode for later new tasks |
| `/status` | Current task details |
| `/search <text>` | Literal search of original conversation history |
| `/memory <command>` | `list`, `show`, `revoke`, `restore` |
| `/context`, `/prompt` | Context composition and recorded model requests |
| `/skill <name> [arguments]`, `/skills` | Explicit invocation or catalog/diagnostics |
| `/workflow` | Runs, history, definitions and guided controls |
| `/processes` | Conversation backgrounds, paged output, stop and end controls |
| `/questions` | Answer, skip/cancel and review pending questions |
| `/qq <command>` | `status`, `enable`, `disable`, `groups`, `inbox`, `outbox`; last three are old group archives |
| `/quit` | Exit client while backend work continues |

A conversation branch shares its working directory, not ongoing model execution. Source read access does not grant management rights over the original work. For lost write responses, verify the original request/result before retrying; closing an approval UI is not rejection.
