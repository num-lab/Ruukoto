import type { SessionDefaultMode } from "@ruukoto/core/types.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import { ViewState as SharedViewState, type SessionView } from "@ruukoto/view/state.ts";
import type { CommandEntry } from "@ruukoto/view/event-flow.ts";
import type { CommandHistoryStore } from "./command-history.ts";

export * from "@ruukoto/view/state.ts";

/** TUI 持有命令回显的持久化与失败提示，共享投影只保存内存条目。 */
export class ViewState extends SharedViewState {
  private commandCounter = 0;
  private unsavedCommands = new Set<string>();

  constructor(private readonly commandHistory?: CommandHistoryStore) { super(); }

  override applySnapshot(result: ConnectResult, instanceChanged: boolean): void {
    if (instanceChanged) this.unsavedCommands.clear();
    super.applySnapshot(result, instanceChanged);
    for (const view of this.sessionViews.values()) {
      if (this.sessions.some((session) => session.id === view.sessionId)) this.restoreCommands(view);
    }
  }

  override openSession(sessionId: string): SessionView {
    const existed = this.sessionViews.has(sessionId);
    const view = super.openSession(sessionId);
    if (!existed) this.restoreCommands(view);
    return view;
  }

  echoCommand(sessionId: string | null, line: string): string | null {
    if (!sessionId) return null;
    const view = this.openSession(sessionId);
    const key = `command:${globalThis.crypto.randomUUID()}`;
    const command = view.flow.command(key, line, ++this.commandCounter);
    this.saveCommand(sessionId, command);
    return key;
  }

  setCommandResult(sessionId: string, key: string | null, text: string, isError = false): void {
    const view = this.openSession(sessionId);
    let command = key ? view.flow.commandResult(key, text, isError) : null;
    if (key && !command) {
      // 另一客户端可先提交命令；持久关联到达后补读该命令，再写原结果。
      this.restoreCommands(view);
      command = view.flow.commandResult(key, text, isError);
    }
    if (command) this.saveCommand(sessionId, command);
    else this.note(sessionId, text);
  }

  private restoreCommands(view: SessionView): void {
    if (!this.commandHistory || !this.instanceId) return;
    let commands: CommandEntry[];
    try {
      commands = this.commandHistory.load(this.instanceId, view.sessionId);
    } catch (err) {
      this.note(view.sessionId, `命令历史读取失败：${(err as Error).message}`);
      return;
    }
    // 其他客户端可能已补写结果；仅保存失败的本地记录优先于旧存储。
    view.flow.installCommands(commands.filter((command) => !this.unsavedCommands.has(command.key)));
    for (const command of commands) this.commandCounter = Math.max(this.commandCounter, command.seq);
  }

  private saveCommand(sessionId: string, command: CommandEntry): void {
    if (!this.commandHistory || !this.instanceId) return;
    try {
      this.commandHistory.save(this.instanceId, sessionId, command);
    } catch (err) {
      this.unsavedCommands.add(command.key);
      this.note(sessionId, `命令历史保存失败：${(err as Error).message}`);
      return;
    }
    this.unsavedCommands.delete(command.key);
  }
}

/**
 * 模式名的着色（左下角状态栏）。返回样式函数，调用方决定包裹范围。
 * 颜色只在状态栏用，不进入 /mode 列表与事件文案（那些地方靠文字区分）。
 */
export function accessModeStyle(mode: SessionDefaultMode): (s: string) => string {
  switch (mode) {
    case "plan":
    case "auto-review":
      return (s) => `\x1b[38;5;75m${s}\x1b[0m`; // 蓝：自动审查
    case "full_access":
      return (s) => `\x1b[38;5;214m${s}\x1b[0m`; // 橙黄：完全访问
    default:
      return (s) => s; // 请求确认：默认前景色
  }
}
