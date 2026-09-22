import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
/**
 * SDK 会话装配（封闭配置）。
 *
 * 封闭点（对应 issue 01 结论）：
 * - 显式 authPath / modelsPath / modelsStore，不读用户 ~/.pi/agent；
 * - 压缩与自动重试关闭（SettingsManager.inMemory）；
 * - session_before_compact 一律 cancel，阻止非预期摘要；
 * - 仅启用显式登记的工具（tools 白名单），不加载内置编码工具；
 * - 资源发现关闭（noSkills / noPromptTemplates / noThemes），仅注入宿主扩展；
 * - 会话 id 稳定：由宿主生成并持久化，跨重启复用同一 pi session。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Session } from "../core/types.ts";

export interface SessionHostHooks {
  /** tool_call 门（记录执行意图；需要确认时阻塞等待拥有者应答）。 */
  onToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
  /** 会话事件观察（驱动器据此记录片段、结果与落盘引用）。 */
  onSessionEvent(event: AgentSessionEvent): void;
  /** 扩展绑定后注入宿主 API（标记条目等）。 */
  bindHostApi(api: { appendEntry: (customType: string, data: unknown) => void }): void;
  /**
   * 上下文选择钩子（issue 05 §3）：每次模型调用前返回新消息视图。
   * pi 会捕获扩展异常并继续运行，因此实现不得抛错——失败原因由调用方
   * （Driver）保存，最终检查在 streamFunction 包装中阻断发送。
   */
  onContext?(messages: any[]): { messages: any[] } | undefined;
}

export interface CreateSdkSessionOptions {
  session: Session;
  sessionsDir: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: any;
  thinkingLevel: ThinkingLevel;
  tools: ToolDefinition[];
  hooks: SessionHostHooks;
}

export async function createSdkSession(opts: CreateSdkSessionOptions): Promise<AgentSession> {
  const { session, hooks } = opts;

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  let hostApiBound = false;
  const loader = new DefaultResourceLoader({
    cwd: session.cwdReal,
    agentDir: opts.agentDir,
    settingsManager,
    // 封闭运行时：项目内自动发现的扩展/技能/提示词/主题/上下文文件一律不
    // 加载，仅注入上方登记的可信宿主扩展（inline factories 不受这些开关影响）
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "ruukoto-host",
        factory: (pi: any) => {
          pi.on("tool_call", async (event: ToolCallEvent) => hooks.onToolCall(event));
          pi.on("session_before_compact", async () => ({ cancel: true }));
          if (hooks.onContext) {
            pi.on("context", (event: { messages: any[] }) => hooks.onContext!(event.messages));
          }
          hooks.bindHostApi({ appendEntry: (customType, data) => pi.appendEntry(customType, data) });
          hostApiBound = true;
        },
      } as any,
    ],
  } as any);
  await loader.reload();

  const sessionManager = openPiSessionManager(session, opts.sessionsDir);

  const { session: sdkSession } = await createAgentSession({
    cwd: session.cwdReal,
    agentDir: opts.agentDir,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    modelRuntime: opts.modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
    customTools: opts.tools,
    tools: opts.tools.map((t) => t.name),
  });

  sdkSession.subscribe((event) => hooks.onSessionEvent(event));
  if (!hostApiBound) {
    // 静默忽略不可接受：宿主扩展必须成功绑定（标记条目依赖它）
    throw new Error("宿主扩展绑定失败：marker API 不可用");
  }
  return sdkSession;
}

export function openPiSessionManager(session: Session, sessionsDir: string): SessionManager {
  fs.mkdirSync(sessionsDir, { recursive: true });
  if (session.sessionFile && fs.existsSync(session.sessionFile)) {
    return SessionManager.open(session.sessionFile, sessionsDir);
  }
  return SessionManager.create(session.cwdReal, sessionsDir, { id: session.piSessionId });
}

export function sessionsDirFor(dataDir: string): string {
  return path.join(dataDir, "sessions");
}
