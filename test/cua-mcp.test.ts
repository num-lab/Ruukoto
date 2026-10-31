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

const MAC = () => parseCuaConfig({ kind: "cua-mac", executable: "/Applications/Cua.app/Contents/MacOS/cua-driver", sha256: "a".repeat(64), version: "0.38.0" });
const ALLOW = ["get_window_state", "get_guide", "click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag", "move_cursor", "run_steps"];
const VALID_BATCH = () => ({ steps: [{ tool: "click", args: { x: 10, y: 20 } }, { tool: "type_text", args: { text: "hi" } }], pid: 42, window_id: 7, observe: {} });

test("Cua批次：get_guide只读、run_steps受限为规范schema且单步动作集合固定", () => {
  const mac = MAC();
  assert.equal(cuaToolEffect(mac, "get_guide"), "read");
  assert.equal(cuaToolEffect(mac, "run_steps"), "write");
  assert.equal(restrictCuaTool(mac, { name: "run_script", inputSchema: {} }), undefined);
  const guide = restrictCuaTool(mac, { name: "get_guide", description: "d", inputSchema: { type: "object", properties: { topic: { type: "string" }, session: { type: "string" } } } })!;
  assert.deepEqual(Object.keys(guide.inputSchema.properties!), ["topic"], "get_guide 同样去掉会话字段");
  const schema = restrictCuaTool(mac, { name: "run_steps", description: "d", inputSchema: { type: "object", properties: { foreground_fallback: {}, session: {} } } })!.inputSchema as Record<string, any>;
  assert.deepEqual(schema.required, ["steps", "pid", "window_id", "observe"]);
  assert.equal(schema.properties.steps.maxItems, 8);
  assert.equal(schema.properties.observe.type, "object");
  assert.ok(!schema.properties.steps.items.properties.tool.enum.includes("set_value"), "set_value 不在批次集合");
  for (const field of ["foreground_fallback", "session", "app", "window", "target", "scope"]) assert.equal(field in schema.properties, false, `${field} 不向模型开放`);
});

