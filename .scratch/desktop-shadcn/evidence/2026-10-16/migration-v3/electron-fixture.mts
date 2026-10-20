import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { startTestRuntime, realTools, waitFor, lastUserText } from "/Users/eitrous/.codex/worktrees/6f13/ruukoto/test/helpers/testkit.ts";
import { product } from "/Users/eitrous/.codex/worktrees/6f13/ruukoto/apps/ruukoto-code/src/product.ts";

const root = "/Users/eitrous/.codex/worktrees/6f13/ruukoto";
const evidence = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n");
const controlDir = fs.mkdtempSync("/tmp/r-v3-control-");
const profile = fs.mkdtempSync("/tmp/r-v3-profile-");
const cdpPort = 18329;
for (const name of ["command.json", "ready.json", "launch"]) fs.rmSync(path.join(evidence, name), { force: true });
let releaseThinking!: () => void;
const thinkingGate = new Promise<void>(resolve => { releaseThinking = resolve; });
let gateFile = "", outside = "";
const before = "export const clock = 1;\n";
const after = "export const clock = 2;\n";
const longCommand = `# LONG_COMMAND_START ${"command-padding-".repeat(6000)}\nprintf 'LONG_COMMAND_END\\n'`;
const t = await startTestRuntime("desktop-ui-v3", async req => {
  const input = lastUserText(req);
  const userIndex = req.messages.map(message => message.role).lastIndexOf("user");
  const hasTool = req.messages.slice(userIndex + 1).some(message => message.role === "tool");
  if (input.startsWith("gui-live:")) {
    if (!hasTool) {
      await thinkingGate;
      return { kind: "tool_calls", calls: [
        { id: "live-read", name: "read", arguments: { path: "src/lib/sync/indexeddb.ts" } },
        { id: "live-bash-one", name: "bash", arguments: { command: `printf 'WORKING_FIRST_STARTED\\n'; while [ ! -f '${gateFile}-one' ]; do sleep 0.1; done; printf 'WORKING_FIRST_DONE\\n'` } },
        { id: "live-bash-two", name: "bash", arguments: { command: `printf 'WORKING_SECOND_STARTED\\n'; while [ ! -f '${gateFile}-two' ]; do sleep 0.1; done; printf 'WORKING_SECOND_DONE\\n'` } },
      ] };
    }
    return { kind: "text", text: "LIVE_COMPLETE：真实任务已完成。" };
  }
  if (input.startsWith("gui-files:")) {
    if (hasTool) return { kind: "text", text: "Updated `src/lib/sync/indexeddb.ts` and `src/components/PassTimeline.tsx`. Tool failures remain visible with their actual results." };
    return { kind: "tool_calls", calls: [
      { id: "read-clock", name: "read", arguments: { path: "src/lib/sync/indexeddb.ts" } },
      { id: "edit-clock", name: "edit", arguments: { path: "src/lib/sync/indexeddb.ts", edits: [{ oldText: before, newText: after }] } },
      { id: "write-timeline", name: "write", arguments: { path: "src/components/PassTimeline.tsx", content: "export const OfflineIndicator = () => 'Offline';\n" } },
      { id: "long-command", name: "bash", arguments: { command: longCommand } },
      { id: "failed-command", name: "bash", arguments: { command: "printf 'QA_TOOL_FAILURE\\n' >&2; exit 17" } },
      { id: "failed-read", name: "read", arguments: { path: "missing.txt" } },
    ] };
  }
  if (input.startsWith("gui-approval:")) {
    if (!hasTool) return { kind: "tool_calls", calls: [{ id: "outside-read", name: "request_file_access", arguments: { path: outside, operation: "read", reason: "核对隔离验收配置" } }] };
    return { kind: "text", text: "APPROVAL_COMPLETE" };
  }
  return { kind: "text", text: input.startsWith("gui-scroll") ? input + "\n\n" + "Scroll history text. ".repeat(70) : "RECEIVED：" + input };
}, { contextWindow: 1_000_000, workDirs: 2, config: { product: product.runtime, ...realTools() } });
let electron: ReturnType<typeof spawn> | undefined;
try {
  const cwd = path.join(t.work[0], "fumotravel-web");
  fs.mkdirSync(path.join(cwd, "src/lib/sync"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src/components"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/lib/sync/indexeddb.ts"), before);
  fs.writeFileSync(path.join(cwd, "src/components/PassTimeline.tsx"), "export const OfflineIndicator = () => 'Online';\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Isolated Desktop QA\n\nActual temporary file preview.\n");
  gateFile = path.join(cwd, "release-tool");
  outside = path.join(t.dirs.root, "outside-approval.txt");
  fs.writeFileSync(outside, "isolated approval file\n");
  outside = fs.realpathSync(outside);
  const { session } = await t.runtime.openWorkspace({ cwd });
  const submit = (sessionId: string, input: string) => t.runtime.submit({ sessionId, requestId: crypto.randomUUID(), input, modelSelection: t.runtime.defaultSelection, accessMode: "full_access" });
  const files = await submit(session.id, "gui-files: Inspect files, update the cache and verify commands.");
  await waitFor("预置真实工具历史", () => t.runtime.store.getTask(files.id)?.status === "completed", 60000);
  const live = await t.runtime.createSession({ projectId: session.projectId, cwd });
  const warm = await submit(live.id, "gui-live-session");
  await waitFor("执行会话准备", () => t.runtime.store.getTask(warm.id)?.status === "completed", 15000);
  const scroll = await t.runtime.createSession({ projectId: session.projectId, cwd });
  for (let index = 0; index < 28; index++) {
    const task = await submit(scroll.id, `gui-scroll ${String(index).padStart(2, "0")}`);
    await waitFor("滚动历史准备", () => t.runtime.store.getTask(task.id)?.status === "completed", 15000);
  }
  const approvalCwd = path.join(t.work[1], "nexus-runtime"); fs.mkdirSync(approvalCwd);
  const approval = (await t.runtime.openWorkspace({ cwd: approvalCwd })).session;
  const warmApproval = await submit(approval.id, "gui-approval-session");
  await waitFor("审批会话准备", () => t.runtime.store.getTask(warmApproval.id)?.status === "completed", 15000);
  fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(controlDir, "owner.token"));
  fs.symlinkSync(t.runtime.socketPath(), path.join(controlDir, "control.sock"));
  const metadata = { profile, controlDir, cwd, sessionId: session.id, liveSessionId: live.id, scrollSessionId: scroll.id, approvalSessionId: approval.id, filesTaskId: files.id, cdpEndpoint: `http://127.0.0.1:${cdpPort}`, backend: "临时真实 Code Runtime / ControlServer / local tool worker", model: "确定性本地 MockModelServer", userDataIsolated: true };
  save("prepared.json", metadata);
  process.stdout.write("Fixture prepared; waiting for launch gate\n");
  await waitFor("允许启动隔离 Electron", () => fs.existsSync(path.join(evidence, "launch")), 600000);
  const bootstrap = path.join(profile, "bootstrap.cjs");
  fs.writeFileSync(bootstrap, `const { app } = require('electron'); app.commandLine.appendSwitch('remote-debugging-port', '${cdpPort}'); app.setName('Ruukoto QA v3'); app.on('browser-window-created', (_, win) => { win.on('page-title-updated', e => e.preventDefault()); win.setTitle('Ruukoto QA v3'); win.setSize(1280, 827); }); app.setPath('userData', ${JSON.stringify(path.join(profile, "app"))}); import(${JSON.stringify(new URL("file://" + path.join(root, "apps/desktop/out/main/index.js")).href)});\n`);
  electron = spawn(require("electron"), [bootstrap], { cwd: root, env: { ...process.env, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_CODE_CONTROL_DIR: controlDir, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir }, stdio: ["ignore", "ignore", "pipe"] });
  electron.stderr!.on("data", chunk => fs.appendFileSync(path.join(evidence, "electron-stderr.log"), chunk));
  save("ready.json", { ...metadata, pid: electron.pid });
  process.stdout.write("Electron fixture ready\n");
  let previous = "";
  while (electron.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 150));
    const file = path.join(evidence, "command.json");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    if (raw === previous) continue;
    previous = raw;
    const command = JSON.parse(raw) as { id: string; action: string };
    if (command.action === "release-thinking") releaseThinking();
    if (command.action === "release-tool-one") fs.writeFileSync(`${gateFile}-one`, "release\n");
    if (command.action === "release-tool-two") fs.writeFileSync(`${gateFile}-two`, "release\n");
    if (command.action === "next-approval") await t.runtime.submit({ sessionId: approval.id, requestId: crypto.randomUUID(), input: "gui-approval: 核对隔离的工作区外文件。", modelSelection: t.runtime.defaultSelection, accessMode: "confirm" });
    if (command.action === "scroll-new") await submit(scroll.id, "gui-scroll new-arrival");
    save("backend-status.json", { command, sessions: t.runtime.store.listSessions(), files: t.runtime.store.listTasksBySession(session.id), live: t.runtime.store.listTasksBySession(live.id), scroll: t.runtime.store.listTasksBySession(scroll.id), approval: t.runtime.store.listTasksBySession(approval.id) });
    if (command.action === "quit") break;
  }
} finally {
  releaseThinking();
  if (gateFile) for (const suffix of ["-one", "-two"]) fs.writeFileSync(`${gateFile}${suffix}`, "release\n");
  if (electron && electron.exitCode === null) { electron.kill("SIGTERM"); await new Promise(resolve => electron!.once("exit", resolve)); }
  await t.shutdown();
  fs.rmSync(controlDir, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}
