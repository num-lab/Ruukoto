/** Observation eligibility: only content actually persisted and delivered into a
 *  model request authorizes writes. Grants recorded at format time stay pending
 *  until the result appears in a subsequent model request — a tool group can
 *  never authorize its own precomputed writes with a freshly returned observation.
 * Note: See .agents/notes/implemented/feature/2026-10-31-cua-batch-eligibility.md
 * Note: See .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import { cuaActionNeed, cuaBatchPlan, type CuaActionNeed } from "./cua.ts";
import { McpError } from "./transport.ts";

/** A window's observation delivered to the model: the actionable snapshot (with
 *  element-token provenance), a screenshot frame, and the diff merge base.
 *  `detached` marks rows whose positions were fabricated when appending a diff —
 *  their real ancestors were not delivered, so menu-route checks cannot trust
 *  their indentation chain. */
interface WindowView { sid: string; text: string; detached?: Set<number> }
export interface WindowGrant {
  /** text = current actionable view (a diff read is normalized: changed rows
   *  become `- [n]` rows and removed rows drop out). */
  snapshot?: WindowView;
  screenshot?: { captureId?: string };
  /** Complete delivered text for diff merging, never actionable by itself;
   *  retains the producing sid and fabricated-position provenance. */
  base?: WindowView;
  /** Last delivered view, including partial rows; restore-only, never a diff base. */
  retained?: WindowView;
}
export interface CuaObservationProjection { text: string; image: boolean }
/** A recorded observation effect that only takes hold once its tool result is
 *  delivered inside a subsequent model request. */
export type PendingObservation =
  | { opId: string; kind: "window"; key: string; state: Record<string, unknown>; text: string; image: boolean; truncated: boolean }
  | { opId: string; kind: "desktop"; ok: boolean }
  | { opId: string; kind: "windowHint"; need: CuaActionNeed };
/** Observation effects still valid for writes within this execution; rebinding,
 *  freezing, disconnecting, rereading or dispatching a batch invalidates them. */
export interface CuaGrants { windows: Map<string, WindowGrant>; invalidated: Set<string>; desktopScreenshot: boolean; activeWindow?: string; pending: PendingObservation[] }
export const freshCuaGrants = (): CuaGrants => ({ windows: new Map(), invalidated: new Set(), desktopScreenshot: false, pending: [] });

const eligibleFailure = (reason: string) => new McpError("cua_observation_required", `${reason}；该请求未发送。先对目标窗口调用 get_window_state 取得新观察（元素动作用已交付的 element_token，坐标动作需要已交付截图），再据此操作。`);

/** Locked-screen, unresolved-AX or still-launching observations never authorize
 *  writes (degraded_reason prefixes match the upstream enum). */
export const cuaObservationBlocked = (state: Record<string, unknown> | undefined): boolean => {
  const reason = state?.degraded_reason;
  return typeof reason === "string" && /^(screen_locked|ax_window_unresolved|ax_app_launching)/.test(reason);
};

/** An element row counts only via the complete token or a line-anchored `- [n]`
 *  index row (same shape as upstream snapshot_row); substrings and label text do
 *  not count as delivered. Complete tokens follow the upstream forms: the
 *  `"element_token":"sid:row"` field in elements JSON, or the markdown footer
 *  `row [N] is "sid:row"` — both require `element_token` on the same line and a
 *  quoted token; `sid:row` text inside app-controlled labels is not delivery.
 *  The row marker matches upstream `- [N] ` exactly (single space, trailing space). */
const tokenVisible = (text: string, sid: string, row: number): boolean => {
  const escapedSid = sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`["']${escapedSid}:${row}["']`);
  return text.split("\n").some(line => line.includes("element_token") && token.test(line))
    || new RegExp(`(^|\\n)[ \\t]*- \\[${row}\\] `).test(text);
};

/** The current valid grant for a token's window (a sid announced as invalidated
 *  is no longer addressable). */
export const tokenGrantWindow = (grants: CuaGrants, sid: string): [string, WindowGrant] | undefined =>
  grants.invalidated.has(sid) ? undefined : [...grants.windows.entries()].find(([, grant]) => grant.snapshot?.sid === sid);

