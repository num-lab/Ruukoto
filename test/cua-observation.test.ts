import assert from "node:assert/strict";
import { test } from "node:test";
import { clearObservationGrant, dropObservationBase, dropObservationGrant, freshCuaGrants, grantWindowObservation, requireCuaEligibility, revokeActionable } from "@ruukoto/agent/mcp/cua-observation.ts";
import { McpError } from "@ruukoto/agent/mcp/transport.ts";
import { cuaBatchSummary } from "@ruukoto/view/cua-batch.ts";

const TREE_TEXT = `snapshot s00000001\n- [14] AXButton "保存"\n- [20] AXTextField "名称"`;
const state = (extra: Record<string, unknown> = {}) => ({ pid: 42, window_id: 7, snapshot_id: "s00000001", ...extra });
const denied = (grants: ReturnType<typeof freshCuaGrants>, name: string, args: Record<string, unknown>, label: string) =>
  assert.throws(() => requireCuaEligibility(grants, name, args), (error: unknown) => error instanceof McpError && error.code === "cua_observation_required", label);

test("观察资格：树内元素可写、坐标需截图、谓词与过期内容不授权", () => {
  const grants = freshCuaGrants();
  // 纯树观察（无截图交付）：元素动作可用，坐标动作不可用
  grantWindowObservation(grants, "42:7", state(), TREE_TEXT, false);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:14" });
  requireCuaEligibility(grants, "type_text", { pid: 42, window_id: 7, text: "hi" });
  denied(grants, "click", { pid: 42, window_id: 7, x: 10, y: 20 }, "树内观察不放行坐标");
  // 截断投影的元素不在已交付文本中
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:99" }, "未交付的行不授权");
  // 窗口不匹配
  denied(grants, "click", { pid: 42, window_id: 8, element_token: "s00000001:14" }, "令牌与指定窗口不一致");
  denied(grants, "click", { pid: 43, window_id: 7, x: 1, y: 2 }, "另一窗口无观察");
  // 失效公告作废旧快照
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000002", invalidated_snapshot_ids: ["s00000001"] }), `snapshot s00000002\n- [5] AXButton "新"`, false);
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:14" }, "已失效快照不授权");
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000002:5" });
  // 截图交付后坐标可用
  grantWindowObservation(grants, "42:7", state({ capture_id: "cap-1" }), "画面", true);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, x: 10, y: 20 });
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, x: 10, y: 20, capture_id: "cap-1" });
  denied(grants, "click", { pid: 42, window_id: 7, x: 10, y: 20, capture_id: "cap-old" }, "过期帧不授权");
  // display_only 观察不建立新截图帧（既有保留帧仍按上游语义可用）
  const displayOnly = freshCuaGrants();
  grantWindowObservation(displayOnly, "42:7", state({ display_only: true }), "画面", true);
  denied(displayOnly, "click", { pid: 42, window_id: 7, x: 10, y: 20 }, "仅有 display_only 帧不能定位输入");
  // 锁屏/AX 未决不授权
  grantWindowObservation(grants, "42:7", state({ degraded_reason: "screen_locked" }), "", false);
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000002:5" }, "锁屏观察不授权");
  grantWindowObservation(grants, "42:7", state({ degraded_reason: "ax_window_unresolved" }), "", false);
  denied(grants, "type_text", { pid: 42, window_id: 7, text: "hi" }, "AX 未决不授权");
});

