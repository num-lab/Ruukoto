import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { connectMcpStdio, McpError, type McpCallEvidence, type McpTimeouts } from "@ruukoto/agent/mcp/transport.ts";
import { cuaArguments, cuaProgram, cuaToolEffect, parseCuaConfig, restrictCuaTool } from "@ruukoto/agent/mcp/cua.ts";
import { mcpImages, McpImageError } from "@ruukoto/agent/mcp/images.ts";

const tool = { name: "click", inputSchema: { type: "object", properties: {} } };
test("Cua stdio：程序缺失只报告不可用，不泄漏内部路径", async () => {
  await assert.rejects(connectMcpStdio({ serviceId: "missing", command: "/missing/private-install/cua-driver", args: [], env: {} }), (error: unknown) => error instanceof McpError && error.code === "connect_failed" && !error.message.includes("private-install"));
});

test("Cua启动：固定制品哈希与宿主参数，Linux显式embedded不接共享daemon", async () => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(process.execPath)) hash.update(bytes);
  const artifact = { executable: process.execPath, sha256: hash.digest("hex") };
  const config = parseCuaConfig(process.platform === "darwin" ? { ...artifact, kind: "cua-mac", version: "0.38.0" } : { ...artifact, kind: "cua-linux", version: "0.7.0", sandbox: "local:desktop", sandboxId: "a".repeat(64) });
  const program = await cuaProgram(config);
  assert.deepEqual(program.args.slice(0, 2), process.platform === "darwin" ? ["mcp", "--direct"] : ["--embedded", "mcp"]);
  assert.equal(program.command, process.execPath);
  assert.equal(program.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  await assert.rejects(cuaProgram({ ...config, sha256: "0".repeat(64) }), (error: unknown) => error instanceof McpError && error.code === "cua_config_invalid");
});

