/** 观察资格判定：只有真正持久化并投影给模型的观察内容才授权写操作。
 * Note: 见 .agents/notes/implemented/feature/2026-10-31-cua-batch-eligibility.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import { cuaActionNeed, cuaBatchPlan, type CuaActionNeed } from "./cua.ts";
import { McpError } from "./transport.ts";

/** 某窗口已交付给模型的有效观察：可操作快照（含元素令牌出处）、截图帧与 diff 合并基线。 */
export interface WindowGrant {
  snapshot?: { sid: string; text: string };
  screenshot?: { captureId?: string };
  /** 最近一次交付的完整观察文本；只作 diff 合并基线，不单独授权。 */
  base?: string;
}
/** 本执行内仍可作为写操作依据的观察；换绑、冻结、断连、重读或批次派发即失效。 */
export interface CuaGrants { windows: Map<string, WindowGrant>; invalidated: Set<string>; desktopScreenshot: boolean; activeWindow?: string }
export const freshCuaGrants = (): CuaGrants => ({ windows: new Map(), invalidated: new Set(), desktopScreenshot: false });

const eligibleFailure = (reason: string) => new McpError("cua_observation_required", `${reason}；该请求未发送。先对目标窗口调用 get_window_state 取得新观察（元素动作用已交付的 element_token，坐标动作需要已交付截图），再据此操作。`);

/** 锁屏、AX 未决或启动中的观察不授权写入（degraded_reason 前缀匹配上游枚举）。 */
export const cuaObservationBlocked = (state: Record<string, unknown> | undefined): boolean => {
  const reason = state?.degraded_reason;
  return typeof reason === "string" && /^(screen_locked|ax_window_unresolved|ax_app_launching)/.test(reason);
};

