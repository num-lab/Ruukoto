/**
 * CLI 入口分发测试（issue 21）。
 *
 * - 单元：resolveEntry 纯函数覆盖全部入口形态（无参/--session/--demo/路径/
 *   `-- 路径`/config/server/start 别名/旧拼法 tui/各管理命令/错误情形）；
 * - 进程级：tsx 与 bin 入口冒烟（非 TTY 拒绝、迁移指引、server 参数快速失败），
 *   管理命令另经真实后台验证产物分页导出。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { resolveEntry } from "@ruukoto/tui/cli-entry.ts";
import type { Task } from "@ruukoto/core/types.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { startMockMcp, MOCK_MCP_SECRET } from "./helpers/mock-mcp.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

// ---- 单元：resolveEntry ----

test("无参 → 默认任务界面", () => {
  const e = resolveEntry([]);
  assert.equal(e.kind, "tui");
  if (e.kind === "tui") {
    assert.equal(e.sessionId, undefined);
    assert.equal(e.demo, undefined);
  }
});

test("--session / --demo → 任务界面入口", () => {
  const s = resolveEntry(["--session", "s1"]);
  assert.equal(s.kind, "tui");
  if (s.kind === "tui") {
    assert.equal(s.sessionId, "s1");
    assert.equal(s.demo, undefined);
  }
  const d = resolveEntry(["--demo"]);
  assert.equal(d.kind, "tui");
  if (d.kind === "tui") {
    assert.equal(d.sessionId, undefined);
    assert.equal(d.demo, true);
  }
});

test("--demo 为布尔标志，不吞下一 token", () => {
  const e = resolveEntry(["--demo", "--session", "s1"]);
  assert.equal(e.kind, "tui");
  if (e.kind === "tui") {
    assert.equal(e.demo, true);
    assert.equal(e.sessionId, "s1");
  }
});

test("路径入口：普通路径、./config、`-- config`", () => {
  assert.deepStrictEqual(resolveEntry(["some/dir"]), { kind: "workspace", path: "some/dir" });
  assert.deepStrictEqual(resolveEntry(["./config"]), { kind: "workspace", path: "./config" });
  assert.deepStrictEqual(resolveEntry(["--", "config"]), { kind: "workspace", path: "config" });
  assert.deepStrictEqual(resolveEntry(["--", "with space/目录"]), { kind: "workspace", path: "with space/目录" });
});

test("命令名优先于路径：config / status 不按路径处理", () => {
  assert.deepStrictEqual(resolveEntry(["config"]), { kind: "config", offline: false });
  assert.deepStrictEqual(resolveEntry(["config", "--offline"]), { kind: "config", offline: true });
  assert.deepStrictEqual(resolveEntry(["status"]), { kind: "legacy", command: "status", argv: [] });
});

test("server 与兼容别名 start 同一路径", () => {
  assert.deepStrictEqual(resolveEntry(["server", "--data-dir", "x"]), { kind: "server", argv: ["--data-dir", "x"] });
  assert.deepStrictEqual(resolveEntry(["start", "--data-dir", "x"]), { kind: "server", argv: ["--data-dir", "x"] });
  assert.deepStrictEqual(resolveEntry(["server"]), { kind: "server", argv: [] });
});

test("旧拼法 tui 与全部管理命令保持 legacy 分发", () => {
  const legacy = [
    "create-project", "project", "create-session", "models", "set-model",
    "submit", "continue", "switch-mode", "set-session-mode", "status", "events",
    "interrupt", "cancel", "resume-queue", "confirm", "read-artifact",
    "credentials", "github", "mcp", "stop", "qq", "grant", "history-search",
    "memory", "selection-records", "legacy-import", "tui", "workflow",
  ];
  for (const cmd of legacy) {
    assert.deepStrictEqual(resolveEntry([cmd, "--x", "1"]), { kind: "legacy", command: cmd, argv: ["--x", "1"] }, cmd);
  }
});

test("错误情形 → help + error", () => {
  const cases: Array<{ argv: string[]; match: RegExp }> = [
    { argv: ["--bogus"], match: /参数错误/ }, // 未知标志
    { argv: ["--session"], match: /参数错误/ }, // 缺值
    { argv: ["path1", "path2"], match: /只接受一个路径/ }, // 多余位置参数
    { argv: ["/p", "--demo"], match: /不能与路径同用/ }, // 路径 + 标志
    { argv: ["--demo", "/p"], match: /不能与路径同用/ },
    { argv: ["--session", "s1", "/p"], match: /不能与路径同用/ },
    { argv: ["config", "--bogus"], match: /参数错误/ },
    { argv: ["config", "extra"], match: /不接受位置参数/ },
    { argv: ["--"], match: /需跟一个工作区路径/ },
    { argv: ["--", "a", "b"], match: /只接受一个路径/ },
  ];
  for (const { argv, match } of cases) {
    const e = resolveEntry(argv);
    assert.equal(e.kind, "help", JSON.stringify(argv));
    if (e.kind === "help") assert.match(e.error ?? "", match, JSON.stringify(argv));
  }
});

// ---- 进程级冒烟（不需要后台） ----

async function runCli(args: string[], opts: { bin?: boolean; product?: "ruukoto" | "ruukoto-code"; env?: NodeJS.ProcessEnv } = {}): Promise<{ status: number; stdout: Buffer; stderr: string }> {
  const product = opts.product ?? "ruukoto-code";
  const cmd = opts.bin ? process.execPath : tsxBin;
  const argv = opts.bin ? [path.join(repoRoot, "apps", product, "bin", `${product}.mjs`), ...args] : ["scripts/start.ts", ...args];
  return await new Promise((resolve, reject) => {
    childProcess.execFile(cmd, argv, { cwd: repoRoot, env: { ...process.env, ...opts.env, RUUKOTO_PRODUCT: "ruukoto-code" }, encoding: "buffer", timeout: 120_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ status: error ? Number(error.code) : 0, stdout, stderr: stderr.toString("utf8") });
    });
  });
}

test("进程：未知名字按工作区路径处理，非 TTY 下退出 1 并提示", async () => {
  const r = await runCli(["definitely-not-a-command-or-dir"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});

test("进程：tui 旧拼法打印迁移指引，且非 TTY 拒绝", async () => {
  const r = await runCli(["tui", "--demo"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /旧拼法/);
  assert.match(r.stderr, /TTY/);
});

test("进程：bin 入口引导 TS，未知名字退出 1", async () => {
  const r = await runCli(["bogus"], { bin: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});

test("进程：server --execution 非法值在启动前快速失败", async () => {
  const r = await runCli(["server", "--execution", "bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--execution 取值无效/);
});

test("进程：config 非 TTY 拒绝", async () => {
  const r = await runCli(["config"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});

test("进程：mcp cua 复用配置向导，非 TTY 给出正常入口要求", async () => {
  const r = await runCli(["mcp", "cua"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});

test("进程：所有 MCP 子命令在连接后台前拒绝旧 --project", async () => {
  for (const sub of ["configure", "list", "enable", "disable", "remove", "check", "cua"]) {
    const result = await runCli(["mcp", sub, "--project", "old-project"]);
    assert.equal(result.status, 1, sub);
    assert.match(result.stderr, /不接受 --project/, sub);
    assert.equal(result.stdout.length, 0, sub);
  }
});

test("进程：空 Code 实例通过 CLI 创建受限 MCP 凭据、绑定并发现工具，通用删除保留引用", async () => {
  const t = await startTestRuntime("mcp-cli-instance", async () => ({ kind: "text", text: "done" }), { config: { product: codeProduct.runtime, socketPath: undefined } });
  const mcp = await startMockMcp({ tools: [{ name: "fetch" }], requireAuth: true });
  const env = { ...process.env, RUUKOTO_OWNER_TOKEN: undefined, RUUKOTO_OWNER_TOKEN_FILE: undefined,
    RUUKOTO_DATA_DIR: t.dirs.dataDir, RUUKOTO_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CONTROL_DIR: t.runtime.controlDir(),
    RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CODE_CONTROL_DIR: t.runtime.controlDir(),
    RUUKOTO_CLI_MCP_SECRET: MOCK_MCP_SECRET };
  try {
    for (const projectArg of [["--project", "old-project"], ["--project=old-project"]]) {
      const refused = await runCli(["mcp", "configure", "--name", "old", "--endpoint", mcp.url, "--disabled", ...projectArg], { bin: true, env });
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /不接受 --project/);
    }
    assert.deepEqual((await t.client.request<{ services: unknown[] }>("mcp_list", {})).services, [], "旧旗标不能被其他旗标吞掉后写入实例配置");
    assert.equal(mcp.hits.length, 0);
    const added = await runCli(["credentials", "add", "--name", "mcp-cli", "--host", mcp.host, "--header", "authorization", "--purpose", "mcp", "--secret-env", "RUUKOTO_CLI_MCP_SECRET"], { bin: true, env });
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(t.runtime.credentials.get("mcp-cli")?.scope, { operations: ["mcp"] });
    assert.equal(t.runtime.credentials.getForUse("mcp-cli"), null, "通用 HTTP 不得借用首次写入的 MCP 凭据");
    const saved = await runCli(["mcp", "configure", "--name", "docs", "--endpoint", mcp.url, "--credential", "mcp-cli", "--tools", "fetch"], { bin: true, env });
    assert.equal(saved.status, 0, saved.stderr);
    const service = JSON.parse(saved.stdout.toString("utf8")) as { id: string };
    const checked = await runCli(["mcp", "check", service.id], { bin: true, env });
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout.toString("utf8")).ok, true);
    assert.ok(mcp.hits.some(hit => hit.rpcMethod === "tools/list" && hit.hasAuth));
    assert.equal(mcp.hits.some(hit => hit.rpcMethod === "tools/call"), false);
    assert.equal(Buffer.concat([added.stdout, saved.stdout, checked.stdout]).includes(Buffer.from(MOCK_MCP_SECRET)), false);
    const removed = await runCli(["credentials", "remove", "mcp-cli"], { bin: true, env });
    assert.equal(removed.status, 1, removed.stderr);
    assert.ok(t.runtime.credentials.get("mcp-cli"), "引用中的凭据仍保留");
    const list = await runCli(["mcp", "list"], { bin: true, env });
    assert.equal(list.status, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout.toString("utf8")).services[0].id, service.id);
  } finally { await mcp.close(); await t.shutdown(); }
});

test("进程：Coding 完整导出超过 720 KiB 的 PNG；分页失败、元数据变化与坏图均保留原目标", async () => {
  const t = await startTestRuntime("art-cli", async () => ({ kind: "text", text: "done" }), { config: { socketPath: undefined } });
  const query = t.runtime.queryArtifact.bind(t.runtime);
  try {
    const session = await t.runtime.createSession({ projectName: "artifact-cli", cwd: t.work[0] });
    const task = await t.client.request<Task>("submit", { session_id: session.id, request_id: "image", input: "建立产物归属", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
    await waitFor("产物归属任务完成", () => t.runtime.store.getTask(task.id)?.status === "completed");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    const body = Buffer.from(`Comment\0${"x".repeat(720 * 1024 + 137)}`);
    const header = Buffer.alloc(8), checksum = Buffer.alloc(4);
    header.writeUInt32BE(body.length); header.write("tEXt", 4);
    checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])));
    const bytes = Buffer.concat([png.subarray(0, -12), header, body, checksum, png.subarray(-12)]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const artifact = t.runtime.artifacts.importImage({ id: "art_cli_png", taskId: task.id, sessionId: session.id, name: "large.png", byteCount: bytes.length, mimeType: "image/png", contentHash: digest }, bytes);
    const output = path.join(t.dirs.root, "exported image.png");
    const source = path.join(t.dirs.dataDir, "artifacts", `${artifact.id}.bin`);
    const args = ["read-artifact", task.id, artifact.id];
    const env = { ...process.env, RUUKOTO_OWNER_TOKEN: undefined, RUUKOTO_OWNER_TOKEN_FILE: undefined,
      RUUKOTO_DATA_DIR: t.dirs.dataDir, RUUKOTO_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CONTROL_DIR: t.runtime.controlDir(),
      RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CODE_CONTROL_DIR: t.runtime.controlDir() };
    const offsets: number[] = [];
    t.runtime.queryArtifact = (input) => { offsets.push(input.offset ?? 0); return query(input); };
    for (const product of ["ruukoto-code"] as const) {
      offsets.length = 0;
      const result = await runCli([...args, "--output", output], { bin: true, product, env });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(offsets, [0, 720 * 1024]);
      assert.equal(result.stdout.length, 0);
      assert.match(result.stderr, /已完整导出/);
      assert.deepEqual(fs.readFileSync(output), bytes);
      assert.equal(createHash("sha256").update(fs.readFileSync(output)).digest("hex"), digest);
      assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    }
    const slice = await runCli([...args, "--offset", "11", "--length", "19"], { env });
    assert.equal(slice.status, 0, slice.stderr);
    assert.deepEqual(slice.stdout, bytes.subarray(11, 30));
    const original = Buffer.from("原有目标\n");
    fs.writeFileSync(output, original);
    for (const flag of ["--offset", "--length"]) {
      offsets.length = 0;
      const conflict = await runCli([...args, "--output", output, flag, "0"], { env });
      assert.equal(conflict.status, 1);
      assert.match(conflict.stderr, /不能与 --offset \/ --length 同用/);
      assert.deepEqual(offsets, [], "参数冲突在连接后台前拒绝");
      assert.deepEqual(fs.readFileSync(output), original);
    }
    const missingOutput = await runCli([...args, "--output"], { env });
    assert.equal(missingOutput.status, 1);
    assert.match(missingOutput.stderr, /需要文件路径/);
    t.runtime.store.setArtifactStatus(artifact.id, "partial");
    const partial = await runCli([...args, "--output", output], { env });
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /尚未完整定稿/);
    assert.deepEqual(fs.readFileSync(output), original);
    t.runtime.store.setArtifactStatus(artifact.id, "complete");
    for (const failure of ["unavailable", "metadata", "truncated", "hash"] as const) {
      offsets.length = 0;
      t.runtime.queryArtifact = (input) => {
        offsets.push(input.offset ?? 0);
        if (input.offset) {
          if (failure === "unavailable") fs.unlinkSync(source);
          if (failure === "metadata") t.runtime.store.db.prepare("UPDATE artifacts SET name = 'changed.png' WHERE id = ?").run(artifact.id);
          if (failure === "truncated") fs.truncateSync(source, 720 * 1024);
          if (failure === "hash") {
            const corrupt = Buffer.from(bytes); corrupt[720 * 1024] ^= 1;
            fs.writeFileSync(source, corrupt);
          }
        }
        return query(input);
      };
      const failed = await runCli([...args, "--output", output], { env });
      assert.equal(failed.status, 1, failure);
      assert.match(failed.stderr, /产物导出失败，目标文件未替换/);
      assert.deepEqual(offsets, [0, 720 * 1024], failure);
      assert.deepEqual(fs.readFileSync(output), original, failure);
      assert.deepEqual(fs.readdirSync(t.dirs.root).filter(name => name.startsWith(".ruukoto-artifact-")), [], "失败临时文件已清理");
      fs.writeFileSync(source, bytes);
      t.runtime.store.db.prepare("UPDATE artifacts SET name = ? WHERE id = ?").run(artifact.name, artifact.id);
    }
    t.runtime.queryArtifact = query;
    for (const text of [Buffer.from("中文-正文\0\n"), Buffer.alloc(0)]) {
      const plain = t.runtime.artifacts.begin({ taskId: task.id, sessionId: session.id, name: "text" });
      fs.writeFileSync(path.join(t.dirs.dataDir, "artifacts", `${plain.id}.bin`), text);
      t.runtime.store.addArtifactBytes(plain.id, text.length);
      t.runtime.artifacts.complete(plain.id);
      const exported = await runCli(["read-artifact", task.id, plain.id, "--output", output], { env });
      assert.equal(exported.status, 0, exported.stderr);
      assert.deepEqual(fs.readFileSync(output), text, "没有哈希的文本与空产物也可完整导出");
    }
  } finally { t.runtime.queryArtifact = query; await t.shutdown(); }
});
