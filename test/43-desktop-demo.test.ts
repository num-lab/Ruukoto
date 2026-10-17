import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { activityGroups, activitySummary } from "../apps/desktop/src/renderer/activity.ts";
import type { DiffTool } from "../apps/desktop/src/renderer/diff.ts";

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("正式 GUI 复用拥有者定稿样式、官方组件与侧栏交互，原生适配只追加", () => {
  const demo = ".scratch/desktop-shadcn/approved-demo-v4/src";
  const gui = "apps/desktop/src/renderer";
  const styles = read(`${gui}/style.css`);
  assert.ok(styles.startsWith(read(`${demo}/style.css`) + read(".scratch/desktop-shadcn/approved-demo-v4-glass.css")));
  assert.equal(read(".scratch/desktop-shadcn/demo/src/style.css"), read(`${demo}/style.css`) + read(".scratch/desktop-shadcn/approved-demo-v4-glass.css") + read(".scratch/desktop-shadcn/approved-demo-v4-rendering.css") + read(".scratch/desktop-shadcn/approved-demo-v4-polish.css") + read(".scratch/desktop-shadcn/approved-demo-v4-files-sidebar.css") + read(".scratch/desktop-shadcn/approved-demo-v4-browser-activity.css"));
  assert.ok(styles.includes(read(".scratch/desktop-shadcn/approved-demo-v4-rendering.css")));
  assert.ok(styles.endsWith(read(".scratch/desktop-shadcn/approved-demo-v4-browser-activity.css")));
  assert.match(styles, /\.command-code code\s*\{\s*white-space:\s*pre;/, "真实多行命令必须保留换行与缩进");
  for (const file of ["reference.css", "theme.css", "sidebar-resizer.tsx", "lib/utils.ts", "source-highlighting.ts"]) assert.equal(read(`${gui}/${file}`), read(`${demo}/${file}`), file);
  const primitives = fs.readdirSync(new URL(`../${demo}/components/ui/`, import.meta.url)).sort();
  assert.deepEqual(fs.readdirSync(new URL(`../${gui}/components/ui/`, import.meta.url)).sort(), primitives);
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
