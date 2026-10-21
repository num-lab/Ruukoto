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
 * 原生文件与身份边界由真实 OS 探针和 smoke 验证，离线用例不替代该证据。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createLocalLauncher } from "@ruukoto/agent/execution/launchers.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import { MAX_FRAME_BYTES } from "@ruukoto/agent/tool-worker/protocol.ts";
import * as os from "node:os";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  taskStatus,
  connectAuthedClient,
  realTools,
  lastUserText,
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

test("真实工具：文件发现→内容检索→读取命中，预览裁剪保留可读完整产物", async () => {
  const t = await startTestRuntime("real-file-search", req => {
    const done = req.messages.filter(message => message.role === "tool").length;
    const calls = [
      { id: "discover", name: "list_files", arguments: { glob: "*.txt", limit: 1 } },
      { id: "locate", name: "search_files", arguments: { query: "SEARCH-TARGET", limit: 1 } },
      { id: "read-hit", name: "read", arguments: { path: "target.txt" } },
    ];
    return done < calls.length ? { kind: "tool_calls", calls: [calls[done]] } : { kind: "text", text: "已读取搜索命中" };
  }, { workDirs: 1, config: realTools() });
  try {
    fs.writeFileSync(path.join(t.work[0], "target.txt"), "SEARCH-TARGET first\nSEARCH-TARGET second\n");
    fs.writeFileSync(path.join(t.work[0], "another.txt"), "other\n");
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const task = await t.runtime.submit({ sessionId, requestId: "search", input: "发现文件并读取命中", modelSelection: t.runtime.defaultSelection, accessMode: "full_access" });
    await waitFor("文件检索闭环完成", () => t.runtime.store.getTask(task.id)?.status === "completed", 30_000);
    const operations = t.runtime.store.listToolOpsByTask(task.id);
    assert.deepEqual(operations.map(operation => [operation.toolName, operation.isError, operation.effectUnknown]), [["list_files", false, false], ["search_files", false, false], ["read", false, false]]);
    const search = operations[1];
    const artifacts = t.runtime.store.listArtifactsByTask(task.id);
    const evidence = artifacts.find(artifact => artifact.name === "search_files 检索证据")!;
    assert.ok(evidence); assert.equal(evidence.status, "complete");
    const bytes = await t.client.request<{ data: string }>("read_artifact", { task_id: task.id, artifact_id: evidence.id });
    assert.match(Buffer.from(bytes.data, "base64").toString("utf8"), /SEARCH-TARGET second/);
    assert.match(search.resultSummary!, /previewTruncated/);
    const history = t.runtime.readHistory({ sessionId }).entries;
    const read = history.find(entry => entry.toolName === "read")!;
    assert.match(t.runtime.readHistoryEntry({ sessionId, entryId: read.entryId }).text, /SEARCH-TARGET/);
  } finally { await t.shutdown(); }
});