test("观察资格：重读尝试即失效，批次要求窗口已观察且逐步达标", () => {
  const grants = freshCuaGrants();
  grantWindowObservation(grants, "42:7", state({ capture_id: "cap-1" }), TREE_TEXT, true);
  // 新观察请求发送前已失效旧授权
  clearObservationGrant(grants, "get_window_state", { pid: 42, window_id: 7 });
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:14" }, "重读尝试使旧观察失效");
  // 未观察窗口的批次整体拒绝
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { x: 1, y: 2 } }], pid: 43, window_id: 9, observe: {} }, "未观察窗口不能批次");
  // 树内批次：元素步骤通过、坐标步骤拒绝
  grantWindowObservation(grants, "42:7", state(), TREE_TEXT, false);
  requireCuaEligibility(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000001:14" } }, { tool: "type_text", args: { text: "hi" } }], pid: 42, window_id: 7, observe: {} });
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { x: 1, y: 2 } }], pid: 42, window_id: 7, observe: {} }, "批次坐标步骤需要截图");
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000002:1" } }], pid: 42, window_id: 7, observe: {} }, "他快照令牌不进批次窗口");
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { from_zoom: true, x: 1, y: 2 } }], pid: 42, window_id: 7, observe: {} }, "zoom 参照不可授权");
  // 截图交付后坐标步骤通过
  grantWindowObservation(grants, "42:7", state({ capture_id: "cap-1" }), "画面", true);
  requireCuaEligibility(grants, "run_steps", { steps: [{ tool: "click", args: { x: 1, y: 2 } }, { tool: "scroll", args: { direction: "down" } }], pid: 42, window_id: 7, observe: {} });
  // 桌面坐标需要桌面截图
  denied(grants, "click", { scope: "desktop", x: 1, y: 2 }, "桌面截图未交付");
  grants.desktopScreenshot = true;
  requireCuaEligibility(grants, "click", { scope: "desktop", x: 1, y: 2 });
  clearObservationGrant(grants, "get_desktop_state", {});
  denied(grants, "click", { scope: "desktop", x: 1, y: 2 }, "桌面重读即失效");
});

test("观察资格：令牌按完整形态与行首索引计数，子串与标签文本不授权", () => {
  const grants = freshCuaGrants();
  // 只交付 s00000001:140 一行：前缀相同的 :14 不得授权；标签内 [99] 不算行
  grantWindowObservation(grants, "42:7", state(), `snapshot s00000001\n- [140] AXButton "确定" s00000001:140\n- [141] AXTextField "[99] 折扣"`, false);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:140" });
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:14" }, "令牌前缀不等于交付");
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:99" }, "标签内的 [99] 不是索引行");
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:1" }, "截取前缀不授权");
});

test("观察资格：增量读保留交付基线，批次派发撤销授权，未交付观察清基线", () => {
  const grants = freshCuaGrants();
  grantWindowObservation(grants, "42:7", state(), TREE_TEXT, false);
  // no_change 增量读换新 sid：旧令牌作废，未变化行在新 sid 下仍可操作
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000002", invalidated_snapshot_ids: ["s00000001"], since: "s00000001", since_status: "no_change" }), "no change since s00000001. Rows and indices are as before; use snapshot_id s00000002 in element_tokens.", false);
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:14" }, "旧快照令牌失效");
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000002:14" });
  // diff 合并新增行（上游格式：+ 新增 / ~ 变更 / - 移除）
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000003", invalidated_snapshot_ids: ["s00000002"], since: "s00000002", since_status: "diff" }), "since s00000002: 1 added, 1 changed, 1 removed. Use element_tokens s00000003:N\n+ [30] AXButton \"新增\"\n~ [20] AXTextField \"名称改\"\n- [14] AXButton \"保存\"", false);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000003:30" });
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000003:20" });
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000003:14" }, "已移除行不算交付");
  // 重排行的增量读丢弃基线，只认规范化后的变更行
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000004", invalidated_snapshot_ids: ["s00000003"], since: "s00000003", since_status: "diff" }), "since s00000003: 0 added, 1 changed, 0 removed.\n~ [5] AXButton \"新\"\nreindexed: [6-9] -> [7-10]", false);
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000004:20" }, "重排后基线不续用");
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000004:5" });
  // 批次派发撤销可操作授权但保留基线：旧令牌与新 sid 行都不可用，直到新观察交付
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000005" }), "snapshot s00000005\n- [7] AXButton \"批前\"", false);
  revokeActionable(grants, "42:7");
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000005:7" }, "派发后旧授权作废");
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000006", invalidated_snapshot_ids: ["s00000005"], since: "s00000005", since_status: "diff" }), "since s00000005: 1 added, 0 changed, 0 removed.\n+ [8] AXButton \"批后\"", false);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000006:7" });
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000006:8" });
  // 结果未交付的观察连基线一起清除：后续增量读不续用旧行
  revokeActionable(grants, "42:7");
  dropObservationBase(grants, "42:7");
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000007", since: "s00000006", since_status: "diff" }), "since s00000006: 1 added, 0 changed, 0 removed.\n+ [9] AXButton \"仅新行\"", false);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000007:9" });
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000007:7" }, "基线已清不复活旧行");
});

