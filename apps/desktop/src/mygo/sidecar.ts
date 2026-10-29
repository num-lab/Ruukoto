import * as readline from "node:readline";
import { PersonalCredentialPipe } from "./personal-credential-pipe.ts";
import type { DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import type { DesktopBrowserEvent } from "@ruukoto/control/protocol.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { DesktopHost } from "../main/host.ts";
import { ipcResult } from "../main/ipc.ts";
import { DesktopError } from "../main/environment.ts";
import type { DesktopNotice } from "../main/notifications.ts";
import type { MyGoBrowserTransport } from "../main/browser-bridge.ts";

declare const __RUUKOTO_REPOSITORY__: string;
const userData = process.argv[2];
if (!userData) throw new DesktopError("user_data_missing", "MyGo 应用数据目录不可用；请重新构建应用。");
let focused = false;
let closing: Promise<void> | null = null;
const send = (message: object): Promise<void> => new Promise((resolve, reject) => { process.stdout.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve()); });

/**
 * Node→Go 窄请求（mygo-agent-browser）：控制面 browser_command 经此转到 Go
 * 侧 browser.Manager。pending 绑定请求 id；超时按效果未知（命令可能已执行），
 * 关闭按 not_sent/disconnected——与 Go 侧同一失败分类，不静默重发。
 */
const goPending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
let goSeq = 0;
function goRequest(method: string, ...args: unknown[]): Promise<unknown> {
  if (closing) return Promise.reject(new DesktopError("bridge_closed", "MyGo 正在退出；请重新打开应用后核实原操作。"));
  const id = ++goSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (goPending.delete(id)) reject(new ControlClientError("bridge_timeout", "MyGo 请求未能取得应答，效果未知；请核实页面状态。", "unknown"));
    }, 60_000);
    goPending.set(id, { resolve, reject, timer });
    void send({ kind: "request", id, method, args }).catch(error => {
      clearTimeout(timer);
      if (goPending.delete(id)) reject(new ControlClientError("bridge_disconnected", "MyGo 连接不可用，请重新打开应用后核实原操作。", "not_sent"));
    });
  });
}
function goResponse(message: { id?: unknown; result?: unknown }): void {
  const pending = typeof message.id === "number" ? goPending.get(message.id) : undefined;
  if (!pending) return;
  goPending.delete(message.id as number);
  clearTimeout(pending.timer);
  pending.resolve(message.result);
}
const browserTransport: MyGoBrowserTransport = {
  command: (op, input) => goRequest("browser_command", { op, ...input }),
};
const credentials = new PersonalCredentialPipe(send);
const platform = {
  credentials,
  publish: (target: DesktopTarget, update: DesktopUpdate) => send({ kind: "update", target, update }),
  focused: () => focused,
  notice: (notice: DesktopNotice) => { void send({ kind: "notice", notice }).catch(() => { process.stderr.write("[ruukoto:desktop] MyGo 通知未送达，请重新打开应用。\n"); }); },
  badge: (count: number) => { void send({ kind: "badge", count }).catch(() => { process.stderr.write("[ruukoto:desktop] MyGo 角标未送达，请重新打开应用。\n"); }); },
};
const host = new DesktopHost(__RUUKOTO_REPOSITORY__, userData, platform, undefined, undefined, browserTransport);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function close(): Promise<void> {
  credentials.close();
  for (const [id, pending] of goPending) {
    goPending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new ControlClientError("bridge_disconnected", "MyGo 连接已关闭；请重新打开应用，原操作结果仍需核实。", "disconnected"));
  }
  closing ??= host.close().catch(() => { process.stderr.write("[ruukoto:desktop] MyGo 子进程清理失败；请检查 Personal 连接和应用数据目录权限。\n"); process.exitCode = 1; });
  return closing;
}
async function receive(line: string): Promise<void> {
  let message: unknown;
  try { message = JSON.parse(line); }
  catch { throw new DesktopError("bridge_invalid", "MyGo 子进程消息损坏；请重新打开应用并核实原操作。"); }
  if (credentials.receive(message)) return;
  if (message && typeof message === "object" && (message as { kind?: unknown }).kind === "response") {
    goResponse(message as { id?: unknown; result?: unknown });
    return;
  }
  if (!message || typeof message !== "object" || !("id" in message) || !Number.isSafeInteger(message.id) || !("method" in message) || typeof message.method !== "string" || !("args" in message) || !Array.isArray(message.args)) throw new DesktopError("bridge_invalid", "MyGo 子进程消息无效；请重新打开应用并核实原操作。");
  const { id, method, args } = message;
  const result = await ipcResult(async () => {
    if (closing) throw new DesktopError("bridge_closed", "MyGo 正在退出；请重新打开应用后核实原操作。");
    switch (method) {
      case "subscribe": return host.subscribe(args[0]);
      case "terminal_reset": return host.resetTerminals();
      case "request": return host.request(args[0], args[1], args[2]);
      case "attachment_instance": return host.attachmentInstance(args[0] ?? "code");
      case "attachments": {
        const files: unknown = args[1];
        if (!Array.isArray(files) || files.some(file => typeof file !== "string") || typeof args[2] !== "string") throw new DesktopError("invalid_params", "所选附件无效；请重新选择。");
        return host.pickAttachments(args[0], async () => files as string[], args[2], args[3] ?? "code");
      }
      case "draft_pick": {
        const files: unknown = args[0];
        if (!Array.isArray(files) || files.some(file => typeof file !== "string")) throw new DesktopError("invalid_params", "所选附件无效；请重新选择。");
        return host.pickDraftAttachments(async () => files as string[]);
      }
      case "draft_upload": return host.uploadDraftAttachments(args[0], args[1], args[2] ?? "code");
      case "focus": focused = args[0] === true; return;
      case "browser_event": return host.browserEvent(args[0] as DesktopBrowserEvent);
      case "navigate": return host.navigate(args[0] as DesktopNotice);
      case "close": return close();
      default: throw new DesktopError("op_not_allowed", "此操作未向 MyGo 开放。");
    }
  });
  // request 已沿用控制面结果，不能再包一层，否则 renderer 会丢失失败分类。
  await send({ kind: "result", id, result: method === "request" && result.ok ? result.value : result });
}
input.on("line", line => {
  if (Buffer.byteLength(line) > 16 * 1024 * 1024) { process.stderr.write("[ruukoto:desktop] MyGo 消息超限，正在关闭连接；请重新打开应用并核实原操作。\n"); input.close(); process.stdin.destroy(); return; }
  void receive(line).catch(() => { process.stderr.write("[ruukoto:desktop] MyGo 消息不可解析，正在关闭连接；请重新打开应用并核实原操作。\n"); input.close(); process.stdin.destroy(); });
});
input.on("close", () => { void close(); });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { input.close(); process.stdin.destroy(); void close(); });
process.stdout.on("error", () => { input.close(); process.stdin.destroy(); void close(); });
