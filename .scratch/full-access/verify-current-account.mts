/** 当前账户的真实 worker 验收；仅使用临时目录、虚拟凭据与本机 HTTP 服务。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { ToolWorkerHost } from "../../packages/agent/src/tool-worker/host.ts";
import { createLauncherFor, type LaunchSpec } from "../../packages/agent/src/execution/launchers.ts";
import { killProcessGroup } from "../../packages/agent/src/managed-processes.ts";
import { product as codingProduct } from "../../apps/ruukoto-code/src/product.ts";
import { product as personalProduct } from "../../apps/ruukoto/src/product.ts";
import { startTestRuntime, realTools, createProjectSession, taskStatus, waitFor } from "../../test/helpers/testkit.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-current-")));
const workspace = path.join(root, "work");
const outside = path.join(root, "virtual-credential");
const written = path.join(root, "outside-written");
const bin = path.join(root, "bin");
fs.mkdirSync(workspace); fs.mkdirSync(bin);
fs.writeFileSync(outside, "virtual-credential-only", { mode: 0o600 });
fs.writeFileSync(path.join(bin, "full-access-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
const virtualEnv = {
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  SSH_AUTH_SOCK: path.join(root, "virtual-ssh-agent"),
  HTTPS_PROXY: "http://virtual-proxy.invalid:3128",
  FULL_ACCESS_VIRTUAL_TOKEN: "virtual-token-only",
  RUUKOTO_OWNER_TOKEN: "virtual-control-token-only",
  RUUKOTO_CONTROL_DIR: path.join(root, "virtual-control"),
  RUUKOTO_CODE_CONTROL_DIR: path.join(root, "virtual-code-control"),
  RUUKOTO_OWNER_TOKEN_FILE: path.join(root, "virtual-owner-token"),
  RUUKOTO_USER_TOOL_OPTION: "virtual-user-tool-setting",
};
const saved = Object.fromEntries(Object.keys(virtualEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, virtualEnv);
const http = createServer((_req, res) => res.end("local-network-ok"));
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/`;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const command = (source: string): string => `${quote(process.execPath)} -e ${quote(source)}`;
const report = (name: string, detail: Record<string, unknown> = {}): void => {
  process.stdout.write(JSON.stringify({ name, passed: true, ...detail }) + "\n");
};
const probe = `
const assert=require('node:assert/strict'), fs=require('node:fs');
assert.equal(process.getuid(),${process.getuid?.()});
assert.equal(process.getgid(),${process.getgid?.()});
assert.equal(process.env.HOME,${JSON.stringify(process.env.HOME)});
assert.equal(process.env.SSH_AUTH_SOCK,${JSON.stringify(virtualEnv.SSH_AUTH_SOCK)});
assert.equal(process.env.HTTPS_PROXY,${JSON.stringify(virtualEnv.HTTPS_PROXY)});
assert.equal(process.env.FULL_ACCESS_VIRTUAL_TOKEN,'virtual-token-only');
for(const key of ['RUUKOTO_OWNER_TOKEN','RUUKOTO_OWNER_TOKEN_FILE','RUUKOTO_CONTROL_DIR','RUUKOTO_CODE_CONTROL_DIR'])assert.equal(process.env[key],undefined);
assert.equal(process.env.RUUKOTO_USER_TOOL_OPTION,'virtual-user-tool-setting');
assert.equal(process.env.GIT_CONFIG_COUNT,'1');
assert.equal(fs.readFileSync(${JSON.stringify(outside)},'utf8'),'virtual-credential-only');
fs.writeFileSync(${JSON.stringify(written)},'outside-write-ok');
require('node:child_process').execFileSync('full-access-tool');
fetch(${JSON.stringify(url)}).then(r=>r.text()).then(text=>{assert.equal(text,'local-network-ok');process.stdout.write('CURRENT_ACCOUNT_PASS')}).catch(e=>{process.stderr.write(e.message);process.exitCode=1});
`;
try {
  report("platform", { platform: process.platform, arch: process.arch, uid: process.getuid?.(), gid: process.getgid?.(), node: process.version });
  for (const [product, backend] of [[codingProduct.runtime, "native"], [personalProduct.runtime, "container"]] as const) {
    const t = await startTestRuntime("current-account", req => req.messages.some(message => message?.role === "tool")
      ? { kind: "text", text: "current-account-complete" }
      : { kind: "tool_calls", calls: [{ id: "real-current", name: "bash", arguments: { command: command(probe) } }] },
    { workDirs: 0, config: { product, ...realTools(), execution: { backend } } });
    try {
      const { sessionId } = await createProjectSession(t.client, workspace);
      // Git 环境由 launch spec 测试单独核实；普通产品任务不注入这组变量。
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "safe.directory";
      process.env.GIT_CONFIG_VALUE_0 = "*";
      const task = await t.client.request<{ id: string }>("submit", { session_id: sessionId, request_id: `current-${product.type}`,
        input: "验证当前账户", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
      await waitFor("真实任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 30_000);
      const detail = await taskStatus(t.client, task.id);
      assert.equal(detail.confirmations.length, 0);
      assert.equal(detail.toolOps.length, 1);
      assert.equal(detail.toolOps[0].isError, false);
      assert.ok(!t.runtime.getEventLog(0, 10_000).some(event => event.body.type === "task.tool_process_unreaped"));
      assert.equal(fs.readFileSync(written, "utf8"), "outside-write-ok");
      report("product-current-account", { product: product.type, backend, fileOutsideWorkspace: true, localNetwork: true, inheritedEnvironment: true, virtualCredential: true, approvals: 0, model: "mock" });
    } finally { await t.shutdown(); }
  }
  const spec: LaunchSpec = { taskId: "real-stop", mode: "full_access", workspace, grantedPaths: [], env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" } };
  const heartbeat = path.join(root, "heartbeat");
  const childSource = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`;
  const host = await ToolWorkerHost.start(createLauncherFor({ backend: "native" }, "full_access"), spec);
  try {
    const call = host.call({ opId: "heartbeat", sdkCallId: "heartbeat", name: "bash", params: { command: command(childSource) + " & wait" } });
    void call.catch(() => undefined);
    await waitFor("后代心跳", () => fs.existsSync(heartbeat) && fs.statSync(heartbeat).size > 2);
    assert.equal(await host.stop(), true);
    await assert.rejects(call);
    const size = fs.statSync(heartbeat).size;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fs.statSync(heartbeat).size, size);
    report("known-descendant-stop", { reaped: true, heartbeatStopped: true });
  } finally { await host.stop(); }
  const shellPid = path.join(root, "shell-pid");
  const crashed = await ToolWorkerHost.start(createLauncherFor({ backend: "container" }, "full_access"), { ...spec, taskId: "real-crash" });
  let pgid: number | undefined;
  try {
    const call = crashed.call({ opId: "crash", sdkCallId: "crash", name: "bash", params: { command: `echo $$ > ${quote(shellPid)}; ${command(childSource)} & wait` } });
    void call.catch(() => undefined);
    await waitFor("已登记独立 Shell", () => fs.existsSync(shellPid));
    pgid = Number(fs.readFileSync(shellPid, "utf8").trim());
    process.kill(Number(crashed.identity()!.id), "SIGKILL");
    assert.equal(await crashed.stop(), false);
    assert.equal(await crashed.stop(), false);
    assert.equal(crashed.stopFailure?.code, "worker_stop_unverified");
    report("worker-crash-stop", { reaped: false, cachedUnknown: true, cleanup: "explicit-test-shell-group-only" });
  } finally {
    if (pgid) assert.equal(await killProcessGroup(pgid, { termGraceMs: 100, killGraceMs: 2000 }), true);
    await crashed.stop();
  }
  const stat = fs.statSync(workspace);
  const restricted = await ToolWorkerHost.start(createLauncherFor({ backend: "native" }, "confirm"),
    { ...spec, mode: "confirm", workspaceIdentity: { dev: stat.dev, ino: stat.ino } });
  try {
    const file = await restricted.call({ opId: "restricted-file", sdkCallId: "restricted-file", name: "read", params: { path: outside } });
    assert.equal(file.isError, true);
    const network = await restricted.call({ opId: "restricted-network", sdkCallId: "restricted-network", name: "bash", params: { command: command(`fetch(${JSON.stringify(url)}).then(()=>process.exit(2),()=>process.stdout.write('DENIED'))`) } });
    assert.equal(network.isError, false);
    assert.ok(JSON.stringify(network.content).includes("DENIED"));
    report("restricted-native-contrast", { outsideFileDenied: true, networkDenied: true });
  } finally {
    const stopped = await restricted.stop();
    assert.equal(stopped, true);
  }
  report("limitations", { detachedProcesses: "not-guaranteed", externalServices: "not-revoked", realModel: false, realCredentials: false, productionChanged: false });
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await new Promise<void>(resolve => http.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
