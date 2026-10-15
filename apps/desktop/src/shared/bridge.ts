import type { RequestOutcome } from "@ruukoto/control/client.ts";
import type { ConnectionState } from "@ruukoto/control/connection.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import type { PendingRequest } from "@ruukoto/control/pending-requests.ts";
import type { ReconcileOutcome, SubmitOutcome } from "@ruukoto/control/submission.ts";

export type DesktopSubmitResult = SubmitOutcome | { kind: "pending_existing"; record: PendingRequest };
export type PendingInput = { record: PendingRequest; result?: ReconcileOutcome };
export type PendingOp = "desktop_pending_read" | "desktop_pending_clear";

export type DesktopTarget = "code" | "personal";
export interface DesktopFailure {
  code: string;
  outcome: RequestOutcome;
  message: string;
  versions?: { client: number; server: number };
}
export type DesktopResult<T> = { ok: true; value: T } | { ok: false; error: DesktopFailure };
export type DesktopUpdate =
  | { type: "state"; state: ConnectionState; detail?: string; error?: DesktopFailure; recovery?: string[] }
  | { type: "snapshot"; result: ConnectResult; instanceChanged: boolean }
  | { type: "event"; event: PersistentEvent; kind: "live" | "replay" }
  | { type: "pending"; entries: PendingInput[]; corrupt: string[]; dir: string }
  | { type: "submission"; record: PendingRequest; result: ReconcileOutcome };
export interface DesktopBridge {
  subscribe(target: DesktopTarget, listener: (update: DesktopUpdate) => void): () => void;
  request(target: DesktopTarget, op: string, params: Record<string, unknown>): Promise<DesktopResult<unknown>>;
  pickFolder(): Promise<DesktopResult<string | null>>;
  reveal(path: string): Promise<DesktopResult<void>>;
}
