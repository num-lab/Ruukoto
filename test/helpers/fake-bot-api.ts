/** 模拟 Bot API：getUpdates 按 offset 返回排队的 update；sendMessage 由 behavior 决定回执。 */
import * as http from "node:http";

export type FakeBotReply = { status: number; body: unknown };

export class FakeBotApi {
  updates: any[] = [];
  sends: any[] = [];
  paths: string[] = [];
  offline = false;
  behavior: (body: any, n: number) => FakeBotReply | Promise<FakeBotReply> = () => ({ status: 200, body: { ok: true, result: { message_id: 1000 + this.sends.length } } });
  private readonly token: string;
  private readonly ownerId: number;
  private server: http.Server;
  private nextUpdate = 1;
  private nextMessage = 1;

  constructor(opts: { token: string; ownerId?: number }) {
    this.token = opts.token;
    this.ownerId = opts.ownerId ?? 42;
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        void (async () => {
          this.paths.push(req.url ?? "");
          const body = raw ? JSON.parse(raw) : {};
          const reply = (r: FakeBotReply) => {
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(JSON.stringify(r.body));
          };
          if (!req.url?.startsWith(`/bot${this.token}/`)) return reply({ status: 401, body: { ok: false, description: "Unauthorized" } });
          if (req.url.endsWith("/getUpdates")) {
            if (this.offline) return reply({ status: 502, body: { ok: false, description: "Bad Gateway" } });
            // 短暂挂起模拟长轮询，避免测试空转
            setTimeout(() => reply({ status: 200, body: { ok: true, result: this.updates.filter((u) => u.update_id >= (body.offset ?? 0)) } }), 30);
            return;
          }
          if (req.url.endsWith("/sendMessage")) {
            this.sends.push(body);
            return reply(await this.behavior(body, this.sends.length));
          }
          reply({ status: 404, body: { ok: false, description: "Not Found" } });
        })().catch(() => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as any).port}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** 推入一条私聊消息 update；返回 message_id（重复投递传入同一 message）。 */
  push(opts: { text?: string; from?: number; chatType?: string; chatId?: number; message?: any; replyTo?: any; forwardOrigin?: any } = {}): any {
    const message = opts.message ?? {
      message_id: this.nextMessage++,
      date: 1_790_000_000,
      chat: { id: opts.chatId ?? opts.from ?? this.ownerId, type: opts.chatType ?? "private" },
      from: { id: opts.from ?? this.ownerId, is_bot: false },
      ...(opts.text !== undefined ? { text: opts.text } : { sticker: { file_id: "x" } }),
      ...(opts.replyTo ? { reply_to_message: opts.replyTo } : {}),
      ...(opts.forwardOrigin !== undefined ? { forward_origin: opts.forwardOrigin } : {}),
    };
    this.updates.push({ update_id: this.nextUpdate++, message });
    return message;
  }
}