test("观察资格：菜单栏元素令牌不授权批次 click（钉版驱动隐式改执行为 invoke_menu）", () => {
  const grants = freshCuaGrants();
  // 树形与上游 menu_path_in 测试夹具一致：菜单项经 AXMenu/AXMenuBarItem 链抵 AXMenuBar
  const menuTree = `snapshot s00000001\n- [0] AXWindow "Doc"\n  - [3] AXButton "OK"\n- [27] AXMenuBar\n  - [700] AXMenuBarItem "Sheet" [actions=[press]]\n    - [701] AXMenu\n      - [760] AXMenuItem "Navigate" [actions=[press]]\n        - [761] AXMenu\n          - [771] AXMenuItem "To Next Sheet" [actions=[press]]\n      - [780] AXMenuItem "Delete Sheet..."`;
  grantWindowObservation(grants, "42:7", state(), menuTree, false);
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000001:771" } }], pid: 42, window_id: 7, observe: {} }, "菜单项令牌的 click 会触发 invoke_menu 路由");
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000001:700" } }], pid: 42, window_id: 7, observe: {} }, "菜单栏项同样拒绝");
  // 窗口内的普通行不受影响；非 click 步骤与直接调用不经该路由，仍按元素令牌授权
  requireCuaEligibility(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000001:3" } }, { tool: "double_click", args: { element_token: "s00000001:771" } }], pid: 42, window_id: 7, observe: {} });
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:771" });
  // 菜单角色的行但祖先链不完整（非菜单栏成员）→ 上游不改路由，交付文本可证则放行
  const popupTree = `snapshot s00000002\n- [0] AXWindow "Doc"\n  - [9] AXGroup "菜单"\n    - [10] AXMenuItem "项"`;
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000002", invalidated_snapshot_ids: ["s00000001"] }), popupTree, false);
  requireCuaEligibility(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000002:10" } }], pid: 42, window_id: 7, observe: {} });
});

test("观察资格：diff 追加行的菜单祖先不可证明即拒，截断观察不作合并基线", () => {
  const grants = freshCuaGrants();
  grantWindowObservation(grants, "42:7", state(), "- [0] AXWindow \"Doc\"\n  - [3] AXButton \"OK\"", false);
  // diff 新增菜单行：变更行不携带祖先（上游按存储全文判定路由），宿主只能按菜单角色拒绝
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000002", invalidated_snapshot_ids: ["s00000001"], since: "s00000001", since_status: "diff" }),
    "since s00000001: 1 added, 0 changed, 0 removed.\n+ [5] AXMenuItem \"To Next Sheet\"", false);
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000002:5" } }], pid: 42, window_id: 7, observe: {} }, "diff 追加的菜单行祖先不可证明");
  requireCuaEligibility(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000002:3" } }], pid: 42, window_id: 7, observe: {} });
  // 未变化的菜单栏基线行经合并视图仍按真实祖先拒绝
  const grants2 = freshCuaGrants();
  grantWindowObservation(grants2, "42:7", state(), "- [0] AXWindow \"Doc\"\n  - [3] AXButton \"OK\"\n- [27] AXMenuBar\n  - [700] AXMenuBarItem \"Sheet\"", false);
  grantWindowObservation(grants2, "42:7", state({ snapshot_id: "s00000002", since: "s00000001", since_status: "no_change" }), "no change since s00000001.", false);
  denied(grants2, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000002:700" } }], pid: 42, window_id: 7, observe: {} }, "未变化菜单行仍按基线祖先拒绝");
  // 交付文本被截断的全量读授权可见行，但不作 diff 基线
  const grants3 = freshCuaGrants();
  grantWindowObservation(grants3, "42:7", state(), "- [0] AXWindow \"Doc\"\n  - [3] AXButton \"OK\"", false, true);
  grantWindowObservation(grants3, "42:7", state({ snapshot_id: "s00000002", since: "s00000001", since_status: "diff" }),
    "since s00000001: 1 added, 0 changed, 0 removed.\n+ [9] AXButton \"新\"", false);
  denied(grants3, "click", { pid: 42, window_id: 7, element_token: "s00000002:3" }, "截断基线不续用旧行");
  requireCuaEligibility(grants3, "click", { pid: 42, window_id: 7, element_token: "s00000002:9" });
});

test("批次审批摘要：有序步骤、目标与末尾观察覆盖整批", () => {
  const lines = cuaBatchSummary({ steps: [
    { tool: "click", args: { element_token: "s00000001:14" } },
    { tool: "type_text", args: { element_token: "s00000001:20", text: "你好世界", delivery_mode: "foreground" } },
    { tool: "hotkey", args: { keys: ["cmd", "s"] } },
  ], pid: 42, window_id: 7, observe: { include_screenshot: false } })!;
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /click.*s00000001:14/);
  assert.match(lines[1]!, /type_text.*你好世界.*foreground/);
  assert.match(lines[2]!, /hotkey.*cmd\+s/);
  assert.match(lines[3]!, /pid 42.*window_id 7/);
  assert.match(lines[4]!, /末尾观察/);
  assert.equal(cuaBatchSummary({ steps: "x" }), null);
  assert.equal(cuaBatchSummary("x"), null);
});

test("观察资格：目标不可归属的重读撤销全部授权，未交付清除全部基线", () => {
  const grants = freshCuaGrants();
  grantWindowObservation(grants, "42:7", state(), "- [0] AXWindow \"Doc\"\n  - [3] AXButton \"A\"", false);
  grantWindowObservation(grants, "42:9", state(), "- [0] AXWindow \"Doc\"\n  - [5] AXButton \"B\"", false);
  // 上游对缺省 pid/window_id 的重读解析前台窗口：不可归属即撤销全部可操作授权
  clearObservationGrant(grants, "get_window_state", {});
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:3" }, "42:7 授权已被不可归属重读撤销");
  denied(grants, "click", { pid: 42, window_id: 9, element_token: "s00000001:5" }, "42:9 授权同样撤销");
  // 明确目标的撤销仍只作用于该窗口
  grantWindowObservation(grants, "42:7", state(), "- [0] AXWindow \"Doc\"\n  - [3] AXButton \"A\"", false);
  grantWindowObservation(grants, "42:9", state(), "- [0] AXWindow \"Doc\"\n  - [5] AXButton \"B\"", false);
  clearObservationGrant(grants, "get_window_state", { pid: 42, window_id: 7 });
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:3" }, "目标窗口撤销");
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 9, element_token: "s00000001:5" });
  // 不可归属的未交付观察清除全部基线：后续 diff 不续用任何旧行
  grantWindowObservation(grants, "42:7", state(), "- [0] AXWindow \"Doc\"\n  - [3] AXButton \"A\"", false);
  dropObservationGrant(grants, {});
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000002", since: "s00000001", since_status: "diff" }), "since s00000001: 1 added, 0 changed, 0 removed.\n+ [9] AXButton \"新\"", false);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000002:9" });
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000002:3" }, "基线全清不复活旧行");
});

