/**
 * 工作区入口助手（issue 21；agent-direction issue 05：`ruukoto <路径>` 的客户端侧逻辑）。
 *
 * - resolveWorkspaceDir：按客户端 cwd 解析路径并取目录身份（realpath + dev/ino），
 *   语义同服务端 src/core/dir-identity.ts，但错误面向命令行用户（不存在/不是目录）；
 *   后台收到 open_workspace 后仍会重新校验目录身份与保护根，这里不做权限判断。
 * - findWorkspaceByRoot：按根目录归属命中已确认的工作区（rootDir 的 cwdReal 相同
 *   或 dev+ino 相同），命中即唯一归属，不再走候选。
 * - findWorkspaceProjects：在尚无根目录归属的旧项目里按会话目录身份找候选（角色
 *   与 QQ 专用会话不参与自动归属；已有归属的工作区不再充当遗留候选）。自动项目名
 *   由后台 open_workspace 取根目录名并处理重名（仅展示层去重，同名不同目录绝不合并）。
 * - workspacePickerProjects：TUI 普通列表数据——带根目录归属的是工作区，无归属且
 *   非内部（角色、QQ 群聊会话所在）的是旧项目；内部项目不进入普通列表。
 * - ensureWorkspaceSession：经 open_workspace 以稳定的启动请求标识幂地复用/创建
 *   工作区并新建会话。应答丢失后的重试方式：重连并完成新握手后，先在新快照里按
 *   createRequestId === startupRequestId 找会话；找到即进入，找不到才用同一
 *   标识重发（服务端去重保证不重建）。标识只在本次启动内复用，不生成第二个。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Project, Session } from "../core/types.ts";
import { sameDirIdentity, type DirIdentity } from "../core/dir-identity.ts";
import { ControlClientError, type ControlTransport } from "./client.ts";
import type { OpResult } from "./ops.ts";

/** 最小控制面客户端：ControlClient 与 ControlConnection 均满足。 */
export type WorkspaceClient = Pick<ControlTransport, "request">;

/** 解析工作区目录：相对路径按客户端 cwd 解析；只接受已存在的目录。 */
export async function resolveWorkspaceDir(pathArg: string, cwd: string): Promise<DirIdentity> {
  const resolved = path.resolve(cwd, pathArg);
  let real: string;
  let stat: fs.Stats;
  try {
    real = await fs.promises.realpath(resolved);
    stat = await fs.promises.stat(real);
  } catch {
    throw new Error(`目录不存在：${pathArg}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`工作区必须是目录：${pathArg}`);
  }
  return { cwd: resolved, cwdReal: real, dev: stat.dev, ino: stat.ino };
}

/** 按根目录归属命中工作区（issue 05）：rootDir 的 cwdReal 相同或 dev+ino 相同。 */
export function findWorkspaceByRoot(snapshot: { projects: Project[] }, identity: DirIdentity): Project | null {
  for (const project of snapshot.projects) {
    if (project.rootDir && sameDirIdentity(project.rootDir, identity)) return project;
  }
  return null;
}

/**
 * 在尚无根目录归属的旧项目里按目录身份找候选：kind 为 dev 且不是逻辑角色绑定的
 * 会话中，cwdReal 相同或 dev+ino 相同（覆盖符号链接与挂载别名）者所属的项目。
 * 已有根目录归属的工作区不再充当候选（归属由 findWorkspaceByRoot 决定）。
 * 去重并保持快照顺序。
 */
export function findWorkspaceProjects(
  snapshot: { projects: Project[]; sessions: Session[]; roleSessionIds: string[] },
  identity: DirIdentity,
): Project[] {
  const seen = new Set<string>();
  const out: Project[] = [];
  for (const session of snapshot.sessions) {
    if (session.kind !== "dev" || snapshot.roleSessionIds.includes(session.id)) continue;
    const sameDir =
      session.cwdReal === identity.cwdReal ||
      (session.cwdDev === identity.dev && session.cwdIno === identity.ino);
    if (!sameDir || seen.has(session.projectId)) continue;
    const project = snapshot.projects.find((p) => p.id === session.projectId);
    if (project && !project.rootDir) {
      seen.add(session.projectId);
      out.push(project);
    }
  }
  return out;
}

/**
 * TUI 普通列表（issue 05）：工作区（带根目录归属）在前，旧项目在后。角色与
 * 群聊会话不进入普通列表；完全由这类会话组成的项目（agent-* 角色项目、
 * qq-* 群项目）随之不出现在列表；含普通 dev 会话的旧项目照旧保留。内部
 * 子任务是任务而非会话，故无需排除。
 */
export function workspacePickerProjects(snapshot: {
  projects: Project[];
  sessions: Session[];
  roleSessionIds: string[];
}): { workspaces: Project[]; legacy: Project[] } {
  const roleIds = new Set(snapshot.roleSessionIds);
  const visible = (session: Session): boolean => session.kind === "dev" && !roleIds.has(session.id);
  const byProject = new Map<string, Session[]>();
  for (const session of snapshot.sessions) {
    const list = byProject.get(session.projectId) ?? [];
    list.push(session);
    byProject.set(session.projectId, list);
  }
  const workspaces: Project[] = [];
  const legacy: Project[] = [];
  for (const project of snapshot.projects) {
    const sessions = byProject.get(project.id) ?? [];
    if (sessions.length > 0 && !sessions.some(visible)) continue;
    (project.rootDir ? workspaces : legacy).push(project);
  }
  return { workspaces, legacy };
}

/**
 * 幂等地打开工作区并新建会话：projectId 指定既有项目（旧项目认领根目录，保留旧
 * 关系）；否则服务端按目录身份复用已归属工作区或创建新工作区（目录校验先于写入，
 * 认领/建项目与建会话同一事务，失败不留空项目）。同一路径用同一启动请求标识，
 * 服务端去重保证重试不重建。request_conflict 等协议错误原样抛出。
 */
export async function ensureWorkspaceSession(
  client: WorkspaceClient,
  snapshot: { projects: Project[]; sessions: Session[] },
  identity: DirIdentity,
  opts: { projectId: string | null; startupRequestId: string },
): Promise<{ session: Session; projectId: string; projectName: string; createdProject: boolean }> {
  if (opts.projectId !== null && !snapshot.projects.some((p) => p.id === opts.projectId)) {
    // 本地前置检查：请求未发出，按明确拒绝回落正常启动（not_sent 会在线等一次不会来的重连）
    throw new ControlClientError("not_found", `项目不存在：${opts.projectId}`, "rejected");
  }
  const result: OpResult<"open_workspace"> = await client.request("open_workspace", {
    cwd: identity.cwd,
    project_id: opts.projectId ?? undefined,
    request_id: opts.startupRequestId,
  });
  return {
    session: result.session,
    projectId: result.session.projectId,
    projectName: result.projectName,
    createdProject: result.createdProject,
  };
}
