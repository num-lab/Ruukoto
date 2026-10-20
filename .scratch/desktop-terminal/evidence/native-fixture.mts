import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { startTestRuntime, waitFor } from "../../../test/helpers/testkit.ts";
import { product } from "../../../apps/ruukoto-code/src/product.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const evidence = import.meta.dirname;
const target = process.argv[2] ?? "mygo";
const fixture = await startTestRuntime("terminal-native-qa", async () => ({ kind: "text", text: "隔离终端验收会话" }), { config: { product: product.runtime } });
const temporary = fs.mkdtempSync("/tmp/rtq-");
const control = path.join(temporary, "control"), profile = path.join(temporary, "profile");
fs.mkdirSync(control); fs.mkdirSync(profile);
fs.symlinkSync(path.join(fixture.runtime.controlDir(), "owner.token"), path.join(control, "owner.token"));
fs.symlinkSync(fixture.runtime.socketPath(), path.join(control, "control.sock"));
const workspaces = [];
for (const cwd of fixture.work) {
  const opened = await fixture.runtime.openWorkspace({ cwd });
  const task = await fixture.runtime.submit({ sessionId: opened.session.id, requestId: crypto.randomUUID(), input: "终端验收", modelSelection: fixture.runtime.defaultSelection });
  await waitFor("准备验收会话", () => fixture.runtime.store.getTask(task.id)?.status === "completed");
  workspaces.push({ cwd, sessionId: opened.session.id, workspaceId: opened.session.projectId });
}
const executable = target === "mygo" ? path.join(repository, "dist/mygo/darwin-arm64/Ruukoto MyGo.app/Contents/MacOS/Ruukoto MyGo") : path.join(repository, "dist/mac-arm64/Ruukoto.app/Contents/MacOS/Ruukoto");
const child = spawn(executable, target === "electron" ? [`--user-data-dir=${profile}`, "--remote-debugging-port=0"] : [], { env: { ...process.env, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_DESKTOP_MYGO_USER_DATA: profile, RUUKOTO_CODE_CONTROL_DIR: control, RUUKOTO_CODE_DATA_DIR: fixture.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: fixture.dirs.agentDir }, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", data => fs.appendFileSync(path.join(evidence, `${target}-stdout.log`), data));
child.stderr.on("data", data => fs.appendFileSync(path.join(evidence, `${target}-stderr.log`), data));
fs.writeFileSync(path.join(evidence, `${target}-ready.json`), JSON.stringify({ pid: child.pid, executable, workspaces, profile, control }, null, 2) + "\n");
process.stdout.write(`${target} 隔离应用已启动 ${child.pid}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill("SIGTERM"));
try { await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); }); }
finally { await fixture.shutdown(); fs.rmSync(temporary, { recursive: true, force: true }); fs.writeFileSync(path.join(evidence, `${target}-cleanup.json`), JSON.stringify({ exitCode: child.exitCode, signal: child.signalCode, temporaryRemoved: !fs.existsSync(temporary) }) + "\n"); }
