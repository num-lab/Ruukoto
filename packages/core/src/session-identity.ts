/** Conversation identity comes only from host-owned child and side-chat bindings. */
import type { SubAgent } from "./types.ts";

export interface WorkflowSessionBinding { runId: string; stepKey: string; sourceSessionId: string }

export type SessionIdentity =
  | { kind: "dev" }
  | { kind: "subagent"; agent: SubAgent; workflow?: WorkflowSessionBinding }
  | { kind: "side"; parentSessionId: string };

export function classifySession(agent: SubAgent | null, workflow: WorkflowSessionBinding | null = null, sideParentSessionId: string | null = null): SessionIdentity {
  if (agent) return { kind: "subagent", agent, ...(workflow ? { workflow } : {}) };
  if (sideParentSessionId) return { kind: "side", parentSessionId: sideParentSessionId };
  return { kind: "dev" };
}
