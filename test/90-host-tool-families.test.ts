import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { buildHostToolSet, hostCallFor, type HostToolContext, type HostToolLedger, type HostToolRuntime } from "@ruukoto/agent/host-tool-families.ts";
import { createSubAgentTools, SUBAGENT_LEDGER, type SubAgentToolsDeps } from "@ruukoto/agent/subagent-tools.ts";
import { ToolOpLedger, type FamilyCheck } from "@ruukoto/agent/tool-op-ledger.ts";
import { HOST_DATA_LEDGER } from "@ruukoto/agent/host-tools.ts";
import { WEB_SEARCH_LEDGER } from "@ruukoto/agent/web-search.ts";
import { APP_DATA_LEDGER } from "@ruukoto/agent/app-data/tools.ts";
import { SCHEDULER_LEDGER } from "@ruukoto/channels/scheduler/ledger.ts";
import { DELEGATION_LEDGER } from "@ruukoto/agent/delegation-tools.ts";
import { CHAT_RESULT_LEDGER } from "@ruukoto/channels/chat-result-tools.ts";
import { SERVICE_LEDGER } from "@ruukoto/channels/service-ledger.ts";
import { SKILL_LEDGER } from "@ruukoto/agent/skills.ts";
import { TODO_LEDGER } from "@ruukoto/agent/todo.ts";

function runtime(): HostToolRuntime {
  return {} as HostToolRuntime;
}

