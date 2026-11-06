/** Development UI state is separate from executable pending requests; restoring a draft never sends it. */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseModelSelection } from "@ruukoto/core/model-selection.ts";
import { isSessionDefaultMode } from "@ruukoto/core/types.ts";
import type { ManagedChatDraft } from "./managed-chat.ts";

export const RELOAD_STATE_ENV = "RUUKOTO_RELOAD_STATE_FILE";

export interface TaskTuiReloadState {
  kind: "task-tui";
  /** Restoring UI state requires the original backend data identity. */
  instanceId: string;
  sessionId: string | null;
  draft: string;
  managedDraft?: ManagedChatDraft;
  updatedAt: string;
}

export interface ConfigTuiReloadState {
  kind: "config-tui";
  instanceId: string;
  /** 配置中心当前所在分区路径（菜单 id 序列）；不含任何表单值。 */
  section: string[];
  updatedAt: string;
}

export type ReloadState = TaskTuiReloadState | ConfigTuiReloadState;

/** dev 注入的重载状态文件路径；非 dev 启动返回 null（不启用状态恢复）。 */
export function reloadStatePathFromEnv(): string | null {
  return process.env[RELOAD_STATE_ENV] ?? null;
}

/** 读取重载状态；文件缺失、损坏或形状不符都返回 null（调用方提示后按正常入口继续）。 */
export function loadReloadState(file: string): ReloadState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as any;
    if (raw?.kind === "task-tui") {
      if (typeof raw.instanceId !== "string") return null;
      return {
        kind: "task-tui",
        instanceId: raw.instanceId,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
        draft: typeof raw.draft === "string" ? raw.draft : "",
        ...(raw.managedDraft && isSessionDefaultMode(raw.managedDraft.mode) ? { managedDraft: {
          text: typeof raw.managedDraft.text === "string" ? raw.managedDraft.text : "",
          mode: raw.managedDraft.mode,
          modelSelection: raw.managedDraft.modelSelection === null ? null : parseModelSelection(raw.managedDraft.modelSelection),
        } } : {}),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      };
    }
    if (raw?.kind === "config-tui") {
      if (typeof raw.instanceId !== "string") return null;
      return {
        kind: "config-tui",
        instanceId: raw.instanceId,
        section: Array.isArray(raw.section) ? raw.section.map(String) : [],
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 原子落盘（0600）：写临时文件后 rename；失败不阻断界面，下次变更再试。 */
export function saveReloadState(file: string, state: ReloadState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 重载状态是便利设施：写失败不影响当前会话
  }
}