/** Equivalent of upstream menu_path_in (window_state_view.rs): a row whose role
 *  is AXMenuItem/AXMenuBarItem with an indent-ancestor chain reaching AXMenuBar
 *  is rerouted by the pinned driver from click to invoke_menu — an implicit call
 *  outside the batch action set. Upstream stores full markdown per sid and
 *  judges on it; the host only has the delivered view: rows with provable real
 *  positions are judged by their ancestor chain, while diff-appended rows
 *  (detached) have fabricated positions and are refused whenever the role is a
 *  menu role. */
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

/** Menu-route predicate for a click token: a token whose `- [n]` row cannot be
 *  parsed from the delivered text (formats other than markdown/both, or a row
 *  truncated out of the projection) cannot be proven non-menu and is refused;
 *  detached rows have fabricated positions so menu roles are refused; rows with
 *  real positions are judged by the upstream-isomorphic indent ancestor chain. */
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

/** Pre-send observation eligibility for writes: the target window must hold an
 *  observation actually delivered to the model; element and coordinate actions
 *  require snapshot rows and a screenshot frame respectively. */
export function requireCuaEligibility(grants: CuaGrants, remoteName: string, args: Record<string, unknown>): void {
  if (remoteName === "run_steps") {
    const plan = cuaBatchPlan(args);
    const grant = grants.windows.get(plan.key);
    if (!grant?.snapshot && !grant?.screenshot) throw eligibleFailure(`批次窗口 ${plan.key} 尚无已交付的有效观察`);
    for (const [index, step] of plan.steps.entries()) {
      const need = cuaActionNeed(step.args);
      checkNeed(grants, need, `批次步骤 ${index + 1}（${step.tool}）`, step.args, { key: plan.key, grant: grant! });
      // The pinned driver reroutes clicks on menu-bar elements to invoke_menu
      // (an implicit call outside the batch set); the predicate runs on the
      // sid's full stored text. double_click/right_click have no such route,
      // and ordinary calls do not take this path either.
      if (step.tool === "click" && need.kind === "token" && menuTokenBlocked(grant!.snapshot!, need.row))
        throw eligibleFailure(`批次步骤 ${index + 1}（click）的元素是菜单栏成员或祖先不可证明；钉版驱动会把该点击改执行为不在批次动作清单的 invoke_menu。改用 hotkey/菜单等价键，或交付截图后用坐标点击`);
    }
    return;
  }
  checkNeed(grants, cuaActionNeed(args), `操作 ${remoteName}`, args);
}

/** The window key an observation request addresses: attributable only when both
 *  pid and window_id normalize to integers (numeric strings normalized per the
 *  upstream coercible forms; anything else is unattributable). When absent,
 *  upstream resolves a front window the host cannot prove — callers must treat
 *  the call as possibly touching any window. */
const argsWindowKey = (args: Record<string, unknown>): string | undefined => {
  const part = (value: unknown) => {
    const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof num === "number" && Number.isInteger(num) ? `${num}` : undefined;
  };
  const pid = part(args.pid), wid = part(args.window_id);
  return pid !== undefined && wid !== undefined ? `${pid}:${wid}` : undefined;
};

/** An observation call revokes the target window/desktop's actionable grants
 *  before it is even sent; the diff merge base is retained for merging the new
 *  observation. An unattributable target revokes every window's actionable
 *  grants (bases retained): reading any window advances the upstream read base. */
export function clearObservationGrant(grants: CuaGrants, remoteName: string, args: Record<string, unknown>): void {
  if (remoteName === "get_window_state") {
    const key = argsWindowKey(args);
    if (key) revokeActionable(grants, key);
    else {
      grants.pending = grants.pending.filter(pending => pending.kind === "desktop");
      for (const k of [...grants.windows.keys()]) revokeActionable(grants, k);
    }
  } else if (remoteName === "get_desktop_state") {
    grants.desktopScreenshot = false;
    grants.pending = grants.pending.filter(pending => pending.kind !== "desktop");
  }
}

/** Dispatching a batch revokes the target window's actionable grants: the
 *  actions may already have changed the UI so the old evidence is stale. Grants
 *  recover only from the batch's trailing or another delivered observation;
 *  the diff merge base is retained for upstream incremental merging. */