test("检索失败：路由保留 partial 产物与可读引用，不把结果帧当作扫描完整", async () => {
  const t = await startTestRuntime("partial-file-search", req => req.messages.some(message => message.role === "tool")
    ? { kind: "text", text: "已报告部分检索结果" }
    : { kind: "tool_calls", calls: [{ id: "partial-search", name: "list_files", arguments: {} }] }, { workDirs: 1, config: realTools() });
  const previous = process.env.PATH;
  try {
    const bin = path.join(t.work[0], "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(t.work[0], "sample.txt"), "captured\n");
    fs.writeFileSync(path.join(bin, "rg"), `#!${process.execPath}\nprocess.stdout.write('sample.txt\\0');process.stderr.write('denied');process.exitCode=2;\n`, { mode: 0o755 });
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    process.env.PATH = bin;
    const task = await t.runtime.submit({ sessionId, requestId: "partial", input: "列出文件", modelSelection: t.runtime.defaultSelection, accessMode: "full_access" });
    await waitFor("部分结果可读", () => t.runtime.store.getTask(task.id)?.status === "completed", 30_000);
    const operation = t.runtime.store.listToolOpsByTask(task.id)[0];
    assert.equal(operation.isError, true); assert.equal(operation.effectUnknown, false);
    const artifacts = t.runtime.store.listArtifactsByTask(task.id).filter(artifact => artifact.name.startsWith("list_files "));
    assert.equal(artifacts.length, 2); assert.ok(artifacts.every(artifact => artifact.status === "partial"));
    const entry = t.runtime.readHistory({ sessionId }).entries.find(entry => entry.toolName === "list_files")!;
    const text = t.runtime.readHistoryEntry({ sessionId, entryId: entry.entryId }).text;
    assert.match(text, /"scanComplete":false/); assert.match(text, /"partial":true/);
    assert.match(text, /部分证据已保留：artifact/); assert.doesNotMatch(text, /完整正文已捕获/);
    const evidence = artifacts.find(artifact => artifact.name === "list_files 检索证据")!;
    const bytes = await t.client.request<{ data: string }>("read_artifact", { task_id: task.id, artifact_id: evidence.id });
    assert.equal(Buffer.from(bytes.data, "base64").toString("utf8"), "sample.txt\0");
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    await t.shutdown();
  }
});

test("同批后续工具仍运行时，已落盘结果逐条可读；旧任务迟到扫描不消费新消息身份", async () => {
  let nextRequest = false;
  let releaseModel!: () => void;
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  const t = await startTestRuntime("per-tool-entry", async req => {
    if (lastUserText(req).includes("NEXT_TASK")) { nextRequest = true; await modelGate; return { kind: "text", text: "下一任务完成" }; }
    if (req.messages.some(message => message.role === "tool")) return { kind: "text", text: "本批完成" };
    return { kind: "tool_calls", calls: [{ id: "first", name: "read", arguments: { path: "first.txt" } }, { id: "second", name: "bash", arguments: { command: "touch second-started; while [ ! -f release-second ]; do sleep 0.1; done" } }] };
  }, { workDirs: 1, config: realTools() });
  try {
    fs.writeFileSync(path.join(t.work[0], "first.txt"), "第一条真实结果\n");
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const first = await t.runtime.submit({ sessionId, requestId: "first", input: "运行两个工具", modelSelection: t.runtime.defaultSelection, accessMode: "full_access" });
    await waitFor("第二个工具等待门控", () => fs.existsSync(path.join(t.work[0], "second-started")), 15_000);
    const entry = t.runtime.readHistory({ sessionId }).entries.find(entry => entry.toolCallId === "first")!;
    assert.ok(entry, "第一条结果已写入 JSONL");
    const references = () => t.runtime.readTaskEvents({ taskId: first.id }).events.filter(event => event.body.type === "task.output_entry" && event.body.entryId === entry.entryId);
    await waitFor("第一条落盘引用已发布", () => references().length === 1, 2000);
    assert.equal(t.runtime.store.getTask(first.id)?.status, "running");
    assert.match(t.runtime.readHistoryEntry({ sessionId, entryId: entry.entryId }).text, /第一条真实结果/);
    fs.writeFileSync(path.join(t.work[0], "release-second"), "");
    await waitFor("本批完成", () => t.runtime.store.getTask(first.id)?.status === "completed", 15_000);
    assert.equal(references().length, 1, "turn_end 不重复引用");
    const second = await t.runtime.submit({ sessionId, requestId: "next", input: "NEXT_TASK", modelSelection: t.runtime.defaultSelection, accessMode: "full_access" });
    await waitFor("下一任务模型请求已开始", () => nextRequest);
    const driver = t.runtime["drivers"].get(sessionId)!;
    const pending = [...driver["pendingEntryMsgIds"]];
    const count = t.runtime.readTaskEvents({ taskId: first.id }).events.length;
    driver["flushEntryRefs"](first);
    assert.deepEqual(driver["pendingEntryMsgIds"], pending);
    assert.equal(t.runtime.readTaskEvents({ taskId: first.id }).events.length, count);
    releaseModel();
    await waitFor("下一任务完成", () => t.runtime.store.getTask(second.id)?.status === "completed", 15_000);
  } finally { releaseModel(); fs.writeFileSync(path.join(t.work[0], "release-second"), ""); await t.shutdown(); }
});

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

    const history = t.runtime.readHistory({ sessionId });
    const editEntry = history.entries.find((entry) => entry.toolName === "edit")!;
    const editResult = await t.client.request<any>("read_tool_result", { session_id: sessionId, entry_id: editEntry.entryId });
    assert.match(editResult.patch, /-41\n\+42/, "返回实际 Edit unified patch");
    assert.equal(editResult.toolName, "edit");
    assert.equal(editResult.isError, false);
    assert.equal(editResult.writeContent, null);
    const failedEntry = history.entries.find((entry) => entry.toolName === "bash" && entry.isError)!;
    const failedResult = await t.client.request<any>("read_tool_result", { session_id: sessionId, entry_id: failedEntry.entryId });
    assert.equal(failedResult.isError, true);
    assert.equal(failedResult.patch, null);
    assert.ok(failedResult.text.length > 0);

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

test("真实 Write：新建、覆盖与无变化的实际 diff 和统计持久化", async () => {
  const t = await startTestRuntime("realtools-write-stats", (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "write-create", name: "write", arguments: { path: "notes.txt", content: "alpha\nbeta\n" } }] };
    if (done === 1) return { kind: "tool_calls", calls: [{ id: "write-overwrite", name: "write", arguments: { path: "notes.txt", content: "alpha\ngamma\nextra\n" } }] };
    if (done === 2) return { kind: "tool_calls", calls: [{ id: "write-same", name: "write", arguments: { path: "notes.txt", content: "alpha\ngamma\nextra\n" } }] };
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
    const stats = [{ added: 2, removed: 0 }, { added: 2, removed: 1 }, { added: 0, removed: 0 }];
    const events = t.runtime.readTaskEvents({ taskId: task.id }).events
      .flatMap((event) => event.body.type === "task.tool_result" ? [event.body] : []);
    assert.deepEqual(events.map((event) => event.editStats), stats, "工具结果事件记录各次 Write 的增删行数");
    const history = t.runtime.readHistory({ sessionId });
    fs.writeFileSync(path.join(dir, "notes.txt"), "后续外部变更不改写旧调用的 diff\n");
    for (const [index, entry] of history.entries.filter((entry) => entry.toolName === "write").entries()) {
      const result = await t.client.request<any>("read_tool_result", { session_id: sessionId, entry_id: entry.entryId });
      assert.equal(result.writeContent, ["alpha\nbeta\n", "alpha\ngamma\nextra\n", "alpha\ngamma\nextra\n"][index], "从实际 SDK assistant arguments 还原 Write 原文");
      if (index === 0) assert.match(result.patch, /\+alpha\n\+beta/);
      else if (index === 1) assert.match(result.patch, /-beta\n\+gamma\n\+extra/);
      else assert.equal(result.patch, "", "已捕获的无变化与未记录补丁不同");
      assert.equal(result.isError, false);
    }
    assert.deepEqual(history.entries.filter((entry) => entry.toolName === "write").map((entry) => entry.editStats), stats,
      "会话历史保留各次 Write 的增删行数");
  } finally {
    await t.shutdown();
  }
});