/** 元素行只按完整令牌或行首 `[n]` 索引计数；子串与标签内文本都不算交付。 */
const tokenVisible = (text: string, sid: string, row: number): boolean => {
  const escapedSid = sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9A-Za-z_])${escapedSid}:${row}(?![0-9A-Za-z_])`).test(text)
    || new RegExp(`(^|\\n)[ \\t]*-[ \\t]*\\[${row}\\]|(^|\\n)[ \\t]*\\[${row}\\]`).test(text);
};

/** 令牌所属窗口的当前有效授权（sid 被公告失效后不再可寻）。 */
export const tokenGrantWindow = (grants: CuaGrants, sid: string): [string, WindowGrant] | undefined =>
  grants.invalidated.has(sid) ? undefined : [...grants.windows.entries()].find(([, grant]) => grant.snapshot?.sid === sid);

function checkNeed(grants: CuaGrants, need: CuaActionNeed, label: string, args: Record<string, unknown>, batch?: { key: string; grant: WindowGrant }): void {
  if (need.kind === "unavailable") throw eligibleFailure(`${label} 依赖未开放的 zoom 能力`);
  if (need.kind === "token") {
    const entry = batch ? (batch.grant.snapshot?.sid === need.sid && !grants.invalidated.has(need.sid) ? ([batch.key, batch.grant] as const) : undefined) : tokenGrantWindow(grants, need.sid);
    if (!entry) throw eligibleFailure(`${label} 引用的元素令牌不属于当前有效快照（可能已被新观察、失效公告或换绑作废）`);
    if (!Number.isInteger(need.row)) throw eligibleFailure(`${label} 的元素令牌形态无效`);
    const [key, grant] = entry;
    if (need.windowKey && need.windowKey !== key) throw eligibleFailure(`${label} 的元素令牌与其指定窗口不一致；一次观察不能授权另一窗口`);
    if (!tokenVisible(grant.snapshot!.text, need.sid, need.row)) throw eligibleFailure(`${label} 的元素不在已交付给模型的观察内容中（行可能被截断投影或已过期）；重新观察后再操作`);
    return;
  }
  if (need.kind === "desktop") {
    if (!grants.desktopScreenshot) throw eligibleFailure(`${label} 需要已交付的桌面截图`);
    return;
  }
  const key = (need.kind === "window" ? need.windowKey : undefined) ?? batch?.key ?? grants.activeWindow;
  const grant = key ? (batch ? (key === batch.key ? batch.grant : undefined) : grants.windows.get(key)) : undefined;
  if (!grant || (!grant.snapshot && !grant.screenshot)) throw eligibleFailure(`${label} 的目标窗口${key ? ` ${key}` : ""}尚无已交付的有效观察`);
  if (typeof args.capture_id === "string" && grant.screenshot?.captureId && args.capture_id !== grant.screenshot.captureId) throw eligibleFailure(`${label} 的 capture_id 与已交付帧不一致（可能已过期）；重新观察后再操作`);
  if (need.kind === "window" && need.coords && !grant.screenshot) throw eligibleFailure(`${label} 需要目标窗口已交付的截图；元素动作请改用 element_token`);
}

/** 写操作发送前的观察资格：目标窗口必须持有已交付给模型的有效观察；元素与坐标分别要求快照行与截图帧。 */
export function requireCuaEligibility(grants: CuaGrants, remoteName: string, args: Record<string, unknown>): void {
  if (remoteName === "run_steps") {
    const plan = cuaBatchPlan(args);
    const grant = grants.windows.get(plan.key);
    if (!grant?.snapshot && !grant?.screenshot) throw eligibleFailure(`批次窗口 ${plan.key} 尚无已交付的有效观察`);
    for (const [index, step] of plan.steps.entries()) checkNeed(grants, cuaActionNeed(step.args), `批次步骤 ${index + 1}（${step.tool}）`, step.args, { key: plan.key, grant: grant! });
    return;
  }
  checkNeed(grants, cuaActionNeed(args), `操作 ${remoteName}`, args);
}

/** 观察类调用在发送前即失效原窗口/桌面的可操作授权；diff 基线保留供新观察合并。 */
export function clearObservationGrant(grants: CuaGrants, remoteName: string, args: Record<string, unknown>): void {
  if (remoteName === "get_window_state") revokeActionable(grants, `${args.pid}:${args.window_id}`);
  else if (remoteName === "get_desktop_state") grants.desktopScreenshot = false;
}

/** 批次开始派发即撤销目标窗口的可操作授权：动作已可能改变界面，旧证据不再有效。
 *  授权仅由批次末尾或其他成功交付的观察恢复；diff 基线保留，供新观察按上游增量语义合并。 */
export function revokeActionable(grants: CuaGrants, key: string): void {
  const grant = grants.windows.get(key);
  if (!grant) return;
  delete grant.snapshot;
  delete grant.screenshot;
  if (grants.activeWindow === key) grants.activeWindow = undefined;
}

/** 远端观察结果未能交付给模型（持久化或投影失败）：上游读取基线已前移但内容不可见，整窗授权与基线一并清除。 */
export function dropObservationBase(grants: CuaGrants, key: string): void {
  grants.windows.delete(key);
  if (grants.activeWindow === key) grants.activeWindow = undefined;
}

/** 成功观察后登记授权：sid/失效公告/截图帧出自结构化结果，文本只用已交付内容。
 *  diff/no_change 且未重排行时把新 sid 的授权合并到既有交付文本上（行号在上游增量读中保持稳定）。 */
export function grantWindowObservation(grants: CuaGrants, key: string, state: Record<string, unknown>, text: string, image: boolean): void {
  if (cuaObservationBlocked(state)) { grants.windows.delete(key); return; }
  for (const sid of Array.isArray(state.invalidated_snapshot_ids) ? state.invalidated_snapshot_ids : []) {
    if (typeof sid !== "string") continue;
    grants.invalidated.add(sid);
    for (const grant of grants.windows.values()) if (grant.snapshot?.sid === sid) delete grant.snapshot;
  }
  const grant = grants.windows.get(key) ?? {};
  const sid = state.snapshot_id;
  if (typeof sid === "string" && sid && !grants.invalidated.has(sid)) {
    const diff = (state.since_status === "diff" || state.since_status === "no_change") && !text.includes("reindexed:");
    const merged = diff && grant.base ? `${grant.base}\n${text}` : text;
    grant.snapshot = { sid, text: merged };
    grant.base = merged;
  }
  if (image && state.display_only !== true && state.on_current_space !== false) grant.screenshot = { ...(typeof state.capture_id === "string" ? { captureId: state.capture_id } : {}) };
  else if (state.screenshot_frame_valid === false || state.screenshot_error !== undefined) delete grant.screenshot;
  grants.windows.set(key, grant);
  grants.activeWindow = key;
}