test("Cua批次：规范形式通过，别名、简写、条件、越界与嵌套宿主字段一律拒绝", () => {
  const mac = MAC();
  const pass = cuaArguments(mac, "run_steps", VALID_BATCH(), ALLOW) as { steps: unknown[]; observe: Record<string, unknown> };
  assert.deepEqual(pass.steps.length, 2);
  assert.deepEqual(pass.observe, { pid: 42, window_id: 7 }, "observe 注入批次窗口");
  const denied = (mutate: (batch: Record<string, any>) => void, label: string, list: string[] = ALLOW) => {
    const batch = VALID_BATCH();
    mutate(batch);
    assert.throws(() => cuaArguments(mac, "run_steps", batch, list), (error: unknown) => error instanceof McpError && error.code === "cua_batch_invalid", label);
  };
  denied(b => { b.steps = Array.from({ length: 9 }, () => ({ tool: "click", args: { x: 1, y: 2 } })); }, "超过八步");
  denied(b => { b.steps = []; }, "空批次");
  denied(b => { b.steps[0] = { click: { x: 1, y: 2 } }; }, "{tool:args} 简写");
  denied(b => { b.steps[0].tool = "press"; }, "上游别名 press");
  denied(b => { b.steps[0].tool = "tab"; }, "键名被当作工具");
  denied(b => { b.steps[0].tool = "get_window_state"; }, "批次内不含观察工具");
  denied(b => { b.steps[0].tool = "wait_for"; }, "wait_for 不在首批");
  denied(b => { b.steps[0].tool = "expect"; }, "expect 不在首批");
  denied(b => { b.steps[0].tool = "set_value"; }, "set_value 不在批次集合");
  denied(b => { b.foreground_fallback = true; }, "foreground_fallback 不开放");
  denied(b => { b.delay_ms = 5000; }, "delay_ms 越界");
  denied(b => { delete b.observe; }, "observe 必填");
  denied(b => { delete b.pid; }, "批次窗口必填");
  denied(b => { b.observe.pid = 999; }, "observe 指向其他窗口");
  denied(b => { b.observe.session = "other"; }, "observe 嵌套会话覆盖");
  denied(b => { b.observe.screenshot_out_file = "/tmp/x.png"; }, "observe 嵌套文件输出");
  denied(b => { b.observe._internal = true; }, "observe 保留字段");
  denied(b => { b.steps[0].args.session = "other"; }, "步骤嵌套会话覆盖");
  denied(b => { b.steps[0].args.sandbox = "x"; }, "步骤嵌套 sandbox");
  denied(b => { b.steps[0].args.debug_image_out = "/tmp/x"; }, "步骤嵌套文件输出");
  denied(b => { b.steps[0].args.pid = 999; }, "步骤重定向窗口");
  denied(b => { b.steps[0].args.window = "其他"; }, "步骤 window 覆盖");
  denied(b => { b.steps[0].args.scope = "desktop"; }, "步骤桌面重定向");
  denied(b => { b.steps[0].args.from_zoom = true; }, "未开放 zoom 参照");
  denied(b => { b.steps[0].args.nope = 1; }, "未知步骤字段");
  denied(b => { b.steps[0].args._internal = true; }, "步骤保留字段");
  denied(b => { b.steps[0].timeout_ms = 20000; }, "步骤 timeout 越界");
  denied(b => { b.steps[1].args.text = "x".repeat(1025); }, "文本超长");
  denied(b => { delete b.steps[1].args.text; }, "必填字段缺失");
  denied(b => { b.steps[0].args.x = "10"; }, "坐标类型错误");
  denied(b => { b.steps[0].args.delivery_mode = "yolo"; }, "delivery_mode 枚举");
  denied(b => { b.steps[0].args = undefined; }, "args 必填");
  denied(b => { b.steps[0] = { tool: "click" }; }, "步骤缺 args");
  denied(b => { b.steps[0].args.app = "其他"; }, "步骤 app 覆盖");
  denied(b => { b.steps[0].args.target = { kind: "desktop" }; }, "步骤 target 覆盖");
  // 可执行组合：无目标、半截坐标、互斥目标、裸 nth 与 capture_id 错配都在发送前拒绝
  denied(b => { b.steps[0].args = {}; }, "click 无目标");
  denied(b => { b.steps[0].args = { x: 10 }; }, "半截坐标");
  denied(b => { b.steps[0].args = { x: 10, y: 20, element_token: "s00000001:14" }; }, "坐标与令牌互斥");
  denied(b => { b.steps[0].args = { element_token: "s00000001:14", role: "AXButton", name: "Save" }; }, "令牌与选择器互斥");
  denied(b => { b.steps[0].args = { role: "AXButton", x: 1, y: 2 }; }, "选择器与坐标互斥");
  denied(b => { b.steps[0].args = { nth: 2 }; }, "裸 nth 不成选择器");
  denied(b => { b.steps[0].args = { role: "AXButton", name: "Save", nth: -1 }; }, "nth 须非负");
  denied(b => { b.steps[0].args = { role: "AXButton", name: "Save", label: "保存" }; }, "name 与 label 互斥");
  denied(b => { b.steps[0].args = { element_token: "s1:1" }; }, "元素令牌须为钉版格式");
  denied(b => { b.steps[0].args = { element_token: "s0000000g:14" }; }, "元素令牌十六进制前缀");
  denied(b => { b.steps[0].args = { element_token: "s00000001:" }; }, "元素令牌缺行号");
  denied(b => { b.steps[0].args = { role: "AXButton", name: "Save" }; }, "click 不接受选择器目标（菜单路由）");
  denied(b => { b.steps[0].args = { capture_id: "cap-1" }; }, "capture_id 需配对坐标");
  denied(b => { b.steps[0].args = { x: 1, y: 2, count: 0 }; }, "count 越界");
  // 受影响子集：生效为文本输入的步骤不接受元素目标（上游过期重试会重放整段输入）
  denied(b => { b.steps[1].args = { element_token: "s00000001:20", text: "hi" }; }, "type_text 不接受令牌");
  denied(b => { b.steps[1].args = { role: "AXTextField", name: "名称", text: "hi" }; }, "type_text 不接受选择器");
  denied(b => { b.steps[1] = { tool: "press_key", args: { element_token: "s00000001:20", key: "asterisk" } }; }, "归一化为 type_text 的 press_key 同样不接受令牌");
  // 数值边界：上游 schema 的 min/max 在发送前生效
  denied(b => { b.steps[1].args = { text: "hi", delay_ms: 201 }; }, "type_text delay_ms 越界");
  denied(b => { b.steps[0] = { tool: "scroll", args: { direction: "down", amount: 51 } }; }, "scroll amount 越界");
  denied(b => { b.steps[0] = { tool: "drag", args: { from_x: 1, from_y: 2, to_x: 3, to_y: 4, steps: 201 } }; }, "drag steps 越界");
  denied(b => { b.steps[0] = { tool: "move_cursor", args: { role: "AXButton", name: "x" } }; }, "move_cursor 不接受元素目标");
  denied(b => { b.steps[0] = { tool: "drag", args: { from_x: 1, from_y: 2, to_x: 3, to_y: 4, element_token: "s1:1" } }; }, "drag 不接受元素目标");
  // 允许列表：子工具、归一化生效工具与末尾观察都必须显式允许
  denied(() => {}, "type_text 未允许", ALLOW.filter(name => name !== "type_text"));
  denied(b => { b.steps[1] = { tool: "press_key", args: { key: "return" } }; }, "press_key 未允许", ALLOW.filter(name => name !== "press_key"));
  denied(b => { b.steps[1] = { tool: "press_key", args: { key: "asterisk" } }; }, "press_key 归一化为 type_text 需两者皆允许", ALLOW.filter(name => name !== "type_text"));
  denied(b => { b.steps[1] = { tool: "hotkey", args: { keys: ["cmd"] } }; }, "单键 hotkey 归一化为 press_key", ALLOW.filter(name => name !== "press_key"));
  denied(() => {}, "observe 工具未允许", ALLOW.filter(name => name !== "get_window_state"));
  denied(() => {}, "run_steps 未允许", ALLOW.filter(name => name !== "run_steps"));
  // 合法形态：选择器、元素令牌、整数 delay、显式批次 delivery_mode、observe 限定字段、归一化可解释步骤
  for (const mutate of [
    (b: Record<string, any>) => { b.steps[0].args = { element_token: "s00000001:14" }; },
    (b: Record<string, any>) => { b.steps[0] = { tool: "double_click", args: { role: "AXButton", name: "Save", nth: 0 } }; },
    (b: Record<string, any>) => { b.steps[0].timeout_ms = 3000; b.delay_ms = 500; b.delivery_mode = "foreground"; },
    (b: Record<string, any>) => { b.observe = { include_screenshot: false, max_elements: 100, pid: 42, window_id: 7 }; },
    (b: Record<string, any>) => { b.steps.push({ tool: "hotkey", args: { keys: ["cmd", "s"] } }); },
    (b: Record<string, any>) => { b.steps.push({ tool: "press_key", args: { element_token: "s00000001:20", key: "return" } }); },
    (b: Record<string, any>) => { b.steps.push({ tool: "press_key", args: { key: "asterisk" } }); },
    (b: Record<string, any>) => { b.steps.push({ tool: "hotkey", args: { keys: ["f5"] } }); },
  ]) {
    const batch = VALID_BATCH();
    mutate(batch);
    assert.doesNotThrow(() => cuaArguments(mac, "run_steps", batch, ALLOW));
  }
  // Linux 配置不开放 run_steps（未获能力平价）
  const linux = parseCuaConfig({ kind: "cua-linux", executable: "/usr/local/bin/cua", sha256: "a".repeat(64), version: "0.7.0", sandbox: "local:desktop", sandboxId: "b".repeat(64) });
  assert.equal(cuaToolEffect(linux, "run_steps"), null);
  assert.throws(() => cuaArguments(linux, "run_steps", VALID_BATCH(), ALLOW), (error: unknown) => error instanceof McpError && error.code === "cua_tool_denied");
});
