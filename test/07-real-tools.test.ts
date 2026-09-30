/**
 * 集成：真实编码工具（read/edit/write/bash）经工具工作进程执行（issue 03 §1/§5/§6.1）。
 *
 * 覆盖：
 * - 在临时 Git 仓库完成"读取—修改—检查失败—修复—检查通过"，改动真实落盘；
 * - 宿主操作 id 与模型调用 id 分开记录（不同任务复用调用 id 不串用）；
 * - 在上游截断之前捕获正文为产物：bash stdout 与 read 的本次已捕获版本
 *   （文件随后被修改也不改写该产物），并能按偏移重新读取；
 * - 断开客户端后任务继续，重连可见改动与检查结果；
 * - Write 新建与覆盖文件的增删行统计保留在工具结果事件和会话历史中；
 * - 执行入口不可用时明确失败，不回退到后台账户执行。
 *
 * 容器内的路径解析与身份隔离（Linux）不在本机验证，见 issue 记录。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  taskStatus,
  connectAuthedClient,
  realTools,
} from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";

/** 按已完成的工具调用数推进脚本：读取 → 检查失败 → 修复 → 检查通过 → 文本。 */
function repairResponder(): Responder {
  return (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    switch (done) {
      case 0:
        return { kind: "tool_calls", calls: [{ id: "c_read", name: "read", arguments: { path: "answer.txt" } }] };
      case 1:
        return {
          kind: "tool_calls",
          calls: [{ id: "c_check1", name: "bash", arguments: { command: "echo check-1; grep -q 42 answer.txt" } }],
        };
      case 2:
        return {
          kind: "tool_calls",
          calls: [
            { id: "c_edit", name: "edit", arguments: { path: "answer.txt", edits: [{ oldText: "41", newText: "42" }] } },
          ],
        };
      case 3:
        return {
          kind: "tool_calls",
          calls: [{ id: "c_check2", name: "bash", arguments: { command: "echo check-2; grep -q 42 answer.txt" } }],
        };
      default:
        return { kind: "text", text: "修复完成，检查通过" };
    }
  };
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

test("真实工具：读取—修改—检查失败—修复—检查通过，正文捕获为产物", async () => {
  const t = await startTestRuntime("realtools", repairResponder(), { workDirs: 1, config: realTools() });
  try {
    const dir = t.work[0]!;
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "answer.txt"), "41\n", "utf8");
    const { sessionId } = await createProjectSession(t.client, dir);

    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "rt-1",
      input: "修复 answer.txt 让检查通过",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);

    // 改动真实落盘
    assert.equal(fs.readFileSync(path.join(dir, "answer.txt"), "utf8"), "42\n", "修复必须写入工作区文件");

    const detail = await taskStatus(t.client, task.id);
    assert.equal(detail.toolOps.length, 4, "应记录四次工具操作");
    // 宿主操作 id 与模型调用 id 分开：不同任务复用调用 id 不串用批准/记录
    const sdkIds = detail.toolOps.map((op: any) => op.sdkCallId);
    assert.deepEqual(sdkIds, ["c_read", "c_check1", "c_edit", "c_check2"], "SDK 调用 id 供关联保留");
    for (const op of detail.toolOps) {
      assert.match(op.id, /^op_/, "宿主分配的操作 id");
      assert.notEqual(op.id, op.sdkCallId, "操作身份不得直接复用模型调用 id");
      assert.equal(op.resultSummary !== null, true, "每次操作都应有结果摘要");
      assert.equal(op.effectUnknown, false, "正常结束的工具不得标为效果不明");
    }
    const check1 = detail.toolOps.find((op: any) => op.sdkCallId === "c_check1");
    assert.equal(check1.isError, true, "第一次检查应失败");
    const check2 = detail.toolOps.find((op: any) => op.sdkCallId === "c_check2");
    assert.equal(check2.isError, false, "修复后检查应通过");

    // 正文产物：bash stdout 与 read 的已捕获版本
    assert.ok(detail.artifacts.length >= 3, `应捕获 stdout×2 与文件正文，实际 ${detail.artifacts.length}`);
    const readArtifact = detail.artifacts.find((a: any) => a.name.includes("文件正文"));
    assert.ok(readArtifact, "read 应捕获本次读取的文件正文");
    const readPart = await t.client.request<any>("read_artifact", {
      task_id: task.id,
      artifact_id: readArtifact.id,
    });
    assert.equal(
      Buffer.from(readPart.data, "base64").toString("utf8"),
      "41\n",
      "文件读取产物保留本次已捕获版本，不因日后文件变化而改写",
    );
    const bashArtifact = detail.artifacts.find((a: any) => a.name.includes("stdout"));
    assert.ok(bashArtifact, "bash 应捕获 stdout 正文");
    assert.equal(bashArtifact.status, "complete", "结果回收后产物定稿");
    const bashPart = await t.client.request<any>("read_artifact", {
      task_id: task.id,
      artifact_id: bashArtifact.id,
    });
    const bashText = Buffer.from(bashPart.data, "base64").toString("utf8");
    assert.match(bashText, /check-1/, "stdout 正文可重新读取");
  } finally {
    await t.shutdown();
  }
});

