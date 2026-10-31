import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const [name, file] of [
  ["Tab 离开、重进与取消的整个拖动周期不让源项回程重叠", "tab-drag-lifecycle-repro.mjs"],
  ["消息 Markdown 缓存保留前置路径绑定及实时内容、附件和子会话更新", "conversation-cache-repro.mjs"],
  ["隐藏文件树的实际组件不产生目录读取", "hidden-files-repro.mjs"],
  ["消息渲染只读取一次有序 flow，不逐条重新排序", "render-repro.mts"],
]) test(name, () => {
  execFileSync(process.execPath, [...(file.endsWith(".mts") ? ["--import", "tsx"] : []), `${root}test/fixtures/desktop/${file}`, root], { cwd: root, stdio: "pipe", timeout: 15000 });
});