export function revokeActionable(grants: CuaGrants, key: string): void {
  grants.pending = grants.pending.filter(pending => pending.kind !== "windowHint" && (pending.kind !== "window" || pending.key !== key));
  const grant = grants.windows.get(key);
  if (!grant) return;
  delete grant.snapshot;
  delete grant.screenshot;
  if (grants.activeWindow === key) grants.activeWindow = undefined;
}

/** A remote observation result could not be delivered to the model
 *  (persistence or projection failure): the upstream read base already advanced
 *  but the content is invisible, so both grants and the base are dropped and
 *  later observations must rebuild. */
export function dropObservationBase(grants: CuaGrants, key: string): void {
  revokeActionable(grants, key);
  grants.windows.delete(key);
  if (grants.activeWindow === key) grants.activeWindow = undefined;
}

/** Drop grants and bases per the observation request's parameters; an
 *  unattributable target drops every window (the read base already advanced on
 *  whichever window upstream read). */
export function dropObservationGrant(grants: CuaGrants, args: Record<string, unknown>): void {
  const key = argsWindowKey(args);
  if (key) dropObservationBase(grants, key);
  else {
    grants.pending = grants.pending.filter(pending => pending.kind === "desktop");
    for (const k of [...grants.windows.keys()]) dropObservationBase(grants, k);
  }
}

/** Negative remote facts take effect immediately, even if their result is omitted. */
export function invalidateCuaSnapshots(grants: CuaGrants, state: Record<string, unknown>): void {
  for (const sid of Array.isArray(state.invalidated_snapshot_ids) ? state.invalidated_snapshot_ids : []) {
    if (typeof sid !== "string") continue;
    grants.invalidated.add(sid);
    grants.pending = grants.pending.filter(pending => pending.kind !== "window" || pending.state.snapshot_id !== sid);
    for (const grant of grants.windows.values()) {
      if (grant.snapshot?.sid === sid) delete grant.snapshot;
      if (grant.retained?.sid === sid) delete grant.retained;
      // A complete base is still needed to merge the replacement diff.
    }
  }
}

/** Row entries in a diff text: upstream emits `+ [n]` (added), `~ [n]` (changed)
 *  and `- [n]` (removed, id from the old sid) without indentation or a `- `
 *  prefix; `reindexed:`/headers and other lines are skipped. Returns normalized
 *  rows plus the row-id classification. */
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

/** Normalize-merge base rows with diff changed rows: changed/removed base rows
 *  drop out and changed rows append as `- [n]` lines. The resulting view has the
 *  same shape as the full markdown upstream stores and is usable for row
 *  checks; appended positions do not reflect real ancestors (callers record
 *  them as detached). */
const mergeDeliveredText = (base: string, diff: string): { merged: string; changed: Set<number>; removed: Set<number> } => {
  const { changed, removed, rows } = parseDiffRows(diff);
  const kept = base.split("\n").filter(line => {
    const match = /^[ \t]*- \[(\d+)\] /.exec(line);
    return !match || (!changed.has(Number.parseInt(match[1]!, 10)) && !removed.has(Number.parseInt(match[1]!, 10)));
  });
  return { merged: [...kept, ...rows].join("\n"), changed, removed };
};

/** Record a successful observation as grants: sid/invalidation/screenshot come
 *  from the structured result; text uses only delivered content.
 *  diff/no_change merges only when the resolved baseline the observation
 *  reports (`state.since`) equals the sid of the retained delivery base —
 *  upstream's actual diff baseline can be an intermediate snapshot produced by
 *  its batch locator reads or a model-requested sid, and with a mismatching
 *  baseline old row ids are meaningless — added and changed rows normalize into
 *  live rows, removed rows drop out of the merged view, and every row of a
 *  non-empty diff's merged view keeps a fabricated position (a diff carries no
 *  ancestors, so even kept rows' indentation chains cannot prove menu-route
 *  ancestry). A delivered text that was truncated, or a reread whose row ids
 *  were reindexed, cannot serve as a merge base either (lost change records
 *  would resurrect stale rows). */
