import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeCuaTools, discoverCuaTargets } from "@ruukoto/agent/mcp/cua-discovery.ts";
import type { CuaConfig } from "@ruukoto/agent/mcp/cua.ts";

test("Cua 配置发现：固定版本与本地沙箱身份由宿主生成，拒绝不安全运行策略", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-targets-"))), binary = path.join(home, "bin/cua");
  fs.mkdirSync(path.dirname(binary)); fs.writeFileSync(binary, "fixed-cua", { mode: 0o700 });
  const states = path.join(home, ".cua/sandboxes"), id = "a".repeat(64);
  fs.mkdirSync(states, { recursive: true }); fs.writeFileSync(path.join(states, "desktop.json"), JSON.stringify({ container_id: id }));
  let restart = "no", version = "cua 0.7.0", running = true;
  const commands: string[][] = [];
  const host = { platform: "linux", home, searchPath: path.dirname(binary), command: async (command: string, args: string[], env: Record<string, string>) => {
    commands.push([command, ...args]);
    assert.equal(env.HOME, home); assert.equal(env.DOCKER_HOST, undefined); assert.equal(env.RUUKOTO_OWNER_TOKEN, undefined);
    if (command === binary) { assert.deepEqual(args, ["--version"]); return version; }
    assert.equal(command, "/usr/bin/docker"); assert.deepEqual(args, ["--host", "unix:///var/run/docker.sock", "inspect", "--type", "container", id]);
    return JSON.stringify([{ Id: id, HostConfig: { RestartPolicy: { Name: restart }, NetworkMode: "bridge" }, Mounts: [], State: { Running: running, Restarting: false } }]);
  } };
  try {
    const targets = await discoverCuaTargets("cua-linux", host);
    assert.deepEqual(targets.issues, []);
    assert.deepEqual(targets.targets[0].config, { kind: "cua-linux", executable: binary, version: "0.7.0", sha256: createHash("sha256").update("fixed-cua").digest("hex"), sandbox: "local:desktop", sandboxId: id });
    restart = "always";
    assert.equal((await discoverCuaTargets("cua-linux", host)).issues[0].code, "cua_sandbox_unsafe");
    restart = "no"; running = false;
    assert.equal((await discoverCuaTargets("cua-linux", host)).issues[0].code, "cua_sandbox_stopped");
    version = "cua 0.8.0";
    assert.equal((await discoverCuaTargets("cua-linux", host)).issues[0].code, "cua_version_unsupported");
    assert.ok(commands.every(command => !command.includes("start") && !command.includes("stop") && !command.includes("--connection")));
    const unsupported = await discoverCuaTargets("cua-mac", host);
    assert.deepEqual(unsupported.targets, []); assert.equal(unsupported.issues[0].code, "cua_platform_unavailable");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Cua 配置发现：缺安装与损坏沙箱可见，普通管理不被初始化错误中断", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-missing-")));
  const host = { platform: "linux", home, searchPath: "", command: async () => "cua 0.7.0" };
  try {
    const missing = await discoverCuaTargets("cua-linux", host);
    assert.equal(missing.issues[0].code, "cua_artifact_missing"); assert.deepEqual(missing.targets, []);
    fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true }); fs.writeFileSync(path.join(home, ".local/bin/cua"), "cua", { mode: 0o700 });
    const noSandbox = await discoverCuaTargets("cua-linux", host);
    assert.equal(noSandbox.issues[0].code, "cua_sandbox_missing");
    fs.mkdirSync(path.join(home, ".cua/sandboxes"), { recursive: true }); fs.writeFileSync(path.join(home, ".cua/sandboxes/broken.json"), "{");
    assert.equal((await discoverCuaTargets("cua-linux", host)).issues[0].code, "cua_sandbox_unavailable");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Code Cua 静态发现：只读取固定制品清单，不启动电脑 runtime，制品变化拒绝", { skip: process.platform !== "darwin" }, async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-static-"))), executable = path.join(directory, "driver"), args = path.join(directory, "args.json");
  const tool = { name: "click", description: "点击", input_schema: { type: "object", properties: { x: { type: "number" } } } };
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify({ version: "0.38.0", tools: [tool] }))});`, { mode: 0o700 });
  const config: CuaConfig = { kind: "cua-mac", version: "0.38.0", executable, sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") };
  try {
    assert.deepEqual(await describeCuaTools(config), [{ name: tool.name, description: tool.description, inputSchema: tool.input_schema }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(args, "utf8")), ["dump-docs", "--type", "mcp"]);
    fs.appendFileSync(executable, "\n");
    await assert.rejects(describeCuaTools(config), { code: "cua_config_invalid" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
