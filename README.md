# Ruukoto

Ruukoto is a software-work assistant based on [Pi](https://github.com/earendil-works/pi), with a TUI and native Electron/MyGo desktop clients. Organize workspaces and conversations, delegate to one level of SubAgents with retained work copies, and run workflows or scheduled work.

<!-- Note: See .agents/notes/implemented/architecture/2026-11-10-single-product.md -->

## Quick Start

Use an ordinary macOS or Linux account with Node ≥ 24.15, Git, ripgrep (`rg`), Bash and Python 3 with PTY support. Restricted execution uses native sandboxes: macOS needs Command Line Tools/Clang and Seatbelt; Linux needs bubblewrap, cgroup v2 and a systemd user manager. Follow the [native prerequisites](deploy/native/README.md).

```bash
npm run setup               # Install both lockfiles, prerequisites and commit hook
npm run build               # Build native supervisors, retained workers and app package
npm link                    # Optional: install ruukoto in PATH
ruukoto config --offline    # Activate fresh storage and configure models/API keys
ruukoto ~/code/my-repo      # Open a conversation; start backend on demand
ruukoto                     # Select a conversation or start with No workspace
ruukoto stop                # Explicitly stop the backend
```

Without linking, use `npm start -- <arguments>`. Daily state lives under `~/.ruukoto/single-v1`. Old profiles are not imported: recognized stopped predecessors permit a blank instance; live, unverifiable, unknown or newer state rejects. Old history and actual work files remain untouched. See [fresh profile selection](docs/usage.md#6-fresh-profiles-and-old-data) before choosing custom directories.

Closing a normal client does not cancel backend work. Retrieve unstarted messages through the desktop queue or TUI `/queue`; interruption pauses dispatch until explicit resume. New chat without a directory creates its own managed workspace on first send, while branches share source files. Close, archive and restart retain history and files.

## Develop This Repository

```bash
npm run dev                    # Checkout-isolated backend and TUI
npm run dev -- --config         # Configure that development instance
npm run dev -- ../my-project    # Open a workspace in that instance
npm run dev -- --desktop        # Managed Electron development client
npm run desktop:build           # Build the Electron application
npm run desktop:mygo            # Build and launch signed development MyGo
npm run desktop:mygo:build      # Build production MyGo without launching
```

Development uses `~/.ruukoto-dev/<checkout-identity>/single-v1` and stops its owned backend/UI when the launcher exits. Configure models in that new profile; there is no implicit old-settings import. See [development](docs/development.md) for isolation, reload and verification, and [desktop development](docs/desktop-development.md) for native application/browser-state separation.

Choose the smallest credible evidence set with [pre-push checks](.agents/skills/pre-push-checks/SKILL.md). CI covers the full check across four isolated application-test shards per OS. Offline/mock checks do not establish actual native-host, Linux or model acceptance; keep raw evidence outside the repository.

## Documentation

- [Usage](docs/usage.md): configuration, profiles, clients, MCP/Cua, browser, workflows and scheduling.
- [Architecture](docs/architecture.md) and [modules](docs/modules/): responsibilities and main flows.
- [Development](docs/development.md): reproducible environments, checks and test navigation.
- [Acceptance](docs/release-acceptance.md): evidence boundaries and cutover requirements.
- [Postmortems](.agents/postmortem/): failure mechanisms and safeguards.
- [Domain glossary](CONTEXT.md), [decisions](.agents/notes/) and [agent instructions](AGENTS.md).
