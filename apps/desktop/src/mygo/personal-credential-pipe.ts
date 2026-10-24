import { DesktopError } from "../main/environment.ts";
import type { PersonalCredentialStorage } from "../main/personal-credentials.ts";

const unavailable = () => new DesktopError("personal_credentials_unavailable", "安全存储不可用；请解锁钥匙串或检查应用授权后重新打开并核实原凭据。");
const invalid = () => new DesktopError("bridge_invalid", "MyGo 安全存储连接无效；请重新打开应用并核实原操作。");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export class PersonalCredentialPipe implements PersonalCredentialStorage {
  private generation: string | null = null;
  private next = 0;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
  private readonly pending = new Map<number, { resolve(value: string | null): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  constructor(private readonly send: (message: object) => Promise<void>, private readonly timeoutMs = 45000) {
    this.readyTimer = setTimeout(() => this.close(), timeoutMs);
    void this.ready.catch(() => { /* 等待方消费错误；尚无调用时也不能产生未处理拒绝。 */ });
  }
  receive(message: unknown): boolean {
    if (!object(message) || message.kind !== "credential_ready" && message.kind !== "credential_result") return false;
    if (this.closed) return true;
    if (message.v !== 1 || typeof message.generation !== "string" || !/^[0-9a-f]{32}$/.test(message.generation)) throw invalid();
    if (message.kind === "credential_ready") {
      if (this.generation) throw invalid();
      this.generation = message.generation;
      clearTimeout(this.readyTimer);
      this.resolveReady();
      return true;
    }
    if (message.generation !== this.generation || !Number.isSafeInteger(message.id) || Number(message.id) <= 0 || Number(message.id) > this.next || !object(message.result)) throw invalid();
    const result = message.result;
    if (result.ok !== true && result.ok !== false || result.ok === true && result.value !== null && (typeof result.value !== "string" || Buffer.byteLength(result.value) > 65536) || result.ok === false && result.code !== "personal_credentials_unavailable") throw invalid();
    const waiting = this.pending.get(Number(message.id));
    if (!waiting) return true;
    this.pending.delete(Number(message.id));
    clearTimeout(waiting.timer);
    if (result.ok === false) waiting.reject(unavailable());
    else waiting.resolve(result.value as string | null);
    return true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    this.rejectReady(unavailable());
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(unavailable()); }
    this.pending.clear();
  }
  private call(op: "read" | "write" | "remove", value?: string): Promise<string | null> {
    const action = this.queue.then(async () => {
      await this.ready;
      if (this.closed || value !== undefined && Buffer.byteLength(value) > 65536) throw unavailable();
      const id = ++this.next;
      return new Promise<string | null>((resolve, reject) => {
        const timer = setTimeout(() => this.close(), this.timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        void this.send({ kind: "credential_request", v: 1, generation: this.generation, id, op, ...(value === undefined ? {} : { value }) }).catch(() => this.close());
      });
    });
    this.queue = action.then(() => undefined, () => undefined);
    return action;
  }
  read(): Promise<string | null> { return this.call("read"); }
  async write(value: string): Promise<void> { await this.call("write", value); }
  async remove(): Promise<void> { await this.call("remove"); }
}