test("观察资格：diff 基线与上游已解析基线不符时不续用旧行", () => {
  const grants = freshCuaGrants();
  grantWindowObservation(grants, "42:7", state(), "- [0] AXWindow \"Doc\"\n  - [3] AXButton \"OK\"", false);
  // 上游 diff 的实际基线是批次内定位器读产生的中间快照（since 已解析为 s00000006），
  // 与交付基线 s00000001 不符：no_change 不能让旧行在新 sid 下复活
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000009", since: "s00000006", since_status: "no_change" }), "no change since s00000006.", false);
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000009:3" }, "基线不符的 no_change 不复活旧行");
  // 匹配基线的合并仍正常工作
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000010" }), "- [0] AXWindow \"Doc\"\n  - [4] AXButton \"新基线\"", false);
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000011", since: "s00000010", since_status: "no_change" }), "no change since s00000010.", false);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000011:4" });
});

test("观察资格：elements 格式令牌不可证非菜单，批次 click 拒绝", () => {
  const grants = freshCuaGrants();
  // elements 格式交付 JSON 数组（含 element_token，无 markdown 行）
  grantWindowObservation(grants, "42:7", state(), `{"elements":[{"element_token":"s00000001:5","role":"AXMenuItem","label":"Delete"}]}`, false);
  // 令牌真实交付：不经菜单路由的动作仍授权
  requireCuaEligibility(grants, "double_click", { pid: 42, window_id: 7, element_token: "s00000001:5" });
  // 批次 click 须在交付文本中找到可判定行；无行即非菜单不可证明，拒绝
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000001:5" } }], pid: 42, window_id: 7, observe: {} }, "elements 格式令牌不授权批次 click");
});

