/** 内置 bash 的真实命令结果进入后续模型请求。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupSession,teardownSession } from "../src/setup.ts";

test("内置 bash 工具可直接复用（宿主无需重写基础工具）", async () => {
  let callIndex = 0;
  const s = await setupSession("builtin-bash", () => {
    callIndex++;
    if (callIndex === 1) {
      return {
        kind: "tool_calls",
        calls: [{ id: "call_bash1", name: "bash", arguments: { command: "echo foundation-ok" } }],
      };
    }
    return { kind: "text", text: "done" };
  });
  try {
    await s.session.prompt("运行 echo foundation-ok");

    const messages = s.session.messages as any[];
    const bashResult = messages.find((m) => m.role === "toolResult" && m.toolName === "bash");
    assert.ok(bashResult, "内置 bash 应被执行并产生结果");
    assert.equal(bashResult.isError, false, "bash 执行不应报错");
    const text = JSON.stringify(bashResult.content);
    assert.ok(text.includes("foundation-ok"), `bash 输出应包含命令结果，实际 ${text.slice(0, 120)}`);

    // 模型收到工具结果
    const secondCall = s.server.calls[1].messages as any[];
    assert.ok(
      secondCall.some((m) => m.role === "tool" && JSON.stringify(m).includes("foundation-ok")),
      "bash 结果应回传给模型",
    );
  } finally {
    await teardownSession(s);
  }
});
