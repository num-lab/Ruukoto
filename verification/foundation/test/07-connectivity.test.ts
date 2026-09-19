/**
 * 验证 7（连通性检查，默认跳过）：真实模型一次往返。
 *
 * 工单要求"真实模型只需少量连通性检查"。本测试默认跳过；
 * 运行 RUN_MODEL_CHECK=1 npm run test:model 执行一次。
 *
 * 使用本机 pi 配置（ModelRuntime 默认读取用户 auth.json / models.json），
 * 优先选 id 含 "flash" 的可用模型，只发一条短消息，不做产品验收。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("真实模型连通性：一次短往返", { skip: process.env.RUN_MODEL_CHECK ? false : "设置 RUN_MODEL_CHECK=1 后运行" }, async () => {
  const modelRuntime = await ModelRuntime.create();
  const available = await modelRuntime.getAvailable();
  assert.ok(available.length > 0, "本机应有已配置凭据的模型");

  const flash = available.find((m: any) => /flash/i.test(m.id));
  const model = flash ?? available[0];
  const label = `${model.provider}/${model.id}`;
  console.log(`使用模型: ${label}`);

  const { session } = await createAgentSession({
    modelRuntime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });

  let assistantText = "";
  let stopReason: string | undefined;
  session.subscribe((event: any) => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      stopReason = event.message.stopReason;
      assistantText = (event.message.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    }
  });

  await session.prompt('这是一次连通性检查，请只回复两个字符：OK');
  assert.equal(stopReason, "stop", `模型应正常结束，实际 ${stopReason}`);
  assert.ok(assistantText.length > 0, "应有回复文本");
  console.log(`回复: ${assistantText.slice(0, 80)}`);
  session.dispose();
});
