/**
 * 验证 3：注册自定义工具并验证调用回路。
 *
 * mock 模型先发起一次工具调用，SDK 执行工具后把结果回传模型。断言：
 * 1. 自定义工具被真实执行（拿到正确参数）
 * 2. 工具结果以合法配对写进历史（toolResult 跟随 toolCall）
 * 3. 后续模型调用收到工具结果（模型可见）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { setupSession, teardownSession } from "../src/setup.ts";

test("自定义工具注册、执行与结果回传", async () => {
  const executed: Array<{ input: string }> = [];

  const echoTool = defineTool({
    name: "host_echo",
    label: "Host Echo",
    description: "宿主提供的示例工具：回显输入",
    parameters: Type.Object({
      input: Type.String({ description: "输入值" }),
    }),
    execute: async (_toolCallId, params) => {
      executed.push({ input: params.input });
      return {
        content: [{ type: "text", text: `echo:${params.input}` }],
        details: {},
      };
    },
  });

  let callIndex = 0;
  const s = await setupSession("custom-tools", () => {
    callIndex++;
    if (callIndex === 1) {
      return {
        kind: "tool_calls",
        calls: [{ id: "call_1", name: "host_echo", arguments: { input: "hello-host" } }],
      };
    }
    return { kind: "text", text: "工具已调用" };
  }, { customTools: [echoTool] });
  try {
    await s.session.prompt("请调用 host_echo 工具，输入 hello-host");

    assert.equal(executed.length, 1, "自定义工具应被执行一次");
    assert.equal(executed[0].input, "hello-host", "工具应收到模型给定的参数");

    // 历史中 toolCall 与 toolResult 合法配对
    const messages = s.session.messages as any[];
    const toolCallMsg = messages.find((m) => m.role === "assistant" && (m.content ?? []).some((c: any) => c.type === "toolCall"));
    const toolResultMsg = messages.find((m) => m.role === "toolResult");
    assert.ok(toolCallMsg, "历史应包含发起工具调用的 assistant 消息");
    assert.ok(toolResultMsg, "历史应包含工具结果消息");
    const call = toolCallMsg.content.find((c: any) => c.type === "toolCall");
    assert.equal(toolResultMsg.toolCallId, call.id, "toolResult 必须与 toolCall id 配对");
    assert.equal(toolResultMsg.toolName, "host_echo");

    // 模型第二轮调用收到了工具结果
    const secondCallMessages = s.server.calls[1].messages as any[];
    const resultForModel = secondCallMessages.find((m) => m.role === "tool");
    assert.ok(resultForModel, "模型应收到 tool 角色消息");
    const resultText = JSON.stringify(resultForModel.content ?? resultForModel);
    assert.ok(resultText.includes("echo:hello-host"), "工具结果文本应回传给模型");
  } finally {
    await teardownSession(s);
  }
});
