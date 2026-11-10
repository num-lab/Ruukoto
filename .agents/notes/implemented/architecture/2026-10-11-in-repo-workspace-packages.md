# Agent Note: Package the application and shared foundations as workspaces

Status: implemented

[Single product](2026-11-10-single-product.md) supersedes two-product assembly and legacy import. This note retains package ownership, dependency direction, browser-safe projection and complete-workspace delivery; historical verification below is not current acceptance.

## Problem

A single code package left product differences without explicit owners and dependency direction enforced only by documentation. [The product decision](../../archived/architecture/2026-10-02-two-agent-products.md) had deferred packaging until independent shipping was needed; the actual driver became explicit assembly and checkable dependencies. The proposal estimated 76% shared code, making separate repositories costly to coordinate across workers, schema, protocols, and shared tests.

Moving directories alone would preserve reverse dependencies: agent tools imported formatting and ledger checks from runtime, control imported model-selection parsing from runtime, and general source verification lived in personal scheduler tools.

## Decision

The root aggregates installation, development, build, and checks. npm workspaces covers `packages/*` and `apps/*`, with one root lockfile and coordinated versions. Each package owns a manifest, exports, dependency declarations, and typecheck. Relative imports use `.ts` within a package; cross-package imports use package names and source exports. tsx, TypeScript bundler resolution, and esbuild use those exports directly, with no parallel paths aliases or compiled source copy.

| Package | Ownership |
| --- | --- |
| `@ruukoto/core` | Profile activation, storage, identity, schema, history reading and model-selection fields |
| `@ruukoto/agent` | Models, context, tools, approval/execution rules, SubAgent formatting and ledger checks |
| `@ruukoto/channels` | Retained scheduling time calculations |
| `@ruukoto/runtime` | Task lifecycle, orchestration, SubAgents, parent delivery, work copies, workspace organization |
| `@ruukoto/control` | Protocol, authentication, client, server |
| `@ruukoto/view` | Browser-compatible snapshots, events, history/task projection, selectors, state labels, history recovery orchestration |
| `@ruukoto/tui` | Shared CLI, task/configuration interfaces, development launcher, programmatic entry |
| `@ruukoto/desktop` | Desktop host shells, bridges, React renderer, application packaging |
| `ruukoto` | Sole bin/main/dev composition and native execution policy |

Runtime receives `ProfilePaths`, not product-capability routing. Core fixes product `ruukoto` and binds layout/instance before writers or clients proceed. Models and task parameters cannot choose identity. Root start/dev use `apps/ruukoto`; there is no alternate product or import entry.

## Dependencies and compatibility

Runtime value dependencies flow toward core, with agent supporting runtime and control exposing operations to clients. Apps assemble foundations; core has no reverse workspace dependency. Retired PA libraries and dependencies are not maintained as disabled branches.

Desktop keeps its dependencies in devDependencies: Electron and Node builtins are external to the Electron bundles; other source is bundled, so production workspace installation need not install desktop tooling. ESLint allows value imports from desktop devDependencies only for that package, while still checking undeclared, cross-package relative, and dynamic imports. Other packages may declare reverse type-only dependencies in devDependencies; core accepts no reverse dependency. Runtime collaboration uses injected callbacks/instances. Static imports, re-exports, type references, and dynamic imports are checked; package-local dynamic imports use static module strings.

View implements the shared projection from [the desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md): pure `ViewState`/`EventFlow`, plus [HistoryRecovery](2026-10-23-shared-history-recovery.md), which orchestrates injected requests but owns neither connections nor client display ordering. Pure state constants and display ownership moved out of Node-dependent modules, with old entries re-exporting for compatibility. UTF-8 counting uses `TextEncoder`. View source forbids Node references; all exports are browser-bundled and checked against browser globals, including transitive unexecuted branches, then exercised in a VM without Node globals for projections and multi-page recovery.

Command execution and SQLite persistence stay in the TUI `ViewState` subclass. Load/save failures remain visible; a failed save must not let old storage replace the local result. EventFlow retains in-memory command entries and unified ordering across resync; extraction adds no command-storage interface. Snapshot installation requires callers to advance an asynchronous request generation and discard obsolete results. `ControlConnection` still owns global sequence-gap detection.

Shared source authorization, operation ledgers, native stopping, SubAgent/workflow ownership and time calculations remain with their retained consumers. Legacy import, organizational remapping and PA-only group/IM/recovery stores are removed, not moved into fixtures.

Root tests/helpers stay together: no test package, numbering changes, or replacement of deliberate raw-SQL layout assertions. Foundation remains outside workspaces with an independent SDK validation package, lockfile, and typecheck; setup runs `npm ci` for both root and foundation. Packaging itself did not bump schema or protocol versions or migrate JSONL, directories, authorization, or credentials.

## Build and checks

Root build runs native helpers, retained tool/background workers, the workflow script worker and the sole app build. The app tarball contains its bin, source and shared dependency declarations; it is not a standalone single-file release. Execution needs the installed workspace and root worker artifacts resolved against the root lockfile.

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
