/**
 * 模拟工具（issue 02 验证用；真实编码工具由 issue 03 沿用同一执行路径接入）。
 *
 * 覆盖：可控延迟、等待确认（配合会话 confirmTools 的 tool_call 门）、
 * 进程树（登记受管进程组）、拒绝正常终止的子进程由测试脚本自身实现，
 * 以及写入一次外部标记（副作用计数断言）。
 *
 * 出于权限边界考虑，这些工具只使用 Node 标准库与测试显式传入的命令；
 * 不开放宿主 Shell。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ManagedProcessRegistry } from "./managed-processes.ts";

export interface MockToolContext {
  registry: ManagedProcessRegistry;
}

export function createMockTools(ctx: MockToolContext): ToolDefinition[] {
  const delay = defineTool({
    name: "mock_delay",
    label: "Mock Delay",
    description: "模拟耗时操作：等待指定毫秒后返回。",
    parameters: Type.Object({
      ms: Type.Number({ description: "等待毫秒数" }),
    }),
    execute: async (_toolCallId, params) => {
      await new Promise((r) => setTimeout(r, Math.min(params.ms, 120_000)));
      return { content: [{ type: "text", text: `delayed:${params.ms}` }], details: {} };
    },
  });

  const gate = defineTool({
    name: "mock_gate",
    label: "Mock Gate",
    description: "需要拥有者确认的工具（确认行为由会话 confirmTools 配置驱动）。",
    parameters: Type.Object({
      note: Type.String({ description: "随确认请求展示的说明" }),
    }),
    execute: async (_toolCallId, params) => {
      return { content: [{ type: "text", text: `gate-ok:${params.note}` }], details: {} };
    },
  });

  const spawn = defineTool({
    name: "mock_spawn",
    label: "Mock Spawn",
    description: "spawn 一个子进程（独立进程组并登记为受管进程），等待其退出。",
    parameters: Type.Object({
      file: Type.String({ description: "可执行文件路径" }),
      args: Type.Array(Type.String(), { description: "参数列表" }),
    }),
    execute: async (_toolCallId, params) => {
      const child = childProcess.spawn(params.file, params.args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      ctx.registry.register(child.pid!, `${params.file} ${params.args.join(" ")}`.trim());
      const stdout = await new Promise<{ code: number | null; out: string }>((resolve) => {
        let out = "";
        child.stdout!.on("data", (c: Buffer) => {
          out += c.toString("utf8");
        });
        child.on("error", (err) => resolve({ code: -1, out: `${out}\nspawn-error:${err.message}` }));
        child.on("close", (code) => resolve({ code, out }));
      });
      return {
        content: [{ type: "text", text: `spawn-exit:${stdout.code}\n${stdout.out.slice(0, 2000)}` }],
        details: { pid: child.pid },
      };
    },
  });

  const mark = defineTool({
    name: "mock_mark",
    label: "Mock Mark",
    description: "向外部文件追加一行标记，模拟一次外部副作用（写入后不可撤销）。",
    parameters: Type.Object({
      path: Type.String({ description: "标记文件路径" }),
      content: Type.String({ description: "标记内容" }),
      ms: Type.Optional(Type.Number({ description: "写入后的额外延迟（毫秒），默认 0" })),
    }),
    execute: async (_toolCallId, params) => {
      await fs.appendFile(params.path, `${params.content}\n`, "utf8");
      if (params.ms && params.ms > 0) {
        await new Promise((r) => setTimeout(r, params.ms));
      }
      return { content: [{ type: "text", text: `marked:${params.path}` }], details: {} };
    },
  });

  return [delay, gate, spawn, mark];
}

export const MOCK_TOOL_NAMES = ["mock_delay", "mock_gate", "mock_spawn", "mock_mark"] as const;