test("Write diff 的 JSON 转义使结果帧超限时，省略补丁且保留成功写入与统计", async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-write-patch-")));
  const file = path.join(workspace, "escaped.txt");
  const previous = `${"\u0001".repeat(Math.floor(MAX_FRAME_BYTES / 6) + 100)}\n`;
  fs.writeFileSync(file, previous);
  const host = ToolWorkerHost.create(createLocalLauncher(), { taskId: "write-patch-frame", mode: "full_access", workspace, grantedPaths: [] });
  try {
    const result = await host.call({ opId: "overwrite", sdkCallId: "overwrite", name: "write", params: { path: "escaped.txt", content: "new\n" } });
    assert.equal(result.ok, true);
    assert.equal(result.isError, false);
    assert.deepEqual(result.details, { editStats: { added: 1, removed: 1 } });
    assert.equal(fs.readFileSync(file, "utf8"), "new\n");
    const next = await host.call({ opId: "next", sdkCallId: "next", name: "write", params: { path: "escaped.txt", content: "next\n" } });
    assert.equal(next.ok, true);
    assert.match((next.details as { patch: string }).patch, /-new\n\+next/);
  } finally { await host.stop(); fs.rmSync(workspace, { recursive: true, force: true }); }
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

test("工作进程启动窗口的中断：启动中的执行单元同样被回收", async () => {
  // agent-direction issue 04 冒烟发现：op 落库早于工作进程 ready，此窗口内的
  // 停止找不到启动中的执行单元（registry 为空），abort() 等待一个无人停止的
  // 工具调用。修复后：占位登记使启动窗口也在停止路径覆盖内。
  const t = await startTestRuntime("realtools-stop-window", (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return { kind: "tool_calls" as const, calls: [{ id: "w_sleep", name: "bash", arguments: { command: "sleep 30" } }] };
    }
    return { kind: "text" as const, text: "不应到达" };
  }, { workDirs: 1, config: realTools() });
  try {
    const dir = t.work[0]!;
    const { sessionId } = await createProjectSession(t.client, dir);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "rt-stop-window",
      input: "执行长命令",
    });
    // op 落库即中断：必然落在工作进程启动窗口（spawn 数百毫秒）
    await waitFor("工具操作已落库", () => (t.runtime.store.listToolOpsByTask(task.id) ?? []).length >= 1, 60_000);
    const startedAt = Date.now();
    const interrupt = t.client.request<any>("interrupt", { task_id: task.id }, 120_000);
    const outcome = await Promise.race([
      interrupt.then(() => "ok" as const),
      new Promise<"slow">((r) => setTimeout(() => r("slow"), 20_000)),
    ]);
    assert.equal(outcome, "ok", "启动窗口的中断必须立即完成，不得等待工具调用自行结束");
    await waitFor("任务中断", async () => (await taskStatus(t.client, task.id)).task.status === "interrupted", 60_000);
    assert.ok(Date.now() - startedAt < 30_000, "中断不得等待长命令自然结束");
    const detail = await taskStatus(t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.sdkCallId === "w_sleep");
    assert.ok(op, "bash 操作已记录");
    assert.equal(op.effectUnknown, true, "启动窗口被停止的 bash 按效果未知补记，不重放");
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
        execution: { backend: "native", native: { workerPath: "/nonexistent/ruukoto-worker.mjs" } },
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
