export type { PersonalDesktopFrame, PersonalDesktopLive, PersonalDesktopEvent, PersonalDesktopMessage, PersonalTimelineEntry, PersonalTimelinePage } from "@ruukoto/view/personal-protocol.ts";
export type PersonalRemoteIdentity = { v: 1; product: "ruukoto"; remoteId: string; origin: string; profile: { id: string; directory: string }; online: boolean; runId?: string };
export type PersonalPendingInput = { v: 1; origin: string; remoteId: string; profile: { id: string; directory: string }; requestId: string; input: string };
export type PersonalInputReceipt = { kind: "accepted" | "pending" | "missing"; requestId: string; status?: "queued" | "placed" | "done" | "unanswered"; answer?: string; truncated?: boolean };
