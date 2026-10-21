// 原生两壳使用真实控制面与合成历史，不连接日常档案或真实模型。
import fs from "node:fs";
import path from "node:path";
import { startTestRuntime } from "../../../test/helpers/testkit.ts";
import { product } from "../../../apps/ruukoto-code/src/product.ts";

const t = await startTestRuntime("spotlight-native", async () => { throw new Error("原生搜索验收不调用模型"); }, { config: { product: product.runtime } });
const control = fs.mkdtempSync("/tmp/ruukoto-search-");
fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(control, "owner.token"));
fs.symlinkSync(t.runtime.socketPath(), path.join(control, "control.sock"));
const sessions = [];
for (let index = 0; index < 2; index++) {
  const opened = await t.runtime.openWorkspace({ cwd: t.work[index] });
  const name = index ? "已存档 needle 会话：" + "很长的名称 ".repeat(12) : "原生验收 needle 会话";
  t.runtime.store.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(index ? "Beta" : "Alpha", opened.session.projectId);
  t.runtime.store.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, opened.session.id);
  if (index) t.runtime.store.setSessionArchived(opened.session.id, true);
  const file = path.join(t.dirs.dataDir, `${opened.session.id}.jsonl`);
  const entries = Array.from({ length: 80 }, (_, at) => ({ type: "message", id: `native-${index}-${at}`, parentId: null, timestamp: new Date(Date.now() - (at + 1) * 60_000).toISOString(), message: { role: at % 2 ? "assistant" : "user", content: [{ type: "text", text: `needle 中文搜索验收 第 ${at + 1} 条。` + "预览保持单行，不影响工作区和相对时间。".repeat(8) }] } }));
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  t.runtime.store.setSessionFile(opened.session.id, file);
  sessions.push({ id: opened.session.id, name, archived: !!index });
}
const result = { root: t.dirs.root, dataDir: t.dirs.dataDir, agentDir: t.dirs.agentDir, controlDir: control, sessions };
fs.writeFileSync(path.join(t.dirs.root, "native-search-config.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(JSON.stringify(result) + "\n");
await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
await t.shutdown();
fs.rmSync(control, { recursive: true, force: true });