test("观察资格：桌面 scope 带窗口目标按窗口内坐标判定，标签令牌字样不算交付", () => {
  const grants = freshCuaGrants();
  grants.desktopScreenshot = true;
  // 上游在带 pid/window_id 时忽略 scope:"desktop" 按窗口内坐标执行：需窗口截图而非桌面截图
  denied(grants, "click", { scope: "desktop", pid: 42, window_id: 7, x: 10, y: 20 }, "窗口内坐标需窗口截图");
  grantWindowObservation(grants, "42:7", state(), "- [0] AXWindow \"Doc\"", false);
  denied(grants, "click", { scope: "desktop", pid: 42, window_id: 7, x: 10, y: 20 }, "树观察无截图仍不授权坐标");
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000002" }), "- [0] AXWindow \"Doc\"", true);
  requireCuaEligibility(grants, "click", { scope: "desktop", pid: 42, window_id: 7, x: 10, y: 20 });
  // 无窗口目标的桌面坐标仍按桌面截图授权
  requireCuaEligibility(grants, "click", { scope: "desktop", x: 10, y: 20 });
  // 应用标签内的 sid:row 字样（无 element_token 字段上下文）不构成交付
  const grants2 = freshCuaGrants();
  grantWindowObservation(grants2, "42:7", state(), '- [0] AXWindow "Doc"\n  - [3] AXStaticText "参考 s00000001:9"', false);
  denied(grants2, "click", { pid: 42, window_id: 7, element_token: "s00000001:9" }, "标签内令牌字样不算交付");
  requireCuaEligibility(grants2, "click", { pid: 42, window_id: 7, element_token: "s00000001:3" });
});

test("观察资格：diff 变更祖先行后合并视图不再凭位置判定菜单，截图式重读保留快照", () => {
  const grants = freshCuaGrants();
  const menuBase = "- [0] AXWindow \"Doc\"\n- [27] AXMenuBar\n  - [700] AXMenuBarItem \"Sheet\"\n    - [701] AXMenu\n      - [771] AXMenuItem \"Next\"";
  grantWindowObservation(grants, "42:7", state(), menuBase, false);
  // diff 变更 AXMenuBar 行：上游按存储全文判 [771] 仍属菜单链，但合并视图中 [27] 移到尾部、
  // [771] 的缩进祖先链断裂——非空 diff 后全部行位置不可凭，菜单角色行一律按可路由拒绝
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000002", since: "s00000001", since_status: "diff" }),
    "since s00000001: 0 added, 1 changed, 0 removed.\n~ [27] AXMenuBar", false);
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000002:771" } }], pid: 42, window_id: 7, observe: {} }, "合并视图祖先链断裂的菜单行即拒");
  requireCuaEligibility(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000002:0" } }], pid: 42, window_id: 7, observe: {} });
  // 截图式重读（同 sid、无行文本）：上游保留行与令牌，只刷新截图
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000002", capture_id: "cap9" }), "", true);
  denied(grants, "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000002:771" } }], pid: 42, window_id: 7, observe: {} }, "截图重读不清空可操作视图");
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000002:0" });
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, x: 10, y: 20 });
  // diff 基线同样保留：后续匹配的 diff 仍正常合并
  grantWindowObservation(grants, "42:7", state({ snapshot_id: "s00000003", since: "s00000002", since_status: "diff" }),
    "since s00000002: 1 added, 0 changed, 0 removed.\n+ [9] AXButton \"新\"", false);
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000003:9" });
});

test("观察资格：行标记与上游 `- [N] ` 同形，变体形态不算交付", () => {
  const grants = freshCuaGrants();
  grantWindowObservation(grants, "42:7", state(), "- [0] AXWindow\n-[4] AXButton \"A\"\n-  [5] AXButton \"B\"\n- [6]", false);
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:4" }, "无空格不算行标记");
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:5" }, "双空格不算行标记");
  denied(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:6" }, "无尾随内容不算行标记");
  requireCuaEligibility(grants, "click", { pid: 42, window_id: 7, element_token: "s00000001:0" });
});
