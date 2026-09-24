/**
 * issue 03 子进程崩溃窗口：启动后台，发送函数在"平台已接收"后记一行并永久挂起，
 * 由父测试 SIGKILL（本地结果不落库）。参数：dataDir agentDir receivedFile socketPath。
 */
import * as fs from "node:fs";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createMockTools } from "../../src/agent/mock-tools.ts";

const [dataDir, agentDir, received, socketPath] = process.argv.slice(2) as [string, string, string, string];
const target = { channel: "mock", account: "bot1", chatId: "owner-chat", configVersion: 1 };
await Runtime.start({
  dataDir,
  agentDir,
  socketPath,
  thinkingLevel: "off",
  modelProvider: "mock",
  modelId: "mock-model",
  toolFactory: (ctx) => createMockTools(ctx),
  scheduler: {
    now: () => Date.parse("2026-09-24T01:00:05Z"),
    tickMs: 0,
    sendTimeoutMs: 600_000,
    channel: {
      target: () => target,
      send: async () => {
        fs.appendFileSync(received, "received\n");
        return new Promise(() => {});
      },
    },
  },
});
