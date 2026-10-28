import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";

const homes = new WeakMap<TestContext, string>();

/** 先登记资源清理，再调用本函数，使 HOME 在资源关闭后恢复。 */
export function isolateSkillHome(t: TestContext): string {
  const current = homes.get(t);
  if (current) return current;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-skill-home-"))), previous = process.env.HOME;
  process.env.HOME = home;
  homes.set(t, home);
  t.after(() => {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}
