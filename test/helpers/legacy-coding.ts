/**
 * 旧 coding 角色播种助手（agent-direction issue 23）：按固定 coding 退役前的持久
 * 形态直接写入角色行、角色会话与 main → coding 委派子任务，不经已删除的运行路径。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "@ruukoto/core/store.ts";
import { randomId, type ModelSelection, type Task } from "@ruukoto/core/types.ts";

const SELECTION: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

/** 旧安装的 coding 角色：agent-coding 项目 + 角色会话 + agent_roles 行。 */
export function seedCodingRole(store: Store, workRoot: string): { projectId: string; sessionId: string } {
  const project = store.createProject("agent-coding");
  const workDir = path.join(workRoot, "agent-work", "coding");
  fs.mkdirSync(workDir, { recursive: true });
  const stat = fs.statSync(workDir);
  const session = store.createSession({
    projectId: project.id, kind: "dev", cwd: workDir, cwdReal: fs.realpathSync(workDir),
    cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: randomId("pi"), confirmTools: [], modelSelection: SELECTION,
  });
  store.insertAgentRole({
    id: "coding", projectId: project.id, sessionId: session.id, workDir, modelSelection: null,
    tools: ["coding", "host_data", "web_search", "mcp", "skills"], createdAt: session.createdAt,
  });
  return { projectId: project.id, sessionId: session.id };
}

/** 旧 coding 子任务（排队态；正文首行为旧宿主写入的委派头）。 */
export function seedCodingChild(
  store: Store,
  sessionId: string,
  opts: { parent?: Task; key: string; mark: string; sourceEventId?: string },
): Task {
  return store.insertQueuedTask({
    sessionId, requestId: `deleg:${opts.parent?.id ?? "legacy"}:${opts.key}`,
    input: `[委派 coding · draft]\n来自 main 的委派\n---\n${opts.mark}`,
    modelSelection: SELECTION, submissionDigest: `legacy-${opts.key}`, agentId: "coding", parentTaskId: opts.parent?.id ?? null,
    sourceEventId: opts.sourceEventId ?? null, accessMode: "confirm", deadline: new Date(Date.now() + 3_600_000).toISOString(),
  }).task;
}

/** 把旧子任务推到 completed 并写入结果（旧结构化 result_ref 由调用方给定）。 */
export function completeCodingChild(store: Store, taskId: string, summary: string, resultRef: string): void {
  const now = new Date().toISOString();
  store.transitionTask(taskId, ["queued"], "running", { startedAt: now });
  store.transitionTask(taskId, ["running"], "completed", { endedAt: now });
  store.setTaskResult(taskId, summary, resultRef);
}
