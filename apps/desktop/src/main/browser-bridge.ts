import { createHash } from "node:crypto";
import { DesktopError } from "./environment.ts";
import type { DesktopBrowserChunk, DesktopBrowserEvent } from "@ruukoto/control/protocol.ts";

/**
 * MyGo 桌面浏览器桥（mygo-agent-browser）：控制面窄命令经此转到 Go 侧
 * browser.Manager；截图/快照结果按 256KiB 原始字节分块回流，服务端按
 * command_id 与 sha256 校验装配。事件上报与登记走同一控制连接。
 * Note: 见 .agents/notes/implemented/feature/2026-10-29-mygo-agent-browser.md
 */

/** Go 侧命令通道（Node→Go 私有帧）；结果即 Manager.Command 的 {ok,value|error}。 */
export interface MyGoBrowserTransport {
  command(op: string, input: Record<string, unknown>): Promise<unknown>;
}

/** 分块发送依赖当前控制连接；连接更换时新请求走新连接，旧请求随断线失效。 */
export interface BrowserConn {
  request(op: "desktop_browser_chunk", params: DesktopBrowserChunk): Promise<unknown>;
  request(op: "desktop_browser_event", params: { event: DesktopBrowserEvent }): Promise<unknown>;
  request(op: "desktop_browser_register", params: { shell: "mygo" }): Promise<unknown>;
}

const CHUNK_BYTES = 256 * 1024;
/** 应答内联上限：结果超过即要求 transfer；非 transfer 字段超限按结果过大拒绝。 */
const INLINE_RESULT_BYTES = 768 * 1024;
const TRANSFER_FIELDS: Record<string, string> = { png: "screenshot" };

interface TransferPick {
  field: string;
  kind: string;
  bytes: Buffer;
}

/** 从 Manager 结果中取出大字段（png=截图二进制、snapshot=快照文本）。 */
function pickTransfer(raw: unknown): TransferPick | null {
  const value = (raw as { ok?: boolean; value?: Record<string, unknown> })?.value;
  if (!value || typeof value !== "object") return null;
  for (const [field, kind] of Object.entries(TRANSFER_FIELDS)) {
    const data = value[field];
    if (typeof data === "string" && data.length > 0) {
      return { field, kind, bytes: field === "png" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8") };
    }
  }
  return null;
}

export class DesktopBrowserBridge {
  constructor(private readonly transport: MyGoBrowserTransport) {}

  /** 每次快照（含重连重同步）后重新登记：连接身份由服务端发定并返回。 */
  register(connection: BrowserConn | null): void {
    if (!connection) return;
    void connection.request("desktop_browser_register", { shell: "mygo" }).catch(error => {
      process.stderr.write(`[ruukoto:desktop] 浏览器能力登记失败：${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  /** 页面事实上行：尽力送达；断线时控制连接自身已按 disconnected 拒绝在途命令。 */
  event(connection: BrowserConn | null, event: DesktopBrowserEvent): void {
    if (!connection) return;
    void connection.request("desktop_browser_event", { event }).catch(error => {
      process.stderr.write(`[ruukoto:desktop] 浏览器事件上报失败：${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  /**
   * 服务端窄命令：转到 Go 执行；结果含 png/snapshot 大字段时分块发送并
   * 在应答里只留声明（kind/sha256/total_bytes/total）。传输失败按错误
   * 结果回包，不阻塞服务端等待分块。
   */
  async handleCall(op: string, params: Record<string, unknown>, callId: string, connection: () => BrowserConn | null): Promise<unknown> {
    if (op !== "browser_command") {
      throw new DesktopError("unsupported", `不支持的桌面浏览器请求：${op}`);
    }
    const input = { ...params };
    const command = typeof input["op"] === "string" ? (input["op"] as string) : "";
    delete input["op"];
    if (!command) throw new DesktopError("invalid_params", "浏览器命令缺少操作。");
    let raw: unknown;
    try {
      raw = await this.transport.command(command, input);
    } catch (error) {
      const e = error as { code?: string; message?: string; outcome?: string };
      return { ok: false, error: { code: typeof e?.code === "string" ? e.code : "bridge_failed", outcome: typeof e?.outcome === "string" ? e.outcome : "not_sent", message: e?.message ?? String(error) } };
    }
    const transfer = pickTransfer(raw);
    if (!transfer) {
      if (Buffer.byteLength(JSON.stringify(raw), "utf8") <= INLINE_RESULT_BYTES) return raw;
      // 超限只发生在只读结果（快照/截图文本）；可变更动作的结果体都很小。
      // 应答未送达而非效果未知，标 not_sent 允许安全重试。
      return { ok: false, error: { code: "result_too_large", outcome: "not_sent", message: "浏览器结果超过内联上限，未送达；请缩小范围后重试。" } };
    }
    const conn = connection();
    if (!conn) {
      return { ok: false, error: { code: "bridge_disconnected", outcome: "disconnected", message: "控制连接不可用，传输未发送。" } };
    }
    const value = (raw as { value: Record<string, unknown> }).value;
    const { [transfer.field]: _omit, ...rest } = value;
    const sha256 = createHash("sha256").update(transfer.bytes).digest("hex");
    const total = Math.max(1, Math.ceil(transfer.bytes.length / CHUNK_BYTES));
    try {
      const sends: Promise<unknown>[] = [];
      for (let index = 0; index < total; index += 1) {
        const slice = transfer.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
        sends.push(conn.request("desktop_browser_chunk", {
          command_id: callId,
          index,
          total,
          total_bytes: transfer.bytes.length,
          sha256,
          data: slice.toString("base64"),
        }));
      }
      await Promise.all(sends);
    } catch (error) {
      return { ok: false, error: { code: "transfer_failed", outcome: "unknown", message: `浏览器传输发送失败：${error instanceof Error ? error.message : String(error)}` } };
    }
    return { ...(raw as Record<string, unknown>), value: { ...rest, transfer: { kind: transfer.kind, sha256, total_bytes: transfer.bytes.length, total } } };
  }
}
