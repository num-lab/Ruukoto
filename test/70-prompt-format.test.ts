import test from "node:test";
import assert from "node:assert/strict";
import { formatPromptSnapshot } from "../src/tui/prompt-format.ts";

test("Prompt 快照解析正文、工具参数与定义，并保留消息顺序", () => {
  const text = formatPromptSnapshot(JSON.stringify({
    v: 1, model: { provider: "test", id: "model" }, thinkingLevel: "high", reasoning: "high", maxTokens: 4096,
    systemPrompt: "系统第一行\n系统第二行",
    messages: [
      { role: "user", content: [{ type: "text", text: "请修改\n第二行" }, { type: "image", mimeType: "image/png", data: "SECRET_BASE64" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "先查看", thinkingSignature: "SECRET_SIGNATURE" }, { type: "toolCall", name: "edit", id: "call1", arguments: { path: "a.ts", edits: [{ oldText: "旧\n正文", newText: "新正文" }] } }] },
      { role: "toolResult", toolName: "edit", toolCallId: "call1", content: [{ type: "text", text: "修改成功" }], isError: false },
    ],
    tools: [{ name: "edit", description: "修改文件\n保留原内容", parameters: { type: "object", properties: { path: { type: "string", description: "文件路径" }, edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" } } } } }, required: ["path", "edits"] } }],
  }));
  assert.match(text, /系统第一行\n系统第二行/);
  assert.match(text, /请修改\n第二行/);
  assert.match(text, /图片 · image\/png/);
  assert.match(text, /思考\n  先查看/);
  assert.match(text, /工具调用 · edit/);
  assert.match(text, /path: a.ts/);
  assert.match(text, /oldText:\n\s+旧\n\s+正文/);
  assert.match(text, /properties:\n\s+path:\n\s+type: string/);
  assert.ok(text.indexOf("1. 用户") < text.indexOf("2. 助手"));
  assert.ok(text.indexOf("2. 助手") < text.indexOf("3. 工具结果"));
  assert.match(text, /isError: false/);
  assert.doesNotMatch(text, /SECRET_|\\n|"role"|"properties"/);
});

test("未知字段与内容类型使用可读层级保留，不输出 data URI", () => {
  const text = formatPromptSnapshot(JSON.stringify({ custom: { note: "附加信息" }, messages: [{ role: "custom", content: [{ type: "future", payload: { note: "新类型内容", uri: "data:image/png;base64,SECRET" } }] }] }));
  assert.match(text, /custom:\n\s+note: 附加信息/);
  assert.match(text, /type: future/);
  assert.match(text, /note: 新类型内容/);
  assert.doesNotMatch(text, /SECRET/);
});

test("无效或非对象 Prompt 快照抛出明确错误", () => {
  assert.throws(() => formatPromptSnapshot('{"systemPrompt":'), /JSON 无效或内容不完整/);
  assert.throws(() => formatPromptSnapshot("null"), /应为对象/);
  assert.throws(() => formatPromptSnapshot("[]"), /应为对象/);
});
