import type { CodeScheduleReconcileOutcome } from "@ruukoto/control/code-schedule-requests.ts";
import type { AttachmentMetadata } from "@ruukoto/core/attachments.ts";
import type { RequestOutcome } from "@ruukoto/control/client.ts";
import type { ConnectionState } from "@ruukoto/control/connection.ts";
import type { ConnectResult, DesktopBrowserEvent } from "@ruukoto/control/protocol.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import type { PendingRequest } from "@ruukoto/control/pending-requests.ts";
import type { OwnerQuestionCancelOutcome, OwnerQuestionCancelReconcileOutcome } from "@ruukoto/control/owner-question-cancel.ts";
import type { ReconcileOutcome, SubmitOutcome, OwnerQuestionAnswerOutcome } from "@ruukoto/control/submission.ts";
import type { PersonalDesktopFrame, PersonalRemoteIdentity, PersonalPendingInput, PersonalInputReceipt } from "./personal-desktop.ts";

export type DesktopAttachment = AttachmentMetadata;

export type DesktopCancelQuestionResult = OwnerQuestionCancelOutcome | { kind: "pending_existing"; record: PendingRequest };
export type DesktopSubmitResult = SubmitOutcome | OwnerQuestionAnswerOutcome | { kind: "pending_existing"; record: PendingRequest };
export type PendingInput = { record: PendingRequest; result?: ReconcileOutcome | OwnerQuestionCancelReconcileOutcome | CodeScheduleReconcileOutcome };
export type PendingOp = "desktop_pending_read" | "desktop_pending_clear";

export type BrowserDocumentId = string;
export interface BrowserDocumentHandle { id: BrowserDocumentId; url: string }
export type DesktopTarget = "code" | "personal";
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
  | { type: "personal_frame"; frame: PersonalDesktopFrame }
  | { type: "personal_identity"; identity: PersonalRemoteIdentity }
  | { type: "personal_pending"; record: PersonalPendingInput | null; result?: PersonalInputReceipt }
  | { type: "navigate"; instanceId: string; navigation: DesktopNavigation }
  | { type: "state"; state: ConnectionState; detail?: string; error?: DesktopFailure; recovery?: string[] }
  | { type: "snapshot"; result: ConnectResult; instanceChanged: boolean }
  | { type: "event"; event: PersistentEvent; kind: "live" | "replay" }
  | { type: "pending"; entries: PendingInput[]; corrupt: string[]; dir: string }
  | { type: "schedule_submission"; record: PendingRequest; result: CodeScheduleReconcileOutcome }
  | { type: "question_cancel"; record: PendingRequest; result: OwnerQuestionCancelReconcileOutcome }
  | { type: "submission"; record: PendingRequest; result: ReconcileOutcome }
  /** 原生浏览器页面事实（闸门/导航/标题/关闭）；经 Go→Node→前端转发。 */
  | { type: "browser_event"; event: DesktopBrowserEvent };
export interface DesktopBridge {
  subscribe(target: DesktopTarget, listener: (update: DesktopUpdate) => void): () => void;
  request(target: DesktopTarget, op: string, params: Record<string, unknown>): Promise<DesktopResult<unknown>>;
  pickAttachments(sessionId: string, target?: DesktopTarget): Promise<DesktopResult<DesktopAttachment[]>>;
  /** 会话尚未创建时选择附件：只登记本机文件，建好会话后由 uploadDraftAttachments 上传。 */
  pickDraftAttachments(): Promise<DesktopResult<DesktopAttachment[]>>;
  uploadDraftAttachments(sessionId: string, tokens: string[], target?: DesktopTarget): Promise<DesktopResult<DesktopAttachment[]>>;
  pickFolder(): Promise<DesktopResult<string | null>>;
  reveal(path: string): Promise<DesktopResult<void>>;
  openTerminal(id: DesktopTerminalId, workspaceId: string, instanceId: string, cols: number, rows: number): Promise<DesktopResult<{ id: DesktopTerminalId; cwd: string }>>;
  inputTerminal(id: DesktopTerminalId, data: string): Promise<DesktopResult<void>>;
  resizeTerminal(id: DesktopTerminalId, cols: number, rows: number): Promise<DesktopResult<void>>;
  killTerminal(id: DesktopTerminalId): Promise<DesktopResult<void>>;
}

/** MyGo 原生浏览器页的可信调用面；仅 mygo preload 注入，Electron/其他宿主无此字段。 */
export interface NativeBrowserApi {
  rect(x: number, y: number, w: number, h: number): Promise<unknown>;
  state(session: string, shown: boolean, covered: boolean): Promise<unknown>;
  takeover(session: string): Promise<unknown>;
  returnToAgent(session: string): Promise<unknown>;
  navigate(session: string, url: string): Promise<unknown>;
  back(session: string): Promise<unknown>;
  forward(session: string): Promise<unknown>;
  reload(session: string): Promise<unknown>;
  close(session: string): Promise<unknown>;
}

declare global {
  interface Window {
    ruukoto: DesktopBridge & { browser?: NativeBrowserApi };
  }
}
