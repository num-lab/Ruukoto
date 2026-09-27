/**
 * 集成：幂等提交与断开重连。
 *
 * 覆盖：提交落盘但应答丢失后重试返回原任务、同键异参冲突；重连补发
 * 无缺口；流式片段与落盘条目引用可恢复；历史查询读 JSONL 原文。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  startTestRuntime,
  routeResponder,
  waitFor,
  createProjectSession,
  taskStatus,
  connectAuthedClient,
} from "./helpers/testkit.ts";
import { parseSessionFile } from "../src/core/history.ts";

test("幂等提交：重试返回原任务；同键异参冲突", async () => {
  const t = await startTestRuntime(
    "idempotent",
    routeResponder([{ match: /写代码/, respond: () => ({ kind: "text", text: "已修改文件" }) }]),
  );
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const first = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "client-key-1",
      input: "帮我写代码",
    });

    // 模拟应答丢失：不等任务完成就重发相同键
    const retry = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "client-key-1",
      input: "帮我写代码",
    });
    assert.equal(retry.id, first.id, "同键同参数必须返回原任务");

    await assert.rejects(
      () =>
        t.client.request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
          session_id: sessionId,
          request_id: "client-key-1",
          input: "改成别的输入",
        }),
      (err: any) => err.code === "request_conflict",
      "同键不同输入必须返回冲突",
    );

    await waitFor("原任务完成", async () => (await taskStatus(t.client, first.id)).task.status === "completed");
  } finally {
    await t.shutdown();
  }
});

test("断开重连：游标补发无缺口；片段与条目引用可恢复", async () => {
  let call = 0;
  const t = await startTestRuntime(
    "reconnect",
    routeResponder([
      {
        match: /长回复/,
        respond: async () => {
          call++;
          await new Promise((r) => setTimeout(r, 200 + call * 50));
          return { kind: "text", text: `完整回复-${call}` };
        },
      },
    ]),
  );
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "conn-1",
      input: "第一段长回复",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    // 客户端 A 记录断开前的游标
    const cursor = t.client.getSeq();
    const seenByA: number[] = [];
    t.client.onEvent((e) => seenByA.push(e.seq));
    const task2 = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "conn-2",
      input: "第二段长回复",
    });
    await waitFor("任务2完成", async () => (await taskStatus(t.client, task2.id)).task.status === "completed");
    t.client.close();

    // 重连：从 A 的游标补发；断开握手期间产生的事件必须完整
    const clientB = await connectAuthedClient(t.runtime);
    const handshake = await clientB.handshake(cursor);
    try {
      const seqs: number[] = [];
      for (const event of handshake.replay) seqs.push(event.seq);
      if (seqs.length > 0) {
        assert.equal(seqs[0], cursor + 1, "补发必须从游标后第一个事件开始");
        for (let i = 1; i < seqs.length; i++) {
          assert.equal(seqs[i], seqs[i - 1]! + 1, "补发事件必须连续无缺口");
        }
        assert.equal(seqs[seqs.length - 1], handshake.seq, "补发必须覆盖到快照序号");
      }
      // 实时推送继续且不重复
      const live: number[] = [];
      clientB.onEvent((e) => live.push(e.seq));
      const task3 = await clientB.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sessionId,
        request_id: "conn-3",
        input: "第三段长回复",
      });
      await waitFor("任务3完成", async () => (await taskStatus(clientB, task3.id)).task.status === "completed");

      // 任务2的事件里包含片段（partial）与条目引用（output_entry）
      const task2Events = handshake.replay.filter(
        (e) => e.taskId === task2.id && (e.body.type === "task.output_fragment" || e.body.type === "task.output_entry"),
      );
      const fragments = task2Events.filter((e) => e.body.type === "task.output_fragment");
      const entryRefs = task2Events.filter((e) => e.body.type === "task.output_entry");
      assert.ok(fragments.length >= 1, "应有未完成输出片段");
      assert.ok(fragments.every((e) => (e.body as any).partial === true), "片段必须标记 partial");
      assert.ok(entryRefs.length >= 2, "至少应有 user 与 assistant 条目引用");

      // 条目引用必须真实存在于 JSONL（不建第二套权威历史）
      const snap = await clientB.request<any>("get_task", { task_id: task2.id });
      const sessionFile = String((entryRefs[0]!.body as any).sessionFile);
      assert.ok(fs.existsSync(sessionFile), "JSONL 会话文件应存在");
      const entries = parseSessionFile(sessionFile);
      const byId = new Map(entries.map((e: any) => [e.id, e]));
      for (const ref of entryRefs) {
        const body = ref.body as any;
        const entry = byId.get(body.entryId) as any;
        assert.ok(entry, `条目 ${body.entryId} 必须在 JSONL 中`);
        assert.equal(entry.message?.role, body.role, "条目角色一致");
      }
      // 任务记录关联的历史条目与文件一致
      assert.ok(
        snap.task.historyEntryIds.length >= entryRefs.length,
        "任务应关联其历史条目",
      );
      // 非法游标被拒绝
      await assert.rejects(
        () => clientB.request("connect", { since: 999999 }),
        (err: any) => err.code === "invalid_cursor",
        "非法游标必须要求重新取快照",
      );
    } finally {
      clientB.close();
    }
  } finally {
    await t.shutdown();
  }
});

test("已接收请求以不可变提交参数核实，不重新验证认证或任务当前权限", async () => {
  const t = await startTestRuntime("model-retry", routeResponder([]));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    t.runtime.store.withTx(() => t.runtime.store.setSessionQueueState(sessionId, "paused", "test"));
    const params = { session_id: sessionId, request_id: "immutable", input: "原始要求",
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } };
    const first = await t.client.request<any>("submit", params);
    await t.client.request("switch_mode", { task_id: first.id, mode: "full_access" });
    const original = t.runtime.modelRuntime.checkAuth;
    t.runtime.modelRuntime.checkAuth = async () => { throw new Error("SECRET must not escape"); };
    try {
      assert.equal((await t.client.request<any>("submit", params)).id, first.id);
      await assert.rejects(t.client.request("submit", { ...params, access_mode: "full_access" }), { code: "request_conflict" });
      await assert.rejects(t.client.request("submit", { ...params, model_selection: { ...params.model_selection, modelId: "other" } }), { code: "request_conflict" });
      await assert.rejects(t.client.request("submit", { ...params, request_id: "new" }), (err: any) => err.code === "model_auth_error" && !err.message.includes("SECRET"));
    } finally { t.runtime.modelRuntime.checkAuth = original; }
    await assert.rejects(t.client.request("submit", { session_id: sessionId, request_id: "missing", input: "不能推断配置" }), { code: "invalid_params" });
  } finally { await t.shutdown(); }
});

test("快照：每个会话只带最近结束的 20 个任务", async () => {
  const t = await startTestRuntime("snapshot-ended", routeResponder([]));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const store = t.runtime.store;
    const ids = store.withTx(() =>
      Array.from({ length: 25 }, (_, i) => {
        const { task } = store.insertQueuedTask({
          sessionId,
          requestId: `ended-${i}`,
          input: `任务 ${i}`,
          modelSelection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
          submissionDigest: `digest-${i}`,
        });
        store.transitionTask(task.id, ["queued"], "canceled", { endedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
        return task.id;
      }),
    );
    const snapshot = (await t.client.handshake()).snapshot;
    assert.deepEqual(
      snapshot.tasks.filter((task) => task.sessionId === sessionId).map((task) => task.id),
      ids.slice(5),
    );
  } finally {
    await t.shutdown();
  }
});
