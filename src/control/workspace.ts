/**
 * 工作区入口助手（issue 21：`ruukoto <路径>` 的客户端侧逻辑）。
 *
 * - resolveWorkspaceDir：按客户端 cwd 解析路径并取目录身份（realpath + dev/ino），
 *   语义同服务端 src/core/dir-identity.ts，但错误面向命令行用户（不存在/不是目录）；
 *   后台收到 create_session 后仍会重新校验目录身份与保护根，这里不做权限判断。
 * - findWorkspaceProjects / suggestProjectName：按目录身份在快照中找已有开发会话
 *   对应的项目（角色与 QQ 专用会话不参与自动归属）；自动项目名取目录名并处理重名
 *   （仅展示层去重，同名不同目录绝不合并为一个项目）。
 * - ensureWorkspaceSession：以稳定的启动请求标识幂等创建项目与会话。
 *   应答丢失后的重试方式：重连并完成新握手后，先在新快照里按
 *   createRequestId === startupRequestId 找会话；找到即进入，找不到才用同一
 *   标识重发（服务端去重保证不重建）。标识只在本次启动内复用，不生成第二个。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Project, Session } from "../core/types.ts";
import type { DirIdentity } from "../core/dir-identity.ts";
import { ControlClientError, type ControlTransport } from "./client.ts";

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

/**
 * 按目录身份找候选项目：kind 为 dev 且不是逻辑角色绑定的会话中，cwdReal 相同
 * 或 dev+ino 相同（覆盖符号链接与挂载别名）者所属的项目。去重并保持快照顺序。
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
    if (project) {
      seen.add(session.projectId);
      out.push(project);
    }
  }
  return out;
}

/** 自动项目名：目录名；与既有项目重名时追加 " (2)"、" (3)"…（仅展示层去重）。 */
export function suggestProjectName(snapshot: { projects: Project[] }, identity: DirIdentity): string {
  const base = path.basename(identity.cwdReal) || "workspace";
  const names = new Set(snapshot.projects.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!names.has(candidate)) return candidate;
  }
}

/**
 * 幂等地保证工作区会话存在：projectId 为 null 时走 create_session 的
 * project_name 自动建项目路径（目录校验先于写入，项目+会话同一事务，
 * 失败不留空项目）；否则按既有项目创建。同一路径用同一启动请求标识，
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
  const projectName =
    opts.projectId === null
      ? suggestProjectName(snapshot, identity)
      : snapshot.projects.find((p) => p.id === opts.projectId)!.name;
  const session = await client.request("create_session", {
    project_id: opts.projectId ?? undefined,
    project_name: opts.projectId === null ? projectName : undefined,
    cwd: identity.cwd,
    request_id: opts.startupRequestId,
  });
  return { session, projectId: session.projectId, projectName, createdProject: opts.projectId === null };
}
