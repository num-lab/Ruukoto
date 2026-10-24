import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { PersonalState } from "../apps/desktop/src/renderer/personal-state.ts";

const sources = ["https://example.invalid/pixel.png", "http://example.invalid/pixel.png", "file:///tmp/pixel.png", "data:image/png;base64,aGVsbG8=", "blob:https://example.invalid/image", "/tmp/pixel.png", "../pixel.png"];
const body = `${sources.map((src, index) => `![图片${index}](${src})`).join("\n\n")}\n\n<script>evil()</script>\n\n[危险链接](javascript:evil())`;
const noop = () => {};

test("Desktop 各 Markdown 正文保留图片地址与说明，HTML 和链接仍按原规则处理", async t => {
  const server = await createServer({ configFile: false, root: "apps/desktop/src/renderer", plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const Conversation: ComponentType<{ model: CodeState; sessionId: string; child?: boolean }> = (await server.ssrLoadModule("/conversation.tsx")).Conversation;
  const PersonalChat: ComponentType<{ model: PersonalState; onConnect: () => void }> = (await server.ssrLoadModule("/personal-chat.tsx")).PersonalChat;
  const FilePreview: ComponentType<{ file: { kind: "markdown"; path: string; content: string }; path: string; mode: "preview"; onMode: () => void; onFiles: () => void; onUrl: () => void }> = (await server.ssrLoadModule("/inspector-panels.tsx")).FilePreview;
  const SkillBody: ComponentType<{ body: string }> = (await server.ssrLoadModule("/code-skills-settings.tsx")).SkillBody;
  const bridge = { request: async () => ({ ok: true as const, value: null }) };
  const code = new CodeState(bridge, noop);
  code.view.openSession("images").flow.installHistory([{ entryId: "image", role: "assistant", text: body, timestamp: "2026-10-25T00:00:00.000Z", taskId: null, inputPurpose: "user", parentId: null, offset: 0, totalBytes: Buffer.byteLength(body), truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: false }], true, 1);
  const personal = new PersonalState(bridge, noop);
  personal.identity = { v: 1, product: "ruukoto", remoteId: "remote", origin: "https://pa.example", profile: { id: "profile", directory: "/private/pa" }, online: true, runId: "run" };
  personal.entries.set(1, { entry: 1, conversation: 0, kind: "pi.assistant", role: "assistant", text: body, partial: false, truncated: false, timestamp: 1 });
  for (const [name, element] of [
    ["Code 主会话", createElement(Conversation, { model: code, sessionId: "images" })],
    ["Code 子会话", createElement(Conversation, { model: code, sessionId: "images", child: true })],
    ["Personal", createElement(PersonalChat, { model: personal, onConnect: noop })],
    ["文件预览", createElement(FilePreview, { file: { kind: "markdown", path: "sample.md", content: body }, path: "sample.md", mode: "preview", onMode: noop, onFiles: noop, onUrl: noop })],
    ["双端技能正文", createElement(SkillBody, { body })],
  ] as const) {
    const html = renderToStaticMarkup(element);
    assert.deepEqual([...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"[^>]*>/g)].map(match => match[1]), sources, name);
    for (let index = 0; index < sources.length; index++) assert.ok(html.includes(`alt="图片${index}"`), name);
    assert.doesNotMatch(html, /\[图片|<script|href="javascript:/, name);
  }
});
