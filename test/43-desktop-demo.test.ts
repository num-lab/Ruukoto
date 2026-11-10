import assert from "node:assert/strict";
import { test } from "node:test";
import { activityGroups, activitySummary } from "../apps/desktop/src/renderer/activity.ts";
import type { DiffTool } from "../apps/desktop/src/renderer/diff.ts";

test("工具摘要只列实际活动类别，覆盖真实 bash，SubAgent 独立于相邻工具组", () => {
  const tool = (key: string, name: string, target = "file.ts"): DiffTool => ({ kind: "tool", key, name, target, at: "", seq: 0, toolOpId: key, toolCallId: key, params: {}, status: "done", summary: null, entryId: key, paramsTruncated: false, artifactIds: [] });
  const items = [tool("a", "read"), tool("b", "edit"), tool("c", "edit"), tool("d", "subagent_delegate"), tool("e", "write", "other.ts")];
  assert.equal(activitySummary(items), "Read files, edited files, wrote files");
  assert.deepEqual(activityGroups(items).map(group => group.map(item => item.key)), [["a", "b", "c"], ["d"], ["e"]]);
  assert.equal(activitySummary([tool("read", "Grep"), tool("run", "bash", "npm test"), tool("edit", "Edit"), tool("write", "WRITE")]), "Read files, ran commands, edited files, wrote files");
  assert.equal(activitySummary([tool("run", "bash")]), "Ran commands");
  assert.equal(activitySummary([tool("unknown", "plugin_action")]), "Tool activity");
  assert.equal(activitySummary([]), "Tool activity");
});
