import type { DesktopResult } from "../shared/bridge.ts";
import { DesktopError } from "./environment.ts";
import { serializeFailure } from "./controller.ts";

export async function ipcResult<T>(action: () => T | Promise<T>): Promise<DesktopResult<T>> {
  try { return { ok: true, value: await action() }; }
  catch (error) { return { ok: false, error: serializeFailure(error) }; }
}

export async function handleRequest(target: unknown, op: unknown, params: unknown, reconnect: () => Promise<void>): Promise<DesktopResult<void>> {
  return ipcResult(async () => {
    if (target !== "code") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
    // 名单只随界面实际需要扩展；reconnect 是本地主进程操作，不转发给后台。
    if (op !== "reconnect") throw new DesktopError("op_not_allowed", "此操作未向桌面客户端开放。");
    if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 0) throw new DesktopError("invalid_params", "重新连接不接受参数。");
    await reconnect();
  });
}
