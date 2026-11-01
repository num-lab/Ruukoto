import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { activityGroups, activitySummary } from "../apps/desktop/src/renderer/activity.ts";
import type { DiffTool } from "../apps/desktop/src/renderer/diff.ts";

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("Desktop preserves approved styles and primitives except explicitly superseded settings and selector scope", () => {
  const demo = "test/fixtures/desktop-baselines/approved-demo-v4/src";
  const gui = "apps/desktop/src/renderer";
  const styles = read(`${gui}/style.css`);
  const approved = read(`${demo}/style.css`);
  // Note: See .agents/notes/implemented/feature/2026-10-28-desktop-settings-demo-design.md
  const retiredSettings = approved.slice(approved.indexOf(".settings-dialog .settings-tabs {"), approved.indexOf('.settings-dialog [data-slot="dialog-close"]'));
  const retiredSettingsMedia = approved.split("\n").find(line => line.startsWith("@media (max-width: 540px) { .settings-dialog .settings-tabs {"));
  assert.ok(retiredSettings && retiredSettingsMedia);
  // Scheduled reuses the mode selector outside the composer's narrow container.
  const currentBaseline = approved.replace(retiredSettings, "").replace(retiredSettingsMedia, "")
    .replace("  .mode-selector > svg {", "  .composer .mode-selector > svg {")
    .replace("  .mode-selector-label {", "  .composer .mode-selector-label {");
  let approvedOffset = 0;
  for (const line of (currentBaseline + read("test/fixtures/desktop-baselines/approved-demo-v4-glass.css")).split("\n")) {
    const next = styles.indexOf(line, approvedOffset);
    assert.ok(next >= 0, `定稿样式须保持原文和顺序：${line}`);
    approvedOffset = next + line.length;
  }
  assert.equal(read("verification/desktop-demo/src/style.css"), (read(`${demo}/style.css`) + read("test/fixtures/desktop-baselines/approved-demo-v4-glass.css") + read("test/fixtures/desktop-baselines/approved-demo-v4-rendering.css") + read("test/fixtures/desktop-baselines/approved-demo-v4-polish.css") + read("test/fixtures/desktop-baselines/approved-demo-v4-files-sidebar.css") + read("test/fixtures/desktop-baselines/approved-demo-v4-browser-activity.css") + read("test/fixtures/desktop-baselines/approved-demo-v4-completed-trace.css") + read("test/fixtures/desktop-baselines/approved-demo-v4-connection-loading.css")).replaceAll("../../../../node_modules/", "../../../node_modules/"));
  assert.ok(styles.includes(read("test/fixtures/desktop-baselines/approved-demo-v4-rendering.css")));
  assert.ok(styles.includes(read("test/fixtures/desktop-baselines/approved-demo-v4-completed-trace.css")));
  assert.ok(styles.includes(read("test/fixtures/desktop-baselines/approved-demo-v4-connection-loading.css")), "保留定稿加载样式，正式功能覆盖继续追加");
  assert.ok(styles.lastIndexOf("transition-property: rotate") > styles.lastIndexOf("transition: transform 150ms"), "工作区箭头的 rotate 过渡必须晚于冻结前缀里匹配不到 rotate 的 transform 过渡");
  assert.equal(read(`${gui}/connection-loading.tsx`), read("verification/desktop-demo/src/connection-loading.tsx"), "加载展示组件逐字同步，模拟计时器留在 Demo App");
  assert.match(styles, /\.command-code code\s*\{\s*white-space:\s*pre;/, "真实多行命令必须保留换行与缩进");
  for (const file of ["reference.css", "theme.css", "sidebar-resizer.tsx", "lib/utils.ts", "source-highlighting.ts"]) assert.equal(read(`${gui}/${file}`), read(`${demo}/${file}`), file);
  const primitives = fs.readdirSync(new URL(`../${demo}/components/ui/`, import.meta.url)).sort();
  assert.deepEqual(fs.readdirSync(new URL(`../${gui}/components/ui/`, import.meta.url)).sort(), [...primitives, "switch.tsx"].sort());
  for (const name of primitives) {
    const file = `components/ui/${name}`;
    const source = read(`${demo}/${file}`).replace(/(["'])@\/([^"']+)\1/g, (_match, quote: string, target: string) => {
      const resolved = [target, `${target}.ts`, `${target}.tsx`].find(candidate => fs.existsSync(new URL(`../${demo}/${candidate}`, import.meta.url)));
      assert.ok(resolved, `未解析的组件别名：${target}`);
      const relative = path.posix.relative(path.posix.dirname(file), resolved);
      return `${quote}${relative.startsWith(".") ? relative : `./${relative}`}${quote}`;
    });
    assert.equal(read(`${gui}/${file}`), source, file);
  }
});
test("工具摘要只列实际活动类别，覆盖真实 bash，SubAgent 独立于相邻工具组", () => {
  const tool = (key: string, name: string, target = "file.ts"): DiffTool => ({ kind: "tool", key, name, target, at: "", seq: 0, toolOpId: key, toolCallId: key, params: {}, status: "done", summary: null, entryId: key, paramsTruncated: false, artifactIds: [] });
  const items = [tool("a", "read"), tool("b", "edit"), tool("c", "edit"), tool("d", "subagent_delegate"), tool("e", "write", "other.ts")];
  assert.equal(activitySummary(items), "Read files, edited files, wrote files");
  assert.deepEqual(activityGroups(items).map(group => group.map(item => item.key)), [["a", "b", "c"], ["d"], ["e"]]);
  assert.equal(activitySummary([tool("read", "Grep"), tool("run", "bash", "npm test"), tool("edit", "Edit"), tool("write", "WRITE")]), "Read files, ran commands, edited files, wrote files");
  assert.equal(activitySummary([tool("run", "bash")]), "Ran commands");
  assert.equal(activitySummary([tool("unknown", "plugin_action")]), "工具活动");
  assert.equal(activitySummary([]), "工具活动");
});
