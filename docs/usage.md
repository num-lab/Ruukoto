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

`ruukoto` or `npm start` opens three administrator groups: Configuration, Status/Start/Stop and Advanced Management. Configuration contains models, capabilities, entry pairing and default permissions; Advanced Management retains terminal chat, work, decisions and recovery. `--directory` or `RUUKOTO_PERSONAL_DIR` selects a separate profile. Choose a new directory for production durable operation; old profiles stay archived.

| Command | Purpose |
| --- | --- |
| `ruukoto settings` | Bounded JSON online/offline model/MCP management and read-only skills |
| `ruukoto maintenance` | Verify and explicitly start/stop the original system service |
| `ruukoto remote` | Local pairing and credential management |
| `ruukoto remote serve` | Private remote service behind Tailscale Serve |

Settings writes use original-key receipts to distinguish saved, applied and uncertain outcomes. Closing the daily menu does not stop an already running production backend; choose its stop action. IM `/帮助` lists available commands; `/后台` shows logs and controls Personal session background work.

Main delegates waiting file, network, app-data, MCP, command, service and browser/computer work. Ask status questions normally; changed requirements go to the original background work and replace its unstarted operations, including unused approvals. Browser/computer work queues under the original full-access permission. After human takeover, choose continuation and use the new observation; old screenshots or references cannot resume it. Processes survive ordinary replies, and canceling their assignment stops only its processes. In scheduled-run management, “只取消本次运行” preserves future triggers; canceling the plan stops future triggers too.

A question from background work keeps that work waiting while main and other work remain available. Answer its question card or original verified owner-entry menu to continue the same work under its original permissions. Ordinary chat and changed requirements do not answer a question; accepted changes reach the work with its next request after the answer. Canceling the assignment invalidates its pending questions.

## 3. Models and Configuration

Personal's model wizard and desktop model settings offer compatible installed OpenAI, Anthropic and DeepSeek presets with per-model API, endpoint, context/output limits and image support. Presets describe the installed configuration; custom configuration retains editable addresses, model names, capacities, supported APIs and credential references. Selecting a preset edits the draft; save and explicit connection testing remain separate. Environment references avoid copying credentials into a new profile, but the selected backend process must actually receive those variables.

Personal connection settings show the desktop/local/Telegram shared permission default and QQ's independent default. Confirmation permits operations within already granted scope and asks when an operation exceeds it. Automatic review evaluates eligible reads; full access uses the backend account's existing rights. Default changes affect future inputs and plans, while existing work retains its original authority. After a lost save response, reread the current value before another change.

Coding's `ruukoto-code config` manages providers, models, defaults and summary-model choices. Saved provider/catalog/key changes apply only when no affected running or queued tasks prevent them; distinguish a saved revision from an applied one. A conversation model choice applies to later submissions, not an already running task.

## 4. Channels and Clients

### 4.1 QQ and Telegram

For Telegram, create a BotFather bot, configure its token in Personal's pairing menu, then send the generated pairing phrase from the intended owner account. QQ uses a configured OneBot WebSocket endpoint such as NapCat and its guided owner pairing. Use dedicated owner-private entries; group membership is not owner authentication.

IM defaults to auto-review. Sensitive operations require explicit approval through the original bound entry. A platform/account/credential change creates a new generation; old approvals and sends cannot move to the new destination.

Telegram presents one decision per card. Read its complete target and parameters, then choose a button or reply directly with a listed number. One-shot approval also accepts exactly `好`, `好的`, `可以`, `行`, `同意`, `确认`, `ok` or `OK`; rejection accepts exactly `不`, `不要`, `不行`, `先别`, `拒绝`, `算了` or `取消`, after trimming outer whitespace. Punctuation changes the match; `嗯`, `是`, forwarded messages and ordinary nonmatching chat do not decide a card. Replying `取消` to a card rejects that operation; asking to cancel an assignment remains a separate action.

Answer a single-choice question directly, use Done for multi-select, and review a batch of questions before submitting. Free answers belong to that question. Applied/not-applied statements and computer recovery use their own explicit card actions; they do not prove stopping. A failed button acknowledgement or card update does not undo a saved choice. To inspect it again, reply `重新显示` to the original card or use its original operation menu.

Long Telegram answers arrive automatically in ordered messages preserving the saved text. Published final files and screenshots use original bytes and remain limited to 8 MiB each; partial files cannot be transferred as complete. Text can be delivered even if a file fails. If a send cannot be verified, later parts stop and restarting does not resend them. Send `/结果`, select a saved result, then reply `全部原文` or `原文 1` to receive all original text or a selected piece from this same private entry. This retrieves saved content without rerunning the model or work. Typing is advisory and does not promise when an answer will finish.

For paused computer work, choose `观察原电脑现场`, then `查看原电脑现场` to receive that observation's saved screenshots. Open and inspect every image before choosing `接受原电脑现场`, which becomes available after complete delivery. A failed or unknown image send keeps acceptance unavailable; request another view explicitly or take a new observation. This inspection is separate from final-output publication. Stopping the whole computer sandbox requires its own choice and may lose other unsaved content.

### Desktop Client

