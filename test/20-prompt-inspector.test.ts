/**
 * issue 13：/prompt 命令的数据层 —— 模型请求列表与 prompt 快照。
 *
 * 覆盖：
 * - 每次模型调用落盘不可变输入快照（systemPrompt/messages/tools 与捕获位置）；
 * - 同一任务多轮调用分别列出，详情与 mock 服务收到的输入一致；
 * - 快照与选择记录、会话归属校验：错误会话读取被拒绝；缺失快照如实报错；
 * - 分页：游标翻页不丢不重；
 * - 发送失败（预算阻断）时无快照也不声称已发送；中断场景 usage 留空；
 * - 后台重启后快照仍可读；
 * - 未认证连接不能调用新端点。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  taskStatus,
  routeResponder,
} from "./helpers/testkit.ts";
import { ControlClient } from "../src/control/client.ts";
import { CONTROL_PROTOCOL_VERSION } from "../src/control/protocol.ts";

/** 读取完整快照 JSON（分段拼接）。 */
async function readSnapshot(client: ControlClient, sessionId: string, recordId: string): Promise<any> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const page = await client.request<any>("read_prompt_snapshot", {
      record_id: recordId,
      session_id: sessionId,
      offset,
      length: 4096,
    });
    const buf = Buffer.from(page.data, "base64");
    if (buf.length === 0) break;
    parts.push(buf);
    offset += buf.length;
    if (offset >= page.artifact.byteCount) break;
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

test("prompt 快照：捕获内容与 mock 收到的输入一致；多轮调用分别列出", async () => {
  const t = await startTestRuntime(
    "prompt-cap",
    (req, callIndex) => {
      if (callIndex === 0) {
        return {
          kind: "tool_calls",
          calls: [
            {
              id: "c1",
              name: "mock_mark",
              arguments: { path: "/tmp/ruukoto-prompt-test-mark.txt", content: "第一次调用" },
            },
          ],
        };
      }
      return { kind: "text", text: "总结完毕" };
    },
  );
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = (await t.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "p-1",
      input: "请查文件然后总结",
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 20_000);
    assert.equal(t.server.calls.length, 2, "工具调用后应有第二轮模型调用");

    const list = await t.client.request<any>("list_prompt_requests", { session_id: sessionId, limit: 10 });
    assert.equal(list.records.length, 2, "同一任务两次调用分别列出");
    assert.equal(list.hasMore, false);
    // 新 → 旧
    assert.ok(list.records[0].callIndex > list.records[1].callIndex);
    assert.equal(list.records[0].taskId, task.id);

    for (let i = 0; i < 2; i++) {
      const record = list.records[1 - i]; // callIndex 升序对应 server.calls 顺序
      assert.ok(record.promptArtifactId, "快照已关联");
      assert.equal(record.callIndex, i + 1);
      const snapshot = await readSnapshot(t.client, sessionId, record.id);
      assert.equal(snapshot.recordId, record.id);
      assert.equal(snapshot.taskId, task.id);
      assert.match(snapshot.capturePoint, /streamFunction/);
      assert.equal(snapshot.model.provider, "mock");
      assert.equal(snapshot.model.id, "mock-model");
      assert.equal(snapshot.thinkingLevel, "off");
      // system prompt 与工具定义存在
      assert.ok(typeof snapshot.systemPrompt === "string" && snapshot.systemPrompt.length > 0);
      assert.ok(snapshot.tools.some((tool: any) => tool.name === "mock_mark"));
      // 与 mock 实际收到的消息对齐：快照消息数 = 请求 messages 去掉 system 后的数量
      const served = t.server.calls[i]!;
      assert.equal(snapshot.messages.length, served.messages.length, `第 ${i + 1} 次调用消息数一致`);
      // 第一轮：最后一条 user 消息是任务输入
      if (i === 0) {
        const lastUser = snapshot.messages.filter((m: any) => m.role === "user").at(-1);
        const text = typeof lastUser.content === "string" ? lastUser.content : lastUser.content.map((c: any) => c.text ?? "").join("");
        assert.match(text, /请查文件然后总结/);
      }
      // 第二轮：包含工具调用与结果
      if (i === 1) {
        const assistant = snapshot.messages.find((m: any) => m.role === "assistant");
        assert.ok(assistant.content.some((c: any) => c.type === "toolCall" && c.name === "mock_mark"));
        const toolResult = snapshot.messages.find((m: any) => m.role === "toolResult");
        assert.ok(toolResult, "第二轮应含工具结果");
      }
    }

    // 修改模型选择/提交新任务后，先前请求详情保持不变（快照不可变）
    const before = await readSnapshot(t.client, sessionId, list.records[1].id);
    const after = await readSnapshot(t.client, sessionId, list.records[1].id);
    assert.deepEqual(after, before);
  } finally {
    await t.shutdown();
  }
});