test("真实 Write：新建与覆盖文件的 diff 统计持久化", async () => {
  const t = await startTestRuntime("realtools-write-stats", (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "write-create", name: "write", arguments: { path: "notes.txt", content: "alpha\nbeta\n" } }] };
    if (done === 1) return { kind: "tool_calls", calls: [{ id: "write-overwrite", name: "write", arguments: { path: "notes.txt", content: "alpha\ngamma\nextra\n" } }] };
    return { kind: "text", text: "写入完成" };
  }, { workDirs: 1, config: realTools() });
  try {
    const dir = t.work[0]!;
    const { sessionId } = await createProjectSession(t.client, dir);
    const task = await t.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId, request_id: "rt-write-stats", input: "创建并更新 notes.txt",
    });
    await waitFor("Write 任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);

    assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "alpha\ngamma\nextra\n");
    const stats = [{ added: 2, removed: 0 }, { added: 2, removed: 1 }];
    const events = t.runtime.readTaskEvents({ taskId: task.id }).events
      .flatMap((event) => event.body.type === "task.tool_result" ? [event.body] : []);
    assert.deepEqual(events.map((event) => event.editStats), stats, "工具结果事件记录两次 Write 的增删行数");
    const history = t.runtime.readHistory({ sessionId });
    assert.deepEqual(history.entries.filter((entry) => entry.toolName === "write").map((entry) => entry.editStats), stats,
      "会话历史保留两次 Write 的增删行数");
  } finally {
    await t.shutdown();
  }
});

test("断开客户端后任务继续；重连可见改动、检查结果与产物引用", async () => {
  const t = await startTestRuntime("realtools-reconnect", repairResponder(), { workDirs: 1, config: realTools() });
  const client = t.client;
  try {
    const dir = t.work[0]!;
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "answer.txt"), "41\n", "utf8");
    const { sessionId } = await createProjectSession(client, dir);

    const task = await client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "rt-2",
      input: "修复 answer.txt 让检查通过",
    });
    // 至少完成第一次工具操作后再断开（证明任务已实际执行）
    await waitFor(
      "首次工具操作已记录",
      () => (t.runtime.store.listToolOpsByTask(task.id) ?? []).length >= 1,
      60_000,
    );
    client.close();

    // 无客户端期间任务继续执行（后台进程持有任务）
    await waitFor(
      "任务在无客户端时完成",
      () => t.runtime.store.getTask(task.id)?.status === "completed",
      60_000,
    );

    // 重连：状态、改动、检查结果与产物引用都在
    const client2 = await connectAuthedClient(t.runtime);
    try {
      const handshake = await client2.handshake();
      const detail = await client2.request<any>("get_task", { task_id: task.id });
      assert.equal(detail.task.status, "completed");
      assert.equal(fs.readFileSync(path.join(dir, "answer.txt"), "utf8"), "42\n");
      assert.equal(detail.toolOps.length, 4);
      assert.ok(detail.artifacts.length >= 3, "产物元数据应可查询");
      const resultEvents = t.runtime.getEventLog(0, 10_000).filter(
        (e) => e.body.type === "task.tool_result" && e.taskId === task.id,
      );
      assert.equal(resultEvents.length, 4, "每次工具结果都有持久事件");
      assert.ok(
        resultEvents.some((e) => e.body.type === "task.tool_result" && (e.body as { artifactIds?: string[] }).artifactIds!.length > 0),
        "工具结果事件应带产物引用",
      );
    } finally {
      client2.close();
    }
  } finally {
    await t.shutdown();
  }
});

test("执行入口不可用：明确失败，不回退到后台账户执行", async () => {
  const t = await startTestRuntime(
    "realtools-nobackend",
    (req) => {
      const done = req.messages.filter((m) => m?.role === "tool").length;
      if (done === 0) {
        return {
          kind: "tool_calls" as const,
          calls: [{ id: "c_bash", name: "bash", arguments: { command: "echo x > fallback-ran.txt" } }],
        };
      }
      return { kind: "text" as const, text: "执行环境不可用，未执行命令" };
    },
    {
      workDirs: 1,
      config: {
        ...realTools(),
        execution: { backend: "container", container: { dockerPath: "/nonexistent/docker" } },
      },
    },
  );
  try {
    const dir = t.work[0]!;
    const { sessionId } = await createProjectSession(t.client, dir);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "rt-3",
      input: "执行命令",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);

    const detail = await taskStatus(t.client, task.id);
    const op = detail.toolOps[0];
    assert.equal(op.isError, true, "缺少执行入口时工具必须报错");
    assert.match(op.resultSummary, /执行环境不可用|execution_unavailable/, "错误应说明执行环境不可用");
    assert.equal(
      fs.existsSync(path.join(dir, "fallback-ran.txt")),
      false,
      "不得回退到后台账户执行项目命令",
    );
  } finally {
    await t.shutdown();
  }
});
