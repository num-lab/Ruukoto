/**
 * 验证 1：关闭自动压缩后，会话历史完整保留，没有任何摘要条目混入。
 *
 * 对照组（压缩开启）必须真的触发压缩，证明断言手段有效；随后验证
 * enabled: false 关闭自动压缩，以及扩展 hook 能拦下阈值触发的压缩。
 *
 * 对应工单：关闭自动压缩、阻止非预期摘要、读取完整历史。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { MockModelServer } from "../src/mock-provider.ts";
import { makeTestDirs, cleanupDirs, writeModelsJson, readSessionFile, type TestDirs } from "../src/helpers.ts";

const LONG_TEXT = "这是一段足够长的正文，用来撑高 token 估算。".repeat(60);

interface Setup {
  dirs: TestDirs;
  server: MockModelServer;
  session: AgentSession;
  compactionEvents: string[];
}

async function setup(
  prefix: string,
  compaction: { enabled: boolean },
  extraExtension?: (pi: any) => void,
): Promise<Setup> {
  const dirs = await makeTestDirs(prefix);
  const server = new MockModelServer(() => ({ kind: "text", text: LONG_TEXT }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl, 200);

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dirs.agentDir, "auth.json"),
    modelsPath: path.join(dirs.agentDir, "models.json"),
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel("mock", "mock-model");
  assert.ok(model, "mock model 应该已注册");

  const settingsManager = SettingsManager.inMemory({
    compaction: { ...compaction, reserveTokens: 100, keepRecentTokens: 50 },
    retry: { enabled: false },
  });

  const loader = new DefaultResourceLoader({
    cwd: dirs.cwd,
    agentDir: dirs.agentDir,
    settingsManager,
    extensionFactories: extraExtension ? [{ name: "test-ext", factory: extraExtension }] : [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: dirs.cwd,
    agentDir: dirs.agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    sessionManager: SessionManager.create(dirs.cwd, dirs.sessionDir),
    settingsManager,
    resourceLoader: loader,
  });

  const compactionEvents: string[] = [];
  session.subscribe((event: any) => {
    if (event.type.startsWith("compaction") || event.type.startsWith("summarization")) {
      compactionEvents.push(event.type);
    }
  });

  return { dirs, server, session, compactionEvents };
}

async function teardown(s: Setup) {
  await s.server.close();
  await cleanupDirs(s.dirs);
}

test("压缩开启时阈值会触发压缩（对照组）", async () => {
  const s = await setup("compact-on", { enabled: true });
  try {
    await s.session.prompt("第一轮");
    await s.session.prompt("第二轮");
    const entries = await readSessionFile(s.session.sessionFile!);
    assert.ok(entries.some((e) => e.type === "compaction"), "压缩开启时应出现 compaction 条目");
    assert.ok(s.compactionEvents.length > 0, "应有压缩相关事件");
  } finally {
    await teardown(s);
  }
});

test("compaction.enabled=false 时阈值不再触发压缩，磁盘历史完整", async () => {
  const s = await setup("compact-off", { enabled: false });
  try {
    for (const turn of ["第一轮", "第二轮", "第三轮"]) {
      await s.session.prompt(turn);
    }

    const entries = await readSessionFile(s.session.sessionFile!);
    assert.ok(!entries.some((e) => e.type === "compaction"), "不应有任何 compaction 条目");
    assert.equal(s.compactionEvents.length, 0, "不应有任何压缩事件");

    // 磁盘历史 = 3 轮 × (user + assistant)，且没有摘要消息
    const messages = entries.filter((e) => e.type === "message");
    assert.equal(messages.length, 6, "磁盘应有完整 6 条消息");
    const roles = messages.map((e) => (e.message as any)?.role);
    assert.deepEqual(roles, ["user", "assistant", "user", "assistant", "user", "assistant"]);

    // Agent 进程内状态同样完整
    assert.equal(s.session.messages.length, 6, "进程内历史应完整");

    // 每次模型调用收到的输入都包含全部此前消息（完整历史进入上下文）
    const counts = s.server.calls.map((c) => c.messages.length);
    assert.deepEqual(counts, [1, 3, 5], `模型输入应逐轮完整增长，实际 ${JSON.stringify(counts)}`);
  } finally {
    await teardown(s);
  }
});

test("扩展可通过 session_before_compact 拦截压缩（阻止非预期摘要）", async () => {
  let compactAttempts = 0;
  const s = await setup("compact-cancel", { enabled: true }, (pi) => {
    pi.on("session_before_compact", async () => {
      compactAttempts++;
      return { cancel: true };
    });
  });
  try {
    await s.session.prompt("第一轮");
    await s.session.prompt("第二轮");

    const entries = await readSessionFile(s.session.sessionFile!);
    assert.ok(compactAttempts > 0, "阈值触发了压缩尝试（对照组已证明会触发）");
    assert.ok(!entries.some((e) => e.type === "compaction"), "取消后磁盘不应有 compaction 条目");

    // 模型后续输入不含摘要（仍然收到完整历史）
    const last = s.server.calls[s.server.calls.length - 1];
    const lastText = JSON.stringify(last.messages);
    assert.ok(!lastText.includes("Goal"), "模型输入不应出现压缩摘要格式");
    assert.ok(lastText.includes("第一轮"), "模型输入应仍包含早期原文");
  } finally {
    await teardown(s);
  }
});
