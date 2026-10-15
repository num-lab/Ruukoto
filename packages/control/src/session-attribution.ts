import type { Project, Session } from "@ruukoto/core/types.ts";

/**
 * 展示归属规则（agent-direction issue 07；仅拥有者的组织查询与界面展示）：
 * 显式工作区映射（session.workspaceProjectId）优先；无映射且来源项目已有根
 * 目录归属时使用来源项目（它本身是工作区）；其余仍列在来源旧项目下。
 * 这不改变会话的资料身份：配置与资料来源恒为会话的原 projectId；AccessScope、
 * 模型工具身份与凭据范围判定不得使用本规则。
 */
export function sessionDisplayAttribution(
  session: Pick<Session, "projectId" | "workspaceProjectId">,
  projects: Pick<Project, "id" | "rootDir">[],
): { projectId: string; kind: "mapped" | "workspace" | "legacy" } {
  if (session.workspaceProjectId !== null) {
    return { projectId: session.workspaceProjectId, kind: "mapped" };
  }
  const source = projects.find((p) => p.id === session.projectId);
  return { projectId: session.projectId, kind: source?.rootDir ? "workspace" : "legacy" };
}
