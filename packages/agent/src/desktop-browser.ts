import type { Store } from "@ruukoto/core/store.ts";
import { CodeScheduleError, getCodeScheduledTaskSource } from "@ruukoto/core/code-scheduler.ts";
import { randomId, type Task } from "@ruukoto/core/types.ts";

// 桌面浏览器宿主：MyGo 右栏原生页面在 Runtime 侧的句柄。
// 与 browser-manager（TUI Chrome）独立：页面生命周期归桌面进程，
// 这里只跟踪控制面上行事件投影的页面状态、按页串行下发命令，
// 并实现接管/交还的等待屏障。
// Note: 见 .agents/notes/proposed/feature/2026-10-29-mygo-agent-browser.md

export class DesktopBrowserError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly effectUnknown = false,
  ) { super(message); this.name = "DesktopBrowserError"; }
}

/** 控制面 `desktop_browser_event` 上行的页面事实（Go 侧 browser.Event 的 JSON 形）。 */
export interface DesktopBrowserEvent {
  kind: string;
  session: string;
  url?: string;
  title?: string;
  owned?: boolean;
  generation?: number;
  source?: string;
}

export interface DesktopBrowserState {
  generation: number;
  owned: boolean;
  gone: boolean;
  /** 交还后待消费的观察要求：闸门 owned false→true 时置位，Driver 边界消费。 */
  pendingReturn?: boolean;
  /** 是否真见过拥有者持有闸门（gate owned:false 事件），区别于状态缺省值。 */
  heldSeen?: boolean;
  url?: string;
  title?: string;
}

export interface DesktopBrowserObservation {
  observationId: string;
  generation: number;
  url?: string;
  title?: string;
  text: string;
}

