import { createHash } from "node:crypto";
import { DesktopError } from "./environment.ts";
import type { DesktopBrowserChunk, DesktopBrowserEvent } from "@ruukoto/control/protocol.ts";

/**
 * MyGo desktop browser bridge (mygo-agent-browser): control-plane narrow commands reach the Go-side
 * browser.Manager through here; screenshot/snapshot results flow back in 256KiB raw-byte chunks, and the server
 * assembles them after checking command_id and sha256. Event reporting and registration share the same control connection.
 * Note: See .agents/notes/implemented/feature/2026-10-29-mygo-agent-browser.md
 */

/** Go-side command channel (Node→Go private frames); the result is Manager.Command's {ok,value|error}. */
export interface MyGoBrowserTransport {
  command(op: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Chunked sends depend on the current control connection; on reconnect new requests take the new connection and old ones lapse. */
export interface BrowserConn {
  request(op: "desktop_browser_chunk", params: DesktopBrowserChunk): Promise<unknown>;
  request(op: "desktop_browser_event", params: { event: DesktopBrowserEvent }): Promise<unknown>;
  request(op: "desktop_browser_register", params: { shell: "mygo" }): Promise<unknown>;
}

const CHUNK_BYTES = 256 * 1024;
/** Inline reply limit: results beyond it require transfer; non-transfer fields over the limit are rejected as too large. */
const INLINE_RESULT_BYTES = 768 * 1024;
const TRANSFER_FIELDS: Record<string, string> = { png: "screenshot" };

interface TransferPick {
  field: string;
  kind: string;
  bytes: Buffer;
}

/** Extracts large fields from a Manager result (png=screenshot binary, snapshot=snapshot text). */
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

  /** Re-registers after every snapshot (including resync on reconnect): the connection identity is issued and returned by the server. */
  register(connection: BrowserConn | null): void {
    if (!connection) return;
    void connection.request("desktop_browser_register", { shell: "mygo" }).catch(error => {
      process.stderr.write(`[ruukoto:desktop] Browser capability registration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  /** Page-fact uplink: best effort; on disconnect the control connection itself rejects in-flight commands as disconnected. */
  event(connection: BrowserConn | null, event: DesktopBrowserEvent): void {
    if (!connection) return;
    void connection.request("desktop_browser_event", { event }).catch(error => {
      process.stderr.write(`[ruukoto:desktop] Browser event report failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  /**
   * Server narrow command: runs on Go; results with large png/snapshot fields are chunked and
   * only declared in the reply (kind/sha256/total_bytes/total). Transfer failures go back as an error
   * result so the server isn't blocked waiting for chunks.
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
      // Over-limit only happens for read-only results (snapshot/screenshot text); mutating actions have small result bodies.
      // The reply wasn't delivered rather than having an unknown effect — marking not_sent allows safe retry.
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