test("宿主工具族从同一 names 清单构建并拒绝重复或漂移", () => {
  const one = { category: "skills" as const, names: ["skill"] as const, build: () => [{ name: "skill" }] as any };
  const two = { category: "coding" as const, names: ["todo_write"] as const, build: () => [{ name: "todo_write" }] as any };
  const built = buildHostToolSet([one, two], runtime());
  assert.deepEqual([...built.names], ["skill", "todo_write"]);
  assert.deepEqual(built.tools.map((tool) => tool.name), ["skill", "todo_write"]);

  assert.throws(
    () => buildHostToolSet([{ ...one, build: () => [{ name: "other" }] as any }, two], runtime()),
    /声明与构建结果不一致/,
  );
  assert.throws(
    () => buildHostToolSet([one, { ...two, names: ["skill"] as const }], runtime()),
    /工具名重复/,
  );
  assert.throws(
    () => buildHostToolSet([{ ...one, build: () => [{ name: "skill" }, { name: "skill" }] as any }], runtime()),
    /重复|声明与构建结果不一致/,
    "同一族实际返回两个同名定义也必须拒绝，不能被 Set 去重掩盖",
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("真实宿主 execute 并发持有独立上下文，先释放的调用不影响另一个，异步异常也经 finally 释放", async (t) => {
  for (const failSecond of [false, true]) {
    await t.test(failSecond ? "后一个调用异步失败" : "后一个调用正常完成", async () => {
      const contexts = new Map<string, HostToolContext>([
        ["call-a", { taskId: "task-a", sessionId: "session-a", projectId: "project-a", hostOpId: "op-a" }],
        ["call-b", { taskId: "task-b", sessionId: "session-b", projectId: "project-b", hostOpId: "op-b" }],
      ]);
      const verified: HostToolContext[] = [];
      const released: string[] = [];
      const gates = new Map([["work-a", deferred()], ["work-b", deferred()]]);
      const inputs: Array<{ workId: string; parentTaskId: string; parentSessionId: string }> = [];
      const deps: Pick<SubAgentToolsDeps, "taskContext" | "bindCall" | "verifyHost" | "integrate"> = {
        taskContext: () => assert.fail("独立调用句柄不能回退到共享任务上下文"),
        bindCall: (id) => ({
          context: contexts.get(id) ?? null,
          release: () => { released.push(id); contexts.delete(id); },
        }),
        verifyHost: (ctx) => { verified.push({ ...ctx }); return null; },
        integrate: async (input) => {
          inputs.push(input);
          await gates.get(input.workId)!.promise;
          const id = input.workId === "work-a" ? "call-a" : "call-b";
          assert.equal(contexts.get(id)?.taskId, input.parentTaskId, "异步执行结束前仍持有自己的调用上下文");
          if (failSecond && id === "call-b") throw new Error("异步汇总失败");
          return {
            work: { id: input.workId } as Awaited<ReturnType<SubAgentToolsDeps["integrate"]>>["work"],
            state: "empty", baseCommit: "abcdef012345", parentHead: null,
            filesChanged: 0, insertions: 0, deletions: 0, files: [],
          };
        },
      };
      const tools = createSubAgentTools(deps as SubAgentToolsDeps);
      const tool = tools.find((tool) => tool.name === "subagent_integrate")!;
      const sdkContext = {} as Parameters<typeof tool.execute>[4];
      const a = tool.execute("call-a", { work_id: "work-a" }, undefined, undefined, sdkContext);
      const b = tool.execute("call-b", { work_id: "work-b" }, undefined, undefined, sdkContext);
      const bResult = failSecond ? assert.rejects(b, /异步汇总失败/) : b;
      try {
        assert.deepEqual(verified, [...contexts.values()], "两次 execute 分别核实完整的宿主上下文");
        assert.deepEqual(inputs, [
          { workId: "work-a", parentTaskId: "task-a", parentSessionId: "session-a" },
          { workId: "work-b", parentTaskId: "task-b", parentSessionId: "session-b" },
        ]);
        assert.deepEqual(released, [], "两个 execute 都停在真实异步接口内，尚未完成");
        gates.get("work-a")!.resolve();
        assert.match(JSON.stringify((await a).content), /work-a/);
        assert.deepEqual(released, ["call-a"]);
        assert.equal(contexts.size, 1);
        assert.equal(contexts.get("call-b")?.hostOpId, "op-b", "释放前一个调用后，后一个仍可执行");
        gates.get("work-b")!.resolve();
        const result = await bResult;
        if (!failSecond) assert.match(JSON.stringify(result!.content), /work-b/);
        assert.deepEqual(released, ["call-a", "call-b"], "正常结束和异常结束都各释放一次");
        assert.equal(contexts.size, 0);
      } finally {
        for (const gate of gates.values()) gate.resolve();
        await Promise.allSettled([a, b, bResult]);
      }
    });
  }
});

test("宿主调用句柄按 sdkCallId 保持独立上下文", () => {
  const contexts = new Map([
    ["call-a", { taskId: "task-a", sessionId: "session-a", projectId: "project", hostOpId: "op-a" }],
    ["call-b", { taskId: "task-b", sessionId: "session-b", projectId: "project", hostOpId: "op-b" }],
  ]);
  const released: string[] = [];
  const bindCall = (id: string) => ({
    context: contexts.get(id) ?? null,
    release: () => released.push(id),
  });
  const a = hostCallFor(bindCall, () => null, "call-a");
  const b = hostCallFor(bindCall, () => null, "call-b");
  assert.equal(a.context?.taskId, "task-a");
  assert.equal(b.context?.taskId, "task-b");
  a.release();
  assert.equal(b.context?.taskId, "task-b");
  b.release();
  assert.deepEqual(released, ["call-a", "call-b"]);
  b.release();
  assert.deepEqual(released, ["call-a", "call-b"]);
});

const CUSTOM_LEDGER: HostToolLedger = {
  names: ["test_custom"],
  ruleFor: (_name, params) => params.mode === "read" ? "no_effect" : params.mode === "approval" ? "approval" : { family: "test_custom" },
  familyCheck: {
    verify: (op) => (op.params.verdict ?? "unverifiable") as ReturnType<FamilyCheck["verify"]>,
    committed: (when) => `已提交：自定义族（${when}）`,
    notCommitted: (when) => `已知未提交：自定义族（${when}）`,
  },
};

function ledgerKit(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-host-ledger-"));
  const db = new Db(root);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new Store(db);
  const project = store.createProject("host-ledger");
  const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi-host", confirmTools: [] });
  const { task } = store.insertQueuedTask({
    sessionId: session.id, requestId: "host-task", input: "宿主工具族清理",
    modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: "host-task",
  });
  store.transitionTask(task.id, ["queued"], "running", {});
  const ledger = new ToolOpLedger(store, {}, [
    HOST_DATA_LEDGER, WEB_SEARCH_LEDGER, APP_DATA_LEDGER, SCHEDULER_LEDGER, DELEGATION_LEDGER,
    SUBAGENT_LEDGER, CHAT_RESULT_LEDGER, SERVICE_LEDGER, SKILL_LEDGER, TODO_LEDGER, CUSTOM_LEDGER,
  ]);
  let n = 0;
  const op = (toolName: string, params: Record<string, unknown> = {}) => {
    const id = `host-op-${++n}`;
    store.withTx(() => store.recordToolIntent({ id, taskId: task.id, sessionId: session.id, toolName, params }));
    return id;
  };
  const events = (type: string, opId: string) => store.getEventsAfter(0).map((e) => e.body).filter(
    (body) => body.type === type && "toolOpId" in body && body.toolOpId === opId,
  );
  const expectResult = (id: string, summary: string, isError: boolean) => {
    const saved = store.getToolOp(id)!;
    assert.equal(saved.resultSummary, summary);
    assert.equal(saved.isError, isError);
    assert.equal(saved.effectUnknown, false);
    const results = events("task.tool_result", id);
    assert.equal(results.length, 1, "族声明产生的结果与事件仅写一次");
    assert.deepEqual(results[0], { type: "task.tool_result", taskId: task.id, toolOpId: id, summary, isError, artifactIds: [] });
  };
  return { store, ledger, task, op, events, expectResult };
}

test("族声明参与 beginStop/settleTask：真实只读族不进快照，自定义族按核实结果补记", (t) => {
  const k = ledgerKit(t);
  const reads = [
    "history_search", "history_read", "memory_list", "memory_read", "web_search", "app_data_query",
    "schedule_query", "notification_query", "coding_result", "subagent_result", "chat_result_list",
    "service_inspect", "skill", "todo_write",
  ].map((name) => k.op(name));
  const customRead = k.op("test_custom", { mode: "read" });
  const save = k.op("memory_save");
  const revoke = k.op("memory_revoke");
  const manage = k.op("service_manage");
  const customApproval = k.op("test_custom", { mode: "approval" });
  const dynamic = k.op("mcp_unregistered");
  const committed = k.op("test_custom", { verdict: "committed" });
  const notCommitted = k.op("test_custom", { verdict: "not_committed" });
  const unverifiable = k.op("test_custom");
  const pending = k.op("test_custom", { verdict: "committed" });
  k.store.withTx(() => k.store.createConfirmation({
    taskId: k.task.id, sessionId: k.task.sessionId, toolOpId: pending, toolName: "test_custom", params: {},
    scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1,
  }));

  const snapshot = k.ledger.beginStop(k.task.id);
  assert.deepEqual(snapshot, [save, revoke, manage, customApproval, dynamic]);
  assert.deepEqual(k.store.withTx(() => k.ledger.settleTask(k.task, snapshot)), [...snapshot, unverifiable]);
  for (const id of [...reads, customRead]) k.expectResult(id, "未完成：只读操作在停止前中止，无写入效果", true);
  k.expectResult(committed, "已提交：自定义族（停止前）", false);
  k.expectResult(notCommitted, "已知未提交：自定义族（停止前）", true);
  k.expectResult(pending, "已知未执行：审批未消费即停止", true);
  for (const id of [...snapshot, unverifiable]) {
    assert.equal(k.store.getToolOp(id)!.resultSummary, null, "未核实操作留给终态事务处理");
    assert.equal(k.store.getToolOp(id)!.effectUnknown, false);
  }
});

test("族声明参与 settleAll：终态残留同样补记，自定义族不能核实时只标一次效果未知", (t) => {
  const k = ledgerKit(t);
  const read = k.op("web_search");
  const committed = k.op("test_custom", { verdict: "committed" });
  const notCommitted = k.op("test_custom", { verdict: "not_committed" });
  const unverifiable = k.op("test_custom");
  const approval = k.op("service_manage");
  k.store.transitionTask(k.task.id, ["running"], "completed", { endedAt: new Date().toISOString() });

  k.store.withTx(() => k.ledger.settleAll());
  k.store.withTx(() => k.ledger.settleAll());
  k.expectResult(read, "未完成：只读操作在后台重启前中止，无写入效果", true);
  k.expectResult(committed, "已提交：自定义族（后台重启前）", false);
  k.expectResult(notCommitted, "已知未提交：自定义族（后台重启前）", true);
  for (const id of [unverifiable, approval]) {
    assert.equal(k.store.getToolOp(id)!.resultSummary, null);
    assert.equal(k.store.getToolOp(id)!.effectUnknown, true);
    assert.equal(k.events("task.tool_effect_unknown", id).length, 1);
    assert.equal(k.events("task.tool_result", id).length, 0);
  }
  assert.equal(k.store.getTask(k.task.id)!.effectUnknown, true);
});

test("族声明参与 settleAfterWriteFailure：只即时补记可核实的自定义族，保留首次结果", (t) => {
  const k = ledgerKit(t);
  const committed = k.op("test_custom", { verdict: "committed" });
  const notCommitted = k.op("test_custom", { verdict: "not_committed" });
  const read = k.op("test_custom", { mode: "read" });
  const approval = k.op("test_custom", { mode: "approval" });
  const unverifiable = k.op("test_custom");
  const completed = k.op("test_custom", { verdict: "not_committed" });
  k.store.withTx(() => k.ledger.recordResult(k.task, completed, "实际调用已完成", false));

  k.store.withTx(() => {
    for (const id of [committed, notCommitted, read, approval, unverifiable, completed]) k.ledger.settleAfterWriteFailure(k.task, id);
    k.ledger.settleAfterWriteFailure(k.task, committed);
  });
  k.expectResult(committed, "已提交：自定义族（结果写入失败前）", false);
  k.expectResult(notCommitted, "已知未提交：自定义族（结果写入失败前）", true);
  k.expectResult(completed, "实际调用已完成", false);
  for (const id of [read, approval, unverifiable]) {
    assert.equal(k.store.getToolOp(id)!.resultSummary, null);
    assert.equal(k.store.getToolOp(id)!.effectUnknown, false, "已经拿到真实结果时不能凭写入失败标未知");
    assert.equal(k.events("task.tool_result", id).length, 0);
  }
});
