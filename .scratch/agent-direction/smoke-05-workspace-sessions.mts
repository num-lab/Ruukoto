/**
 * 按工作区创建和切换开发会话的产品级冒烟（agent-direction issue 05，ADR 0017）。
 *
 * 模型层打桩（MockModelServer，确定性脚本），其余全真：真实 bin/ruukoto-dev.mjs
 * 后台进程、真实 socket / SQLite / 文件系统。
 *
 * 覆盖（与工单 05 验收标准对应）：
 *  1. 打开含多个仓库（.git 子目录）的根目录 → 工作区+新会话，快照携带根目录身份；
 *  2. 符号链接别名与路径变体重开 → 同一工作区、每次新建会话；同名不同目录各自
 *     成工作区（仅展示名追加序号，绝不合并）；同一请求标识重发不重复创建；
 *  3. 旧入口（create_project + create_session）项目经 open_workspace 认领根目录：
 *     旧关系保留、认领后自动归属、旧 API 记录仍可读；
 *  4. 完整路径：新会话提交任务执行完成，历史可查。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL。工作区位置可用 TMPDIR 控制。
 * 运行：npx tsx .scratch/agent-direction/smoke-05-workspace-sessions.mts
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, makeTestDirs, cleanupDirs, taskStatus, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { killProcessTree } from "../../test/helpers/backend.ts";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

const { dirs } = await makeTestDirs("smoke05", 0);
const controlDir = path.join(dirs.root, "control");
const server = new MockModelServer(async () => ({ kind: "text", text: "pong" }));
const baseUrl = await server.start();
await writeModelsJson(dirs, baseUrl);

const child = childProcess.spawn(
  process.execPath,
  [path.join(repoRoot, "bin", "ruukoto-dev.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--tools", "mock"],
  {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_DEV_CONTROL_DIR: controlDir },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  },
);
let stderr = "";
child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

async function connect(): Promise<ControlClient> {
  const socketPath = path.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`后台提前退出：${stderr.slice(0, 2000)}`);
    }
    try {
      const client = await ControlClient.connect(socketPath, 1500);
      await authenticateClient(client, controlDir);
      await client.handshake();
      return client;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`后台连接超时：${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

const mono = path.join(dirs.root, "mono");
fs.mkdirSync(path.join(mono, "repo-a", ".git"), { recursive: true });
fs.mkdirSync(path.join(mono, "repo-b", ".git"), { recursive: true });
const alias = path.join(dirs.root, "alias-mono");
fs.symlinkSync(mono, alias);
const sameA = path.join(dirs.root, "slot-a", "app");
const sameB = path.join(dirs.root, "slot-b", "app");
fs.mkdirSync(sameA, { recursive: true });
fs.mkdirSync(sameB, { recursive: true });

let client: ControlClient | null = null;
try {
  client = await connect();
  const c = client;

  await check("打开含多个仓库的根目录：工作区+新会话，快照携带根目录身份", async () => {
    const res = (await c.request<any>("open_workspace", { cwd: mono, request_id: "boot-1" })) as any;
    assert.equal(res.createdProject, true);
    const real = fs.realpathSync(mono);
    assert.equal(res.projectName, path.basename(real));
    assert.equal(res.session.cwdReal, real);
    const snap = (await c.handshake()).snapshot;
    const project = snap.projects.find((p: any) => p.id === res.session.projectId);
    assert.deepEqual(project.rootDir, { cwd: mono, cwdReal: real, dev: project.rootDir.dev, ino: project.rootDir.ino });
  });

  await check("别名与路径变体重开：同一工作区、每次新建会话，不重复建项目", async () => {
    const first = (await c.request<any>("open_workspace", { cwd: mono, request_id: "boot-2" })) as any;
    const viaAlias = (await c.request<any>("open_workspace", { cwd: alias, request_id: "boot-3" })) as any;
    assert.equal(viaAlias.session.projectId, first.session.projectId);
    assert.notEqual(viaAlias.session.id, first.session.id);
    assert.equal(viaAlias.createdProject, false);
    const viaDot = (await c.request<any>("open_workspace", { cwd: path.join(mono, "."), request_id: "boot-4" })) as any;
    assert.equal(viaDot.session.projectId, first.session.projectId);
    const snap = (await c.handshake()).snapshot;
    const workspaces = snap.projects.filter((p: any) => p.rootDir);
    assert.equal(workspaces.length, 1, "别名不重复创建工作区");
    const wsSessions = snap.sessions.filter((s: any) => s.projectId === first.session.projectId && s.id.startsWith("sess_"));
    assert.equal(wsSessions.length, 4, "首检 1 条 + 别名/变体 3 条：每次打开一条新会话，可逐条恢复");
  });

  await check("同一请求标识重发：返回原会话，不重复创建", async () => {
    const first = (await c.request<any>("open_workspace", { cwd: mono, request_id: "boot-r" })) as any;
    const again = (await c.request<any>("open_workspace", { cwd: mono, request_id: "boot-r" })) as any;
    assert.equal(again.session.id, first.session.id);
    const snap = (await c.handshake()).snapshot;
    assert.equal(snap.sessions.filter((s: any) => s.createRequestId === "boot-r").length, 1);
  });

  await check("同名不同目录：各自成工作区，名称仅展示层去重", async () => {
    const wa = (await c.request<any>("open_workspace", { cwd: sameA, request_id: "boot-a" })) as any;
    const wb = (await c.request<any>("open_workspace", { cwd: sameB, request_id: "boot-b" })) as any;
    assert.notEqual(wa.session.projectId, wb.session.projectId);
    assert.deepEqual([wa.projectName, wb.projectName], ["app", "app (2)"]);
  });

  await check("旧项目认领根目录：旧关系保留、自动归属、旧 API 仍可读", async () => {
    const legacyDir = path.join(dirs.root, "legacy-dir");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = (await c.request<any>("create_project", { name: "legacy-proj", request_id: "lg-1" })) as any;
    const oldSession = (await c.request<any>("create_session", { project_id: legacy.id, cwd: legacyDir })) as any;
    const adopted = (await c.request<any>("open_workspace", { cwd: legacyDir, project_id: legacy.id, request_id: "boot-adopt" })) as any;
    assert.equal(adopted.session.projectId, legacy.id);
    assert.equal(adopted.createdProject, false);
    const snap = (await c.handshake()).snapshot;
    const project = snap.projects.find((p: any) => p.id === legacy.id);
    assert.ok(project.rootDir, "旧项目认领根目录");
    assert.ok(snap.sessions.some((s: any) => s.id === oldSession.id), "旧会话仍可读");
    // 认领后不带 project_id 打开同目录：按根目录身份自动归属该项目
    const auto = (await c.request<any>("open_workspace", { cwd: legacyDir, request_id: "boot-auto" })) as any;
    assert.equal(auto.session.projectId, legacy.id);
    assert.notEqual(auto.session.id, adopted.session.id);
  });

  await check("完整路径：新会话提交任务执行完成，历史可查", async () => {
    const res = (await c.request<any>("open_workspace", { cwd: sameA, request_id: "boot-e2e" })) as any;
    const task = (await c.request<any>("submit", {
      session_id: res.session.id,
      request_id: "e2e-1",
      input: "hello-smoke",
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(c, task.id)).task.status === "completed");
    const page = (await c.request<any>("read_history", { session_id: res.session.id })) as any;
    const text = JSON.stringify(page);
    assert.ok(text.includes("hello-smoke"), "历史含本次输入");
    assert.ok(text.includes("pong"), "历史含模型应答");
  });

  await c.request("stop");
  c.close();
  client = null;
  const code = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(null), 20_000);
    child.once("exit", (c0) => {
      clearTimeout(timer);
      resolve(c0);
    });
  });
  assert.equal(code, 0, "后台正常停止");
} finally {
  if (client) client.close();
  if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
  await server.close();
  await cleanupDirs(dirs);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过（环境：${process.platform} ${process.arch}，真实 bin 后台/socket/SQLite/文件，模型打桩）`);
if (failed.length > 0) process.exit(1);
