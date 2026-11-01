# Agent Note: Discover delegated MCP without granting it to the parent

Status: implemented

## Problem

Shared-runtime main has no direct MCP tools, but its controlled SubAgent delegation includes configured MCP under [source capabilities](../architecture/2026-10-15-subagent-source-capabilities.md). Preflight reused main's SDK without an MCP extension, saved an empty discovery signature, and then the child correctly rejected its nonempty registry as changed. The official discovery migration also omitted `tool_search` from default child candidates, unnecessarily turning unconstrained children into fixed direct-tool consumers.

## Decision

Install the existing official MCP extension for delegation-capable main sessions without adding MCP to main's execution profile. Discover only during delegation preflight; ordinary main chat does not contact MCP services. Main's actual task-tool set excludes both MCP names and `tool_search`, including after preflight has registered tools. Its model-visible server guidance remains absent.

For active main preflight, discovered service versions and credential digests must match the parent task's starting selections. There is no parent MCP tool-call signature to inherit because main cannot call these tools. MCP-enabled parents retain the stricter intersection with their captured tool signatures and allowed task-tool set. Cua remains excluded from delegation. The source/role checks and child's exact pinned discovery-signature verification remain unchanged.

Include the officially registered `tool_search` in available child candidates. Unconstrained roles retain deferred discovery; explicit role or step tool lists still select only their fixed tools and use direct registration when they exclude search. No duplicate MCP registry or client is introduced.

## Alternatives considered

- Give main direct MCP: the shortest registration change, but violates its intentionally narrower tool category and lets a parent use delegated-only authority.
- Accept an empty preflight signature: avoids the startup rejection, but permits an unverified child registry and loses source-change detection.
- Add a separate discovery client: isolates parent registration, but duplicates official registry/schema behavior and transport ownership. Reuse the official extension with separate discovery and call eligibility.

## Consequences

Main retains private registered definitions after preflight until normal SDK disposal, while activation and invocation gates keep them unavailable to main. Delegation performs discovery work; plain main chat does not. The shared runtime's historical Personal composition benefits without changing the independent durable Personal runtime. Offline tests cover actual mock MCP discovery/calls, no parent exposure, changed source configuration/credentials, fixed direct roles and existing source revocation; real services and models remain separate acceptance.
