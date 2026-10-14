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
