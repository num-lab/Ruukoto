import * as readline from "node:readline";
import { DesktopHost } from "../main/host.ts";
import { ipcResult } from "../main/ipc.ts";
import { DesktopError } from "../main/environment.ts";
import type { DesktopNotice } from "../main/notifications.ts";

declare const __RUUKOTO_REPOSITORY__: string;
const userData = process.argv[2];
if (!userData) throw new DesktopError("user_data_missing", "MyGo 应用数据目录不可用；请重新构建应用。");
let focused = false;
const send = (message: object): Promise<void> => new Promise((resolve, reject) => { process.stdout.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve()); });
const host = new DesktopHost(__RUUKOTO_REPOSITORY__, userData, {
  publish: (target, update) => send({ kind: "update", target, update }),
  focused: () => focused,
  notice: notice => { void send({ kind: "notice", notice }).catch(() => { process.stderr.write("[ruukoto:desktop] MyGo 通知未送达，请重新打开应用。\n"); }); },
  badge: count => { void send({ kind: "badge", count }).catch(() => { process.stderr.write("[ruukoto:desktop] MyGo 角标未送达，请重新打开应用。\n"); }); },
});
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let closing: Promise<void> | null = null;
function close(): Promise<void> {
  closing ??= host.close().catch(() => { process.stderr.write("[ruukoto:desktop] MyGo 子进程清理失败；请检查 Personal 连接和应用数据目录权限。\n"); process.exitCode = 1; });
  return closing;
}
async function receive(line: string): Promise<void> {
  let message: unknown;
  try { message = JSON.parse(line); }
  catch { throw new DesktopError("bridge_invalid", "MyGo 子进程消息损坏；请重新打开应用并核实原操作。"); }
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
