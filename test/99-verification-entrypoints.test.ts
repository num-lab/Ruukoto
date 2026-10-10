import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { cleanupRuntime } from "../verification/smoke/gate.ts";
import { probeModelConfig } from "@ruukoto/agent/model-config.ts";

const root = path.resolve(import.meta.dirname, "..");
const entry = (name: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "verification/smoke", name), ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.error, undefined, `${name} 未正常退出：${result.error?.message}`);
  return result;
};

test("冒烟拒绝旧远端参数，退出 2 且不创建后台或尝试 SSH", () => {
  for (const name of ["smoke-04-desktop-execution.mts", "smoke-13-subagent-messaging.mts", "smoke-15-recover-subagents.mts", "smoke-18-im-final-delivery.mts"]) {
    const result = entry(name, ["--remote"], { ...process.env, PATH: "" });
    assert.equal(result.status, 2, `${name}：${result.stderr}`);
    assert.match(result.stderr, /前提缺失：此入口不接受参数：--remote/, name);
  }
});

test("Docker 不可用时单独报告前提缺失，不记为通过或断言失败", () => {
  const result = entry("smoke-04-desktop-execution.mts", [], { ...process.env, PATH: "" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /需要可用的 Docker 与镜像/);
});

test("发布模型入口要求显式配置，help 与升级入口各自可核实", () => {
  const name = "smoke-24-release-acceptance.mts";
  const missing = entry(name, []);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /必须显式提供 --models 与 --model/);
  const unknown = entry(name, ["--remote"]);
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /参数无效/);
  const help = entry(name, ["--help"], { ...process.env, PATH: "" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /可能产生费用/);
  const upgrade = entry(name, ["--upgrade-only"], { ...process.env, SMOKE24_BASE: "ruukoto-nonexistent-verification-base", SMOKE24_BASE_TAR: "" });
  assert.equal(upgrade.status, 2, upgrade.stderr);
  assert.match(upgrade.stderr, /升级需要 npm、tar/);
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

test("自包含模型缺凭据时离线速退 2，不继承 API key 或个人 auth，不启动 TUI", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "ruukoto-model-gate-test-"));
  const bin = path.join(directory, "bin"), home = path.join(directory, "home"), temporary = path.join(directory, "temporary");
  for (const dir of [bin, temporary, path.join(home, ".pi", "agent")]) fs.mkdirSync(dir, { recursive: true });
  const models = path.join(directory, "models.json"), calls = path.join(directory, "calls.txt");
  const config = { providers: { openai: {
    baseUrl: "http://127.0.0.1:1", api: "openai-completions", headers: { "x-verification": "headers-are-not-proof-of-auth" },
    models: [{ id: "verification-no-credential", name: "Verification", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }],
  } } };
  fs.writeFileSync(path.join(home, ".pi", "agent", "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "personal-key-must-not-be-read" } }));
  fs.writeFileSync(path.join(bin, "docker"), '#!/bin/sh\nprintf "docker %s\\n" "$*" >> "$SMOKE_TEST_CALLS"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "python3"), '#!/bin/sh\nprintf "python3 %s\\n" "$*" >> "$SMOKE_TEST_CALLS"\n[ "$1" = "-c" ] && exit 0\nexit 77\n', { mode: 0o755 });
  try {
    fs.writeFileSync(models, JSON.stringify({ providers: { openai: { ...config.providers.openai, apiKey: "fixture-key" } } }));
    const configured = await probeModelConfig(directory);
    assert.equal(configured.ok, true, `补上凭据后夹具必须是有效配置：${configured.detail}`);
    fs.writeFileSync(models, JSON.stringify(config));
    const result = entry("smoke-24-release-acceptance.mts", ["--models", models, "--model", "openai/verification-no-credential"], {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: home, TMPDIR: temporary,
      OPENAI_API_KEY: "environment-key-must-not-be-inherited", SMOKE_TEST_CALLS: calls,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /前提缺失：模型 openai\/verification-no-credential 未通过离线配置与认证检查/);
    assert.doesNotMatch(fs.readFileSync(calls, "utf8"), /pty-run|docker run/, "只允许基础设施探测，不能启动 TUI 或工具容器");
    assert.deepEqual(fs.readdirSync(temporary).filter((name) => name.startsWith("rk24-")), [], "认证门禁拒绝后清除临时模型档案");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