async function fixture(options: McpTimeouts = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ruukoto-cua-stdio-")), record = path.join(directory, "sent.jsonl");
  const connection = await connectMcpStdio({ serviceId: "offline-cua", command: process.execPath, args: [fileURLToPath(new URL("./helpers/cua-stdio-fixture.mjs", import.meta.url)), record], env: { PATH: "/usr/bin:/bin" } }, options);
  return { connection, async calls() { return (await fs.readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(message => message.method === "tools/call"); },
    async close() { await connection.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test("Cua stdio：跨调用保持同进程，每次证据独立，记录失败零发送", async () => {
  process.env.RUUKOTO_CUA_TEST_SECRET = "must-not-inherit";
  const f = await fixture();
  try {
    assert.equal((await f.connection.listTools())[0].name, "click");
    const saved: McpCallEvidence[][] = [[], []];
    const pids: number[] = [];
    for (const index of [0, 1]) {
      const response = await f.connection.callTool(tool, { index }, undefined, {
        async recordCallRequest(request) { assert.equal(JSON.parse(request).params.arguments.index, index); },
        async recordCallProgress(evidence) { saved[index].push({ ...evidence }); },
      });
      const content = response.content[0]; assert.equal(content.type, "text");
      if (content.type !== "text") throw new Error("expected text");
      const result = JSON.parse(content.text); pids.push(result.pid); assert.equal(result.inheritedSecret, null);
    }
    assert.equal(pids[0], pids[1]); assert.equal(pids[0], f.connection.pid);
    assert.equal(JSON.parse(saved[1][0].request!).params.arguments.index, 1);
    assert.notEqual(JSON.parse(saved[0].at(-1)!.response!).id, JSON.parse(saved[1].at(-1)!.response!).id);
    assert.equal(JSON.parse(saved[1].at(-1)!.request!).params.arguments.index, 1);
    await assert.rejects(f.connection.callTool(tool, {}, undefined, { async recordCallRequest() { throw new Error("disk failed"); } }), (error: unknown) => error instanceof McpError && error.code === "evidence_failed");
    assert.equal((await f.calls()).length, 2);
  } finally { delete process.env.RUUKOTO_CUA_TEST_SECRET; await f.close(); }
});

test("Cua stdio：写后取消和异常退出不重发，拒绝并发抢占", async () => {
  const f = await fixture({ callTimeoutMs: 5000 });
  try {
    const controller = new AbortController();
    let sent!: () => void; const recorded = new Promise<void>(resolve => { sent = resolve; });
    const call = f.connection.callTool(tool, { hang: true }, controller.signal, { async recordCallRequest() { sent(); } });
    const rejected = assert.rejects(call, (error: unknown) => error instanceof McpError && error.code === "canceled");
    await recorded;
    await assert.rejects(f.connection.callTool(tool, {}), (error: unknown) => error instanceof McpError && error.code === "call_active");
    // 等管道实际可见，避免只证明记录后、写入前取消。
    while (!(await f.calls()).length) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort(); await rejected;
    assert.equal((await f.calls()).length, 1); assert.ok(f.connection.callEvidence?.request); assert.equal(f.connection.callEvidence?.response, undefined);
    await f.connection.close(); assert.equal((await f.calls()).length, 1);
  } finally { await f.close(); }
  const exited = await fixture();
  try { await assert.rejects(exited.connection.callTool(tool, { exit: true })); assert.equal((await exited.calls()).length, 1); assert.equal(exited.connection.callEvidence?.response, undefined); }
  finally { await exited.close(); }
});

test("Cua stdio：记录期间取消或超时，迟到记录不能发送或污染下一次调用", async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    const f = await fixture({ callTimeoutMs: mode === "timeout" ? 50 : 5000 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    try {
      const controller = new AbortController();
      const call = f.connection.callTool(tool, { old: true }, controller.signal, { async recordCallRequest() { entered(); await gate; } });
      const failure = assert.rejects(call, (error: unknown) => error instanceof McpError && error.code === (mode === "cancel" ? "canceled" : "timeout"));
      await started;
      if (mode === "cancel") controller.abort();
      await failure;
      assert.equal((await f.calls()).length, 0);
      await f.connection.callTool(tool, { current: true });
      release();
      // 后续调用的应答排在旧 send 的继续执行之后，确保检查没有抢先读管道。
      await f.connection.callTool(tool, { barrier: true });
      assert.deepEqual((await f.calls()).map(message => message.params.arguments), [{ current: true }, { barrier: true }]);
      assert.equal(JSON.parse(f.connection.callEvidence!.request!).params.arguments.barrier, true);
    } finally { release(); await f.close(); }
  }
});

test("Cua stdio：关闭一条连接只回收自身进程", async () => {
  const first = await fixture(), second = await fixture();
  try {
    assert.notEqual(first.connection.pid, second.connection.pid);
    await first.connection.close();
    assert.equal(first.connection.closed, true);
    await second.connection.callTool(tool, { stillConnected: true });
    assert.equal((await second.calls()).length, 1);
  } finally { await first.close(); await second.close(); }
});

test("Cua stdio：两次调用间退出使连接失效，下一调用不记录新发送", async () => {
  const f = await fixture();
  try {
    await f.connection.callTool(tool, { exitAfter: true });
    const deadline = Date.now() + 1000;
    while (!f.connection.closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.connection.closed, true);
    let recorded = false;
    await assert.rejects(f.connection.callTool(tool, {}, undefined, { async recordCallRequest() { recorded = true; } }));
    assert.equal(recorded, false); assert.equal((await f.calls()).length, 1);
  } finally { await f.close(); }
});

test("Cua stdio：原请求持久慢于SDK超时，释放后禁止首次发送", async () => {
  const f = await fixture({ callTimeoutMs: 40 });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const pending = f.connection.callTool(tool, { stale: true }, undefined, { async recordCallRequest() { entered(); await gate; } });
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof McpError && error.code === "timeout");
    await started;
    await new Promise(resolve => setTimeout(resolve, 80));
    release(); await rejected;
    await f.connection.callTool(tool, { barrier: true });
    assert.deepEqual((await f.calls()).map(message => message.params.arguments), [{ barrier: true }]);
  } finally { release(); await f.close(); }
});

test("Cua stdio：48MiB聚合预算容纳四张上限图片，超限保留原发送事实", async () => {
  const f = await fixture();
  try {
    const result = await f.connection.callTool(tool, { images: true });
    const images = mcpImages(result); assert.equal(images.size, 4); assert.ok([...images.values()].every(image => !(image instanceof McpImageError)));
    await assert.rejects(f.connection.callTool(tool, { oversize: true }));
    assert.equal((await f.calls()).length, 2); assert.equal(JSON.parse(f.connection.callEvidence!.request!).params.arguments.oversize, true); assert.equal(f.connection.callEvidence?.response, undefined);
  } finally { await f.close(); }
});

test("Cua配置：拒绝任意启动项与异sandbox，模型清单去掉宿主目标和危险工具", () => {
  const config = parseCuaConfig({ kind: "cua-linux", executable: "/usr/local/bin/cua", sha256: "a".repeat(64), version: "0.7.0", sandbox: "local:desktop", sandboxId: "b".repeat(64) });
  assert.throws(() => parseCuaConfig({ ...config, args: ["--shell"] }));
  assert.throws(() => parseCuaConfig({ ...config, version: "latest" }));
  assert.throws(() => cuaArguments(config, "computer_click", { sandbox: "local:other" }));
  assert.throws(() => cuaArguments(config, "computer_click", { session: "other" }));
  assert.deepEqual(cuaArguments(config, "computer_click", { x: 1, y: 2 }), { x: 1, y: 2, sandbox: "local:desktop" });
  const raw = { name: "computer_click", inputSchema: { type: "object" as const, properties: { sandbox: { type: "string" }, x: { type: "number" } }, required: ["sandbox", "x"] } };
  const restricted = restrictCuaTool(config, raw)!;
  assert.deepEqual(restricted.inputSchema.required, ["x"]); assert.deepEqual(Object.keys(restricted.inputSchema.properties!), ["x"]); assert.equal(restricted.inputSchema.additionalProperties, false); assert.ok(raw.inputSchema.properties.sandbox);
  assert.equal(cuaToolEffect(config, "computer_screenshot"), "read"); assert.equal(cuaToolEffect(config, "computer_accessibility_act"), "write");
  for (const name of ["computer_shell", "computer_clipboard", "sandbox_create", "sandbox_delete", "run_script"]) assert.equal(restrictCuaTool(config, { ...raw, name }), undefined);
  const mac = parseCuaConfig({ kind: "cua-mac", executable: "/Applications/Cua.app/Contents/MacOS/cua-driver", sha256: "a".repeat(64), version: "0.38.0" });
  for (const [name, field] of [["get_window_state", "screenshot_out_file"], ["get_desktop_state", "screenshot_out_file"], ["click", "debug_image_out"]]) {
    const restrictedMac = restrictCuaTool(mac, { name, inputSchema: { type: "object", properties: { [field]: { type: "string" } } } })!;
    assert.deepEqual(restrictedMac.inputSchema.properties, {});
    assert.throws(() => cuaArguments(mac, name, { [field]: "/tmp/forbidden-write" }), (error: unknown) => error instanceof McpError && error.code === "cua_parameter_denied");
  }
  assert.equal(restrictCuaTool(mac, { ...raw, name: "launch_app" }), undefined);
});
