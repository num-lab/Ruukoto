import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("文件树加载状态在图标中呈现，完成后展开、失败可重试、取消与缓存刷新保持意图", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync(process.execPath, ["test/fixtures/desktop/file-tree-repro.mjs", root], { cwd: root, stdio: "pipe", timeout: 20000 });
});
