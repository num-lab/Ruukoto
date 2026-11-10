import * as fs from "node:fs";
import * as path from "node:path";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import type { Session } from "@ruukoto/core/types.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { snapshotSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import { canonicalJson, sha256 } from "@ruukoto/core/json.ts";
import { subAgentDefinitionDigest, type SubAgentDefinitionSnapshot } from "@ruukoto/core/subagent-definition.ts";

export function fixtureSubAgentDefinition(): SubAgentDefinitionSnapshot {
  const content: Omit<SubAgentDefinitionSnapshot, "digest"> = { kind: "role", name: "general", raw: "---\ndescription: 测试角色\n---\n\n按任务执行。\n",
    description: "测试角色", tools: null, permissions: { mode: "inherit", protectSource: false }, body: "按任务执行。" };
  return { ...content, digest: subAgentDefinitionDigest(content) };
}

export function seedTestRole(agentDir: string): void {
  const directory = path.join(agentDir, "agents");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "general.md"), fixtureSubAgentDefinition().raw, { mode: 0o600 });
}

export function fixtureSubAgentRoleCatalog() {
  const roles = [fixtureSubAgentDefinition()], diagnostics: { name: string; code: string; message: string }[] = [];
  return { roles, diagnostics, digest: sha256(canonicalJson({ roles, diagnostics })) };
}


export function fixtureSubAgentAuthority(rt: Runtime, session: Session): NonNullable<WorkflowSource["authority"]> {
  const toolClass = "dev";
  return { toolClass, categories: rt["delegationCategories"](), grantIds: [], configuration: rt["workflowConfiguration"](session.projectId),
    workspace: { path: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno } };
}

export function fixtureSubAgentScope(source: WorkflowSource) {
  return { paths: [], sourceRefs: [], readMemories: [], execution: snapshotSubAgentExecution({ source, roleDigest: fixtureSubAgentDefinition().digest,
    accessMode: source.accessMode, protectSource: false, tools: [], mcpSignature: "fixture" }) };
}
