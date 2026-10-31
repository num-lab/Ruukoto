import assert from "node:assert/strict";
import { test } from "node:test";
import { clearObservationGrant, freshCuaGrants, grantWindowObservation, requireCuaEligibility } from "@ruukoto/agent/mcp/cua-observation.ts";
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
