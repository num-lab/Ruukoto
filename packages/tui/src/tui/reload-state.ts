/**
 * dev 重载状态（issue 21 §5）：界面状态与待提交任务分开保存——这里只存界面
 * 状态（当前会话、草稿、继续任务意图 / 配置中心所在分区），不复用也不伪装成
 * PendingRequestStore 记录。落盘方式沿用其原子写（tmp + rename、0600）。
 *
 * 只在 dev 启动注入 RUUKOTO_RELOAD_STATE_FILE 时启用；秘密（API key 等表单值）
 * 永不写入——类型上就没有这些字段。恢复时用 instanceId 核对数据实例，不匹配
 * 或文件损坏一律视为无效，由调用方提示并按正常入口继续。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const RELOAD_STATE_ENV = "RUUKOTO_RELOAD_STATE_FILE";

export interface TaskTuiReloadState {
  kind: "task-tui";
  /** 写入时的数据实例 id（握手 instanceId）；不匹配则记录无效。 */
  instanceId: string;
  sessionId: string | null;
  draft: string;
  continueForTaskId: string | null;
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
        continueForTaskId: typeof raw.continueForTaskId === "string" ? raw.continueForTaskId : null,
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
