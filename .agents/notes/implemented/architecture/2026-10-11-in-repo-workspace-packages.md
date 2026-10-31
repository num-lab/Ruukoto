# Agent Note: Package both products as workspaces in one repository

Status: implemented

[The personal product entry](../simplification/2026-10-18-personal-product-entry.md) partially supersedes shared Personal assembly: Personal now owns its durable runtime and reuses only genuinely shared business libraries, transports, validation, and execution primitives. Coding packages and same-repository delivery remain. Combined Personal migration acceptance belongs to [the migration proposal](../../proposed/architecture/2026-10-17-personal-pi-durable.md).

## Problem

A single code package left product differences without explicit owners and dependency direction enforced only by documentation. [The product decision](2026-10-02-two-agent-products.md) had deferred packaging until independent shipping was needed; the actual driver became explicit assembly and checkable dependencies. The proposal estimated 76% shared code, making separate repositories costly to coordinate across workers, schema, protocols, and shared tests.

Moving directories alone would preserve reverse dependencies: agent tools imported formatting and ledger checks from runtime, control imported model-selection parsing from runtime, and general source verification lived in personal scheduler tools.

## Decision

The root aggregates installation, development, build, and checks. npm workspaces covers `packages/*` and `apps/*`, with one root lockfile and coordinated versions. Each package owns a manifest, exports, dependency declarations, and typecheck. Relative imports use `.ts` within a package; cross-package imports use package names and source exports. tsx, TypeScript bundler resolution, and esbuild use those exports directly, with no parallel paths aliases or compiled source copy.

| Package | Ownership |
| --- | --- |
| `@ruukoto/core` | Storage, identity, schema, history reading, common import snapshot/file/row/receipt helpers, model-selection fields |
| `@ruukoto/agent` | Models, context, tools, approval/execution rules, SubAgent formatting and ledger checks |
| `@ruukoto/channels` | Retained QQ/Telegram/GitHub/scheduler infrastructure, IM approval/inbound media, retirement and source checks, old group-result queries and operation-ledger rules |
| `@ruukoto/runtime` | Task lifecycle, orchestration, SubAgents, parent delivery, work copies, workspace organization |
| `@ruukoto/control` | Protocol, authentication, client, server |
| `@ruukoto/view` | Browser-compatible snapshots, events, history/task projection, selectors, state labels, history recovery orchestration |
| `@ruukoto/tui` | Shared CLI, task/configuration interfaces, development launcher, programmatic entry |
| `@ruukoto/desktop` | Desktop host shells, bridges, React renderer, application packaging |
| `ruukoto` | Personal bin/main/dev entries, durable sessions, business tools, local management |
| `ruukoto-code` | Coding bin/main/dev entries, capabilities, legacy development import policy |

Coding and retained shared assemblies use declarations in `product.ts`: `RuntimeProduct` supplies identity, IM/scheduler/service capabilities, and tool-family factories; `CliProduct` supplies the default execution backend, old-project write eligibility, and import direction. `Runtime.start` requires an explicit product declaration rather than branching on `ProductType` inside shared assembly. Host identity still registers `product.type` and rejects cross-product directories; model/task parameters cannot choose it.

Each bin fixes its own identity. Root `npm start` uses `scripts/start.ts`, preserving environment identity selection with ruukoto as default; each app start fixes its bin. Root dev/code use the corresponding app launcher and separate fixed development directories. Coding watches workspace source and reloads only the task UI for view changes. Personal's thin launcher manages a Node-watch foreground backend; `--config` runs the same managed menu without source watching, and development refuses profiles with enabled IM.

## Dependencies and compatibility

Runtime value dependencies follow `agent -> core`, `channels -> agent/core`, `runtime -> channels/agent/core`, `control -> core`, `view -> control/core`, and `tui -> view/control/runtime/agent/core`. Apps may depend on shared packages, never on each other. Personal does not directly depend on shared TUI or Runtime. The initial durable transition used Personal Pi 1.3.0 beside Coding 0.85.1; both products now declare Pi 1.3.0. Historical dual-version acceptance does not describe current dependencies.

Desktop keeps its dependencies in devDependencies: Electron and Node builtins are external to the Electron bundles; other source is bundled, so production workspace installation need not install desktop tooling. ESLint allows value imports from desktop devDependencies only for that package, while still checking undeclared, cross-package relative, and dynamic imports. Other packages may declare reverse type-only dependencies in devDependencies; core accepts no reverse dependency. Runtime collaboration uses injected callbacks/instances. Static imports, re-exports, type references, and dynamic imports are checked; package-local dynamic imports use static module strings.

