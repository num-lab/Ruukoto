import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { startTestRuntime, waitFor } from "../../../test/helpers/testkit.ts";
import { product } from "../../../apps/ruukoto-code/src/product.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
const root = process.cwd();
const desktopControl = fs.mkdtempSync("/tmp/d06-control-");
const t = await startTestRuntime("d06-gui", async req => {
  const lastUser = req.messages.map(item => item.role).lastIndexOf("user");
  if (!req.messages.slice(lastUser + 1).some(item => item.role === "tool")) return { kind: "tool_calls", calls: [{ id: "gate", name: "mock_gate", arguments: { note: "桌面审批参数：中文👩‍💻" } }] };
  return { kind: "text", text: "审批决定已收到。" };
}, { config: { product: product.runtime } });
const dir = path.join(t.dirs.root, "gui"); fs.mkdirSync(dir);
fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(desktopControl, "owner.token"));
fs.symlinkSync(t.runtime.socketPath(), path.join(desktopControl, "control.sock"));
const opened = await t.runtime.openWorkspace({ cwd: t.work[0] });
const session = await t.runtime.createSession({ projectId: opened.session.projectId, cwd: t.work[0], confirmTools: ["mock_gate"] });
const tui = new ViewState();
const connection = new ControlConnection({ socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! }, { onState() {}, onSnapshot(result, ctx) { tui.applySnapshot(result, ctx.instanceChanged); }, onEvent(event, kind) { tui.applyEvent(event, kind); } });
await connection.start();
const bootstrap = path.join(dir, "bootstrap.cjs");
fs.writeFileSync(bootstrap, `const {app,Notification}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(dir, "app"))});
const log=value=>fs.appendFileSync(${JSON.stringify(path.join(dir, "native.jsonl"))},JSON.stringify(value)+'\\n');
const original=Notification.prototype.show;
Notification.prototype.show=function(){log({type:'show-call',title:this.title,body:this.body});this.on('show',()=>log({type:'shown',title:this.title}));this.on('failed',(_event,error)=>log({type:'failed',error}));return original.call(this)};
app.whenReady().then(()=>{const set=app.dock.setBadge.bind(app.dock);app.dock.setBadge=value=>{log({type:'badge',value});set(value)}});
let previous='';setInterval(()=>{const file=${JSON.stringify(path.join(dir, "window-command"))};if(!fs.existsSync(file))return;const command=fs.readFileSync(file,'utf8');if(command===previous)return;previous=command;if(command.startsWith('quit'))app.quit()},100);
import(${JSON.stringify(new URL("file://" + path.join(root, "apps/desktop/out/main/index.js")).href)});
`);
const require = createRequire(import.meta.url);
const electron = spawn(require("electron"), [bootstrap], { env: { ...process.env, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_CODE_CONTROL_DIR: desktopControl, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir }, stdio: ["ignore", "ignore", "pipe"] });
let stderr = ""; electron.stderr.on("data", data => { stderr += data; });
let count = 0;
const evidence: { command: string; taskId: string; tuiPending: number; detail: NonNullable<ReturnType<typeof t.runtime.getTaskDetail>>; native: unknown[] }[] = [];
async function next() {
  const task = await t.runtime.submit({ sessionId: session.id, requestId: `gui-${++count}`, input: `桌面审批验收 ${count}`, modelSelection: t.runtime.defaultSelection });
  await waitFor("审批进入 TUI 共享投影", () => tui.pendingApprovals().some(item => item.taskId === task.id));
  assert.equal(t.runtime.store.getTask(task.id)?.status, "awaiting_confirmation");
  return task.id;
}
let taskId = await next();
fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify({ dir, sessionId: session.id, taskId, pid: electron.pid }));
process.stdout.write(JSON.stringify({ dir, sessionId: session.id, taskId, pid: electron.pid }) + "\n");
let previous = "";
try {
  while (electron.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const commandFile = path.join(dir, "command");
    if (!fs.existsSync(commandFile)) continue;
    const command = fs.readFileSync(commandFile, "utf8");
    if (command === previous) continue;
    previous = command;
    if (command.startsWith("next")) taskId = await next();
    if (command.startsWith("tui-reject")) {
      const pending = tui.pendingApprovals().find(item => item.taskId === taskId)!;
      await t.client.request("respond_confirmation", { confirmation_id: pending.id, permission_version: pending.permissionVersion, decision: "reject" });
    }
    evidence.push({ command, taskId, tuiPending: tui.pendingApprovals().length, detail: t.runtime.getTaskDetail(taskId)!, native: fs.existsSync(path.join(dir, "native.jsonl")) ? fs.readFileSync(path.join(dir, "native.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] });
    fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(evidence, null, 2));
    if (command === "finish") break;
  }
} finally {
  fs.writeFileSync(path.join(dir, "window-command"), "quit");
  await new Promise(resolve => { if (electron.exitCode !== null) resolve(null); else electron.once("exit", resolve); });
  const destination = path.join(root, ".scratch/desktop-gui/evidence/06-electron"); fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "verification.json"), JSON.stringify({ actions: evidence.map(value => {
    const { native: _native, detail, ...entry } = value;
    return { ...entry, taskStatus: detail.task.status, confirmations: detail.confirmations.map(c => ({ id: c.id, status: c.status, permissionVersion: c.permissionVersion, consumedAt: c.consumedAt })) };
  }), native: evidence.at(-1)?.native ?? [] }, null, 2) + "\n");
  if (stderr) fs.writeFileSync(path.join(destination, "stderr.log"), stderr);
  connection.close(); await t.shutdown(); fs.rmSync(desktopControl, { recursive: true, force: true });
}
