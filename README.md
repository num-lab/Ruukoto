# Ruukoto

Two independently operated agents based on [Pi](https://github.com/earendil-works/pi), delivered from one repository:

<!-- Note: See .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md -->

| | `ruukoto-code` (Coding Agent) | `ruukoto` (Personal Agent) |
| --- | --- | --- |
| Host | Development machine, macOS or Linux | Dedicated Linux server |
| Main interface | TUI | IM tunnel and PA desktop, sharing `main` |
| Organization | Workspace → conversations | One persistent main conversation |
| Backend | Starts on demand; `ruukoto-code stop` stops it | Persistent systemd service |
| Profile | `~/.ruukoto-code/` | `~/.ruukoto-durable/`; explicitly choose a new production directory |

See the [architecture](docs/architecture.md) for their separate runtimes and shared components.

## Quick Start

Use an ordinary macOS or Linux account with Node ≥ 24.15, Git, ripgrep (`rg`), Bash and Python 3 with PTY support. Linux native tests also require the [sandbox prerequisites](deploy/native/README.md), which CI prepares automatically. Restricted execution uses native sandboxes. Personal file search has its own read-only worker built by `build:worker`.

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

### Personal Agent

Follow the [deployment guide](deploy/systemd/README.md) for the account, native execution, persistent user manager, systemd unit and optional service helper. Configure models and credential environment variables in a new profile, then pair dedicated IM entries.

```bash
ruukoto                       # Models, IM, permissions, work and instance management
ruukoto serve                 # Foreground backend; signals request a verified stop
# Choose a separate profile: RUUKOTO_PERSONAL_DIR=/absolute/new-profile ruukoto
```

See [Personal management](docs/usage.md#25-personal-agent-management).

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

## Documentation

- [Usage](docs/usage.md): running, configuration, SubAgent roles, entry setup, imports and troubleshooting.
- [Architecture](docs/architecture.md) and [modules](docs/modules/): responsibilities and main flows.
- [Development](docs/development.md): reproducible environments, checks and test navigation.
- [Acceptance](docs/release-acceptance.md): release evidence and remaining verification.
- [Postmortems](.agents/postmortem/): failure mechanisms and resulting safeguards.
- [Domain glossary](CONTEXT.md), [decisions](.agents/notes/) and [agent instructions](AGENTS.md).
