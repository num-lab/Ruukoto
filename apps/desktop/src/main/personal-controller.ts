import * as fs from "node:fs";
import * as path from "node:path";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { ControlConnection, type ConnectionConfig } from "@ruukoto/control/connection.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import type { DesktopUpdate } from "../shared/bridge.ts";
import { serializeFailure } from "./controller.ts";
import { personalSocketPath, validatePersonalConfig, type PersonalTargetConfig } from "./personal-config.ts";
import { SshProcess, forwardArgs, forwardFailure, tokenArgs, tokenFailure } from "./personal-ssh.ts";
import { versionRecovery } from "./recovery.ts";

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class PersonalController {
  private connection: ControlConnection | null = null;
  private forward: SshProcess | null = null;
  private reader: SshProcess | null = null;
  private retry: NodeJS.Timeout | null = null;
  private forwardDelay = 500;
  private generation = 0;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  private cleanup: Promise<void> = Promise.resolve();
  private token = "";
  readonly socketPath: string;
  readonly config: PersonalTargetConfig;
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "closed", detail: "尚未连接" };
  constructor(config: PersonalTargetConfig, userData: string, private readonly publish: (update: DesktopUpdate) => void, private readonly env: NodeJS.ProcessEnv = process.env, private readonly deps: { ssh?: string; clientFactory?: ConnectionConfig["clientFactory"] } = {}) {
    this.config = validatePersonalConfig(config, userData);
    this.socketPath = personalSocketPath(userData);
  }
  private current(generation: number): boolean { return !this.stopped && this.generation === generation; }
  private state(update: Extract<DesktopUpdate, { type: "state" }>): void { this.status = update; this.publish(update); }
  private fail(error: unknown): void {
    ++this.generation;
    const failure = serializeFailure(error, this.token);
    this.state({ type: "state", state: "failed", error: failure, detail: failure.message, ...(failure.versions ? { recovery: versionRecovery("personal", failure.versions, false, this.config.controlDir) } : {}) });
    this.cleanup = this.stopResources();
    void this.cleanup.catch(() => { process.stderr.write("[ruukoto:desktop] Personal socket 清理失败；重新连接前请检查应用数据目录权限。\n"); });
  }
  private async stopResources(): Promise<void> {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.connection?.close();
    this.connection = null;
    const reader = this.reader, forward = this.forward;
    await Promise.all([reader?.stop(), forward?.stop()]);
    if (this.reader === reader) this.reader = null;
    if (this.forward === forward) this.forward = null;
    fs.rmSync(this.socketPath, { force: true });
    this.token = "";
  }
  reconnect(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const generation = ++this.generation;
    const previous = this.pending;
    const cleanup = Promise.all([this.cleanup, this.stopResources()]);
    this.pending = (async () => {
      try {
        await cleanup;
        await previous;
        if (!this.current(generation)) return;
        fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
        fs.chmodSync(path.dirname(this.socketPath), 0o700);
        this.state({ type: "state", state: "connecting" });
        this.forwardDelay = 500;
        this.startForward(generation);
        this.connection = new ControlConnection({ socketPath: this.socketPath, token: () => this.readToken(generation), expectedProduct: "ruukoto", clientFactory: this.deps.clientFactory }, {
          onState: (state, detail, error) => {
            if (!this.current(generation)) return;
            if (state === "online") this.forwardDelay = 500;
            if (state === "failed") this.fail(error);
            else this.state({ type: "state", state, detail: this.token ? detail?.replaceAll(this.token, "[令牌已隐藏]") : detail });
          },
          onSnapshot: (result, context) => { if (this.current(generation)) this.publish({ type: "snapshot", result, instanceChanged: context.instanceChanged }); },
          onEvent: (event, kind) => { if (this.current(generation)) this.publish({ type: "event", event, kind }); },
        });
        await this.connection.start();
      } catch (error) {
        // 可重试连接错误已由 ControlConnection 持有；其他初始化失败在此报告。
        if (this.current(generation) && this.status.state !== "reconnecting") this.fail(error);
      }
    })();
    return this.pending;
  }
  private startForward(generation: number): void {
    if (!this.current(generation)) return;
    const forward = new SshProcess(this.deps.ssh ?? "ssh", forwardArgs(this.config, this.socketPath), this.env, false);
    this.forward = forward;
    void forward.done.then(result => {
      if (!this.current(generation)) return;
      this.forward = null;
      const failure = forwardFailure(result.code, result.stderr);
      if (failure) { this.fail(failure); return; }
      const delay = this.forwardDelay;
      this.forwardDelay = Math.min(delay * 2, 8000);
      this.retry = setTimeout(() => { this.retry = null; this.startForward(generation); }, delay);
    }).catch(error => { if (this.current(generation)) this.fail(error); });
  }
  private async readToken(generation: number): Promise<string> {
    if (!this.current(generation)) throw new ControlClientError("ssh_canceled", "连接已关闭", "not_sent");
    const reader = new SshProcess(this.deps.ssh ?? "ssh", tokenArgs(this.config), this.env, true);
    this.reader = reader;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void reader.stop(); }, 15000);
    let result: Awaited<SshProcess["done"]>;
    try { result = await reader.done; }
    finally { clearTimeout(timeout); if (this.reader === reader) this.reader = null; }
    if (timedOut) throw new ControlClientError("ssh_timeout", "SSH 预检与读取令牌超时；正在重试。", "not_sent");
    if (!this.current(generation)) throw new ControlClientError("ssh_canceled", "连接已关闭", "not_sent");
    if (result.code !== 0) throw tokenFailure(result.code, result.stderr);
    this.token = result.stdout.trim();
    if (!this.token) throw tokenFailure(1, "");
    return this.token;
  }
  async request<K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    if (!this.connection || (this.status.state !== "online" && op !== "get_task")) throw new ControlClientError("connection_unavailable", "连接不可用：请求未发送", "not_sent");
    const token = this.token;
    try { return await this.connection.request(op, params); }
    catch (error) {
      const failure = serializeFailure(error, token);
      throw new ControlClientError(failure.code, failure.message, failure.outcome, failure.versions);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    ++this.generation;
    await Promise.all([this.cleanup, this.stopResources(), this.pending]);
    this.state({ type: "state", state: "closed", detail: "已主动关闭" });
  }
}