View implements the shared projection from [the desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md): pure `ViewState`/`EventFlow`, plus [HistoryRecovery](2026-10-23-shared-history-recovery.md), which orchestrates injected requests but owns neither connections nor client display ordering. Pure state constants and display ownership moved out of Node-dependent modules, with old entries re-exporting for compatibility. UTF-8 counting uses `TextEncoder`. View source forbids Node references; all exports are browser-bundled and checked against browser globals, including transitive unexecuted branches, then exercised in a VM without Node globals for projections and multi-page recovery.

Command execution and SQLite persistence stay in the TUI `ViewState` subclass. Load/save failures remain visible; a failed save must not let old storage replace the local result. EventFlow retains in-memory command entries and unified ordering across resync; extraction adds no command-storage interface. Snapshot installation requires callers to advance an asynchronous request generation and discard obsolete results. `ControlConnection` still owns global sequence-gap detection.

The original proposal called the development launcher, workspace migration, and group-result tools product-specific. Coding still uses them; durable Personal does not. Common import primitives remain in core, while the Coding app owns its table policy and permission settlement; the personal importer is retired. Durable Personal owns current scheduler/service assembly. Shared old-operation classification and commit checks remain available to `ToolOpLedger`, so disabled product capabilities do not change recovery conclusions or erase read-only group archives.

Root tests/helpers stay together: no test package, numbering changes, or replacement of deliberate raw-SQL layout assertions. Foundation remains outside workspaces with an independent SDK validation package, lockfile, and typecheck; setup runs `npm ci` for both root and foundation. Packaging itself did not bump schema or protocol versions or migrate JSONL, directories, authorization, or credentials.

## Build and checks

Current root build runs native helpers, tool/background/Personal workers, the script worker, and app builds. App tarballs contain bins, source, and shared dependency declarations; they are not standalone single-file releases. Deployment still needs the installed workspace and root worker artifacts resolved against the root lockfile. The original packaging build covered fewer workers; later additions do not change this delivery requirement.

Desktop uses explicit desktop build scripts rather than joining the generic workspace build. The Electron path builds/checks/packages the macOS arm64 application into root dist with ad-hoc signing; MyGo has its own explicit build. Desktop lint/typecheck and pure-logic tests join existing checks, and CI avoids downloading Electron binaries. Root typecheck covers tests/scripts, each workspace, then foundation; check aggregates builds, static/documentation checks, and offline tests. The historical statement that desktop defined no build script referred to the generic `build` hook, not absence of dedicated desktop commands.

## Alternatives considered

- Separate repositories isolate access and releases, but most code and shared contracts need coordinated evolution. Keep one repository for the actual ownership/dependency problem.
- Add import rules only: cheapest and sufficient to block reverse edges, but leaves product entries and assembly without explicit package ownership. Package and enforce together.
- Keep relative cross-package imports: less migration text, but bypasses exports and declarations, making the dependency graph misleading.
- Add a shared test package: a separate graph is possible, but root tests already express cross-module contracts and do not ship with products.
- Put foundation into workspaces: one install is convenient, but independent SDK/Linux-probe verification is intentional and the two-lockfile setup already works.
- Inject command storage into view: this would move the entire state class, but desktop needs no SQLite terminal history. Keep local recovery/persistence in the TUI subclass.

## Consequences

Entries and capabilities have explicit owners, and lint rejects new dependency violations. Most original changes were mechanical paths/imports, with one shared runtime and execution implementation. Costs include ten manifests, per-package checking, and reverse types requiring shared source in the same repository. Independent package versions and registry releases need a separate coordination decision if required.

Historical 2026-10-11 macOS arm64/Node 24.15.0 evidence: clean setup passed; full check built and checked the then-eight packages, static/docs passed, application tests had 1025 passes/one skip, and foundation had nine passes/one skip. Skips were gated real-model cases. Test/99 covered bins, app entries, and positive/negative imports; test/64 covered old-operation recovery after personal capabilities were disabled.

A separately tagged Docker image, using the host's reachable proxy, passed four smoke suites at 27/27 with model/QQ/Telegram stubs. Upgrade from `60fa19e` to the workspace layout passed 4/4 for uninterrupted other-product operation, retained history, and independent stopping; temporary image/containers were removed. Dependency/schema/protocol versions did not change in that packaging step. Real models, real IM, systemd/sudo deployment, and the Node 22/Linux backend matrix were not run. Linux worker evidence is not full backend-platform acceptance, nor acceptance of later Pi or desktop changes.
