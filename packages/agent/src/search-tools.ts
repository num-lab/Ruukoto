import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostCallFor, type HostToolFamily } from "./host-tool-families.ts";

export class ToolSearchError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ToolSearchError"; }
}
export interface ToolSearchResult { tools: { name: string; description: string }[]; total: number }

export function searchToolDefinitions(tools: readonly ToolDefinition[], query: string, limit: number): ToolSearchResult {
  if (!query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new ToolSearchError("invalid_search", "query 须为1至500字符的关键词，limit须为1至20；请收窄查询后重试。");
  const terms = [...new Set(query.toLowerCase().trim().split(/\s+/))];
  const matches = tools.map(tool => {
    const name = tool.name.toLowerCase(), text = `${name} ${tool.description.toLowerCase()}`;
    const score = terms.every(term => text.includes(term)) ? terms.reduce((value, term) => value + (name === term ? 10 : name.includes(term) ? 2 : 1), 0) : 0;
    return { tool, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return { tools: matches.slice(0, limit).map(({ tool }) => ({ name: tool.name, description: tool.description })), total: matches.length };
}

// Note: 见 .agents/notes/implemented/feature/2026-10-25-code-tool-discovery.md
export function createSearchToolsFamily(): HostToolFamily {
  return {
    category: "mcp", names: ["search_tools"], ledger: { names: ["search_tools"], ruleFor: () => "no_effect" },
    build: runtime => [defineTool({
      name: "search_tools", label: "search_tools", executionMode: "sequential",
      description: "按工具名或描述中的关键词搜索延迟注册的 MCP 工具。空格分隔的词须全部匹配；返回命中名称与描述，并在下一次模型请求提供完整参数定义，激活持续到本任务结束。没有命中时改用更短关键词；只搜索当前任务获准的工具，搜索不改变权限。",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500, description: "工具名或描述关键词；空格分隔，全部匹配，最多500字符。" }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最多返回并激活的工具数，默认5，上限20。" })),
      }, { additionalProperties: false }),
      execute: async (sdkCallId, params) => {
        const call = hostCallFor(runtime.call.bindCall, runtime.call.taskContext, sdkCallId);
        try {
          if (!call.context || !runtime.searchTools) throw new ToolSearchError("search_unavailable", "当前任务无法搜索工具；结束本轮并报告拥有者。");
          const result = runtime.searchTools(call.context, params.query, params.limit ?? 5);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
        } finally { call.release(); }
      },
    })],
  };
}
