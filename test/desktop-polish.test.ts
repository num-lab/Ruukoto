import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Tab 拖动、落下、取消后旧位置 hover 暂停，指针移动恢复且键盘焦点保留", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync(process.execPath, [`.scratch/desktop-shadcn/evidence/polish-history/tab-hover-repro.mjs`, root], { cwd: root, stdio: "pipe", timeout: 15000 });
});
