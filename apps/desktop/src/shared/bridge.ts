import type { AttachmentMetadata } from "@ruukoto/core/attachments.ts";
import type { RequestOutcome } from "@ruukoto/control/client.ts";
import type { ConnectionState } from "@ruukoto/control/connection.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import type { PendingRequest } from "@ruukoto/control/pending-requests.ts";
import type { ReconcileOutcome, SubmitOutcome } from "@ruukoto/control/submission.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";

export type DesktopAttachment = AttachmentMetadata;

export type DesktopSubmitResult = SubmitOutcome | { kind: "pending_existing"; record: PendingRequest };
export type PendingInput = { record: PendingRequest; result?: ReconcileOutcome };
export type PendingOp = "desktop_pending_read" | "desktop_pending_clear";

export type BrowserDocumentId = string;
export interface BrowserDocumentHandle { id: BrowserDocumentId; url: string }
export type DesktopTarget = "code" | "personal";
export type DesktopSkillPreview = OpResult<"skill_import_preview">;
export type DesktopTerminalId = string;
export type DesktopTerminalUpdate = { type: "terminal"; id: DesktopTerminalId } & ({ kind: "output"; data: string } | { kind: "exit"; exitCode: number; signal?: number });
export interface DesktopFailure {
  code: string;
  outcome: RequestOutcome;
  message: string;
  versions?: { client: number; server: number };
}
export type DesktopResult<T> = { ok: true; value: T } | { ok: false; error: DesktopFailure };
export interface DesktopNavigation { sessionId: string; taskId: string }
export type DesktopUpdate =
  | DesktopTerminalUpdate
  | { type: "navigate"; instanceId: string; navigation: DesktopNavigation }
  | { type: "state"; state: ConnectionState; detail?: string; error?: DesktopFailure; recovery?: string[] }
  | { type: "snapshot"; result: ConnectResult; instanceChanged: boolean }
  | { type: "event"; event: PersistentEvent; kind: "live" | "replay" }
  | { type: "pending"; entries: PendingInput[]; corrupt: string[]; dir: string }
  | { type: "submission"; record: PendingRequest; result: ReconcileOutcome };
export interface DesktopBridge {
  subscribe(target: DesktopTarget, listener: (update: DesktopUpdate) => void): () => void;
  request(target: DesktopTarget, op: string, params: Record<string, unknown>): Promise<DesktopResult<unknown>>;
  pickAttachments(sessionId: string, target?: DesktopTarget): Promise<DesktopResult<DesktopAttachment[]>>;
  /** 会话尚未创建时选择附件：只登记本机文件，建好会话后由 uploadDraftAttachments 上传。 */
  pickDraftAttachments(): Promise<DesktopResult<DesktopAttachment[]>>;
  uploadDraftAttachments(sessionId: string, tokens: string[], target?: DesktopTarget): Promise<DesktopResult<DesktopAttachment[]>>;
  pickFolder(): Promise<DesktopResult<string | null>>;
  pickSkillFolder(target: DesktopTarget, instanceId: string): Promise<DesktopResult<DesktopSkillPreview | null>>;
  reveal(path: string): Promise<DesktopResult<void>>;
  openTerminal(id: DesktopTerminalId, workspaceId: string, instanceId: string, cols: number, rows: number): Promise<DesktopResult<{ id: DesktopTerminalId; cwd: string }>>;
  inputTerminal(id: DesktopTerminalId, data: string): Promise<DesktopResult<void>>;
  resizeTerminal(id: DesktopTerminalId, cols: number, rows: number): Promise<DesktopResult<void>>;
  killTerminal(id: DesktopTerminalId): Promise<DesktopResult<void>>;
}