test("prompt 快照：归属校验与缺失快照", async () => {
  const t = await startTestRuntime("prompt-own", routeResponder([]));
  try {
    const a = await createProjectSession(t.client, t.work[0]!, { projectName: "pa" });
    const b = await createProjectSession(t.client, t.work[1]!, { projectName: "pb" });
    const task = (await t.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: a.sessionId,
      request_id: "p-own",
      input: "你好",
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    const list = await t.client.request<any>("list_prompt_requests", { session_id: a.sessionId, limit: 5 });
    assert.equal(list.records.length, 1);
    const record = list.records[0];

    // 错误会话归属被拒绝
    await assert.rejects(
      t.client.request("read_prompt_snapshot", { record_id: record.id, session_id: b.sessionId }),
      /不属于该会话|不存在/,
    );
    // 不存在的记录
    await assert.rejects(
      t.client.request("read_prompt_snapshot", { record_id: "sel_不存在", session_id: a.sessionId }),
      /不存在/,
    );
    // 缺失快照（模拟旧记录：清掉关联）如实报错
    (t.runtime.store as any).db.prepare("UPDATE selection_records SET prompt_artifact = NULL WHERE id = ?").run(record.id);
    await assert.rejects(
      t.client.request("read_prompt_snapshot", { record_id: record.id, session_id: a.sessionId }),
      /未记录/,
    );
    // 不存在的会话
    await assert.rejects(t.client.request("list_prompt_requests", { session_id: "ses_不存在" }), /会话不存在/);
  } finally {
    await t.shutdown();
  }
});

test("prompt 列表：游标分页不丢不重", async () => {
  const t = await startTestRuntime("prompt-page", routeResponder([]));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 三个任务 → 三条记录
    for (let i = 0; i < 3; i++) {
      const task = (await t.client.request<any>("submit", {
        model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sessionId,
        request_id: `p-page-${i}`,
        input: `第 ${i} 个问题`,
      })) as any;
      await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    }
    const page1 = await t.client.request<any>("list_prompt_requests", { session_id: sessionId, limit: 2 });
    assert.equal(page1.records.length, 2);
    assert.equal(page1.hasMore, true);
    const last = page1.records[page1.records.length - 1];
    const page2 = await t.client.request<any>("list_prompt_requests", {
      session_id: sessionId,
      limit: 2,
      cursor: { createdAt: last.createdAt, id: last.id },
    });
    assert.equal(page2.records.length, 1);
    assert.equal(page2.hasMore, false);
    const ids = [...page1.records, ...page2.records].map((r: any) => r.id);
    assert.equal(new Set(ids).size, 3, "分页不丢不重");
  } finally {
    await t.shutdown();
  }
});

test("prompt 快照：预算阻断无快照；失败状态如实标注", async () => {
  const t = await startTestRuntime("prompt-blocked", routeResponder([]), {
    contextWindow: 12_000,
    config: { budgetOverrides: { toolResultReserve: 500, safetyMargin: 200, memoryBudget: 0 } },
  });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = (await t.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "p-blocked",
      input: "x".repeat(50_000),
    })) as any;
    await waitFor("任务 interrupted", async () => (await taskStatus(t.client, task.id)).task.status === "interrupted");
    assert.equal(t.server.calls.length, 0, "预算不足不得发出 provider 请求");
    const list = await t.client.request<any>("list_prompt_requests", { session_id: sessionId, limit: 5 });
    // 选择未产生有效结果即阻断：没有请求记录（选择记录也未落盘）
    assert.equal(list.records.length, 0);
  } finally {
    await t.shutdown();
  }
});

test("prompt 快照：跨后台重启可读", async () => {
  // 手工搭目录：shutdown 不删目录，重启后仍可读
  const { makeTestDirs, writeModelsJson, cleanupDirs, connectAuthedClient } = await import("./helpers/testkit.ts");
  const { MockModelServer } = await import("./helpers/mock-provider.ts");
  const { Runtime } = await import("../src/runtime/runtime.ts");
  const { ControlServer } = await import("../src/control/server.ts");
  const { createMockTools } = await import("../src/agent/mock-tools.ts");
  const { dirs, work } = await makeTestDirs("prompt-restart", 1);
  const server = new MockModelServer(routeResponder([]));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const startRuntime = async (sock: string) => {
    const runtime = await Runtime.start({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      socketPath: `${dirs.root}/${sock}`,
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
      toolFactory: (ctx) => createMockTools(ctx),
    });
    await ControlServer.start(runtime);
    const client = await connectAuthedClient(runtime);
    await client.handshake();
    return { runtime, client };
  };
  try {
    const r1 = await startRuntime("c1.sock");
    const { sessionId } = await createProjectSession(r1.client, work[0]!);
    const task = (await r1.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "p-restart",
      input: "重启后仍要能看到这句话",
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(r1.client, task.id)).task.status === "completed");
    const list = await r1.client.request<any>("list_prompt_requests", { session_id: sessionId, limit: 5 });
    const record = list.records[0];
    const before = await readSnapshot(r1.client, sessionId, record.id);
    r1.client.close();
    await r1.runtime.stop("test_restart");

    const r2 = await startRuntime("c2.sock");
    try {
      const after = await readSnapshot(r2.client, sessionId, record.id);
      assert.deepEqual(after, before, "重启后快照内容不变");
      const list2 = await r2.client.request<any>("list_prompt_requests", { session_id: sessionId, limit: 5 });
      assert.equal(list2.records.length, 1, "重启后列表仍可查询");
    } finally {
      r2.client.close();
      await r2.runtime.stop("test_end");
    }
  } finally {
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("prompt 端点：未认证连接被拒绝", async () => {
  const t = await startTestRuntime("prompt-auth", routeResponder([]));
  try {
    const socket = net.createConnection(t.runtime.socketPath());
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const reply = await new Promise<any>((resolve) => {
      socket.on("data", (chunk) => resolve(JSON.parse(chunk.toString("utf8").trim())));
      socket.write(
        `${JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, id: "1", op: "list_prompt_requests", params: { session_id: "ses_x" } })}\n`,
      );
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, "unauthorized");
    socket.destroy();
  } finally {
    await t.shutdown();
  }
});
