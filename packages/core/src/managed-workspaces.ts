// Note: See .agents/notes/implemented/feature/2026-11-07-managed-coding-workspaces.md
import { RuntimeApiError } from "./api-error.ts";
import type { DirIdentity } from "./dir-identity.ts";
import { parseModelSelection } from "./model-selection.ts";
import type { Store } from "./store.ts";
import { isSessionDefaultMode, type ModelSelection, type SessionDefaultMode } from "./types.ts";

export const managedWorkspaceKey = (projectId: string): string => `managed_workspace:${projectId}`;
export const managedWorkspaceRequestKey = (requestId: string): string => `managed_workspace_request:${requestId}`;

export interface ManagedWorkspaceRequest {
  requestId: string;
  paramsDigest: string;
  projectId: string;
  root: string;
  parent: DirIdentity | null;
  stage: DirIdentity | null;
  modelSelection: ModelSelection;
  mode: SessionDefaultMode;
  sessionId: string | null;
  error: string | null;
}

function parseRequest(text: string, requestId: string): ManagedWorkspaceRequest {
  const directory = (value: DirIdentity | null): boolean => value === null || typeof value === "object" && value !== null &&
    typeof value.cwd === "string" && value.cwd.length > 0 && value.cwd === value.cwdReal &&
    Number.isSafeInteger(value.dev) && value.dev >= 0 && Number.isSafeInteger(value.ino) && value.ino > 0;
  try {
    const value = JSON.parse(text) as ManagedWorkspaceRequest;
    if (!value || typeof value !== "object" || value.requestId !== requestId || !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId) ||
        typeof value.projectId !== "string" || !/^proj_[0-9a-f]{24}$/.test(value.projectId) ||
        typeof value.paramsDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.paramsDigest) || typeof value.root !== "string" ||
        !directory(value.parent) || !directory(value.stage) || value.stage !== null && value.parent === null || !isSessionDefaultMode(value.mode) ||
        value.sessionId !== null && (typeof value.sessionId !== "string" || !/^sess_[0-9a-f]{24}$/.test(value.sessionId) || value.stage === null) ||
        value.error !== null && typeof value.error !== "string") throw new Error("Invalid managed workspace receipt");
    value.modelSelection = parseModelSelection(value.modelSelection);
    return value;
  } catch { throw new RuntimeApiError("managed_workspace_corrupt", "工作区创建记录损坏，请保留原数据并核实记录。"); }
}

export function getManagedWorkspaceRequest(store: Store, requestId: string): ManagedWorkspaceRequest | null {
  const text = store.getMetaValue(managedWorkspaceRequestKey(requestId));
  return text === null ? null : parseRequest(text, requestId);
}

export function listManagedWorkspaceRequestIds(store: Store): string[] {
  const rows = store.db.prepare("SELECT key FROM meta WHERE key LIKE 'managed_workspace_request:%' ORDER BY key").all() as Array<{ key: string }>;
  return rows.map(row => row.key.slice("managed_workspace_request:".length));
}

export function saveManagedWorkspaceRequest(store: Store, request: ManagedWorkspaceRequest): void {
  store.setMetaValue(managedWorkspaceRequestKey(request.requestId), JSON.stringify(request));
}