type CallFn = (connectionId: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

interface WireResult {
  ok: boolean;
  value?: { value?: Record<string, unknown>; generation?: number; transfer?: { kind: string; data: Buffer } };
  error?: { code: string; outcome?: string; message: string };
}

export interface DesktopBrowserCommandResult {
  value: Record<string, unknown>;
  generation?: number;
  /** 分块装配后的传输字节（截图）；服务端已按声明校验 sha256 与完整度。 */
  transfer?: { kind: string; data: Buffer };
}

/** 交还后的 DOM 观察脚本：返回截断标注的页面正文摘要；不写元素引用（模型再取 snapshot 才有 ref）。 */
const OBSERVE_SCRIPT = `(() => {
  const main = document.querySelector("main") ?? document.body;
  let text = (main?.innerText ?? "").replace(/\\s+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
  const limit = 12000; let truncated = false;
  if (text.length > limit) { text = text.slice(0, limit); truncated = true; }
  return JSON.stringify({ url: location.href, title: document.title, text, truncated });
})()`;

export class DesktopBrowserManager {
  private readonly states = new Map<string, DesktopBrowserState>();
  private readonly waiters = new Map<string, Set<(s: DesktopBrowserState) => void>>();
  private readonly tails = new Map<string, Promise<void>>();
  /** 会话内最近一次模型快照的引用集合，按 (任务绑定键) 与页面代次绑定。 */
  private readonly snapshots = new Map<string, { generation: number; refs: Set<string> }>();

  constructor(private readonly deps: { store: Store; call: () => CallFn | null }) {}

  /** 资格 = 持久化 MyGo 来源绑定 + dev 会话 + 完全访问 + 非 Plan/SubAgent/定时后代。 */
  eligible(task: Task): boolean {
    if (!this.deps.store.getTaskBrowserBinding(task.id)) return false;
    if (this.deps.store.getSessionIdentity(task.sessionId)?.kind !== "dev") return false;
    try {
      const scheduled = getCodeScheduledTaskSource(this.deps.store, task.id);
      return task.accessMode === "full_access" && !task.planMode && !task.parentTaskId && !task.subAgentId && scheduled === null;
    } catch (error) {
      if (!(error instanceof CodeScheduleError)) throw error;
      return false;
    }
  }

  binding(task: Task): { connectionId: string } | null {
    return this.deps.store.getTaskBrowserBinding(task.id);
  }

  private key(task: Task, binding?: { connectionId: string } | null): string | null {
    const b = binding ?? this.binding(task);
    return b ? `${b.connectionId}|${task.sessionId}` : null;
  }

  state(task: Task): DesktopBrowserState | null {
    const k = this.key(task);
    return k ? this.states.get(k) ?? null : null;
  }

  /** 上行页面事件投影本地状态；代次翻转作废快照引用，闸门翻转或页面消亡释放等待。 */
  onEvent(connectionId: string, event: DesktopBrowserEvent): void {
    const k = `${connectionId}|${event.session}`;
    const prev = this.states.get(k);
    const next: DesktopBrowserState = {
      generation: event.generation ?? prev?.generation ?? 0,
      owned: prev?.owned ?? false,
      gone: prev?.gone ?? false,
      pendingReturn: prev?.pendingReturn,
      heldSeen: prev?.heldSeen,
      url: event.url ?? prev?.url,
      title: event.title ?? prev?.title,
    };
    if (event.kind === "gate") {
      next.owned = event.owned === true;
      if (!next.owned) next.heldSeen = true;
      else { if (prev?.heldSeen === true) next.pendingReturn = true; next.heldSeen = false; }
    }
    if (event.kind === "gone" || event.kind === "closed") { next.gone = true; next.owned = false; }
    if (prev && prev.generation !== next.generation) this.snapshots.delete(k);
    this.states.set(k, next);
    if (next.owned || next.gone) {
      const ws = this.waiters.get(k);
      if (ws) { this.waiters.delete(k); for (const w of ws) w(next); }
    }
  }

  /** 桌面浏览器连接断开：该连接所有页面视为消亡并释放等待。 */
  onDisconnect(connectionId: string): void {
    const prefix = `${connectionId}|`;
    for (const [k, s] of this.states) {
      if (!k.startsWith(prefix) || s.gone) continue;
      s.gone = true; s.owned = false;
      const ws = this.waiters.get(k);
      if (ws) { this.waiters.delete(k); for (const w of ws) w(s); }
    }
  }

  /** 消费一次待观察的交还；返回消费到的页面代次，无待观察返回 null。 */
  takePendingReturn(task: Task): { generation: number } | null {
    const st = this.state(task);
    if (!st?.pendingReturn) return null;
    st.pendingReturn = false;
    return { generation: st.generation };
  }

  /** 会话清理：页面归桌面进程，这里只丢本地投影、引用与等待。 */
  forgetSession(sessionId: string): void {
    for (const [k, s] of this.states) {
      if (!k.endsWith(`|${sessionId}`)) continue;
      const ws = this.waiters.get(k);
      if (ws) { this.waiters.delete(k); for (const w of ws) w(s); }
    }
    for (const k of [...this.snapshots.keys()]) if (k.endsWith(`|${sessionId}`)) this.snapshots.delete(k);
  }

  /**
   * 接管等待：闸门回到 Agent 持有（resolve released）、页面消亡（gone）、
   * 或停止回调成立（stopped）。取消优先，且只解除等待不发出任何动作。
   */
  awaitGate(task: Task, stopped: () => boolean): Promise<"released" | "gone" | "stopped"> {
    const k = this.key(task);
    if (!k) return Promise.resolve("stopped");
    const st = this.states.get(k);
    if (!st || st.gone) return Promise.resolve("gone");
    if (st.owned) return Promise.resolve("released");
    return new Promise(resolve => {
      const waiter = (s: DesktopBrowserState) => {
        clearInterval(iv);
        resolve(s.gone ? "gone" : "released");
      };
      const iv = setInterval(() => {
        if (!stopped()) return;
        clearInterval(iv);
        this.waiters.get(k)?.delete(waiter);
        resolve("stopped");
      }, 25);
      let set = this.waiters.get(k);
      if (!set) { set = new Set(); this.waiters.set(k, set); }
      set.add(waiter);
      // 事件可能落在 owned 检查与登记之间：登记后复查，避免永久等待。
      const cur = this.states.get(k);
      if (cur && (cur.owned || cur.gone)) { this.waiters.get(k)?.delete(waiter); clearInterval(iv); resolve(cur.gone ? "gone" : "released"); }
    });
  }

  /** 快照引用校验：引用须来自当前页面代次的一次成功 snapshot。 */
  requireRef(task: Task, ref: string): void {
    const k = this.key(task);
    const st = k ? this.states.get(k) : null;
    const snap = k ? this.snapshots.get(k) : null;
    if (!st || st.gone) throw new DesktopBrowserError("disconnected", "页面不可用；请 status 核实后重开");
    if (!snap || snap.generation !== st.generation || !snap.refs.has(ref)) {
      throw new DesktopBrowserError("stale_ref", "引用未由当前页面代次的 snapshot 提供；请重新取快照");
    }
  }

  noteSnapshot(task: Task, generation: number, refs: Iterable<string>): void {
    const k = this.key(task);
    if (k) this.snapshots.set(k, { generation, refs: new Set(refs) });
  }

  /** 串行执行页面命令：发送边界复核闸门，接管中先等交还，拒绝旧代次重放。 */
  async command(task: Task, op: string, input: Record<string, unknown>, opts: { timeoutMs?: number; stopped?: () => boolean } = {}): Promise<DesktopBrowserCommandResult> {
    const binding = this.binding(task);
    if (!binding) throw new DesktopBrowserError("not_bound", "任务没有 MyGo 浏览器来源");
    const k = `${binding.connectionId}|${task.sessionId}`;
    const stopped = opts.stopped ?? (() => false);
    const run = (this.tails.get(k) ?? Promise.resolve()).then(() => this.execute(k, binding.connectionId, task, op, input, opts.timeoutMs ?? 55_000, stopped));
    this.tails.set(k, run.then(() => undefined, () => undefined));
    return run;
  }

  private async execute(k: string, connectionId: string, task: Task, op: string, input: Record<string, unknown>, timeoutMs: number, stopped: () => boolean): Promise<DesktopBrowserCommandResult> {
    let st = this.states.get(k);
    // status/open 不过闸门：status 是探针本身（如实回传 owned:false 的接管态），open 允许页面不存在。
    if (op !== "status" && op !== "open") {
      if (!st || st.gone) throw new DesktopBrowserError("disconnected", "页面已关闭或连接断开");
      if (!st.owned) {
        const outcome = await this.awaitGate(task, stopped);
        if (outcome === "stopped") throw new DesktopBrowserError("canceled", "任务已停止，浏览器动作未发送");
        st = this.states.get(k);
        if (!st || st.gone) throw new DesktopBrowserError("disconnected", "等待交还期间页面已关闭或连接断开");
      }
    }
    if (stopped()) throw new DesktopBrowserError("canceled", "任务已停止，浏览器动作未发送");
    const call = this.deps.call();
    if (!call) throw new DesktopBrowserError("unavailable", "桌面浏览器连接不可用");
    const wire = await call(connectionId, { op, session: task.sessionId, generation: input.generation ?? st?.generation ?? 0, ...input }, timeoutMs).catch(error => {
      throw new DesktopBrowserError("outcome_unknown", `命令效果未知：${(error as Error).message}`, true);
    }) as WireResult;
    if (!wire || typeof wire !== "object") throw new DesktopBrowserError("outcome_unknown", "命令效果未知：响应缺失", true);
    if (!wire.ok) {
      const err = wire.error ?? { code: "rejected", outcome: "rejected", message: "命令被拒绝" };
      const outcome = err.outcome ?? "rejected";
      // unknown/disconnected 都可能已越过发送点，按效果未知记，不静默重试。
      throw new DesktopBrowserError(err.code, `${err.message}（${err.code}）`, outcome === "unknown" || outcome === "disconnected");
    }
    const value = wire.value ?? {};
    const latest = this.states.get(k);
    if (typeof value.generation === "number" && latest && value.generation !== latest.generation) {
      latest.generation = value.generation;
      this.snapshots.delete(k);
    }
    return { value: value.value ?? {}, generation: value.generation, transfer: value.transfer as DesktopBrowserCommandResult["transfer"] };
  }

  /** 交还后的宿主自动观察：DOM 正文摘要，供会话 marker 与参考块投影。 */
  async observe(task: Task): Promise<DesktopBrowserObservation> {
    const data = await this.command(task, "eval", { script: OBSERVE_SCRIPT });
    let parsed: { url?: string; title?: string; text?: string; truncated?: boolean };
    try { parsed = JSON.parse(String(data.value ?? "")); }
    catch { throw new DesktopBrowserError("invalid_response", "观察脚本未返回可解析结果"); }
    const st = this.state(task);
    const text = parsed.text ?? "";
    return {
      observationId: randomId("obs"),
      generation: st?.generation ?? 0,
      url: parsed.url ?? st?.url,
      title: parsed.title ?? st?.title,
      text: parsed.truncated ? `${text}\n…（正文截断）` : text,
    };
  }
}
