/**
 * 集成：工具正文产物（issue 03 §5/§6.6）。
 *
 * 覆盖：
 * - 超长 stdout 与跨分块 UTF-8：上游截断之前完整捕获为产物，按偏移/长度
 *   重新读取且字节完整；
 * - 中断/异常保留已捕获部分（partial），不丢弃后报告完整成功；
 * - 产物查询按任务归属：其他任务的工具与控制接口都读不到本任务正文；
 * - 产物跨后台重启可读。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  taskStatus,
  connectAuthedClient,
  realTools,
  makeTestDirs,
  writeModelsJson,
  cleanupDirs,
} from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { Runtime } from "../src/runtime/runtime.ts";
import { ControlServer } from "../src/control/server.ts";

const BIG_TEXT = "中文-abc-0123\n"; // 多字节字符，强制跨分块

function bigOutputResponder(): Responder {
  return (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [
          {
            id: "c_big",
            name: "bash",
            arguments: { command: `node -e 'process.stdout.write(${JSON.stringify(BIG_TEXT)}.repeat(30000))'` },
          },
        ],
      };
    }
    return { kind: "text", text: "大输出处理完" };
  };
}

test("超长 stdout 与跨分块 UTF-8：完整捕获、按偏移读取、切片重组一致", async () => {
  const t = await startTestRuntime("artifact-big", bigOutputResponder(), { workDirs: 1, config: realTools() });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "art-1",
      input: "产生大输出",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 120_000);

    const detail = await taskStatus(t.client, task.id);
    const artifact = detail.artifacts.find((a: any) => a.name.includes("stdout"));
    assert.ok(artifact, "应有 stdout 产物");
    const expected = Buffer.from(BIG_TEXT.repeat(30000), "utf8");
    assert.equal(artifact.byteCount, expected.length, "产物字节数与原始输出一致（未被上游截断）");
    assert.equal(artifact.status, "complete");

    // 分片读取并重组：与原文逐字节一致（跨分块 UTF-8 不损坏）
    const chunks: Buffer[] = [];
    const step = 64 * 1024 + 13; // 故意不对齐分块边界
    for (let offset = 0; offset < expected.length; offset += step) {
      const part = await t.client.request<any>("read_artifact", {
        task_id: task.id,
        artifact_id: artifact.id,
        offset,
        length: step,
      });
      chunks.push(Buffer.from(part.data, "base64"));
    }
    assert.deepEqual(Buffer.concat(chunks), expected, "按偏移重组的产物必须与原始输出逐字节一致");

    // 模型视图可以限长，但产物保留完整正文
    const op = detail.toolOps[0];
    assert.ok((op.resultSummary?.length ?? 0) <= 300, "模型侧摘要限长");
  } finally {
    await t.shutdown();
  }
});

test("中断保留已捕获部分（partial）与失败原因，不报告完整成功", async () => {
  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "c_slow", name: "bash", arguments: { command: "echo partial-marker; sleep 60" } }],
      };
    }
    return { kind: "text", text: "不应到达" };
  };
  const t = await startTestRuntime("artifact-partial", responder, { workDirs: 1, config: realTools() });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "art-2",
      input: "运行长命令",
    });
    // 等 stdout 的 partial-marker 已经进产物
    await waitFor(
      "已捕获部分输出",
      () =>
        t.runtime.store
          .listArtifactsByTask(task.id)
          .some((a) => a.byteCount >= "partial-marker\n".length),
      60_000,
    );

    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务中断", async () => (await taskStatus(t.client, task.id)).task.status === "interrupted", 30_000);

    const detail = await taskStatus(t.client, task.id);
    const artifact = detail.artifacts.find((a: any) => a.name.includes("stdout"));
    assert.ok(artifact, "中断前已捕获的输出应保留");
    assert.equal(artifact.status, "partial", "未完整回收的产物保持 partial，不报告完整成功");
    const part = await t.client.request<any>("read_artifact", {
      task_id: task.id,
      artifact_id: artifact.id,
    });
    assert.match(Buffer.from(part.data, "base64").toString("utf8"), /^partial-marker\n/, "已捕获部分完整可读");
    assert.equal(detail.task.effectUnknown, true, "被中断的命令结果缺失，保留效果不明事实");
  } finally {
    await t.shutdown();
  }
});

test("产物查询按任务归属：其他任务与其他会话读不到本任务正文", async () => {
  const responder: Responder = (req) => {
    const text = JSON.stringify(req.messages);
    if (/读别的任务产物/.test(text) && req.messages.filter((m) => m?.role === "tool").length === 0) {
      const artifactId = /ARTID:([a-z0-9_]+)/.exec(text)?.[1] ?? "missing";
      return {
        kind: "tool_calls",
        calls: [{ id: "c_steal", name: "read_artifact", arguments: { artifact_id: artifactId } }],
      };
    }
    if (req.messages.filter((m) => m?.role === "tool").length === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "c_own", name: "bash", arguments: { command: "echo own-output" } }],
      };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("artifact-scope", responder, { workDirs: 2, config: realTools() });
  try {
    const { sessionId: sA } = await createProjectSession(t.client, t.work[0]!, { projectName: "art-a" });
    const taskA = await t.client.request<any>("submit", {
      session_id: sA,
      request_id: "art-a1",
      input: "产生输出",
    });
    await waitFor("任务A完成", async () => (await taskStatus(t.client, taskA.id)).task.status === "completed", 60_000);
    const detailA = await taskStatus(t.client, taskA.id);
    const artifactA = detailA.artifacts.find((a: any) => a.name.includes("stdout"));
    assert.ok(artifactA);

    // 另一个会话的任务尝试用 read_artifact 读 A 的产物 → 拒绝
    const { sessionId: sB } = await createProjectSession(t.client, t.work[1]!, { projectName: "art-b" });
    const taskB = await t.client.request<any>("submit", {
      session_id: sB,
      request_id: "art-b1",
      input: `读别的任务产物 ARTID:${artifactA.id}`,
    });
    await waitFor("任务B完成", async () => (await taskStatus(t.client, taskB.id)).task.status === "completed", 60_000);
    const detailB = await taskStatus(t.client, taskB.id);
    const stealOp = detailB.toolOps.find((op: any) => op.sdkCallId === "c_steal");
    assert.equal(stealOp.isError, true);
    assert.match(stealOp.resultSummary, /不属于当前任务/, "其他任务不得读取本任务产物");

    // 控制接口：任务归属不匹配同样拒绝
    await assert.rejects(
      () =>
        t.client.request("read_artifact", {
          task_id: taskB.id,
          artifact_id: artifactA.id,
        }),
      (err: any) => err.code === "not_found",
      "控制接口不跨任务返回正文",
    );
  } finally {
    await t.shutdown();
  }
});

test("产物跨后台重启可读", async () => {
  const { dirs, work } = await makeTestDirs("artifact-restart", 1);
  const server = new MockModelServer(bigOutputResponder());
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  try {
    const r1 = await Runtime.start({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      socketPath: `${dirs.root}/c.sock`,
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
      ...realTools(),
    });
    await ControlServer.start(r1);
    const c1 = await connectAuthedClient(r1);
    await c1.handshake();
    const project = (await c1.request<any>("create_project", { name: "art-restart" })) as any;
    const session = (await c1.request<any>("create_session", { project_id: project.id, cwd: work[0]! })) as any;
    const task = (await c1.request<any>("submit", {
      session_id: session.id,
      request_id: "art-r1",
      input: "产生大输出",
    })) as any;
    await waitFor("任务完成", async () => {
      const d = await c1.request<any>("get_task", { task_id: task.id });
      return d.task.status === "completed";
    }, 120_000);
    const detail = (await c1.request<any>("get_task", { task_id: task.id })) as any;
    const artifact = detail.artifacts.find((a: any) => a.name.includes("stdout"));
    assert.ok(artifact);
    c1.close();
    await r1.stop("test_restart");

    // 重启：同一数据目录
    const r2 = await Runtime.start({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      socketPath: `${dirs.root}/c.sock`,
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
      ...realTools(),
    });
    await ControlServer.start(r2);
    const c2 = await connectAuthedClient(r2);
    await c2.handshake();
    try {
      const part = await c2.request<any>("read_artifact", {
        task_id: task.id,
        artifact_id: artifact.id,
        offset: 0,
        length: 1024,
      });
      const expected = Buffer.from(BIG_TEXT.repeat(30000), "utf8");
      assert.deepEqual(Buffer.from(part.data, "base64"), expected.subarray(0, 1024), "重启后产物正文不变");
      assert.equal(part.artifact.byteCount, expected.length);
    } finally {
      c2.close();
      await r2.stop("test_end");
    }
  } finally {
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("产物磁盘写入失败：停止执行、保留已捕获部分与失败原因，不报告完整成功", async () => {
  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "c_write_fail", name: "bash", arguments: { command: "echo some-output" } }],
      };
    }
    return { kind: "text", text: "已处理捕获失败" };
  };
  const t = await startTestRuntime("artifact-deny", responder, { workDirs: 1, config: realTools() });
  const artifactsDir = `${t.dirs.dataDir}/artifacts`;
  try {
    // 注入存储失败：产物目录只读（同 UID 的 EACCES）
    fs.chmodSync(artifactsDir, 0o500);
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "art-fail-1",
      input: "产生输出",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);

    const detail = await taskStatus(t.client, task.id);
    const op = detail.toolOps[0];
    assert.equal(op.isError, true, "存储失败必须让工具失败，不得报告完整成功");
    assert.match(op.resultSummary, /输出捕获失败/, "结果应说明捕获失败且已停止");
    const artifact = detail.artifacts[0];
    assert.ok(artifact, "产物元数据（partial）应保留");
    assert.equal(artifact.status, "partial", "存储失败的产物保持 partial");
    assert.equal(artifact.byteCount, 0, "未写入任何字节（不是丢弃后声称全量留存）");
  } finally {
    fs.chmodSync(artifactsDir, 0o700);
    await t.shutdown();
  }
});
