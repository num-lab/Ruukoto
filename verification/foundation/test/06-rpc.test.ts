/**
 * 验证 6：以子进程方式驱动 pi（RPC 模式，JSONL over stdio）。
 *
 * 这是"后台进程驱动任务、另一端读取事件"的跨进程形态（本机通信选型候选）。
 * Note: 见 .agents/notes/implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md
 * 断言：
 * 1. `pi --mode rpc --no-session` 可用本地 mock 模型启动（PI_CODING_AGENT_DIR 隔离）
 * 2. prompt 命令收到 success 响应，事件流可读（agent_end）
 * 3. 助手回复内容可从事件流还原
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { MockModelServer } from "../../../test/helpers/mock-provider.ts";
import { makeTestDirs, writeModelsJson } from "../src/helpers.ts";

const CLI = new URL("../node_modules/.bin/pi", import.meta.url).pathname;

function readLines(stream: NodeJS.ReadableStream, onLine: (obj: any) => void) {
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    // RPC 协议要求仅按 \n 分帧
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) {
        try {
          onLine(JSON.parse(line));
        } catch {
          // 忽略非 JSON 行
        }
      }
    }
  });
}

test("RPC 子进程模式：prompt 命令与事件流", async () => {
  const server = new MockModelServer(() => ({ kind: "text", text: "RPC 回复正常" }));
  const baseUrl = await server.start();
  const dirs = await makeTestDirs("rpc");
  await writeModelsJson(dirs, baseUrl, 200_000);
  const agentDir = dirs.agentDir;

  const child = spawn(CLI, ["--mode", "rpc", "--no-session", "--provider", "mock", "--model", "mock-model"], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events: any[] = [];
  const responses: any[] = [];
  readLines(child.stdout, (obj) => {
    if (obj.type === "response") responses.push(obj);
    else events.push(obj);
  });
  const stderr: string[] = [];
  child.stderr.on("data", (c: Buffer) => stderr.push(c.toString()));

  // 等 RPC 就绪：pi 启动后会发一些初始化事件；直接发 prompt，收到 response 即视为就绪
  const done = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`RPC 超时。stderr: ${stderr.join("")}`)), 30_000);
    const check = (obj: any) => {
      if (obj.type === "response" && obj.command === "prompt") {
        clearTimeout(t);
        resolve();
      }
    };
    // 在事件数组中补查（防止 prompt response 在注册 check 前到达）
    for (const r of responses) check(r);
    readLines(child.stdout, check);
  });

  child.stdin.write(JSON.stringify({ id: "req-1", type: "prompt", message: "你好" }) + "\n");
  await done;

  assert.equal(responses.find((r) => r.id === "req-1")?.success, true, "prompt 应被接受");

  // 等 agent_end（一轮完成）
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (events.some((e) => e.type === "agent_end")) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > 20_000) {
        clearInterval(iv);
        reject(new Error(`未等到 agent_end。事件: ${events.map((e) => e.type).join(",")}`));
      }
    }, 50);
  });

  // 助手回复文本应出现在事件流（message_update 的 partial 或 message_end）
  const allText = JSON.stringify(events);
  assert.ok(allText.includes("RPC 回复正常"), "事件流应包含助手回复文本");

  // mock 收到了 prompt
  assert.equal(server.calls.length, 1, "mock 模型应收到一次调用");

  child.kill("SIGTERM");
  server.close();
  await rm(dirs.root, { recursive: true, force: true });
});
