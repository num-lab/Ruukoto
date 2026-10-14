// 起 ruukoto-code 开发后台，新开工作区会话，完全访问提交一句不调工具的消息，导出 prompt 快照。
// 用法：npx tsx .scratch/agent-facing-text/evidence/reviews/snapshot-capture.mts（先按行内常量改工作区路径与输出目录）。
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { devProfileFor, buildChildEnv } from "../../../../packages/tui/src/dev.ts";
import { ControlClient } from "../../../../packages/control/src/client.ts";
const repo = "/Users/eitrous/Developer/ruukoto";
const profile = devProfileFor(repo, undefined, "ruukoto-code");
const env = buildChildEnv(process.env, profile);
fs.mkdirSync(profile.logsDir, { recursive: true });
const log = fs.openSync("/tmp/aft/backend.log", "w");
const child = childProcess.spawn(process.execPath, [path.join(repo, "apps/ruukoto-code/bin/ruukoto-code.mjs"), "server", "--data-dir", profile.dataDir, "--agent-dir", profile.agentDir], { cwd: repo, env, stdio: ["ignore", log, log] });
const sock = path.join(profile.controlDir, "control.sock");
const token = fs.readFileSync(path.join(profile.controlDir, "owner.token"), "utf8").trim();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let c: ControlClient | null = null;
try {
  for (let i = 0; i < 60 && !c; i++) { await sleep(1000); try { c = await ControlClient.connect(sock); await c.authenticate(token); } catch { c = null; } }
  if (!c) throw new Error("后台未就绪");
  const ws: any = await c.request("open_workspace", { cwd: "/Users/eitrous/Developer/Temp", request_id: `aft_${Date.now()}` });
  const sessionId = ws.session?.id ?? ws.sessionId ?? ws.session_id;
  console.log("workspace", JSON.stringify(ws).slice(0, 300));
  const sub: any = await c.request("submit", { session_id: sessionId, request_id: `aft_${Date.now()}`, input: "只回复 OK 两个字母，不要调用任何工具。", access_mode: "full_access", model_selection: { provider: "magpie", modelId: "mirasim/deepseek-flash", thinkingLevel: "off" } });
  console.log("submit", JSON.stringify(sub).slice(0, 300));
  let recs: any = null;
  for (let i = 0; i < 120; i++) { await sleep(2000); recs = await c.request("list_selection_records", { session_id: sessionId }); if (recs.records?.length && recs.records[0].promptArtifactId) break; }
  fs.writeFileSync("/tmp/aft/records.json", JSON.stringify(recs, null, 2));
  const rec = recs.records[0];
  const parts: Buffer[] = []; let offset = 0;
  for (;;) { const r: any = await c.request("read_prompt_snapshot", { record_id: rec.id, session_id: sessionId, offset, length: 256 * 1024 }); const b = Buffer.from(r.data, "base64"); parts.push(b); offset += b.length; if (!b.length || offset >= r.artifact.byteCount) break; }
  fs.writeFileSync("/tmp/aft/snapshot.json", Buffer.concat(parts));
  const task: any = await c.request("get_task", { task_id: rec.taskId });
  console.log("task", task.task?.status, task.task?.accessMode, "session", sessionId);
} finally { c?.close(); child.kill("SIGTERM"); await sleep(3000); }
