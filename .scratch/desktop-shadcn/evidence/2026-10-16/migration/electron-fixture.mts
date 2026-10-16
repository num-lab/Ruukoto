import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { startTestRuntime, realTools, waitFor, lastUserText } from "../../../../../test/helpers/testkit.ts";
import { product } from "../../../../../apps/ruukoto-code/src/product.ts";

const root = process.cwd();
const require = createRequire(import.meta.url);
const evidence = path.join(root, ".scratch/desktop-shadcn/evidence/2026-10-16/migration");
fs.rmSync(path.join(evidence, "command"), { force: true });
fs.rmSync(path.join(evidence, "ready.json"), { force: true });
const controlDir = fs.mkdtempSync("/tmp/r-ui-control-");
const profile = fs.mkdtempSync("/tmp/r-ui-profile-");
let readFile = "", outside = "", childHeld = false;
let releaseChild!: () => void;
const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
const before = "export const clock = 1;\n";
const after = "export const clock = 2;\n";
const largeBefore = Array.from({ length: 1000 }, (_, n) => `旧-${n}-${"a".repeat(90)}\n`).join("");
const largeAfter = Array.from({ length: 1000 }, (_, n) => `新-${n}-${"b".repeat(90)}\n`).join("");
const t = await startTestRuntime("desktop-ui", async req => {
  const input = lastUserText(req);
  const lastUser = req.messages.map(message => message.role).lastIndexOf("user");
  const hasTool = req.messages.slice(lastUser + 1).some(message => message.role === "tool");
  if (input.includes("gui-child")) {
    if (!hasTool) return { kind: "tool_calls", calls: [{ id: "child-read", name: "read", arguments: { path: readFile } }] };
    childHeld = true; await childGate;
    return { kind: "text", text: "Verified the cached pass segments and the HLC clock." };
  }
  if (input.includes("gui-agent")) {
    if (!hasTool) return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { request: "gui-child：读取指定文件并核对时钟。", key: "gui-child", role: "general", read_paths: [readFile] } }] };
    return { kind: "text", text: "The auditor is checking the offline cache." };
  }
  if (input.includes("gui-approval")) {
    if (!hasTool) return { kind: "tool_calls", calls: [{ id: "outside-read", name: "request_file_access", arguments: { path: outside, operation: "read", reason: "核对离线缓存配置" } }] };
    return { kind: "text", text: "审批已处理。" };
  }
  if (input.includes("gui-files")) {
    if (hasTool) return { kind: "text", text: "Added Hybrid Logical Clock reconciliation in `src/lib/sync/indexeddb.ts` and surfaced an understated offline indicator inside `src/components/PassTimeline.tsx` when reading from cached tunnel state." };
    return { kind: "tool_calls", calls: [
      { id: "edit-clock", name: "edit", arguments: { path: "src/lib/sync/indexeddb.ts", edits: [{ oldText: before, newText: after }] } },
      { id: "write-timeline", name: "write", arguments: { path: "src/components/PassTimeline.tsx", content: "export const OfflineIndicator = () => 'Offline';\n" } },
      { id: "edit-large", name: "edit", arguments: { path: "large.ts", edits: [{ oldText: largeBefore, newText: largeAfter }] } },
      { id: "write-empty", name: "write", arguments: { path: "empty.ts", content: "" } },
    ] };
  }
  return { kind: "text", text: "已收到输入。" };
}, { contextWindow: 1_000_000, workDirs: 2, config: { product: product.runtime, ...realTools() } });
let electron: ReturnType<typeof spawn> | undefined;
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n");
try {
  const cwd = path.join(t.work[0], "fumotravel-web");
  fs.mkdirSync(path.join(cwd, "src/lib/sync"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src/components"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/lib/sync/indexeddb.ts"), before);
  fs.writeFileSync(path.join(cwd, "large.ts"), largeBefore);
  readFile = path.join(cwd, "clock.txt"); fs.writeFileSync(readFile, "HLC clock verified\n"); readFile = fs.realpathSync(readFile);
  outside = path.join(t.dirs.root, "approval.txt"); fs.writeFileSync(outside, "cache=offline\n"); outside = fs.realpathSync(outside);
  const { session } = await t.runtime.openWorkspace({ cwd });
  const submit = (sessionId: string, input: string) => t.runtime.submit({ sessionId, requestId: crypto.randomUUID(), input, modelSelection: t.runtime.defaultSelection, accessMode: "full_access" });
  const files = await submit(session.id, "gui-files: Cache reserved Shinkansen seat segments in IndexedDB so travelers in mountain tunnels can view QR boarding passes offline, and reconcile CRDT timestamps on reconnect.");
  await waitFor("文件工具完成", () => t.runtime.store.getTask(files.id)?.status === "completed", 60000);
  const agentSession = await t.runtime.createSession({ projectId: session.projectId, cwd });
  const delegation = await submit(agentSession.id, "gui-agent: Verify offline cache and HLC clock.");
  await waitFor("子会话读取并等待", () => childHeld, 60000);
  const approvalCwd = path.join(t.work[1], "nexus-runtime"); fs.mkdirSync(approvalCwd);
  const approvalSession = (await t.runtime.openWorkspace({ cwd: approvalCwd })).session;
  const approvalTask = await t.runtime.submit({ sessionId: approvalSession.id, requestId: "ui-approval", input: "gui-approval: 核对工作区外的离线配置。", modelSelection: t.runtime.defaultSelection, accessMode: "confirm" });
  await waitFor("真实文件审批", () => {
    const detail = t.runtime.getTaskDetail(approvalTask.id)!;
    save("fixture-progress.json", { task: detail.task, toolOps: detail.toolOps, confirmations: detail.confirmations });
    if (detail.task.endedAt) throw new Error(JSON.stringify(detail));
    return detail.task.status === "awaiting_confirmation";
  }, 15000);
  fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(controlDir, "owner.token"));
  fs.symlinkSync(t.runtime.socketPath(), path.join(controlDir, "control.sock"));
  const bootstrap = path.join(profile, "bootstrap.cjs");
  fs.writeFileSync(bootstrap, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(path.join(profile, "app"))}); import(${JSON.stringify(new URL("file://" + path.join(root, "apps/desktop/out/main/index.js")).href)});\n`);
  electron = spawn(require("electron"), [bootstrap], { cwd: root, env: { ...process.env, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_CODE_CONTROL_DIR: controlDir, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir }, stdio: ["ignore", "ignore", "pipe"] });
  electron.stderr!.on("data", chunk => fs.appendFileSync(path.join(evidence, "electron-stderr.log"), chunk));
  save("ready.json", { pid: electron.pid, profile, controlDir, cwd, sessionId: session.id, agentSessionId: agentSession.id, approvalSessionId: approvalSession.id, tasks: { files: files.id, delegation: delegation.id, approval: approvalTask.id }, backend: "临时真实 Code Runtime / ControlServer / tool worker", model: "确定性本地 MockModelServer", userDataIsolated: true });
  process.stdout.write("Electron fixture ready\n");
  let previous = "";
  while (electron.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const commandFile = path.join(evidence, "command");
    if (!fs.existsSync(commandFile)) continue;
    const command = fs.readFileSync(commandFile, "utf8");
    if (command === previous) continue;
    previous = command;
    if (command.startsWith("release-child")) releaseChild();
    if (command.startsWith("next-approval")) await t.runtime.submit({ sessionId: approvalSession.id, requestId: crypto.randomUUID(), input: "gui-approval: 再次核对离线配置。", modelSelection: t.runtime.defaultSelection, accessMode: "confirm" });
    save("backend-status.json", { tasks: t.runtime.store.listTasksBySession(session.id), approval: t.runtime.getTaskDetail(approvalTask.id), agents: t.runtime.store.listSubAgents() });
    if (command.startsWith("quit")) break;
  }
} finally {
  releaseChild();
  if (electron && electron.exitCode === null) { electron.kill("SIGTERM"); await new Promise(resolve => electron!.once("exit", resolve)); }
  await t.shutdown();
  fs.rmSync(controlDir, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}
