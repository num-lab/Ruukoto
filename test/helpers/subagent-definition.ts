import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import type { Session } from "@ruukoto/core/types.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { snapshotSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import { canonicalJson, sha256 } from "@ruukoto/core/import-files.ts";
import { subAgentDefinitionDigest, type SubAgentDefinitionSnapshot } from "@ruukoto/core/subagent-definition.ts";

export function fixtureSubAgentDefinition(): SubAgentDefinitionSnapshot {
  const content: Omit<SubAgentDefinitionSnapshot, "digest"> = { kind: "role", name: "general", raw: "---\ndescription: 测试角色\n---\n\n按任务执行。\n",
    description: "测试角色", tools: null, permissions: { mode: "inherit", protectSource: false }, body: "按任务执行。" };
  return { ...content, digest: subAgentDefinitionDigest(content) };
}

export function fixtureSubAgentRoleCatalog() {
  const roles = [fixtureSubAgentDefinition()], diagnostics: { name: string; code: string; message: string }[] = [];
  return { roles, diagnostics, digest: sha256(canonicalJson({ roles, diagnostics })) };
}


export function fixtureSubAgentAuthority(rt: Runtime, session: Session): NonNullable<WorkflowSource["authority"]> {
  const toolClass = rt.store.getSessionIdentity(session.id)?.kind === "dev" ? "dev" : "main";
  return { toolClass, categories: rt["delegationCategories"](toolClass), grantIds: [], configuration: rt["workflowConfiguration"](session.projectId),
    workspace: { path: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno } };
}

export function fixtureSubAgentScope(source: WorkflowSource) {
  return { paths: [], sourceRefs: [], readMemories: [], execution: snapshotSubAgentExecution({ source, roleDigest: fixtureSubAgentDefinition().digest,
    accessMode: source.accessMode, protectSource: false, tools: [], mcpSignature: "fixture" }) };
}
