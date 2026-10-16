import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { startTestRuntime, lastUserText, waitFor } from "../../../test/helpers/testkit.ts";
import { product } from "../../../apps/ruukoto-code/src/product.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const evidence = import.meta.dirname;
const t = await startTestRuntime("mygo-ui", async request => ({ kind: "text", text: `MyGo 回显：${lastUserText(request)}\n\n这是隔离后台的真实任务结果。` }), { config: { product: product.runtime } });
const control = fs.mkdtempSync("/tmp/rmg-c-");
const profile = fs.mkdtempSync("/tmp/rmg-u-");
fs.symlinkSync(path.join(t.runtime.controlDir(), "owner.token"), path.join(control, "owner.token"));
fs.symlinkSync(t.runtime.socketPath(), path.join(control, "control.sock"));
const workspace = path.join(t.work[0], "mygo-experiment");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "README.md"), "# MyGo 试验\n\n这是可预览的隔离工作区文件。\n");
fs.writeFileSync(path.join(workspace, "sample.txt"), "附件选择与快照上传验收\n");
const { session } = await t.runtime.openWorkspace({ cwd: workspace });
const task = await t.runtime.submit({ sessionId: session.id, requestId: crypto.randomUUID(), input: "你好，MyGo。", modelSelection: t.runtime.defaultSelection });
await waitFor("初始化会话", () => t.runtime.store.getTask(task.id)?.status === "completed");
const executable = path.join(root, "dist/mygo/darwin-arm64/Ruukoto MyGo.app/Contents/MacOS/Ruukoto MyGo");
const child = spawn(executable, [], { cwd: root, env: { ...process.env, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_DESKTOP_MYGO_USER_DATA: profile, RUUKOTO_CODE_CONTROL_DIR: control, RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir }, stdio: ["ignore", "ignore", "pipe"] });
child.stderr.on("data", data => fs.appendFileSync(path.join(evidence, "mygo-stderr.log"), data));
const metadata = { pid: child.pid, profile, control, workspace, sessionId: session.id, runtime: "真实临时 Runtime / ControlServer", model: "本地确定性 MockModelServer" };
fs.writeFileSync(path.join(evidence, "ready.json"), JSON.stringify(metadata, null, 2) + "\n");
process.stdout.write(`MyGo fixture ready: ${JSON.stringify(metadata)}\n`);
try {
  await new Promise(resolve => child.once("exit", resolve));
  fs.writeFileSync(path.join(evidence, "tasks.json"), JSON.stringify(t.runtime.store.listTasksBySession(session.id), null, 2) + "\n");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await t.shutdown();
  fs.rmSync(control, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}
