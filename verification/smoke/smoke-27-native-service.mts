/** 系统服务常驻验收；模型与通知渠道模拟，worker、scope、调度和恢复真实。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { ControlClient } from "@ruukoto/control/client.ts";
import { createLauncherFor, ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import { linuxNativeScopeEmpty } from "@ruukoto/agent/execution/native-linux.ts";
import { parseRule, firstDue } from "@ruukoto/channels/scheduler/time.ts";
import { product } from "../../apps/ruukoto/src/product.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";
import { afterTool, authenticateClient, lastUserText, realTools, taskStatus, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";

const [action, requestedRoot] = process.argv.slice(2);
assert.ok(process.platform === "linux" && requestedRoot && path.isAbsolute(requestedRoot), "用法：service|heartbeat|cancel|status|prerequisite <独立绝对目录>");
const root = fs.realpathSync(requestedRoot);
const marker = path.join(root, ".native-service-smoke");
if (!fs.existsSync(marker)) {
  assert.ok(["service", "prerequisite"].includes(action) && fs.readdirSync(root).length === 0, "验证只能初始化空目录；已有实例资料不能用作 smoke 档案");
  fs.writeFileSync(marker, "ruukoto-native-service-smoke-v1\n", { flag: "wx", mode: 0o600 });
}
assert.equal(fs.readFileSync(marker, "utf8"), "ruukoto-native-service-smoke-v1\n", "验证目录标记不匹配");
const dirs = { root, dataDir: path.join(root, "data"), agentDir: path.join(root, "agent") };
const workspace = path.join(root, "workspace"), readyFile = path.join(root, "ready.json");
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const heartbeat = path.join(workspace, "heartbeat");
const heartbeatCommand = (target: string): string => {
  const source = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(target + ".pid")},require('node:fs').readFileSync('/proc/self/stat'));setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(target)},'h'),20)`;
  return `setsid node -e ${quote(source)} </dev/null >/dev/null 2>&1 & sleep 600`;
};
const report = (name: string, details: Record<string, unknown> = {}): void => {
  const result = { name, time: new Date().toISOString(), pid: process.pid, uid: process.getuid!(), ...details };
  fs.appendFileSync(path.join(root, "results.jsonl"), JSON.stringify(result) + "\n");
  process.stderr.write(`[ruukoto:service-smoke] ${JSON.stringify(result)}\n`);
};

if (action === "prerequisite") {
  fs.mkdirSync(workspace, { recursive: true });
  const stat = fs.statSync(workspace);
  const worker = ToolWorkerHost.create(createLauncherFor({ backend: "native" }, "confirm"), {
    taskId: `missing-prerequisite-${process.pid}`, mode: "confirm", workspace,
    workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [],
  });
  try {
    await assert.rejects(worker.start(), error => {
      assert.ok(error instanceof ExecutionError && error.code === "execution_unavailable");
      assert.ok(["policy_missing", "binary_missing"].includes(error.reason ?? ""));
      report("prerequisite-rejected", { code: error.code, reason: error.reason, message: error.message });
      return true;
    });
  } finally { assert.equal(await worker.stop(), true); }
} else if (action === "service") {
  for (const dir of [dirs.dataDir, dirs.agentDir, workspace]) fs.mkdirSync(dir, { recursive: true });
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const manager = execFileSync("/usr/bin/systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).trim();
  const userState = execFileSync("/usr/bin/loginctl", ["show-user", String(process.getuid!()), "-p", "Linger", "-p", "Sessions", "-p", "State"], { encoding: "utf8" }).trim();
  report("service-start", { bootId, manager, userState, cgroup: fs.readFileSync("/proc/self/cgroup", "utf8").trim(),
    runtimeDir: process.env.XDG_RUNTIME_DIR, bus: process.env.DBUS_SESSION_BUS_ADDRESS });
  const launcher = createLauncherFor({ backend: "native" }, "confirm");
  const proofWorkspace = path.join(root, `proof-${process.pid}`), proofHeartbeat = path.join(proofWorkspace, "heartbeat");
  fs.mkdirSync(proofWorkspace);
  let sequence = 0;
  const spec = (): LaunchSpec => {
    const stat = fs.statSync(proofWorkspace);
    return { taskId: `service-${process.pid}-${++sequence}`, mode: "confirm", workspace: proofWorkspace,
      workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [] };
  };
  const worker = ToolWorkerHost.create(launcher, spec());
  await worker.start();
  const running = worker.call({ opId: "detached", sdkCallId: "detached", name: "bash", params: { command: heartbeatCommand(proofHeartbeat) }, timeoutMs: 600_000 }).catch(() => null);
  await waitFor("脱离组后代心跳", () => fs.existsSync(proofHeartbeat) && fs.statSync(proofHeartbeat).size > 5, 60_000);
  const scope = worker.identity()?.id;
  assert.ok(scope, "必须登记真实 scope");
  const cgroup = execFileSync("/usr/bin/systemctl", ["--user", "show", scope, "--property=ControlGroup", "--value"], { encoding: "utf8" }).trim();
  assert.ok(cgroup && path.isAbsolute(cgroup) && path.basename(cgroup) === scope, "必须核实 scope 的 cgroup 身份");
  const childStat = fs.readFileSync(proofHeartbeat + ".pid", "utf8");
  const fields = childStat.slice(childStat.lastIndexOf(")") + 2).split(" ");
  assert.equal(fields[2], childStat.split(" ")[0], "setsid 后代的进程组须为自身 PID");
  assert.equal(await worker.stop(), true);
  await running;
  const size = fs.statSync(proofHeartbeat).size;
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(fs.statSync(proofHeartbeat).size, size);
  assert.equal(linuxNativeScopeEmpty(path.join("/sys/fs/cgroup", cgroup)), true);
  report("detached-stop-pass", { scope, cgroup, childStat, frozenBytes: size });
  let created!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { created = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const starting = ToolWorkerHost.create({ kind: "native", async launch(input) {
    const unit = await launcher.launch(input); created(); await gate; return unit;
  } }, spec());
  const start = starting.start().catch(() => null);
  await Promise.race([entered, start.then(() => { throw new Error("原生单元未创建"); })]);
  const canceled = starting.stop(); release();
  assert.equal(await canceled, true); await start;
  report("startup-cancel-pass");

  const model = new MockModelServer(request => {
    const text = lastUserText(request);
    if (afterTool(request)) return { kind: "text", text: "SERVICE-DONE" };
    if (text.includes("SERVICE-HEARTBEAT")) return { kind: "tool_calls", calls: [{ id: "heartbeat", name: "bash", arguments: { command: heartbeatCommand(heartbeat), timeout: 600 } }] };
    if (text.startsWith("[SubAgent 委派")) return { kind: "tool_calls", calls: [{ id: "timer-write", name: "write", arguments: { path: "service-timer.txt", content: `native ${bootId}\n` } }] };
    if (text.includes("SERVICE-TIMER")) return { kind: "tool_calls", calls: [{ id: "timer-delegate", name: "subagent_delegate", arguments: {
      key: "native-timer", request: "SERVICE-TIMER-WORKER", target: ".",
    } }] };
    return { kind: "text", text: "SERVICE-DONE" };
  });
  await writeModelsJson(dirs, await model.start());
  const target = { channel: "telegram", account: "service-mock", chatId: "service-mock", configVersion: 1 };
  const runtime = await Runtime.start({ ...dirs, product: product.runtime, ...realTools(), execution: { backend: "native" },
    modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", qqDisabled: true,
    scheduler: { tickMs: 1000, channel: { target: () => target, send: async input => {
      const run = runtime.sched.listRuns(schedule.id, 1)[0];
      assert.ok(run?.rootTaskId);
      const tasks = runtime.store.listScheduledRunTasks(run.id);
      const child = tasks.find(task => task.subAgentId !== null);
      assert.ok(child && child.status === "completed" && child.accessMode === "confirm" && !child.effectUnknown);
      const operation = runtime.store.listToolOpsByTask(child.id).find(op => op.sdkCallId === "timer-write");
      assert.ok(operation && operation.toolName === "write" && operation.isError === false && !operation.effectUnknown);
      const childSession = runtime.store.getSession(child.sessionId)!;
      assert.equal(fs.readFileSync(path.join(childSession.cwdReal, "service-timer.txt"), "utf8"), `native ${bootId}\n`);
      assert.equal(runtime.store.getOccupancyByDir(childSession.cwdReal), null);
      report("scheduled-report", { bootId, text: input.text,
        runId: run.id, childTaskId: child.id, operationId: operation.id, cwd: childSession.cwdReal, fileContent: `native ${bootId}\n`,
        userState: execFileSync("/usr/bin/loginctl", ["show-user", String(process.getuid!()), "-p", "Sessions", "-p", "State"], { encoding: "utf8" }).trim() });
      return { platformMessageId: `service-${Date.now()}` };
    } } },
  });
  await ControlServer.start(runtime);
  const session = await runtime.createSession({ projectName: `service-${process.pid}`, cwd: workspace });
  const main = runtime.store.getAgentRole("main")!;
  const now = Date.now();
  const rule = parseRule({ kind: "once", at: new Date(now + 30_000).toISOString(), time_zone: "UTC" });
  const schedule = runtime.store.withTx(() => runtime.sched.insertSchedule({ createKey: `service-${process.pid}`, paramsDigest: `service-${process.pid}`,
    createTaskId: null, createOpId: null, projectId: main.projectId, createPermissionVersion: 1, accessMode: "confirm", rule,
    instruction: "SERVICE-TIMER", sourceRefs: [], target, nextDueAt: firstDue(rule, now), tzData: "service-real-clock", reason: "service verification" }, "service-smoke"));
  fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid, bootId, sessionId: session.id, scheduleId: schedule.id,
    controlDir: runtime.controlDir(), socket: runtime.socketPath() }) + "\n");
  report("service-ready", { bootId, sessionId: session.id, scheduleId: schedule.id });
  const shutdown = async (): Promise<void> => { await runtime.stop("service-smoke"); await model.close(); process.exit(0); };
  process.once("SIGTERM", () => { void shutdown(); });
} else {
  assert.ok(["heartbeat", "cancel", "status"].includes(action), "未知验证动作");
  const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as { sessionId: string; socket: string; controlDir: string };
  const client = await ControlClient.connect(ready.socket);
  try {
    await authenticateClient(client, ready.controlDir);
    if (action === "heartbeat") {
      const task = await client.request<{ id: string }>("submit", { session_id: ready.sessionId, request_id: `heartbeat-${Date.now()}`, input: "SERVICE-HEARTBEAT", access_mode: "confirm",
        model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
      fs.writeFileSync(path.join(root, "heartbeat-task.json"), JSON.stringify(task) + "\n");
      process.stdout.write(JSON.stringify(task) + "\n");
    } else {
      const task = JSON.parse(fs.readFileSync(path.join(root, "heartbeat-task.json"), "utf8")) as { id: string };
      if (action === "cancel") await client.request("cancel", { task_id: task.id });
      process.stdout.write(JSON.stringify(await taskStatus(client, task.id)) + "\n");
    }
  } finally { client.close(); }
}
