/**
 * 验证 4：从后台（同进程宿主）并行驱动多个会话并读取事件。
 *
 * 对应 ADR 0002（后台运行任务，TUI 负责交互）与阶段 1 的多会话要求。
 * 断言：
 * 1. 两个会话可同时执行任务（A 阻塞在模型响应时 B 可完整走完一轮）
 * 2. 各会话事件独立可订阅，互不串用
 * 3. 历史与状态互相隔离（文件、消息、sessionId 均独立）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupSession, teardownSession } from "../src/setup.ts";
import { readSessionFile, waitFor } from "../src/helpers.ts";

test("多会话并行执行、事件订阅与状态隔离", async () => {
  // A 的 mock 延迟 400ms 才返回，制造并行窗口；B 即时返回
  const s = await setupSession("multi-session-a", async () => {
    await new Promise((r) => setTimeout(r, 400));
    return { kind: "text", text: "reply-A" };
  });

  // 第二个会话：setupSession 自建独立 SessionManager 与独立 mock 服务，同进程并行
  const sB = await setupSession("multi-session-b", async () => {
    return { kind: "text", text: "reply-B" };
  });

  const eventsA: string[] = [];
  const eventsB: string[] = [];
  s.session.subscribe((e: any) => eventsA.push(`${e.type}`));
  sB.session.subscribe((e: any) => eventsB.push(`${e.type}`));

  try {
    let aFinished = false;
    const promptA = s.session.prompt("会话A：耗时任务").then(() => {
      aFinished = true;
    });
    // 并行窗口：A 还没结束时，B 完整执行
    await sB.session.prompt("会话B：快速任务");
    assert.ok(!aFinished, "A 应仍在执行中（并行证据）");
    await waitFor("会话A 完成", () => aFinished);
    await promptA;

    // 事件独立：两个会话各自都有完整 agent 生命周期事件
    for (const ev of ["agent_start", "agent_end"]) {
      assert.ok(eventsA.includes(ev), `会话A 缺少 ${ev}`);
      assert.ok(eventsB.includes(ev), `会话B 缺少 ${ev}`);
    }

    // 状态隔离：sessionId 不同、历史互不可见
    assert.notEqual(s.session.sessionId, sB.session.sessionId, "sessionId 必须独立");
    const histA = JSON.stringify(s.session.messages);
    const histB = JSON.stringify(sB.session.messages);
    assert.ok(histA.includes("会话A"), "A 历史应包含 A 消息");
    assert.ok(!histA.includes("会话B"), "A 历史不得串入 B 消息");
    assert.ok(histB.includes("会话B"), "B 历史应包含 B 消息");
    assert.ok(!histB.includes("会话A"), "B 历史不得串入 A 消息");

    // 磁盘文件独立
    const fileA = s.session.sessionFile!;
    const fileB = sB.session.sessionFile!;
    assert.notEqual(fileA, fileB, "会话文件必须分开");
    const entriesA = await readSessionFile(fileA);
    const entriesB = await readSessionFile(fileB);
    const textA = JSON.stringify(entriesA);
    const textB = JSON.stringify(entriesB);
    assert.ok(textA.includes("会话A") && !textA.includes("会话B"), "A 文件不得包含 B 消息");
    assert.ok(textB.includes("会话B") && !textB.includes("会话A"), "B 文件不得包含 A 消息");
  } finally {
    await teardownSession(s);
    await teardownSession(sB);
  }
});
