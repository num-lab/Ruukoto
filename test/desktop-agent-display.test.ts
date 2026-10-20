import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { subAgentTaskRequestId } from "@ruukoto/agent/subagent-ledger.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { randomId, TASK_START_MARKER, type Session, type SubAgent, type Task, type WorkDelegation } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";
import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";
import { startTestRuntime } from "./helpers/testkit.ts";

test("子任务详情仅从唯一成功委派投影原始请求，继续与协作沿精确任务关联", async () => {
  const kit = await startTestRuntime("agent-display", () => ({ kind: "text", text: "不应执行模型" }));
  try {
    const { runtime } = kit, { store } = runtime;
    const parentSession = await runtime.createSession({ projectName: "展示来源", cwd: kit.work[0] });
    const foreignSession = await runtime.createSession({ projectId: parentSession.projectId, cwd: kit.work[0] });
    const childSession = await runtime.createSession({ projectId: parentSession.projectId, cwd: kit.work[1] });
    const collaboratorSession = await runtime.createSession({ projectId: parentSession.projectId, cwd: kit.work[1] });
    const input = "[SubAgent 委派 · 独立执行]\n宿主权限与路径说明\n---\n原始请求";
    const task = (session: Session, extra: Partial<Parameters<typeof store.insertQueuedTask>[0]> = {}): Task => store.withTx(() => {
      const created = store.insertQueuedTask({ sessionId: session.id, requestId: randomId("request"), input, modelSelection: runtime.defaultSelection, submissionDigest: "fixture", ...extra }).task;
      store.endTask(created.id, ["queued"], "canceled");
      store.setTaskResult(created.id, "历史展示夹具", JSON.stringify({ sessionId: session.id, taskId: created.id }));
      store.markSubAgentResultsDelivered([created.id], created.createdAt);
      return store.getTask(created.id)!;
    });
    const parent = task(parentSession);
    const createAgent = (session: Session): SubAgent => {
      const agent: SubAgent = { id: randomId("agent"), definition: fixtureSubAgentDefinition(), parentSessionId: parentSession.id, sessionId: session.id,
        workDir: session.cwd, activeWorkId: null, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: parent.createdAt };
      store.withTx(() => store.insertSubAgent(agent));
      return agent;
    };
    const primary = createAgent(childSession), collaborator = createAgent(collaboratorSession);
    const work: WorkDelegation = { id: randomId("work"), parentSessionId: parentSession.id, originTaskId: parent.id, subAgentId: primary.id,
      requestKey: "first", paramsDigest: "fixture", writeTarget: null, canceledAt: null, canceledBy: null, cancelReason: null, createdAt: parent.createdAt };
    store.withTx(() => store.insertWorkDelegation(work));
    const child = (source: Task, key: string, agent = primary, workId = work.id, extra: Partial<Parameters<typeof store.insertQueuedTask>[0]> = {}) => task(
      agent.id === primary.id ? childSession : collaboratorSession,
      { requestId: subAgentTaskRequestId(workId, key), parentTaskId: source.id, workId, subAgentId: agent.id, ...extra },
    );
    const operation = (source: Task, params: Record<string, unknown>, status: "success" | "error" | "pending" | "unknown" = "success") => {
      const id = randomId("op");
      store.withTx(() => {
        store.recordToolIntent({ id, taskId: source.id, sessionId: source.sessionId, toolName: "subagent_delegate", params });
        if (status !== "pending") store.recordToolResult(id, "委派结果包含内部工作与任务标识", status === "error");
        if (status === "unknown") store.markToolOpEffectUnknown(id);
      });
      return id;
    };
    const display = (value: Task) => runtime.getTaskDetail(value.id)!.task.displayInput;
    const original = "核对中文时钟\n---\n[SubAgent 委派 · 这是原始正文的一部分]";
    const first = child(parent, "first");
    const firstOp = operation(parent, { key: "first", request: original, materials: "资料".repeat(5000) });
    assert.equal(runtime.getTaskDetail(parent.id)!.toolOps.find(op => op.id === firstOp)!.paramsTruncated, true);
    assert.equal(display(first), original, "完整持久参数不受线上预览截断影响");
    operation(parent, { key: "first", request: "同键异参失败的正文" }, "error");
    operation(parent, { key: "first", request: original });
    assert.equal(display(first), original, "忽略失败冲突，成功重放相同正文仍唯一");

    const nextParent = task(parentSession);
    const continued = child(nextParent, "continued");
    operation(nextParent, { key: "continued", request: "继续核对", work_id: work.id });
    assert.equal(display(continued), "继续核对", "继续委派不受首次父任务与首次key限制");
    const joined = child(nextParent, "joined", collaborator);
    operation(nextParent, { key: "joined", request: "独立协作核对", work_id: work.id, sub_agent_id: collaborator.id });
    assert.equal(display(joined), "独立协作核对", "协作者不必等于工作首次Agent");

    const reusedWork: WorkDelegation = { ...work, id: randomId("work"), originTaskId: nextParent.id, requestKey: "reused" };
    store.withTx(() => store.insertWorkDelegation(reusedWork));
    const reused = child(nextParent, "reused", primary, reusedWork.id);
    operation(nextParent, { key: "reused", request: "同Agent承接新工作", sub_agent_id: primary.id });
    assert.equal(display(reused), "同Agent承接新工作");

    const missing = child(nextParent, "missing");
    assert.equal(display(missing), undefined, "没有父工具来源时保留任务原文");
    for (const status of ["pending", "unknown", "error"] as const) {
      const value = child(nextParent, status);
      operation(nextParent, { key: status, request: status, work_id: work.id }, status);
      assert.equal(display(value), undefined, status);
    }
    const foreignParent = task(foreignSession);
    const foreign = child(foreignParent, "foreign");
    operation(foreignParent, { key: "foreign", request: "其他父会话", work_id: work.id });
    assert.equal(display(foreign), undefined, "父会话不同不能借工作ID关联");
    const wrongAgent = child(nextParent, "wrong-agent", collaborator);
    operation(nextParent, { key: "wrong-agent", request: "应由首次Agent处理", work_id: work.id });
    assert.equal(display(wrongAgent), undefined);
    const wrongRequest = child(nextParent, "correct", primary, work.id, { requestId: "不匹配的执行请求" });
    operation(nextParent, { key: "correct", request: "另一执行请求", work_id: work.id });
    assert.equal(display(wrongRequest), undefined);
    const noAssociation = task(childSession);
    assert.equal(display(noAssociation), undefined);
    operation(nextParent, { key: "continued", request: "第二个不同的成功正文", work_id: work.id });
    assert.equal(display(continued), undefined, "成功来源有歧义时不猜正文");

    const historyFile = path.join(kit.dirs.dataDir, "display-input.jsonl");
    const history = [
      { type: "session", version: 3, id: childSession.piSessionId, timestamp: first.createdAt, cwd: childSession.cwd },
      { type: "custom", id: "start", parentId: null, timestamp: first.createdAt, customType: TASK_START_MARKER, data: { taskId: first.id } },
      { type: "message", id: "user", parentId: "start", timestamp: first.createdAt, message: { role: "user", content: first.input } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    fs.writeFileSync(historyFile, history);
    store.withTx(() => store.setSessionFile(childSession.id, historyFile));
    const detail = await kit.client.request<OpResult<"get_task">>("get_task", { task_id: first.id });
    assert.equal(detail.task.displayInput, original);
    assert.equal(detail.task.input, input);
    assert.equal(store.getTask(first.id)!.input, input);
    assert.equal(runtime.readHistory({ sessionId: childSession.id }).entries[0].text, input);
    assert.equal(fs.readFileSync(historyFile, "utf8"), history);
    assert.equal(kit.server.calls.length, 0, "只读投影不触发模型或重送请求");
  } finally {
    await kit.shutdown();
  }
});

function taskView(extra: Partial<TaskView> = {}): TaskView {
  return { id: "child", sessionId: "session", requestId: "request", input: "完整宿主输入", inputPurpose: "user", modelSelection: null, submissionDigest: "digest",
    status: "running", accessMode: "confirm", planMode: false, permissionVersion: 1, grantedPaths: [], pendingAccessMode: null, interruptReason: null,
    cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: "parent",
    sourcePermissionVersion: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: "work", subAgentId: "agent", readScope: null,
    resultDeliveredAt: null, createdAt: "2026-10-16T00:00:00Z", startedAt: "2026-10-16T00:00:00Z", endedAt: null, ...extra };
}

test("展示正文在旧详情、终态保护与同实例快照后保留，跨实例清除", () => {
  const view = new ViewState();
  view.upsertTask(taskView());
  view.applyEvent({ seq: 20, sessionId: "session", taskId: "child", createdAt: "2026-10-16T00:00:01Z", body: { type: "task.completed", taskId: "child", sessionId: "session" } }, "live");
  view.installTaskDetail(taskView({ displayInput: "原始请求" }), [], null, 10);
  assert.equal(view.getTask("child")!.displayInput, "原始请求", "旧详情仍补不可变展示元数据");
  assert.equal(view.getTask("child")!.status, "completed", "旧详情不回滚状态");
  view.upsertTask(taskView({ status: "queued" }));
  assert.equal(view.getTask("child")!.displayInput, "原始请求");
  assert.equal(view.getTask("child")!.status, "completed");
  view.upsertTask(taskView({ status: "completed", endedAt: "2026-10-16T00:00:01Z" }));
  assert.equal(view.getTask("child")!.displayInput, "原始请求", "普通完整任务更新未携带可选字段时仍保留");
  const snapshot = fakeSnapshot({ tasks: [taskView()], instanceId: "instance" });
  view.instanceId = "instance";
  view.applySnapshot({ snapshot, seq: 30, replay: [] }, false);
  assert.equal(view.getTask("child")!.displayInput, "原始请求");
  view.applySnapshot({ snapshot: { ...snapshot, instanceId: "other" }, seq: 30, replay: [] }, true);
  assert.equal(view.getTask("child")!.displayInput, undefined);
  assert.equal(view.getTask("child")!.input, "完整宿主输入");
});
