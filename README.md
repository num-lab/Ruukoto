# Ruukoto

Two independently operated agents for one owner, delivered from one repository:

<!-- Note: See .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md -->

| | `ruukoto-code` (Coding Agent) | `ruukoto` (Personal Agent) |
| --- | --- | --- |
| Host | Development machine, macOS or Linux | Dedicated Linux server |
| Main interface | TUI | QQ private chat, Telegram and PA desktop, sharing `main` |
| Organization | Workspace → conversations | One persistent main conversation |
| Backend | Starts on demand; `ruukoto-code stop` stops it | Persistent systemd service |
| Profile | `~/.ruukoto-code/` | `~/.ruukoto-durable/`; explicitly choose a new production directory |

Both read skills from the backend account's `$HOME/.agents/skills/`. See the [architecture](docs/architecture.md) for their separate runtimes and shared components.

## Current Status

Both products use Pi 1.3.0. Coding supports workspaces, conversations, SubAgents, workflows, profile imports and desktop [Scheduled tasks](docs/usage.md#54-scheduled-tasks), with fixed time, workspace, permissions and model. The Personal artifact has isolated acceptance evidence; production cutover and final combined acceptance have separate requirements.

Outstanding product work includes cross-product shared memory, email and GitHub comment channels, and a standalone QQ group-chat extension. Core group chat is retired; old group data remains read-only. Historical platform substitutes do not establish current real-platform acceptance. See the [acceptance record](docs/release-acceptance.md).

## Quick Start

Use an ordinary macOS or Linux account with Node ≥ 24.15, Git, ripgrep (`rg`), Bash and Python 3 with PTY support. Linux native tests also require the [sandbox prerequisites](deploy/native/README.md), which CI prepares automatically. Restricted execution uses native sandboxes, not Docker. Personal file search has its own read-only worker built by `build:worker`.

```bash
npm run setup       # Install both lockfiles, check prerequisites and install the commit hook
npm run check       # Build native supervisors, workers and WASM; run static and offline checks
npm link            # Optional: install both commands in PATH; otherwise use npm start -- …
```

### Coding Agent

```bash
ruukoto-code config               # Instance-wide MCP; model/API keys can be configured offline
ruukoto-code ~/code/my-repo       # Open a new conversation; start the backend if needed
ruukoto-code                      # Return to an existing conversation
ruukoto-code stop                 # Stop the backend
```

Workspaces follow real directory identity: symlinks and path variants reuse one workspace; different directories with the same name remain separate. A workspace may contain several repositories. Production commands reject legacy `local`/`container` overrides. Full access runs directly as the starting account without a task sandbox on both platforms; see [startup](docs/usage.md#21-start-the-backend).

| TUI command | Purpose |
| --- | --- |
| `/new` | Create an empty conversation in this workspace |
| `/branch [name]` | Branch persisted history and switch; parent and child share the working directory |
| `/side` | Toggle this conversation's tool-free side chat |
| `/resume` | Return to the parent or another conversation |
| `/questions` | Answer or cancel persistent questions, then resume once |
| `/processes` | Inspect background logs, verify stopping and end a background process |
| `/queue` | Reorder queued messages or turn ordinary input into steering |
| `/steer text` | Send steering input to the current task |

Branching neither calls a model nor starts the source task. Names may contain Chinese and spaces. See [commands](docs/usage.md#72-commands) for source access and failure recovery.

### Personal Agent

Follow the [deployment guide](deploy/systemd/README.md) for the account, native execution, persistent user manager, systemd unit and optional service helper. Configure models and credential environment variables in a new profile, then pair dedicated QQ/Telegram entries. Keep old profiles as archives; do not import them.

```bash
ruukoto                       # Models, IM, permissions, work and instance management
ruukoto serve                 # Foreground backend; signals request a verified stop
# Choose a separate profile: RUUKOTO_PERSONAL_DIR=/absolute/new-profile ruukoto
```

The PA desktop and both IM platforms share the main conversation; background analysis reports to its original entry. Closing the daily menu does not stop an already started backend: use its stop action. `--directory` fixes the profile; `settings` supports bounded JSON reads/writes with original-key verification, and `maintenance` verifies and explicitly controls the original service. `remote` pairs desktop clients; `remote serve` hosts HTTPS/WSS. In IM, `/帮助` lists commands and `/后台` manages session background work. See [Personal management](docs/usage.md#25-personal-agent-management).

### Develop This Repository

Run `npm run check:static` and targeted tests while editing; choose the smallest sufficient set using [pre-push checks](.agents/skills/pre-push-checks/SKILL.md). CI runs the full check. Application tests use at most two files concurrently; macOS first runs shared-UID fixtures serially. Keep raw evidence outside the repository; use the explicit external-output arguments in the [platform probe guide](verification/foundation/scripts/native-isolation/README.md) rather than overwriting historical reports.

```bash
npm run dev                   # Isolated Personal profile; restart the foreground backend on source edits
npm run dev -- --config        # Same profile's configuration menu; exit stops this backend
npm run code                  # Coding development backend and TUI
npm run code -- --desktop      # Desktop frontend for the development backend (macOS)
npm run desktop:build         # Build the Electron application, including its terminal
npm run code -- ../my-project  # Create/reuse the workspace and enter a new conversation
```

MyGo uses `npm run desktop:mygo`; see [desktop development](docs/desktop-development.md). [Browser usage](docs/usage.md#12-browser) covers login and screenshot export. [Test navigation](docs/development.md#daily-feedback) includes workflow execution and interruptible waiting. [Real-model acceptance](docs/development.md#external-acceptance) uses explicit model files and isolated profiles.

## Documentation

- [Usage](docs/usage.md): running, configuration, SubAgent roles, entry setup, imports and troubleshooting.
- [Architecture](docs/architecture.md) and [modules](docs/modules/): responsibilities and main flows.
- [Development](docs/development.md): reproducible environments, checks and test navigation.
- [Acceptance](docs/release-acceptance.md): release evidence and remaining verification.
- [Postmortems](.agents/postmortem/): failure mechanisms and resulting safeguards.
- [Domain glossary](CONTEXT.md), [decisions](.agents/notes/) and [agent instructions](AGENTS.md).
