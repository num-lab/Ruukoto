import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import { PROTOCOL_VERSION } from "@ruukoto/core/types.ts";
import { bindAgentReportFallback, claimAgentReports, listAgentWaits, registerAgentReport, releaseAgentReports, transferAgentReportFallbacks } from "@ruukoto/core/agent-wait.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { EventFlowView } from "@ruukoto/tui/tui/event-flow-view.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { afterTool, connectAuthedClient, lastToolText, lastUserText, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

initTheme("dark");

test("控制面补报停车：原任务与别名都保留可信身份，实时和重连仅列出可执行排队任务", async () => {
  const t = await startTestRuntime("wait-parked-view", () => { throw new Error("停车夹具不得请求模型"); }, { workDirs: 1 });
  const clients = [t.client];
  try {
    const session = await t.runtime.createSession({ projectName: "parked", cwd: t.work[0] }), store = t.runtime.store;
    const sameInput = "[后台工作最终回报]\n同名资料";
    const queued = (requestId: string, input = sameInput) => store.insertQueuedTask({ sessionId: session.id, requestId, input, submissionDigest: requestId, modelSelection: t.runtime.defaultSelection }).task;
    const parent = store.withTx(() => {
      store.setSessionQueueState(session.id, "paused", "fixture");
      const task = queued("parent", "拥有者工作");
      store.transitionTask(task.id, ["queued"], "running");
      return store.getTask(task.id)!;
    });
    const source: WorkflowSource = { product: "ruukoto-code", projectId: session.projectId, sessionId: session.id, taskId: parent.id,
      permissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null };
    const reports = [0, 1].map(index => store.withTx(() => {
      const sub = store.createSession({ projectId: session.projectId, cwd: session.cwd, cwdReal: session.cwdReal, cwdDev: session.cwdDev,
        cwdIno: session.cwdIno, piSessionId: `parked-${index}`, confirmTools: [] });
      const subAgentId = `sub-${index}`, workId = `work-${index}`;
      store.insertSubAgent({ definition: fixtureSubAgentDefinition(), id: subAgentId, parentSessionId: session.id, sessionId: sub.id, workDir: session.cwd, activeWorkId: workId,
        currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
      store.insertWorkDelegation({ id: workId, parentSessionId: session.id, originTaskId: parent.id, subAgentId, requestKey: `work-${index}`,
        paramsDigest: "d", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: sub.createdAt });
      const child = store.insertQueuedTask({ sessionId: sub.id, requestId: "child", input: "后台工作", submissionDigest: "child", parentTaskId: parent.id, subAgentId, workId, modelSelection: t.runtime.defaultSelection }).task;
      store.transitionTask(child.id, ["queued"], "completed"); store.setTaskResult(child.id, "已完成", "{}");
      return registerAgentReport(store, { target: { kind: "task", taskId: child.id }, source, parentSessionId: session.id });
    }));
    const [canonical, alias, owner] = store.withTx(() => [queued("original-a"), queued("original-b"), queued("owner-same-text")]);
    store.withTx(() => { bindAgentReportFallback(store, reports[0].key, canonical.id); bindAgentReportFallback(store, reports[1].key, alias.id); });
    const state = new ViewState(); state.applySnapshot(await t.client.handshake(), false);
    const view = state.openSession(session.id);
    t.client.onEvent(event => state.applyEvent(event, "live"));
    assert.equal(state.tasks.get(owner.id)?.inputPurpose, "user", "普通同名输入不取得补报身份");
    assert.deepEqual(view.flow.items.filter(entry => entry.kind === "message" && entry.role === "user" && entry.text === sameInput).map(entry => entry.taskId), [owner.id]);
    store.withTx(() => transferAgentReportFallbacks(store, reports.map(report => report.key), canonical.id));
    await waitFor("别名实时停车", () => state.tasks.get(alias.id)?.reportParked === true);
    assert.equal(state.tasks.get(canonical.id)?.reportParked, false);
    store.withTx(() => claimAgentReports(store, { taskId: parent.id, keys: reports.map(report => report.key) }));
    await waitFor("原汇总任务实时停车", () => state.tasks.get(canonical.id)?.reportParked === true);
    assert.deepEqual(state.queuedTasksFor(session.id).map(task => task.id), [owner.id]);
    for (const task of [canonical, alias]) {
      const detail = await t.client.request<OpResult<"get_task">>("get_task", { task_id: task.id });
      assert.equal(detail.task.inputPurpose, "internal_report"); assert.equal(detail.task.reportParked, true);
      assert.equal(detail.task.status, "queued"); assert.equal(detail.task.input, sameInput); assert.equal(detail.task.requestId, task.requestId);
    }
    const again = await connectAuthedClient(t.runtime); clients.push(again);
    const restored = new ViewState(); restored.applySnapshot(await again.handshake(), false);
    assert.deepEqual(restored.queuedTasksFor(session.id).map(task => task.id), [owner.id]);
    assert.equal(restored.tasks.get(alias.id)?.reportParked, true);
    store.withTx(() => releaseAgentReports(store, parent.id, "parent_failed"));
    await waitFor("失败后原任务重入队列", () => state.tasks.get(canonical.id)?.reportParked === false);
    assert.deepEqual(new Set(state.queuedTasksFor(session.id).map(task => task.id)), new Set([canonical.id, owner.id]));
    assert.equal(state.tasks.get(alias.id)?.reportParked, true, "归并别名始终停车");
    assert.equal(t.server.calls.length, 0);
  } finally { for (const client of clients) client.close(); await t.shutdown(); }
});

test("真实控制面等待：实时与重连含完整对象，TUI 状态与实际渲染区分等待和新输入中断", async () => {
  let releaseChild!: () => void;
  const childReady = new Promise<void>(resolve => { releaseChild = resolve; });
  let parentPhase = 0, runId = "";
  const t = await startTestRuntime("wait-view", async request => {
    const input = lastUserText(request);
    if (input === "等待后台") {
      if (parentPhase++ === 0) return { kind: "tool_calls", calls: [{ id: "start", name: "workflow_start", arguments: { title: "后台处理",
        key: "view", input: null, script: 'return await agent("child",{request:"WAIT_CHILD"});',
      } }] };
      runId = (JSON.parse(lastToolText(request)) as { run: { id: string } }).run.id;
      return { kind: "tool_calls", calls: [{ id: "wait", name: "agent_wait", arguments: { targets: [{ kind: "workflow", run_id: runId }] } }] };
    }
    if (input.includes("WAIT_CHILD")) { await childReady; return { kind: "text", text: "后台完成" }; }
    return { kind: "text", text: "新输入已处理" };
  }, { config: { product: codeProduct.runtime }, workDirs: 1 });
  const clients = [t.client], events: PersistentEvent[] = [];
  try {
    const session = await t.runtime.createSession({ projectName: "wait-view", cwd: t.work[0] });
    const state = new ViewState();
    state.applySnapshot(await t.client.handshake(), false);
    const view = state.openSession(session.id), rendered = new EventFlowView();
    t.client.onEvent(event => { events.push(event); state.applyEvent(event, "live"); });
    const parent = await t.runtime.submit({ sessionId: session.id, requestId: "parent", input: "等待后台", modelSelection: t.runtime.defaultSelection });
    await waitFor("等待视图已实时推送", () => state.tasks.get(parent.id)?.wait?.phase === "waiting");
    const detail = await t.client.request<OpResult<"get_task">>("get_task", { task_id: parent.id });
    assert.equal(PROTOCOL_VERSION, 26);
    assert.equal(detail.task.resourcePhase, "conversation");
    assert.equal(detail.task.wait!.targets[0].id, runId);
    assert.equal(detail.task.wait!.targets[0].kind, "workflow");
    const workflow = t.runtime.getWorkflowDetail(runId).run;
    assert.equal(detail.task.wait!.targets[0].label, `工作流 · 后台处理 · 第 ${workflow.number} 项 · ${workflow.createdAt}`);
    assert.ok(detail.task.wait!.deadline);
    assert.deepEqual(state.tasks.get(parent.id)?.wait, detail.task.wait);
    rendered.setEntries(view.flow.items);
    assert.match(stripTerminalSequences(rendered.render(100).join("\n")), /等待后台：工作流.*running/s);

    const again = await connectAuthedClient(t.runtime); clients.push(again);
    const snapshot = await again.handshake(detail.seq);
    const restored = new ViewState(); restored.applySnapshot(snapshot, false);
    assert.deepEqual(restored.tasks.get(parent.id)?.wait, detail.task.wait);
    assert.equal(restored.tasks.get(parent.id)?.resourcePhase, "conversation");
    for (const event of snapshot.replay) restored.applyEvent(event, "replay");
    assert.equal(restored.tasks.get(parent.id)?.wait?.phase, "waiting", "重放不能回退等待阶段");

    const next = await t.runtime.submit({ sessionId: session.id, requestId: "owner-next", input: "新消息", modelSelection: t.runtime.defaultSelection });
    await waitFor("可信新输入已打断等待", () => state.tasks.get(parent.id)?.status === "interrupted" && state.tasks.get(parent.id)?.wait?.reason === "owner_input");
    assert.equal(listAgentWaits(t.runtime.store, { taskId: parent.id })[0].reason, "owner_input");
    rendered.setEntries(view.flow.items);
    assert.match(stripTerminalSequences(rendered.render(100).join("\n")), /新输入打断等待，后台工作继续/);
    const resource = events.find(event => event.body.type === "task.resources_changed" && event.body.taskId === parent.id);
    assert.ok(resource, "资源阶段有持久事件");
    await waitFor("新输入完成", () => t.runtime.store.getTask(next.id)?.status === "completed");
    const interrupted = await again.request<OpResult<"get_task">>("get_task", { task_id: parent.id });
    assert.equal(interrupted.task.wait?.reason, "owner_input");
    const waitOp = interrupted.toolOps.find(op => op.toolName === "agent_wait")!;
    assert.equal(waitOp.effectUnknown, false);
    assert.equal(interrupted.task.effectUnknown, false);
  } finally { releaseChild(); for (const client of clients) client.close(); await t.shutdown(); }
});

test("真实工具资格：SubAgent、工作流步骤与无工具后备汇总均不能调用 agent_wait", async () => {
  let parentPhase = 0;
  const checked = new Set<string>();
  const t = await startTestRuntime("wait-tool-class", request => {
    const input = lastUserText(request);
    if (input === "工具资格") {
      if (parentPhase++ === 0) return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { request: "SUBAGENT_MARK", key: "sub", read_paths: ["."] } }] };
      if (parentPhase === 2) return { kind: "tool_calls", calls: [{ id: "workflow", name: "workflow_start", arguments: { title: "后台处理",
        key: "workflow", input: null, script: 'return await agent("step",{request:"WORKFLOW_MARK"});',
      } }] };
      return { kind: "text", text: "父轮结束" };
    }
    const kind = input.startsWith("[工作流最终回报]") ? "fallback" : input.includes("WORKFLOW_MARK") ? "workflow" : "subagent";
    checked.add(kind);
    assert.ok(!toolNamesOf(request).includes("agent_wait"));
    if (kind === "fallback") assert.deepEqual(toolNamesOf(request), []);
    if (!afterTool(request)) return { kind: "tool_calls", calls: [{ id: `hidden-${kind}`, name: "agent_wait", arguments: { targets: [{ kind: "task", task_id: "foreign" }] } }] };
    assert.match(lastToolText(request), /Tool agent_wait not found|白名单/);
    return { kind: "text", text: `${kind}完成` };
  }, { config: { product: codeProduct.runtime }, workDirs: 1 });
  try {
    const session = await t.runtime.createSession({ projectName: "class", cwd: t.work[0] });
    await t.runtime.submit({ sessionId: session.id, requestId: "parent", input: "工具资格", modelSelection: t.runtime.defaultSelection });
    await waitFor("三类真实调用均被拒绝", () => checked.size === 3 && t.runtime.store.listTasksByStatus(["running", "queued"]).length === 0);
    assert.deepEqual(checked, new Set(["subagent", "workflow", "fallback"]));
    assert.equal(listAgentWaits(t.runtime.store).length, 0);
    assert.ok(t.runtime.store.listAllUnresolvedToolOps().every(op => op.toolName !== "agent_wait"));
  } finally { await t.shutdown(); }
});
