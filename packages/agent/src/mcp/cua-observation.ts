/** 观察资格判定：只有真正持久化并投影给模型的观察内容才授权写操作。
 * Note: 见 .agents/notes/implemented/feature/2026-10-31-cua-batch-eligibility.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import { cuaActionNeed, cuaBatchPlan, type CuaActionNeed } from "./cua.ts";
import { McpError } from "./transport.ts";

/** 某窗口已交付给模型的有效观察：可操作快照（含元素令牌出处）、截图帧与 diff 合并基线。 */
export interface WindowGrant {
  /** text = 当前可操作视图（diff 读为规范化合并结果：变更行统一为 `- [n]` 行，移除行不保留）；
   *  detached = 位置由 diff 追加伪造的行号集合——这些行的真实祖先未交付，菜单路由判据不可凭其缩进链。 */
  snapshot?: { sid: string; text: string; detached?: Set<number> };
  screenshot?: { captureId?: string };
  /** 最近一次交付的完整观察文本（sid 为产出该文本的快照）；只作 diff 合并基线，不单独授权。 */
  base?: { sid: string; text: string };
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

/** 元素行只按完整令牌或行首 `- [n]` 索引行计数（与上游 snapshot_row 同形态）；子串与标签内文本都不算交付。
 *  完整令牌只在含 `element_token` 的行计数（上游 markdown 页脚与 elements JSON 的字段形态），
 *  元素标签等应用可控文本内出现的 sid:row 字样不构成交付。 */
const tokenVisible = (text: string, sid: string, row: number): boolean => {
  const escapedSid = sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(^|[^0-9A-Za-z_])${escapedSid}:${row}(?![0-9A-Za-z_])`);
  return text.split("\n").some(line => line.includes("element_token") && token.test(line))
    || new RegExp(`(^|\\n)[ \\t]*-[ \\t]*\\[${row}\\]`).test(text);
};

/** 令牌所属窗口的当前有效授权（sid 被公告失效后不再可寻）。 */
export const tokenGrantWindow = (grants: CuaGrants, sid: string): [string, WindowGrant] | undefined =>
  grants.invalidated.has(sid) ? undefined : [...grants.windows.entries()].find(([, grant]) => grant.snapshot?.sid === sid);

/** 上游 menu_path_in（window_state_view.rs）的等价判定：行角色为 AXMenuItem/AXMenuBarItem 且缩进
 *  祖先链抵达 AXMenuBar 时，钉版驱动会把该行的 click 改执行为 invoke_menu —— 不在批次动作清单的
 *  隐式调用。上游按 sid 存储完整 markdown 并在其上判定；宿主只有交付视图：真实位置可证的行
 *  按祖先链判定，diff 追加行（detached）位置伪造，菜单角色一律按可路由拒绝。 */
const MENU_ROW_ROLES = new Set(["AXMenuItem", "AXMenuBarItem"]);

const treeRowItem = (line: string): { role: string; label: string } | undefined => {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("- ")) return undefined;
  const rest = trimmed.slice(2);
  let body = rest;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("] ");
    if (close >= 0) body = rest.slice(close + 2);
  }
  const space = body.indexOf(" ");
  const after = space < 0 ? "" : body.slice(space + 1).trimStart();
  return { role: space < 0 ? body : body.slice(0, space), label: after.match(/^"([^"]*)"/)?.[1] ?? "" };
};

/** click 令牌的菜单路由判据：交付文本中找不到可解析的 `- [n]` 行（elements/both 之外的格式、
 *  行被截断投影）即不可证明非菜单行，拒绝；detached 行位置由合并追加伪造、祖先不可证明，
 *  菜单角色按可路由拒绝；位置真实的行按上游同构的缩进祖先链判定。 */
const menuTokenBlocked = (snapshot: { text: string; detached?: Set<number> }, row: number): boolean => {
  const marker = `[${row}] `;
  const line = snapshot.text.split("\n").find(l => { const trimmed = l.trimStart(); return trimmed.startsWith("- ") && trimmed.slice(2).startsWith(marker); });
  if (!line) return true;
  const role = treeRowItem(line)?.role;
  if (!role || !MENU_ROW_ROLES.has(role)) return false;
  if (snapshot.detached?.has(row)) return true;
  return menuRow(snapshot.text, row);
};

const menuRow = (text: string, row: number): boolean => {
  const lines = text.split("\n"), marker = `[${row}] `;
  const at = lines.findIndex(line => { const trimmed = line.trimStart(); return trimmed.startsWith("- ") && trimmed.slice(2).startsWith(marker); });
  if (at < 0) return false;
  const indent = (line: string) => line.length - line.trimStart().length;
  const self = treeRowItem(lines[at]!);
  if (!self || !MENU_ROW_ROLES.has(self.role) || !self.label) return false;
  let level = indent(lines[at]!);
  for (let index = at - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (indent(line) >= level) continue;
    const parent = treeRowItem(line);
    if (!parent) return false;
    level = indent(line);
    if (parent.role === "AXMenuBar") return true;
    if (MENU_ROW_ROLES.has(parent.role) && parent.label) continue;
    if (parent.role === "AXMenu") continue;
    return false;
  }
  return false;
};

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
    for (const [index, step] of plan.steps.entries()) {
      const need = cuaActionNeed(step.args);
      checkNeed(grants, need, `批次步骤 ${index + 1}（${step.tool}）`, step.args, { key: plan.key, grant: grant! });
      // 钉版驱动把菜单栏元素的 click 改执行为 invoke_menu（不在批次动作清单的隐式调用）：
      // 判据落在该 sid 的完整存储文本上；double_click/right_click 无该路由，普通调用亦不经此路径。
      if (step.tool === "click" && need.kind === "token" && menuTokenBlocked(grant!.snapshot!, need.row))
        throw eligibleFailure(`批次步骤 ${index + 1}（click）的元素是菜单栏成员或祖先不可证明；钉版驱动会把该点击改执行为不在批次动作清单的 invoke_menu。改用 hotkey/菜单等价键，或交付截图后用坐标点击`);
    }
    return;
  }
  checkNeed(grants, cuaActionNeed(args), `操作 ${remoteName}`, args);
}

/** 观察请求的窗口键：pid/window_id 均可归一化为整数时才可归属（字符串数字按上游可强转的
 *  形态归一，其余形态视为不可归属）；缺省时上游解析前台窗口，宿主无法证明目标是谁，
 *  调用方须按“可能影响任一窗口”保守处理。 */
const argsWindowKey = (args: Record<string, unknown>): string | undefined => {
  const part = (value: unknown) => {
    const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof num === "number" && Number.isInteger(num) ? `${num}` : undefined;
  };
  const pid = part(args.pid), wid = part(args.window_id);
  return pid !== undefined && wid !== undefined ? `${pid}:${wid}` : undefined;
};

/** 观察类调用在发送前即失效原窗口/桌面的可操作授权；diff 基线保留供新观察合并。
 *  目标不可归属时撤销全部窗口的可操作授权（基线保留）：重读任意窗口都会推进上游读基线。 */
export function clearObservationGrant(grants: CuaGrants, remoteName: string, args: Record<string, unknown>): void {
  if (remoteName === "get_window_state") {
    const key = argsWindowKey(args);
    if (key) revokeActionable(grants, key);
    else for (const k of [...grants.windows.keys()]) revokeActionable(grants, k);
  } else if (remoteName === "get_desktop_state") grants.desktopScreenshot = false;
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

/** 按观察请求参数清除授权与基线；目标不可归属时清除全部窗口（读基线已在前移的窗口上推进）。 */
export function dropObservationGrant(grants: CuaGrants, args: Record<string, unknown>): void {
  const key = argsWindowKey(args);
  if (key) dropObservationBase(grants, key);
  else for (const k of [...grants.windows.keys()]) dropObservationBase(grants, k);
}

/** diff 文本的行条目：上游按 `+ [n]`（新增）、`~ [n]`（变更）、`- [n]`（已移除，旧 sid 的 id）
 *  输出且不带缩进与 `- ` 前缀；`reindexed:`/标题等非行条目跳过。返回规范化行与行号分类。 */
const parseDiffRows = (diff: string): { changed: Set<number>; removed: Set<number>; rows: string[] } => {
  const changed = new Set<number>(), removed = new Set<number>(), rows: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^([+~-]) \[(\d+)\] (.+)$/.exec(line);
    if (!match) continue;
    const index = Number.parseInt(match[2]!, 10);
    if (match[1] === "-") removed.add(index);
    else { changed.add(index); rows.push(`  - [${match[2]}] ${match[3]}`); }
  }
  return { changed, removed, rows };
};

/** 基线行 + diff 变更行的规范化合并：被变更/移除的基线行剔除，变更行统一为 `- [n]` 行附后。
 *  结果视图与上游存储的完整 markdown 同形可供行判定；追加行位置不反映真实祖先（调用方记入 detached）。 */
const mergeDeliveredText = (base: string, diff: string): { merged: string; changed: Set<number> } => {
  const { changed, removed, rows } = parseDiffRows(diff);
  const kept = base.split("\n").filter(line => {
    const match = /^[ \t]*-[ \t]*\[(\d+)\] /.exec(line);
    return !match || (!changed.has(Number.parseInt(match[1]!, 10)) && !removed.has(Number.parseInt(match[1]!, 10)));
  });
  return { merged: [...kept, ...rows].join("\n"), changed };
};

/** 成功观察后登记授权：sid/失效公告/截图帧出自结构化结果，文本只用已交付内容。
 *  diff/no_change 只在上游报出的已解析基线（state.since）与既有交付基线的 sid 一致时才合并
 *  ——上游的 diff 基线可能是批次内定位器读产生的中间快照或模型指定的其他 sid，基线不符时
 *  旧行号与新快照内容无对应关系，按只含变更行的视图授权；交付文本被截断或行号被重排时
 *  该读同样不能作合并基线（丢失的变更记录会让旧行复活）。 */
export function grantWindowObservation(grants: CuaGrants, key: string, state: Record<string, unknown>, text: string, image: boolean, truncated = false): void {
  if (cuaObservationBlocked(state)) { grants.windows.delete(key); return; }
  for (const sid of Array.isArray(state.invalidated_snapshot_ids) ? state.invalidated_snapshot_ids : []) {
    if (typeof sid !== "string") continue;
    grants.invalidated.add(sid);
    for (const grant of grants.windows.values()) if (grant.snapshot?.sid === sid) delete grant.snapshot;
  }
  const grant = grants.windows.get(key) ?? {};
  const sid = state.snapshot_id;
  if (typeof sid === "string" && sid && !grants.invalidated.has(sid)) {
    const diff = state.since_status === "diff" || state.since_status === "no_change";
    const changedOnly = () => {
      // 只含变更行的视图：无基线、基线不符、截断交付或行号被重排时都不能续用旧行
      const { merged, changed } = mergeDeliveredText("", text);
      grant.snapshot = { sid, text: merged, detached: changed };
      delete grant.base;
    };
    if (!diff) {
      grant.snapshot = { sid, text };
      if (truncated) delete grant.base;
      else grant.base = { sid, text };
    } else if (grant.base && grant.base.sid === state.since && !truncated && !text.includes("reindexed:")) {
      const { merged, changed } = mergeDeliveredText(grant.base.text, text);
      const detached = new Set(grant.snapshot?.detached ?? []);
      for (const row of changed) detached.add(row);
      grant.snapshot = { sid, text: merged, detached };
      grant.base = { sid, text: merged };
    } else {
      changedOnly();
    }
  }
  if (image && state.display_only !== true && state.on_current_space !== false) grant.screenshot = { ...(typeof state.capture_id === "string" ? { captureId: state.capture_id } : {}) };
  else if (state.screenshot_frame_valid === false || state.screenshot_error !== undefined) delete grant.screenshot;
  grants.windows.set(key, grant);
  // 无内容观察（display_only 等）不产生任何授权，也不应把上下文目标引向空窗口
  if (grant.snapshot || grant.screenshot) grants.activeWindow = key;
}
