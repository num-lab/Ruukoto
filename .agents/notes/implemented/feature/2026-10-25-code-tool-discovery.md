# Agent Note: Expose Coding MCP tools on demand

Status: implemented

[MCP host simplification](../simplification/2026-10-26-mcp-host-responsibilities.md) supersedes the local search algorithm, old tool name, task activation set, and reset rules: Pi owns search and branch discovery. On-demand exposure, intersection with current eligibility, and reconstructable model inputs remain. This note preserves the original decision.

## Problem

At task start, MCP put every authorized definition in the model request, consuming context even for unused tools. The owner requested `search_tools` for deferred tools, initially in Coding Agent only.

## Decision

The original implementation retains start-of-task connection, discovery, schema validation, and pinned versions; it defers only model-visible definitions. `search_tools` matches all query keywords against authorized MCP names/descriptions, returning at most five by default and twenty at most. Results expose names/descriptions; matching full schemas enter the next model request and stay active through that task. Each new task resets activation. Pi now owns the replacement discovery machinery described by the superseding note.

Driver separates base eligibility from activation. SDK exposure, presend checks, and invocation gates use the latter. Search only considers currently enabled base-eligible services whose configuration version is unchanged; it changes no role, Plan, or approval eligibility. Explicit child-task tool lists or host narrowing with no search entry retain direct exposure so required tools remain usable. Fixed-capability completeness checks still use base eligibility.

Existing prompt snapshots and selection records persist actual definitions; search summaries enter tool history without a new database format. Test models really search before existing MCP business scenarios, and business-responder counts exclude that handshake. Complete requests remain recorded. A separate discovery integration checks actual initial/next requests and snapshots rather than relying on the helper as discovery evidence.

This supplements [MCP client](../architecture/2026-09-23-mcp-client.md) and [instance MCP configuration](../simplification/2026-10-24-code-instance-mcp.md) exposure timing while retaining discovery, versions, provenance, and approval. [Transport reuse](../architecture/2026-10-17-mcp-transport-reuse.md) and Personal's separate assembly remain.

## Alternatives considered

Connecting only after search saves initialization but changes fixed-capability checks, signatures, and failure timing, and still needs a searchable catalog. Hiding built-ins too saves more context but makes everyday read/wait/approval depend on discovery; only extensible MCP was deferred. Hiding definitions but allowing guessed calls is simpler yet makes exposure disagree with invocation authorization; undiscovered calls must be rejected.

## Consequences

Unused MCP definitions leave the initial context budget, at the cost of a search before use. The original local keyword search was not semantic search. Explicit fixed roles retain required tools. Historical sessions may contain old tool names/results without activating them in new tasks. `test/search-tools.test.ts`, MCP suites 24/25/44/58, and child-task cases cover requests, Plan, rejection, reset, and compatibility. Historical real-model evidence is in the offline copy of `.scratch/agent-tools-next/issues/01-code-tools.md`.