export function grantWindowObservation(grants: CuaGrants, key: string, state: Record<string, unknown>, text: string, image: boolean, truncated = false): void {
  invalidateCuaSnapshots(grants, state);
  if (cuaObservationBlocked(state)) { dropObservationBase(grants, key); return; }
  const grant = grants.windows.get(key) ?? {};
  const sid = state.snapshot_id;
  if (typeof sid === "string" && sid && !grants.invalidated.has(sid)) {
    const diff = state.since_status === "diff" || state.since_status === "no_change";
    const changedOnly = () => {
      // Changed-rows-only view: no base, a mismatched baseline, a truncated
      // delivery or reindexed rows all forbid reusing old row ids.
      const { merged, changed } = mergeDeliveredText("", text);
      if (changed.size) grant.snapshot = { sid, text: merged, detached: changed };
      else delete grant.snapshot;
      delete grant.base;
    };
    if (!diff) {
      // Screenshot-style reread (include_accessibility_tree:false): upstream
      // keeps rows and tokens under the same sid, so when no rows arrive the
      // retained non-actionable view restores the actionable view — including
      // its detached provenance — and only the screenshot rule below refreshes.
      const treeless = !/^[ \t]*- \[\d+\] /m.test(text);
      if (sid === grant.retained?.sid && treeless) grant.snapshot = grant.retained;
      else if (!/^[ \t]*- (?:\[\d+\] )?AX\w+(?: |$)/m.test(text) && ![...text.matchAll(/["']s[0-9a-f]{8}:(\d+)["']/g)].some(match => tokenVisible(text, sid, Number.parseInt(match[1]!, 10)))) {
        // A cleared/empty projection is not an observation of the window.
        delete grant.snapshot;
        delete grant.base;
      }
      else {
        grant.snapshot = { sid, text };
        if (truncated) {
          // Missing ancestors cannot establish a menu row's real position.
          grant.snapshot.detached = new Set([...text.matchAll(/^[ \t]*- \[(\d+)\] /gm)].map(match => Number.parseInt(match[1]!, 10)));
          delete grant.base;
        }
        else grant.base = { sid, text };
      }
    } else if (grant.base && grant.base.sid === state.since && !truncated && !text.includes("reindexed:")) {
      const { merged, changed, removed } = mergeDeliveredText(grant.base.text, text);
      const detached = new Set(grant.base.detached ?? []);
      // A non-empty diff carries no ancestors: any changed or removed row can
      // alter kept rows' indentation chains, so no merged-view row can prove
      // menu ancestry by position (only no_change retains position trust).
      if (changed.size || removed.size) for (const match of merged.matchAll(/^[ \t]*- \[(\d+)\] /gm)) detached.add(Number.parseInt(match[1]!, 10));
      grant.snapshot = { sid, text: merged, detached };
      grant.base = { sid, text: merged, detached };
    } else {
      changedOnly();
    }
  }
  grant.retained = grant.snapshot;
  if (image && state.display_only !== true && state.on_current_space !== false) grant.screenshot = { ...(typeof state.capture_id === "string" ? { captureId: state.capture_id } : {}) };
  else if (state.screenshot_frame_valid === false || state.screenshot_error !== undefined) delete grant.screenshot;
  grants.windows.set(key, grant);
  // An empty observation (display_only etc.) grants nothing and must not steer
  // the context target toward an empty window.
  if (grant.snapshot || grant.screenshot) grants.activeWindow = key;
}

/** Activate pending observations whose tool results are inside the outgoing
 *  model request, in recorded order. Entries whose results were not delivered
 *  (e.g. dropped by context assembly) stay pending: only a later request that
 *  actually carries them can activate them. */
export function deliverCuaObservations(grants: CuaGrants, delivered: ReadonlyMap<string, CuaObservationProjection>): void {
  if (!grants.pending.length) return;
  const remaining: PendingObservation[] = [];
  for (const pending of grants.pending) {
    const projection = delivered.get(pending.opId);
    if (!projection) { remaining.push(pending); continue; }
    if (pending.kind === "window") grantWindowObservation(grants, pending.key, pending.state, projection.text, pending.image && projection.image, pending.truncated || projection.text !== pending.text);
    else if (pending.kind === "desktop") { if (pending.ok && projection.image) grants.desktopScreenshot = true; }
    else if (pending.kind === "windowHint") {
      const need = pending.need;
      grants.activeWindow = need.kind === "token" && need.sid ? tokenGrantWindow(grants, need.sid)?.[0] ?? grants.activeWindow
        : need.kind === "window" ? need.windowKey ?? grants.activeWindow : grants.activeWindow;
    }
  }
  grants.pending = remaining;
}
