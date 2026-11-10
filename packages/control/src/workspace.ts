/** Owner workspace discovery and idempotent conversation creation. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Project, Session } from "@ruukoto/core/types.ts";
import { sameDirIdentity, type DirIdentity } from "@ruukoto/core/dir-identity.ts";
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


/** Open the bound workspace or create one, retaining the caller's idempotency key. */
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
