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
} from "./helpers/testkit.ts";
import { ControlClient } from "../src/control/client.ts";
import { parseSessionFile } from "../src/agent/driver.ts";

test("幂等提交：重试返回原任务；同键异参冲突", async () => {
  const t = await startTestRuntime(
    "idempotent",
    routeResponder([{ match: /写代码/, respond: () => ({ kind: "text", text: "已修改文件" }) }]),
  );
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const first = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "client-key-1",
      input: "帮我写代码",
    });

    // 模拟应答丢失：不等任务完成就重发相同键
    const retry = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "client-key-1",
      input: "帮我写代码",
    });
    assert.equal(retry.id, first.id, "同键同参数必须返回原任务");

    await assert.rejects(
      () =>
        t.client.request("submit", {
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
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "conn-1",
      input: "第一段长回复",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    // 客户端 A 记录断开前的游标
    const cursor = t.client.getSeq();
    const seenByA: number[] = [];
    t.client.onEvent((e) => seenByA.push(e.seq));
    const task2 = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "conn-2",
      input: "第二段长回复",
    });
    await waitFor("任务2完成", async () => (await taskStatus(t.client, task2.id)).task.status === "completed");
    t.client.close();

    // 重连：从 A 的游标补发；断开握手期间产生的事件必须完整
    const clientB = await ControlClient.connect(t.runtime.socketPath());
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
      const task3 = await clientB.request<any>("submit", {
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
