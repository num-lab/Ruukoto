/**
 * 验证 5：可信自用插件最小接入示例。
 *
 * 插件是一个独立 TS 模块（default export 工厂函数），演示宿主承诺给插件
 * 的四类扩展点（对应工单"列出上下文、记忆、工具和入口所需扩展点"）：
 *  1. 工具：pi.registerTool / customTools —— 注册读取宿主数据的工具
 *  2. 权限实施点：tool_call 阻断（供 03 号工单复用）
 *  3. 生命周期：session_start / agent_start / agent_end 事件订阅
 *  4. 存储：pi.appendEntry —— 插件状态持久化到会话（不进模型上下文）
 */

import { test } from "node:test";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { setupSession,teardownSession } from "../src/setup.ts";
import { readSessionFile } from "../src/helpers.ts";

test("可信插件：宿主数据工具、tool_call 阻断、生命周期订阅、状态持久化", async () => {
  const lifecycle: string[] = [];
  const blocked: string[] = [];
  let hostData: string | undefined;
  const executed: Array<{ id: string; input: string }> = [];

  const s = await setupSession("plugin", (req, callIndex) => {
    if (callIndex === 0) {
      return { kind: "tool_calls", calls: [{ id: "call_h1", name: "host_history", arguments: { input: "hello-host" } }] };
    }
    if (callIndex === 1) {
      return { kind: "tool_calls", calls: [{ id: "call_b1", name: "bash", arguments: { command: "curl http://evil.example.com" } }] };
    }
    return { kind: "text", text: "done" };
  }, {
    extensions: [
      {
        name: "trusted-plugin-example",
        factory: (pi) => {
          // 生命周期：宿主事件订阅。
          // 注：SDK createAgentSession 路径下实测 session_start / session_shutdown
          // 不会派发给 inline 扩展（CLI 交互模式的事件），每轮 agent 生命周期可靠。
          pi.on("before_agent_start", async () => lifecycle.push("before_agent_start"));
          pi.on("agent_start", async () => lifecycle.push("agent_start"));
          pi.on("agent_end", async () => lifecycle.push("agent_end"));
          pi.on("agent_settled", async () => lifecycle.push("agent_settled"));

          // 状态持久化：插件状态条目（不进模型上下文）
          pi.on("before_agent_start", async () => {
            pi.appendEntry("plugin-demo-state", { startedAt: Date.now() });
          });

          // 权限实施点（示例）：禁止 bash 访问外网域名
          pi.on("tool_call", async (event: any) => {
            if (event.toolName === "bash" && String(event.input?.command ?? "").includes("evil.example.com")) {
              blocked.push(event.input.command);
              return { block: true, reason: "外网访问需要拥有者确认" };
            }
            return undefined;
          });
        },
      },
    ],
    customTools: [
      defineTool({
        name: "host_history",
        label: "Host History",
        description: "读取当前会话历史条数",
        parameters: Type.Object({ input: Type.String() }),
        execute: async (id, params) => {
          executed.push({ id, input: params.input });
          hostData = `count=${s.session.messages.length}`;
          return { content: [{ type: "text", text: `history:${hostData}` }], details: {} };
        },
      }),
    ],
  });
  try {
    await s.session.prompt("查一下历史条数");
    await s.session.prompt("curl 外网试试");
    await s.session.prompt("结束");

    // 1. 工具扩展点：host_history 真实执行且拿到宿主数据
    assert.ok(hostData?.startsWith("count="), `宿主工具应执行，实际 ${hostData}`);
    const messages = s.session.messages as any[];
    const toolResult = messages.find((m) => m.role === "toolResult" && m.toolName === "host_history");
    assert.ok(toolResult, "历史中应有 host_history 的结果");
    assert.deepEqual(executed, [{ id: "call_h1", input: "hello-host" }]);
    const call = messages.flatMap(message => message.role === "assistant" ? message.content ?? [] : []).find(part => part.type === "toolCall" && part.name === "host_history");
    assert.ok(call); assert.equal(toolResult.toolCallId, call.id);
    assert.ok(s.server.calls[1].messages.some(message => message.role === "tool" && JSON.stringify(message).includes(`history:${hostData}`)));
    assert.ok(JSON.stringify(toolResult.content).includes("count="), "工具结果应包含宿主读取的数据");

    // 2. tool_call 阻断：bash 被拦截，产生错误结果消息，而不是执行
    assert.equal(blocked.length, 1, "bash 应被插件拦截一次");
    const blockedResult = messages.filter((m) => m.role === "toolResult" && m.toolName === "bash");
    assert.ok(blockedResult.length >= 1, "被拦截的调用应有 toolResult");
    assert.equal(blockedResult[0].isError, true, "被拦截调用应以错误结果返回模型");

    // 3. 生命周期事件：插件收到每轮 agent 生命周期
    assert.ok(lifecycle.includes("before_agent_start"), "应收到 before_agent_start");
    assert.ok(lifecycle.includes("agent_start"), "应收到 agent_start");
    assert.ok(lifecycle.includes("agent_end"), "应收到 agent_end");
    assert.ok(lifecycle.includes("agent_settled"), "应收到 agent_settled");

    // 4. 存储扩展点：appendEntry 写入磁盘，且类型为 custom（不进模型上下文）
    const entries = await readSessionFile(s.sessionFile());
    const customEntries = entries.filter((e) => e.type === "custom");
    assert.ok(customEntries.length >= 1, "插件状态应持久化为 custom 条目");
    assert.equal((customEntries[0] as any).customType, "plugin-demo-state");
    assert.ok(!s.server.calls.some((c) => JSON.stringify(c.messages).includes("plugin-demo-state")), "custom 条目不得进入模型上下文");
  } finally {
    await teardownSession(s);
  }
});
