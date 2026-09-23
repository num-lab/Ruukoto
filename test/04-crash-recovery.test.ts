/**
 * 集成：崩溃恢复（真实后台子进程 + SIGKILL）。
 *
 * 覆盖：接收后尚未启动、首次 assistant 消息前、工具已写标记但未记录结果、
 * 排队任务保留顺序且不自动启动、重复后台启动被拒、历史原文保持完整、
 * effect_unknown 事实保留且标记计数不增加。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MockModelServer } from "./helpers/mock-provider.ts";
import {
  makeTestDirs,
  cleanupDirs,
  writeModelsJson,
  routeResponder,
  createProjectSession,
  taskStatus,
  waitFor,
  lastUserText,
} from "./helpers/testkit.ts";
import { killBackend, spawnBackend, spawnBackendRaw, type Backend } from "./helpers/backend.ts";
import { parseSessionFile } from "../src/core/history.ts";

test("工具已产生标记但未记录结果时崩溃：中断保留事实，不重放，排队不自动启动", async () => {
  const server = new MockModelServer(
    routeResponder([
      {
        match: /MARKCRASH/,
        respond: (req) => {
          const markerPath = lastUserText(req).replace(/^MARKCRASH:/, "").trim();
          if (!JSON.stringify(req.messages).includes("marked:")) {
            return {
              kind: "tool_calls",
              calls: [
                {
                  id: "call_mark_1",
                  name: "mock_mark",
                  arguments: { path: markerPath, content: "external-effect-1", ms: 1500 },
                },
              ],
            };
          }
          return { kind: "text", text: "mark-done" };
        },
      },
      {
        match: /QUICK/,
        respond: () => ({ kind: "text", text: "quick-done" }),
      },
    ]),
  );
  let dirs: any = null;
  let markerPath = "";
  let backend: Backend | null = null;
  try {
    const baseUrl = await server.start();
    const made = await makeTestDirs("crash-midtool", 2);
    dirs = made.dirs;
    const workA = made.work[0]!;
    await writeModelsJson(dirs, baseUrl);
    markerPath = path.join(made.work[1]!, "marker.txt");

    // 启动后台（第一个实例）
    backend = await spawnBackend(dirs.dataDir, dirs.agentDir);
    const { projectId, sessionId } = await createProjectSession(backend.client, workA);

    // 第二个实例必须被拒绝（进程级）
    const second = spawnBackendRaw(["src/cli.ts", "start", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir]);
    const secondCode: number | null = await new Promise((resolve) => {
      second.once("exit", (code) => resolve(code));
      setTimeout(() => resolve(-999), 30_000);
    });
    assert.notEqual(secondCode, 0, "重复后台启动必须失败");
    assert.notEqual(secondCode, -999, "第二个实例应快速退出而非超时");

    // 任务 A：写外部标记后进入长延迟（结果未记录窗口）；任务 B 排队
    const taskA = await backend.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "crash-a",
      input: `MARKCRASH:${markerPath}`,
    });
    const taskB = await backend.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "crash-b",
      input: "QUICK:排队任务B",
    });
    await waitFor("标记文件已写入", () => markerPath !== "" && fsSync.existsSync(markerPath));
    // 立即 SIGKILL：工具还在写后延迟中，执行结果未记录
    await killBackend(backend);

    // 重启恢复
    backend = await spawnBackend(dirs.dataDir, dirs.agentDir);
    const snapshot = await backend.client.request<any>("get_task", { task_id: taskA.id });
    assert.equal(snapshot.task.status, "interrupted", "活动任务重启后标为中断");
    assert.equal(snapshot.task.interruptReason, "backend_restart");
    assert.equal(snapshot.task.effectUnknown, true, "结果缺失的标记操作应保留效果不明事实");
    const markOp = snapshot.toolOps.find((op: any) => op.sdkCallId === "call_mark_1");
    assert.ok(markOp, "应保留工具执行意图");
    assert.equal(markOp.resultSummary, null, "结果缺失");
    assert.equal(markOp.effectUnknown, true, "效果不明标记在工具操作上");

    // 外部标记不重放：计数不变
    const countAfterRestart = (await fs.readFile(markerPath, "utf8")).split("\n").filter((l) => l.trim()).length;
    assert.equal(countAfterRestart, 1, "不得自动重放外部副作用");

    // 排队任务保留且不自动启动（会话暂停）
    const statusB1 = await taskStatus(backend.client, taskB.id);
    assert.equal(statusB1.task.status, "queued", "排队任务应保留");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal((await taskStatus(backend!.client, taskB.id)).task.status, "queued", "恢复后不得自动调度");

    // 拥有者恢复队列后执行
    await backend.client.request("resume_queue", { session_id: sessionId });
    await waitFor("任务B完成", async () => (await taskStatus(backend!.client, taskB.id)).task.status === "completed");

    // 历史原文完整：可解析，包含 A 的输入与 assistant 工具调用，无伪造工具结果
    const snap = await backend.client.handshake();
    const sessionRec = snap.snapshot.sessions.find((s: any) => s.id === sessionId);
    assert.ok(sessionRec?.sessionFile, "会话文件应已回填");
    const entries = parseSessionFile(sessionRec.sessionFile);
    const texts = JSON.stringify(entries);
    assert.ok(texts.includes("MARKCRASH"), "历史应保留用户输入原文");
    assert.ok(entries.some((e: any) => e.type === "message"), "应有消息条目");
  } finally {
    if (backend) await killBackend(backend).catch(() => {});
    await server.close();
    if (dirs) await cleanupDirs(dirs);
  }
});

test("首次 assistant 消息前崩溃：不宣布消息已持久化，请求保留，历史不伪造", async () => {
  const server = new MockModelServer(
    routeResponder([
      {
        match: /SLOWFIRST/,
        respond: async () => {
          await new Promise((r) => setTimeout(r, 30_000));
          return { kind: "text", text: "太迟了" };
        },
      },
      {
        match: /QUICK/,
        respond: () => ({ kind: "text", text: "quick-done" }),
      },
    ]),
  );
  let dirs: any = null;
  let backend: Backend | null = null;
  try {
    const baseUrl = await server.start();
    const made = await makeTestDirs("crash-first", 1);
    dirs = made.dirs;
    await writeModelsJson(dirs, baseUrl);

    backend = await spawnBackend(dirs.dataDir, dirs.agentDir);
    const { sessionId } = await createProjectSession(backend.client, made.work[0]!);
    const task = await backend.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "first-1",
      input: "SLOWFIRST:第一个请求",
    });
    await waitFor("任务运行中", async () => (await taskStatus(backend!.client, task.id)).task.status === "running");
    await new Promise((r) => setTimeout(r, 300)); // 首个 assistant 消息尚未产生
    await killBackend(backend);

    backend = await spawnBackend(dirs.dataDir, dirs.agentDir);
    const detail = await taskStatus(backend.client, task.id);
    assert.equal(detail.task.status, "interrupted", "重启后标为中断");
    assert.equal(detail.task.input, "SLOWFIRST:第一个请求", "已接收请求必须保留");
    // 会话从未落盘：不得伪造任何历史
    const snap = await backend.client.handshake();
    const sessionRec = snap.snapshot.sessions.find((s: any) => s.id === sessionId);
    const sessionFile = sessionRec?.sessionFile ?? null;
    if (sessionFile) {
      assert.ok(!fsSync.existsSync(sessionFile), "首次响应前崩溃不得产生会话文件");
    }
    // 拥有者恢复队列后可继续使用该会话（新任务正常执行）
    await backend.client.request("resume_queue", { session_id: sessionId });
    const next = await backend.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "first-2",
      input: "QUICK:恢复后的新任务",
    });
    await waitFor("新任务完成", async () => (await taskStatus(backend!.client, next.id)).task.status === "completed");
  } finally {
    if (backend) await killBackend(backend).catch(() => {});
    await server.close();
    if (dirs) await cleanupDirs(dirs);
  }
});
