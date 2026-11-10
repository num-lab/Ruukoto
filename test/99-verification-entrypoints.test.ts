import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { cleanupRuntime, probeNativeExecution } from "../verification/smoke/gate.ts";
import { PassThrough } from "node:stream";
import { ExecutionError, type LaunchedUnit } from "@ruukoto/agent/execution/launchers.ts";
import { probeModelConfig } from "@ruukoto/agent/model-config.ts";

const root = path.resolve(import.meta.dirname, "..");
const entry = async (name: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "verification/smoke", name), ...args], {
    cwd: root, env: { ...env, TSX_DISABLE_CACHE: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  };
  // A subprocess watchdog needs platform time; successful exits resolve immediately through the close event.
  const timer = setTimeout(() => { timedOut = true; stop(); }, 30_000);
  try {
    const [status, signal] = await once(child, "close");
    assert.equal(timedOut, false, `${name} timed out: ${stderr}`);
    assert.equal(signal, null, `${name} was terminated: ${stderr}`);
    return { status, stdout, stderr };
  } finally { clearTimeout(timer); stop(); }
};

test("冒烟拒绝旧远端参数，退出 2 且不创建后台或尝试 SSH", async () => {
  for (const name of ["smoke-04-desktop-execution.mts", "smoke-13-subagent-messaging.mts", "smoke-15-recover-subagents.mts"]) {
    const result = await entry(name, ["--remote"], { ...process.env, PATH: "" });
    assert.equal(result.status, 2, `${name}：${result.stderr}`);
    assert.match(result.stderr, /前提缺失：此入口不接受参数：--remote/, name);
  }
});

