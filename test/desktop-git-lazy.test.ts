import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Git graph 接近末尾自动追加，隐藏、错误、加载中及失效观察均不重复请求", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync(process.execPath, ["test/fixtures/desktop/observer-repro.mjs", root], { cwd: root, stdio: "pipe", timeout: 15000 });
});
