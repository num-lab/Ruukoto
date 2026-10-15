/**
 * 控制面测试替身（架构工单 07）：实现 ControlTransport，接在真实 ControlConnection 下，
 * 重连、缺口重同步与认证失败的处理照常走真实代码。
 *
 * 不模拟后台状态：应答由测试按 op 设定（按 op 表定类型），未设定的 op 按明确拒绝；
 * 断线时在途请求一并失败，并通知断线监听者（与真实客户端一致）。
 */

import { ControlClientError, type ClientCloseInfo, type ControlTransport } from "@ruukoto/control/client.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";

/** 应答函数；第二个参数是收到请求的实例（可在应答前 drop 模拟断线）。 */
export type FakeHandlers = { [K in TuiOp]?: (params: OpParams<K>, transport: FakeTransport) => OpResult<K> | Promise<OpResult<K>> };

export interface FakeScript {
  /** 默认返回 seq 0 的空快照。 */
  handshake?(since: number | undefined, transport: FakeTransport): Promise<ConnectResult> | ConnectResult;
  authenticate?(transport: FakeTransport): Promise<void>;
  handlers?: FakeHandlers;
}

export function fakeSnapshot(overrides: Partial<ConnectResult["snapshot"]> = {}): ConnectResult["snapshot"] {
  return {
    product: "ruukoto-code",
    projects: [],
    sessions: [],
    tasks: [],
    confirmations: [],
    artifacts: [],
    previews: {},
    instanceId: "inst-1",
    execution: { backend: "local", note: "local 执行后端：无隔离" },
    defaultModel: { provider: "mock", id: "mock-model", name: "Mock", thinkingLevel: "off" },
    ...overrides,
  };
}

export class FakeTransport implements ControlTransport {
  readonly requests: Array<{ op: TuiOp; params: unknown }> = [];
  private readonly eventListeners = new Set<(event: PersistentEvent) => void>();
  private readonly closeListeners = new Set<(info: ClientCloseInfo) => void>();
  private readonly inflight = new Set<(err: Error) => void>();
  private closed = false;

  constructor(private readonly script: FakeScript) {}

  get isClosed(): boolean {
    return this.closed;
  }

  async authenticate(): Promise<void> {
    await this.script.authenticate?.(this);
  }

  async handshake(since?: number): Promise<ConnectResult> {
    return this.script.handshake ? this.script.handshake(since, this) : { seq: 0, replay: [], snapshot: fakeSnapshot() };
  }

  onEvent(listener: (event: PersistentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: (info: ClientCloseInfo) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request<K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    if (this.closed) return Promise.reject(new ControlClientError("closed", "客户端已关闭", "not_sent"));
    this.requests.push({ op, params });
    const handler = this.script.handlers?.[op] as ((p: OpParams<K>, t: FakeTransport) => OpResult<K> | Promise<OpResult<K>>) | undefined;
    return new Promise<OpResult<K>>((resolve, reject) => {
      this.inflight.add(reject);
      const settle = <V>(fn: (v: V) => void) => (v: V) => {
        if (this.inflight.delete(reject)) fn(v);
      };
      Promise.resolve()
        .then(() => (handler ? handler(params, this) : Promise.reject(new ControlClientError("unknown_op", `替身未设定：${op}`, "rejected"))))
        .then(settle(resolve), settle(reject));
    });
  }

  close(): void {
    this.terminate("closed", "客户端主动关闭");
  }

  /** 推送实时事件。 */
  emit(event: PersistentEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  /** 模拟断线：在途请求失败，通知断线监听者。 */
  drop(code = "connection_closed", message = "连接已关闭"): void {
    this.terminate(code, message);
  }

  private terminate(code: string, message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const reject of this.inflight) reject(new ControlClientError(code, message, "disconnected"));
    this.inflight.clear();
    for (const listener of this.closeListeners) listener({ code, message });
  }
}

/** 每次建连给出一个新实例，共用同一份脚本；transports 按建连顺序排列。 */
export function fakeControl(script: FakeScript = {}) {
  const transports: FakeTransport[] = [];
  return {
    transports,
    factory: async (): Promise<ControlTransport> => {
      const transport = new FakeTransport(script);
      transports.push(transport);
      return transport;
    },
  };
}