On the server, use `ruukoto remote` to manage pairing, then connect the PA desktop to the verified Tailscale HTTPS origin using the generated one-time code. HTTPS/WSS terminates at Tailscale Serve and reaches the private remote service; the local Unix socket is not a public network endpoint. See [deployment](../deploy/systemd/README.md) for backend/remote-service ownership and [desktop](modules/desktop.md) for credential isolation.

Personal decisions, work questions and recovery choices appear in the conversation timeline. Read the original target and parameters before approving a one-shot operation. IM-origin approvals, answers and continuation choices stay with the original verified entry; native cards offer the inspection and cancellation actions available for that item.

Ask for a final file or screenshot to receive its published file card. Complete files up to 8 MiB support native preview and download after byte/hash verification; a partial or oversized capture is shown as unavailable for complete delivery. Each delegation supports eight final files across its members. Failed transfer, canceled save or a lost connection leaves the business result unchanged; download the original published file again without repeating its write. Old profiles must finish, cancel or recover pending work and retained resources with their original program before output delivery is enabled; history remains intact.

For a single question that allows one selection, choosing an option submits it directly. Multi-select waits for Done, and a batch of several questions ends with review. Enter other answers in the question's own field; each pending question keeps its own draft. If a submitted choice's response is lost, inspect its original receipt. That card stays locked until the result is verified, including after reopening the application, while the composer and other questions remain usable.

## 5. Extended Capabilities

### 5.1 MCP Services

Both products use Pi 1.3.0 for Streamable HTTP services and fixed managed Cua programs. Ordinary services support anonymous access or existing Bearer references. The owner chooses allowed tools and local read/write/unknown-effect classifications.

| Operation | Entry and behavior |
| --- | --- |
| Configure service | Coding's instance MCP settings; Personal's desktop or native management |
| Migrate old Personal configuration | Explicitly migrate to v4, preserving original references/history before new business calls |
| Change credentials | Explicitly rebind and save; newline-only changes do not change new token identity, while a changed token invalidates old unstarted approval |
| Inspect/end unknown call | Original Personal timeline card or Calls section; explicitly end work while retaining uncertainty and inspect the original receipt after a lost response |
| Recover computer | Verify original CLI stop → view fresh image → accept that exact observation → continue the corresponding work |

Authorized reads need no individual approval; writes/unknown effects follow the current approval policy. A lost reply to a sent write stops that source's automatic business execution. Manual finalization retains uncertainty; new independent work can use the same service. Computer recovery requires real stop evidence and full fresh-image display before acceptance. Cleaning the original CLI leaves its Linux sandbox running; stopping the whole recorded sandbox is a separate explicit choice that can lose memory and unsaved application state. See [the desktop flow](modules/desktop.md#mcp-call-finalization-and-computer-recovery).

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

`ask_user` presents one to three structured questions and keeps the original Coding task waiting. Answer or explicitly cancel through `/questions` or a desktop question card; closing the window leaves the question pending. Answers return through the original tool call with its model and permissions. Ordinary messages queue, while explicit guidance cancels the pending question and enters the next request. Answers and reports do not approve tools. [Personal work questions](modules/personal-durable.md#work-questions) continue their original background work.

Trusted Coding background reports enter the active task's next model request after the current request and tool batch finish. They wait while a question needs an answer. When the conversation is idle, report summaries run before queued owner messages; they do not appear in the user queue.

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

Personal recovery cards separate original receipts, current observations and your recorded applied/not-applied statement. Check the original record or known target first; current URL or service health alone does not establish an earlier write's effect. When offered, an effect statement records your conclusion without requiring freeform evidence, while stopping and reply delivery remain separate. Stopping original execution targets only the recorded job, launcher, browser, process or computer CLI. [Native recovery](modules/personal-durable.md#native-recovery-choices) explains each family's checks and settlement rules.

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
| `/qq <command>` | `status`, `enable`, `disable`, `groups`, `inbox`, `outbox`; last three are old group archives |
| `/quit` | Exit client while backend work continues |

Retrieving an unstarted message restores its text and attachments to the initiating draft without stopping the current task or changing the remaining queue's order or pause state. The draft-only `/detach` command removes restored attachments and is not listed in general help or completion. Historical `/recall` retains its stopping and edit-pause rules. If the latest owner input is a structured answer or Skip, historical recall rejects it rather than skipping back to the earlier requirement.

An owner pause persists across new messages, retrieval, reports and backend restart. Explicit resume starts queued work; it never reruns an interrupted task. If old execution still holds directory occupancy, verify it stopped before confirming the separate stop-verification prompt. Headless `ruukoto-code resume-queue <session> --stop-confirmed` records that explicit confirmation; ordinary `resume-queue` cannot release it. New messages after interruption are independent tasks in the same conversation; `continue` and `/continue` are removed.

A Coding backend restart makes unanswered questions stale and interrupts the original task; client closure or reconnection alone does neither. Schema 58 and control protocol 49 require a fresh Coding data directory. Preserve old profiles and pending answer/continue records in their original instance; they are not converted or replayed into the new instance.

A conversation branch shares its working directory, not ongoing model execution. Source read access does not grant management rights over the original work. For lost write responses, verify the original request/result before retrying; closing an approval UI is not rejection.
