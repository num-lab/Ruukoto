# Foundation Verification

Requires Node ≥24.15, matching the root workspace. This package exercises Pi (`@earendil-works/pi-coding-agent` 1.3.0) public APIs: concurrent conversations, full on-disk history, controlled model context, tools/extensions and Linux execution boundaries. It uses root `test/helpers/mock-provider.ts`; run from a complete checkout. [Development](../../docs/development.md) owns environment and hook instructions.

## Run

```bash
npm run setup
npm run test:foundation
npm run typecheck
npm --prefix verification/foundation run test:model
output="$(mktemp -d "${TMPDIR:-/tmp}/ruukoto-linux-probes.XXXXXX")"
npm --prefix verification/foundation run linux:probes -- --output-dir "$output"
```

The foundation suite is offline; `test:model` explicitly uses local Pi credentials for a real round trip. Linux probes require installed native prerequisites.

## Verification Index

These are historical stage-zero conclusions, not proof that the current checkout passes. Later product/platform evidence is in [release acceptance](../../docs/release-acceptance.md#historical-verification).

| Test, relative to this package | Historical coverage/result |
| --- | --- |
| `test/01-compaction.test.ts` | Automatic compaction can be disabled/intercepted; full disk history preserved; passed |
| `test/02-context.test.ts` | Per-round context selection without rewriting history; passed |
| `test/03-tools.test.ts` | Built-in bash reuse and results; passed |
| `test/04-sessions.test.ts` | Concurrent in-process conversations with isolated events/state; passed |
| `test/05-plugin.test.ts` | Custom-tool call pairing/results and trusted-plugin lifecycle/permissions/storage; passed |
| Retired RPC exploration | Subprocess JSONL/events passed historically; not adopted by the product and removed from the active suite; original source revision was `28c033f7` |
| `test/07-connectivity.test.ts` | Real `deepseek-v4-flash` passed; skipped by default, enabled with `RUN_MODEL_CHECK=1` |
| `scripts/linux-isolation/` | Historical Docker boundary, 31/31 in Docker Desktop Linux VM |

## Current Wiring and Historical SDK Behavior

Both products pin Pi 1.3.0. Coding loads explicit host modules via public `discoverAndLoadExtensions`, injecting dependencies through each SDK's EventBus. MCP uses official factories/registry. System entries in `TranscriptContext.messages` retain prompt/tools; pre-send validation and snapshots read the same final messages.

Stage-zero observations below describe that investigation, not a replacement for current integration. See [MCP host responsibilities](../../.agents/notes/implemented/simplification/2026-10-26-mcp-host-responsibilities.md).

- `createAgentSession()` ignored `extensionFactories`; inline extensions needed `DefaultResourceLoader({ extensionFactories })`.
- SDK sessions did not send `session_start`/`session_shutdown` to inline extensions; per-round `before_agent_start`, `agent_start`, `agent_end`, `agent_settled` were reliable.
- `SessionManager.create()` created JSONL lazily; `session.sessionFile` was undefined before first write.
- A closed `ModelRuntime.create()` configuration required explicit `authPath`, `modelsPath` and `modelsStore` to avoid reading `~/.pi/agent`.

## Linux Probes

The explicit-output `linux:probes` command above runs [native probes](scripts/native-isolation/linux-README.md) with `/usr/bin/bwrap` and an independent user scope, without Docker. [Product smoke](../smoke/README.md) separately verifies integration.

The [retired Docker comparison](scripts/linux-isolation/README.md) tested workspace writes, hidden host paths, denied outside writes, subprocesses, CapEff=0, denied mounts/network, absent credentials/`~/.pi`, blocked host loopback/gateway control access and root-owned `0600` state inaccessible to task UID. Its results remain in `results/linux-isolation-report.{json,md}`. That stage used Docker Desktop on macOS (Linux VM, linuxkit 6.12.76/Debian 13), not the target Linux server's host prerequisites.

## Native Coding Boundary

[Seatbelt/bubblewrap probes](scripts/native-isolation/README.md) are independently rerunnable. The 2026-10-08 candidates failed: macOS did not reclaim every detached descendant, and tx denied bwrap namespace creation. Historical `native-*` reports retain those outcomes. They do not establish current product acceptance; shared native primitives and actual product integration have separate smoke results.
