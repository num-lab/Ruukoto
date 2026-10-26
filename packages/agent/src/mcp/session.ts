/** 官方 MCP 扩展的产品接线；工具清单和搜索只由 Pi 注册表提供。
 * Note: 见 .agents/notes/implemented/simplification/2026-10-26-mcp-host-responsibilities.md
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as os from "node:os";
import { createMcpExtension, createToolSearchExtension, type ExtensionAPI, type ToolDefinition, type McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import { McpSessionExpiredError, type CallToolResult, type JsonRpcRequest } from "@earendil-works/pi-mcp";
import type { CredentialStore } from "../execution/credentials.ts";
import { isMcpCredential, mcpCredentialDigest } from "./client.ts";
import { createMcpHttpTransport, classifyMcpError, McpError, type ManagedMcpTransport, type McpCallHooks, type McpCallEvidence, type McpTimeouts } from "./transport.ts";
import { allowlistEffectFor, type McpServiceConfig, type McpStore } from "./store.ts";
import { restrictCuaTool, cuaToolEffect } from "./cua.ts";
import { compileMcpSchema, validateRemoteTool } from "./schema.ts";
import type { McpToolInfo } from "./tools.ts";
import type { CodeCuaManager } from "./code.ts";
import type { Task } from "@ruukoto/core/types.ts";
import type { RoutedCallOutput } from "../tool-router.ts";

interface Invocation {
  id: string; meta: McpToolInfo; params: Record<string, unknown>; active: boolean;
  original(params: Record<string, unknown>): Promise<CallToolResult>;
  hooks?: McpCallHooks; evidence: McpCallEvidence;
}
interface Registration { original: ToolDefinition<any, any, any>; wrapped: ToolDefinition<any, any, any>; meta: McpToolInfo; disabled: boolean }
export interface McpSessionOptions extends McpTimeouts {
  store: McpStore; credentials: CredentialStore; cua?: CodeCuaManager;
  task(): Task | null;
  discover(): boolean;
  allow(meta: McpToolInfo): boolean;
  direct(): boolean;
  cuaAllowed(): boolean;
  dispatch(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<RoutedCallOutput>;
  changed(): void;
}
export class McpSession {
  private api: ExtensionAPI | undefined;
  private register: ExtensionAPI["registerTool"] | undefined;
  private readonly registrations = new Map<string, Registration>();
  private readonly published = new Map<string, McpServiceConfig>();
  private readonly calls = new AsyncLocalStorage<Invocation>();
  private readonly transports = new Set<ManagedMcpTransport>();
  private active = 0;
  private readonly activeByService = new Map<string, number>();
  private readonly selections = new Map<string, string>();
  private readonly owners = new Map<ManagedMcpTransport, string>();
  private readonly failures = new Map<string, string>();
  private readonly latest = new Map<string, ManagedMcpTransport>();
  constructor(private readonly opts: McpSessionOptions) {}

  install(pi: ExtensionAPI): void {
    this.api = pi;
    this.register = definition => pi.registerTool(definition);
    const credentials: Pick<NonNullable<McpExtensionOptions["credentials"]>, "forServer" | "tokens" | "remove"> = {
      forServer: () => ({ load: () => undefined, save: () => { throw new McpError("auth_failed", "当前入口不开放 OAuth 凭据保存。"); }, withRefreshLock: fn => fn() }),
      tokens: () => undefined, remove: () => false,
    };
    createMcpExtension({
      startupWaitMs: this.opts.connectTimeoutMs,
      loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
      credentials: credentials as NonNullable<McpExtensionOptions["credentials"]>,
      logPath: os.devNull,
      updateConfig: () => { throw new McpError("configuration_unavailable", "请通过拥有者的 MCP 设置管理服务。"); },
      createTransport: entry => {
        const service = this.published.get(entry.name);
        if (!service) throw new McpError("service_unavailable", "MCP 服务未由宿主发布。");
        const bind = (request: JsonRpcRequest) => {
          const call = this.calls.getStore();
          if (!call?.hooks || call.meta.service.id !== service.id || (request.params as { name?: string } | undefined)?.name !== call.meta.remoteName) throw new McpError("call_unbound", "MCP 原调用身份不符；该请求未发送。");
          return { evidence: call.evidence, hooks: call.hooks, active: () => call.active };
        };
        const transport = service.cua
          ? this.opts.cua!.createTransport(service, this.opts.task()!, bind)
          : createMcpHttpTransport(service.endpoint!, service.credential ? async () => {
            const credential = this.opts.credentials.get(service.credential!);
            if (!isMcpCredential(credential, new URL(service.endpoint!).host)) throw new McpError("auth_failed", "MCP 凭据已撤销或范围不符；该请求未发送。");
            return credential.secret.trim();
          } : undefined, bind);
        this.transports.add(transport);
        this.latest.set(entry.name, transport);
        this.owners.set(transport, entry.name);
        const selected = () => this.latest.get(entry.name) === transport && this.published.get(entry.name)?.id === service.id && this.published.get(entry.name)?.configVersion === service.configVersion;
        transport.onError(error => { if (selected()) this.failures.set(entry.name, classifyMcpError(error).code); });
        transport.onClose(() => {
          if (selected() && ![...this.registrations.values()].some(item => item.meta.exposure !== "hidden" && item.meta.service.id === service.id && item.meta.service.configVersion === service.configVersion)) this.failures.set(entry.name, "connect_failed");
        });
        const send = transport.send.bind(transport);
        transport.send = async (message, options) => {
          try { await send(message, options); }
          catch (error) {
            if (selected() && (!("method" in message) || message.method !== "tools/call")) this.failures.set(entry.name, classifyMcpError(error).code);
            const call = this.calls.getStore();
            if (call && error instanceof McpSessionExpiredError) call.evidence.response = undefined;
            throw error;
          }
        };
        return transport;
      },
    })({ ...pi, registerCommand: () => undefined, registerTool: definition => this.add(definition) });
    createToolSearchExtension()(pi);
    pi.on("session_shutdown", async () => {
      if (this.active) throw new McpError("call_active", "MCP 原调用尚未结束；不能销毁其传输。");
      await Promise.all([...this.transports].map(transport => transport.close()));
      this.transports.clear();
    });
  }

  private add(definition: ToolDefinition<any, any, any>): void {
    if (!definition.name.startsWith("mcp__")) {
      this.register!({ ...definition, exposure: "hidden" });
      return;
    }
    const serviceName = definition.namespace?.aliases?.[0];
    const previous = this.registrations.get(definition.name);
    const service = (definition.exposure === "hidden" ? previous?.meta.service : undefined) ?? (serviceName && this.published.get(serviceName)) ?? previous?.meta.service;
    if (!service || !definition.label.startsWith(`${service.name}/`)) throw new McpError("definition_unbound", "MCP 工具缺少宿主服务归属。");
    const remoteName = definition.label.slice(service.name.length + 1);
    const effect = service.cua ? cuaToolEffect(service.cua, remoteName) : allowlistEffectFor(service.toolAllowlist, remoteName);
    const declaredOutput = (definition.outputSchema as { properties?: { structuredContent?: Record<string, unknown> } } | undefined)?.properties?.structuredContent;
    const raw = { name: remoteName, inputSchema: definition.parameters as Record<string, unknown>, description: definition.description };
    const restricted = service.cua ? restrictCuaTool(service.cua, raw) : raw;
    const validated = restricted && validateRemoteTool(restricted);
    // Pi 将本地 $ref 重定位到结果外壳，校验时必须保留同一根对象。
    const output = declaredOutput && Object.keys(declaredOutput).length ? compileMcpSchema("outputSchema", definition.outputSchema) : undefined;
    const invalidOutput = !!output && ("disabledReason" in output || declaredOutput!.type !== undefined && declaredOutput!.type !== "object");
    const meta: McpToolInfo = {
      service, remoteName, exposedName: definition.name, description: restricted?.description ?? definition.description,
      inputSchema: restricted?.inputSchema ?? raw.inputSchema, rawInputSchema: raw.inputSchema, ...(output && !("disabledReason" in output) ? { checkOutput: (value: unknown) => value !== undefined && output.check({ content: [], structuredContent: value }) } : {}),
      effect: effect ?? "unknown",
      toolSignature: createHash("sha256").update(JSON.stringify([remoteName, restricted?.inputSchema, definition.outputSchema, effect])).digest("hex"),
      exposure: definition.exposure ?? "direct",
    };
    const wrapped: ToolDefinition<any, any, any> = {
      ...definition, parameters: meta.inputSchema, description: meta.description,
      exposure: !effect || !validated || "disabledReason" in validated || invalidOutput || !this.opts.allow(meta) ? "hidden" : definition.exposure,
      execute: (id, rawParams, signal, update, ctx) => {
        const params = rawParams as Record<string, unknown>;
        return this.calls.run({
        id, meta, params, active: true, evidence: {},
        original: async args => {
          const result = await definition.execute(id, args, signal, update, ctx);
          if (!result.structuredContent || typeof result.structuredContent !== "object" || Array.isArray(result.structuredContent)) throw new McpError("result_invalid", "MCP 原结果缺失；请检查原操作，不能重发。");
          return result.structuredContent as unknown as CallToolResult;
        },
      }, async () => {
        this.active++;
        this.activeByService.set(meta.service.name, (this.activeByService.get(meta.service.name) ?? 0) + 1);
        try {
          const out = await this.opts.dispatch(id, params, signal);
          return { content: out.content as import("@earendil-works/pi-ai").ToolResultMessage["content"], details: { ruukotoMcpIsError: out.isError }, ...(out.isError ? { isError: true } : {}) };
        } finally { this.calls.getStore()!.active = false; this.active--; this.activeByService.set(meta.service.name, (this.activeByService.get(meta.service.name) ?? 1) - 1); }
      });
      },
    };
    this.registrations.set(definition.name, { original: definition, wrapped, meta, disabled: !effect || !validated || "disabledReason" in validated || invalidOutput });
    this.register!(wrapped);
    this.opts.changed();
  }

  tools(): McpToolInfo[] {
    const registered = new Set(this.api?.getAllTools().map(tool => tool.name));
    return [...this.registrations.values()].filter(item => !item.disabled && registered.has(item.meta.exposedName) && item.meta.exposure !== "hidden").map(item => item.meta);
  }
  qualify(): void {
    for (const { meta, wrapped, original, disabled } of this.registrations.values()) {
      meta.exposure = this.opts.direct() && original.exposure !== "hidden" ? "direct" : original.exposure ?? "direct";
      const exposure = !disabled && this.opts.allow(meta) ? meta.exposure : "hidden";
      if (wrapped.exposure === exposure) continue;
      wrapped.exposure = exposure;
      this.register!(wrapped);
    }
  }
  async sync(): Promise<void> {
    if (!this.api || !this.opts.discover()) return;
    const exposure = this.opts.direct() ? "direct" : "deferred";
    const services = this.opts.store.listServices().filter(service => service.toolAllowlist.length && (!service.cua || this.opts.cua && this.opts.cuaAllowed()));
    for (const [name] of this.published) if (!services.some(service => service.name === name) && !this.activeByService.get(name)) { this.api.unregisterMcpServer(name); this.published.delete(name); this.latest.delete(name); this.selections.delete(name); }
    for (const service of services) {
      const selection = JSON.stringify([service, service.credential ? mcpCredentialDigest(this.opts.credentials.get(service.credential)) : null, exposure]);
      if (selection === this.selections.get(service.name) || this.activeByService.get(service.name)) continue;
      this.selections.set(service.name, selection);
      this.published.set(service.name, service);
      this.failures.delete(service.name);
      const config = { timeout: (this.opts.callTimeoutMs ?? 60_000) / 1000, enabled: service.enabled, exposure: "hidden" as const, toolExposure: Object.fromEntries(service.toolAllowlist.map(item => [typeof item === "string" ? item : item.name, exposure] as const)) };
      // 选择标记只使 Pi 重注册；受管传输使用原 resolver 和宿主程序，不向 wire 转发标记。
      this.api.registerMcpServer(service.name, service.cua ? { ...config, command: service.cua.executable, args: [], env: { RUUKOTO_MCP_SELECTION: String(service.configVersion) } } : { ...config, url: service.endpoint!, headers: { "x-ruukoto-selection": `${service.configVersion}:${service.credential ? mcpCredentialDigest(this.opts.credentials.get(service.credential)) ?? "missing" : "anonymous"}` } });
    }
    this.qualify();
    for (const transport of this.transports) if (![...this.latest.values()].includes(transport) && !this.activeByService.get(this.owners.get(transport)!)) { await transport.close(); this.transports.delete(transport); this.owners.delete(transport); }
  }
  async ready(): Promise<void> {
    await this.sync();
    const pending = [...this.published.values()].filter(service => service.enabled);
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 15_000) + (this.opts.listTimeoutMs ?? 15_000);
    while (pending.some(service => !this.failures.has(service.name) && ![...this.registrations.values()].some(item => item.meta.exposure !== "hidden" && item.meta.service.id === service.id && item.meta.service.configVersion === service.configVersion)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    this.qualify();
  }
  failure(service: McpServiceConfig): string { return this.failures.get(service.name) ?? "tools_unavailable"; }
  unavailable(): McpServiceConfig[] {
    return [...this.published.values()].filter(service => service.enabled && !this.tools().some(meta => meta.service.id === service.id && meta.service.configVersion === service.configVersion));
  }
  async call(params: Record<string, unknown>, hooks: McpCallHooks): Promise<CallToolResult> {
    const call = this.calls.getStore();
    if (!call) throw new McpError("call_unbound", "MCP 调用缺少官方执行归属；该请求未发送。");
    call.hooks = hooks;
    try { return await call.original(params); } catch (error) {
      const failure = classifyMcpError(error);
      throw failure.requestSent === undefined ? new McpError(failure.code, failure.message, !!call.evidence.request, failure.remoteRejected) : failure;
    }
  }
  evidence(): McpCallEvidence | undefined { return this.calls.getStore()?.evidence; }
}
