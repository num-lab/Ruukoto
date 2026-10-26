/**
 * 验证 2：每轮模型输入可调整（上下文组装扩展点）。
 *
 * 扩展 `context` 事件在每次 LLM 调用前收到消息的深拷贝；宿主用它实现
 * "预算内保留最近完整交互" 的选取规则。断言：
 * 1. 模型实际收到的输入被过滤（早期消息不进入后续调用）
 * 2. 磁盘会话文件仍保留全部原文（历史与模型上下文分离）
 * 3. 过滤是非破坏的：过滤后进程内历史与会话文件均不变
 *    （工具调用/结果配对不受过滤影响在 test/03 中单独覆盖）
 * Note: 见 .agents/notes/implemented/architecture/2026-09-19-preserve-session-history.md
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupSession, teardownSession } from "../src/setup.ts";
import { readSessionFile } from "../src/helpers.ts";

test("context 事件过滤早期消息，磁盘原文完整保留", async () => {
  const seenMessageCounts: number[] = [];
  const s = await setupSession("context-select", (req) => {
    seenMessageCounts.push(req.messages.length);
    return { kind: "text", text: `回复（第 ${seenMessageCounts.length} 轮）` };
  }, {
    extensions: [
      {
        name: "context-selector",
        factory: (pi) => {
          pi.on("context", async (event: any) => {
            // 保留最后 2 条（一轮 user+assistant），加上当前 user 消息
            const kept = event.messages.slice(-2);
            return { messages: kept };
          });
        },
      },
    ],
  });
  try {
    await s.session.prompt("第一轮：记住暗号 alpha");
    await s.session.prompt("第二轮：记住暗号 beta");
    await s.session.prompt("第三轮：现在还有哪些消息在上下文里？");

    // 模型每次只收到选取后的消息（最后 2 条 + 系统提示不含在内）
    assert.deepEqual(seenMessageCounts, [1, 2, 2], `模型输入条数应被过滤，实际 ${JSON.stringify(seenMessageCounts)}`);

    // 磁盘保留全部原文（6 条消息 = 3 轮 × 2）
    const entries = await readSessionFile(s.sessionFile());
    const messages = entries.filter((e) => e.type === "message" && (e.message as { role?: unknown })?.role !== "system");
    assert.equal(messages.length, 6, "磁盘会话文件必须保留全部原文");
    const userTexts = messages
      .filter((e) => (e.message as any).role === "user")
      .map((e) => JSON.stringify((e.message as any).content));
    assert.ok(userTexts.some((t) => t.includes("alpha")), "第一轮原文必须完整保留在磁盘");
    assert.ok(userTexts.some((t) => t.includes("beta")), "第二轮原文必须完整保留在磁盘");

    // 进程内历史同样完整（非破坏性过滤）
    assert.equal(s.session.messages.filter(message => message.role !== "system").length, 6, "扩展过滤不得修改对话历史");

    // 最后一轮模型输入确实包含第三轮问题（配对完整，无孤儿消息）
    const lastCall = seenMessageCounts[seenMessageCounts.length - 1];
    assert.equal(lastCall, 2);
  } finally {
    await teardownSession(s);
  }
});