test("原生前提失败核实停止后报告不可用，停止未知保留现场", async () => {
  for (const stopped of [true, false]) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "ruukoto-native-gate-test-")));
    const evidence = path.join(directory, "evidence.txt");
    fs.writeFileSync(evidence, "本次虚拟现场");
    let stopCalls = 0;
    const unit: LaunchedUnit = {
      entry: { kind: "systemd_unit", id: "test-native.scope", label: "fake unit",
        stop: async () => { stopCalls++; return stopped; } },
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exit: Promise.resolve({ code: 1, signal: null }),
    };
    try {
      await assert.rejects(() => probeNativeExecution({ kind: "native", launch: async () => {
        throw new ExecutionError("execution_unavailable", "测试夹具没有 namespace", unit, "sandbox_rejected");
      } }, directory), error => stopped
        ? error instanceof ExecutionError && error.code === "execution_unavailable"
        : error instanceof Error && !(error instanceof ExecutionError) && error.message.includes("停止未核实"));
      assert.equal(stopCalls, 1, "创建单元后的能力失败也必须执行真实 stop 接口");
      assert.equal(fs.existsSync(evidence), !stopped, "停止未知保留现场；已核实停止才清理");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test("Release acceptance requires explicit model configuration and offers offline help", async () => {
  const name = "smoke-24-release-acceptance.mts";
  const directory = fs.mkdtempSync(path.join(tmpdir(), "ruukoto-release-entry-test-"));
  const env = { ...process.env, PATH: "", HOME: directory, TMPDIR: directory };
  try {
    for (const args of [[], ["--remote"]]) {
      const rejected = await entry(name, args, env);
      assert.equal(rejected.status, 2, rejected.stderr);
      assert.notEqual(rejected.stderr.trim(), "", "Invalid configuration must explain how to proceed");
      assert.deepEqual(fs.readdirSync(directory), [], "Rejected arguments must not initialize storage");
    }
    const help = await entry(name, ["--help"], env);
    assert.equal(help.status, 0, help.stderr);
    for (const option of ["--models", "--model"]) assert.ok(help.stdout.includes(option));
    assert.match(help.stdout, /可能产生费用/);
    assert.deepEqual(fs.readdirSync(directory), [], "Help must not initialize storage");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("特权验收源码完整归档为文本，没有可执行的 mts 入口", () => {
  const archive = path.join(root, "verification/archive");
  const names = ["smoke-09-linux-service-management.mts", "smoke09-remote.mts", "smoke09-backendctl.mts", "smoke-10-standing-permissions.mts", "smoke10-remote.mts", "release-24-linux-full-access.mts"];
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(archive, `${name}.txt`)), `归档缺少依赖：${name}`);
    assert.ok(!fs.existsSync(path.join(archive, name)), `特权源码不应成为可执行入口：${name}`);
  }
  assert.ok(fs.existsSync(path.join(root, "verification/smoke/pty-run.py")), "模型验收需要的 PTY 助手必须随 clone 提供");
});

test("Runtime 停止失败时仍关闭模型桩，返回清理失败并保留现场", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "ruukoto-cleanup-test-"));
  const artifact = path.join(directory, "evidence.txt");
  fs.writeFileSync(artifact, "停止失败的现场");
  let modelClosed = false;
  const cause = new Error("SQLite 停止事件写入失败");
  try {
    const failure = await cleanupRuntime({ stop: async () => { throw cause; } }, {
      close: async () => { modelClosed = true; },
    }, directory);
    assert.ok(failure instanceof Error, "停止失败必须成为清理失败");
    assert.equal(failure.cause, cause, "保留最初的停止错误");
    assert.equal(modelClosed, true, "停止失败也要关闭模型桩");
    assert.equal(fs.readFileSync(artifact, "utf8"), "停止失败的现场", "不能删除仍待核实的资料");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Invalid or credential-free model configurations exit offline without starting the TUI", async () => {
  // The isolated TMPDIR must leave room for the real Unix socket address on macOS too.
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk-gate-"));
  const bin = path.join(directory, "bin"), home = path.join(directory, "home"), temporary = path.join(directory, "tmp");
  const server = createServer((_request, response) => { response.writeHead(500); response.end(); });
  let connections = 0;
  server.on("connection", () => { connections++; });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const dir of [bin, temporary, path.join(home, ".pi", "agent")]) fs.mkdirSync(dir, { recursive: true });
    const models = path.join(directory, "models.json"), calls = path.join(directory, "calls.txt");
    const config = { providers: { openai: {
      baseUrl: `http://127.0.0.1:${address.port}`, api: "openai-completions", headers: { "x-verification": "headers-are-not-proof-of-auth" },
      models: [{ id: "verification-no-credential", name: "Verification", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }],
    } } };
    const auth = path.join(home, ".pi", "agent", "auth.json");
    const personalAuth = JSON.stringify({ openai: { type: "api_key", key: "personal-key-must-not-be-read" } });
    fs.writeFileSync(auth, personalAuth);
    const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(python.error, undefined);
    assert.equal(python.status, 0, python.stderr);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    // Profile activation uses Python too; forward real -c helpers while recording and blocking PTY startup.
    fs.writeFileSync(path.join(bin, "python3"), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quote(calls)}\n[ "$1" = "-c" ] && exec ${quote(python.stdout.trim())} "$@"\nexit 77\n`, { mode: 0o755 });
    fs.writeFileSync(calls, "");
    fs.writeFileSync(models, JSON.stringify({ providers: { openai: { ...config.providers.openai, apiKey: "fixture-key" } } }));
    const configured = await probeModelConfig(directory);
    assert.equal(configured.ok, true, `The fixture must be valid when credentials are supplied: ${configured.detail}`);
    for (const configuration of ["{", JSON.stringify({ providers: {} }), JSON.stringify(config)]) {
      fs.writeFileSync(models, configuration);
      const result = await entry("smoke-24-release-acceptance.mts", ["--models", models, "--model", "openai/verification-no-credential"], {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: home, TMPDIR: temporary,
        OPENAI_API_KEY: "environment-key-must-not-be-inherited",
      });
      assert.equal(result.status, 2, result.stderr);
      assert.notEqual(result.stderr.trim(), "", "Missing prerequisites must be explained");
      assert.equal(connections, 0, "Preflight must not contact the model endpoint");
      assert.doesNotMatch(fs.readFileSync(calls, "utf8"), /pty-run/, "Preflight rejection must not start the TUI");
      const endpoints = path.join(temporary, `ruukoto-${process.getuid!()}`);
      assert.deepEqual(fs.readdirSync(temporary).filter(name => name !== path.basename(endpoints)), [], "Preflight rejection must remove temporary profiles");
      if (fs.existsSync(endpoints)) assert.deepEqual(fs.readdirSync(endpoints), [], "Preflight rejection must release its control endpoint");
      assert.equal(fs.readFileSync(auth, "utf8"), personalAuth);
    }
  } finally {
    try {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});
