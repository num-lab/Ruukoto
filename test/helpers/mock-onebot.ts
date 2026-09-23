/**
 * 进程内模拟 OneBot v11 正向 WebSocket 服务（issue 07 测试；模拟 NapCat 侧）。
 *
 * - token 鉴权（Authorization: Bearer 头，错误即关闭 4401）；
 * - get_login_info 返回可配置账号；send_group_msg 记录参数并按注入行为应答
 *   （成功/平台明确失败/不应答=结果不明/延迟乱序）；
 * - 服务端可向客户端推送群消息与撤回事件；可主动断开连接模拟掉线。
 * 测试不得向真实 QQ/NapCat 发送消息——本服务只监听回环随机端口。
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export const MOCK_QQ_SECRET = "qq-onebot-test-secret-3c7d1f";
export const MOCK_QQ_ACCOUNT = "990001";

export interface MockOneBotAction {
  action: string;
  params: Record<string, unknown>;
}

/** send_group_msg 的行为注入：ok=正常返回 message_id；fail=平台明确失败（retcode≠0）；silent=不应答（客户端超时=结果不明）。 */
export type MockSendBehavior = "ok" | "fail" | "silent";

export interface MockOneBot {
  url: string;
  host: string;
  /** 收到的动作调用（按到达顺序）。 */
  actions: MockOneBotAction[];
  /** 已建立的连接数（重连断言用）。 */
  connectionCount(): number;
  /** 向全部在线客户端推送事件（群消息/撤回等）。 */
  pushEvent(event: Record<string, unknown>): void;
  /** 推送群消息的便捷构造（结构化消息段数组）。 */
  pushGroupMessage(input: { groupId: string; userId: string; messageId: number; segments: unknown[]; senderName?: string; time?: number }): void;
  /** 推送群撤回事件。 */
  pushRecall(input: { groupId: string; messageId: number; userId?: string | number }): void;
  /** 主动断开全部连接（模拟账号掉线/服务端故障）。 */
  dropConnections(): void;
  /** send_group_msg 应答行为（可运行期切换）。 */
  setSendBehavior(behavior: MockSendBehavior): void;
  /** send_group_msg 应答延迟（乱序/积压场景；0=立即）。 */
  setSendDelayMs(ms: number): void;
  close(): Promise<void>;
}

export async function startMockOneBot(opts: {
  secret?: string | null;
  /** get_login_info 返回的账号（默认 MOCK_QQ_ACCOUNT；用于身份不匹配场景）。 */
  account?: string;
}): Promise<MockOneBot> {
  const secret = opts.secret === undefined ? MOCK_QQ_SECRET : opts.secret;
  const account = opts.account ?? MOCK_QQ_ACCOUNT;
  const actions: MockOneBotAction[] = [];
  const sockets = new Set<WebSocket>();
  let sendBehavior: MockSendBehavior = "ok";
  let sendDelayMs = 0;
  let sentMessageId = 900000;

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const port = (wss.address() as AddressInfo).port;

  wss.on("connection", (ws, req) => {
    if (secret !== null && req.headers.authorization !== `Bearer ${secret}`) {
      ws.close(4401, "unauthorized");
      return;
    }
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const action = typeof msg.action === "string" ? msg.action : null;
      if (!action) return;
      const echo = msg.echo;
      actions.push({ action, params: (msg.params ?? {}) as Record<string, unknown> });
      const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ ...body, echo }));
      if (action === "get_login_info") {
        reply({ status: "ok", retcode: 0, data: { user_id: Number(account), nickname: "mock-bot" } });
        return;
      }
      if (action === "send_group_msg") {
        const respond = () => {
          if (sendBehavior === "silent") return; // 不应答：客户端超时 → 结果不明
          if (sendBehavior === "fail") {
            reply({ status: "failed", retcode: 100, msg: "SEND_FAILED", wording: "模拟平台明确失败" });
            return;
          }
          reply({ status: "ok", retcode: 0, data: { message_id: ++sentMessageId } });
        };
        if (sendDelayMs > 0) setTimeout(respond, sendDelayMs);
        else respond();
        return;
      }
      // 其他动作（心跳探测等）：通用成功
      reply({ status: "ok", retcode: 0, data: {} });
    });
  });

  const pushEvent = (event: Record<string, unknown>): void => {
    const frame = JSON.stringify(event);
    for (const ws of sockets) ws.send(frame);
  };

  return {
    url: `ws://127.0.0.1:${port}/`,
    host: `127.0.0.1:${port}`,
    actions,
    connectionCount: () => sockets.size,
    pushEvent,
    pushGroupMessage(input) {
      pushEvent({
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        self_id: Number(account),
        group_id: Number(input.groupId),
        user_id: Number(input.userId),
        message_id: input.messageId,
        message: input.segments,
        sender: { nickname: input.senderName ?? `user-${input.userId}`, card: "" },
        time: input.time ?? Math.floor(Date.now() / 1000),
      });
    },
    pushRecall(input) {
      pushEvent({
        post_type: "notice",
        notice_type: "group_recall",
        self_id: Number(account),
        group_id: Number(input.groupId),
        user_id: input.userId ?? 0,
        operator_id: input.userId ?? 0,
        message_id: input.messageId,
        time: Math.floor(Date.now() / 1000),
      });
    },
    dropConnections() {
      for (const ws of sockets) ws.terminate();
    },
    setSendBehavior: (b) => {
      sendBehavior = b;
    },
    setSendDelayMs: (ms) => {
      sendDelayMs = ms;
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
