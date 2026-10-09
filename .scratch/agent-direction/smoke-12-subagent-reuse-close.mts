/**
 * SubAgent 继续委派、跨工作复用与显式关闭（agent-direction issue 12）的本机冒烟。
 *
 * 模拟：模型（MockModelServer 确定性脚本）与消息平台（不启用）。
 * 真实：Runtime + 控制面 + SQLite 库 + 独立 JSONL + 真实受限工具工作进程
 * （Docker 容器后端，04/11 已验证的 macOS 受限执行边界）+ 真实文件读取与
 * 只读范围 + 真实 CLI（bin/ruukoto-code.mjs work close，经 socket 与拥有者令牌）。
 *
 * 覆盖（与工单验收对应）：
 *  A1. 继续委派与复用的执行记录相互独立（三件套分别核实；A 首次结果不改写）；
 *  A2. 复用后旧路径在真实容器中实际被拒（B 尝试读 A 的文件 → 只读范围拒绝）；
 *  A3. 空闲期间无残余容器；
 *  A4. 经真实 CLI `work close` 关闭后，继续与复用委派均被拒（已关闭）；
 *  A5. 关闭后历史、产物与目录仍在（subagent 工作目录/会话/回复/work_get 可读）；
 *  A6. 重启后关闭状态保持、另一空闲 Agent 仍可复用。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL；2 = docker/镜像不可用。
 * TMPDIR 可换位置。容器 uid/gid 约定同 smoke-04/11。
 *
 * `--remote`：本机只做驱动——rsync 当前仓库（HEAD + 未提交改动）到
 * tx:/tmp/ruukoto-smoke12-src，远端 npm ci 后在 tx 的既有受限执行环境
 * （docker）自包含跑完全程；远端退出码即结果。真实 QQ/Telegram 平台
 * 无入口，本冒烟不含消息平台证据（模型与平台均为模拟，两处分别记录）。
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { waitFor, lastUserText, realTools, connectAuthedClient, writeModelsJson } from "../../test/helpers/testkit.ts";
import { MockModelServer, type Responder, type RecordedRequest } from "../../test/helpers/mock-provider.ts";
import { Runtime, type RuntimeConfig } from "../../src/runtime/runtime.ts";
import { ControlServer } from "../../src/control/server.ts";

const IMAGE = process.env.RUUKOTO_WORKER_IMAGE ?? "ruukoto-worker:latest";
const UID = Number(process.env.RUUKOTO_CONTAINER_UID ?? (process.platform === "darwin" ? 1000 : (process.getuid?.() ?? 1000)));
const GID = Number(process.env.RUUKOTO_CONTAINER_GID ?? (process.platform === "darwin" ? 1000 : (process.getgid?.() ?? 1000)));

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true, detail: "" });
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
      console.log(`FAIL ${name}: ${(err as Error).message}`);
    });
}
function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

// ---------- 远端驱动（--remote：rsync 后在 tx 自包含执行） ----------
if (process.argv.includes("--remote")) {
  const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
  const REMOTE = "tx";
  const RDIR = "/tmp/ruukoto-smoke12-src";
  const SELF = ".scratch/agent-direction/smoke-12-subagent-reuse-close.mts";
  const run = (label: string, cmd: string, args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}) => {
    console.log(`\n=== ${label} ===`);
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? 600_000 });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const code = r.status ?? (r.signal ? -1 : 1);
    if (code !== 0 && !opts.allowFail) {
      console.error(`驱动步骤失败（${label}，退出码 ${code}${r.signal ? `，信号 ${r.signal}` : ""}）`);
      process.exit(1);
    }
    return { code };
  };
  run("探测 tx 环境", "ssh", [REMOTE, "set -e && node --version && docker version >/dev/null && echo docker-ok && docker image inspect ruukoto-worker:latest >/dev/null && echo image-ok"], { timeoutMs: 60_000 });
  run("记录代码状态", "bash", ["-lc", `git -C ${repoRoot} rev-parse --abbrev-ref HEAD; git -C ${repoRoot} rev-parse HEAD; git -C ${repoRoot} status --short`]);
  run("rsync 仓库到 tx", "rsync", ["-az", "--delete", "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".idea", "--exclude", "*.log", `${repoRoot}/`, `${REMOTE}:${RDIR}/`], { timeoutMs: 300_000 });
  run("远端 npm ci", "ssh", [REMOTE, `cd ${RDIR} && npm ci --no-audit --no-fund --prefer-offline`], { timeoutMs: 600_000 });
  const remote = run("远端冒烟（Linux 受限执行环境）", "ssh", [REMOTE, `cd ${RDIR} && node_modules/.bin/tsx ${SELF}`], { allowFail: true, timeoutMs: 900_000 });
  console.log(`\n=== 驱动结束：远端退出码 ${remote.code} ===`);
  process.exit(remote.code === 0 ? 0 : 1);
}

// ---------- 基础设施门 ----------
try {
  execFileSync("docker", ["version"], { stdio: "ignore", timeout: 15_000 });
  docker(["image", "inspect", IMAGE]);
} catch {
  console.error(`基础设施缺失：需要 docker 可用且镜像 ${IMAGE} 存在（deploy/worker-image/build.sh 构建）`);
  process.exit(2);
}
console.log(`环境：${process.platform} ${process.arch}；镜像 ${IMAGE}；容器 uid:gid ${UID}:${GID}`);

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "ruukoto-smoke12-")));
const workDir = path.join(root, "workspace");
fs.mkdirSync(workDir, { recursive: true });
const fileA = path.join(workDir, "a.txt");
const fileB = path.join(workDir, "b.txt");
const secretA = `SCOPE-A-${Math.random().toString(36).slice(2, 10)}`;
const secretB = `SCOPE-B-${Math.random().toString(36).slice(2, 10)}`;
fs.writeFileSync(fileA, `资料 A ${secretA}\n`, "utf8");
fs.writeFileSync(fileB, `资料 B ${secretB}\n`, "utf8");

function afterTool(req: RecordedRequest): boolean {
  return req.messages[req.messages.length - 1]?.role === "tool";
}
function lastToolText(req: RecordedRequest): string {
  const m = req.messages[req.messages.length - 1];
  return typeof (m as any)?.content === "string" ? (m as any).content : JSON.stringify((m as any)?.content ?? "");
}
function inputText(req: RecordedRequest): string {
  return req.messages
    .map((m: any) => {
      const content = m?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
      return "";
    })
    .join("\n");
}
async function waitIdle(rt: Runtime, agentId: string): Promise<void> {
  await waitFor("Agent 空闲", () => rt.store.getSubAgent(agentId)!.state === "idle");
}

const evidence: string[] = [];
const bToolResults: string[] = [];

const responder: Responder = async (req) => {
  const text = lastUserText(req);
  if (text.includes("[SubAgent 委派")) {
    // 复用承接的 B：先尝试读旧工作的 A（应被真实 worker 拒绝），随后收尾
    if (text.includes("分析另一项 B")) {
      if (afterTool(req)) return { kind: "text", text: "SMOKE12-SUB-B-DONE" };
      return { kind: "tool_calls", calls: [{ id: "b1", name: "read", arguments: { path: fileA } }] };
    }
    if (text.includes("继续分析 A")) return { kind: "text", text: "SMOKE12-SUB-A2-DONE" };
    if (text.includes("预先分析 B")) return { kind: "text", text: "SMOKE12-SUB-PRE-DONE" };
    if (text.includes("重启后继续分析 B")) return { kind: "text", text: "SMOKE12-SUB-RE-DONE" };
    if (afterTool(req)) return { kind: "text", text: `SMOKE12-SUB-A-DONE 读到 ${lastToolText(req).match(/SCOPE-A-[a-z0-9]+/)?.[0] ?? "?"}` };
    return { kind: "tool_calls", calls: [{ id: "a1", name: "read", arguments: { path: fileA } }] };
  }
  if (afterTool(req)) return { kind: "text", text: "已委派" };
  if (text.includes("委派 A")) return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "读取 A 并总结", key: "sk1", read_paths: [fileA] } }] };
  return { kind: "text", text: "收到" };
};

// ============ ruukoto-code：真实容器 worker + 真实 CLI ============
const server = new MockModelServer(responder);
const baseUrl = await server.start();
const dataDir = path.join(root, "data");
const agentDir = path.join(root, "agent");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
await writeModelsJson({ root, dataDir, agentDir }, baseUrl);
const config: RuntimeConfig = {
  dataDir,
  agentDir,
  // 不配 socketPath：默认 <root>/control/control.sock，与真实 CLI 的发现路径一致
  thinkingLevel: "off",
  modelProvider: "mock",
  modelId: "mock-model",
  productType: "ruukoto-code",
  ...realTools(),
  execution: { backend: "container", container: { uid: UID, gid: GID } },
};

let rt = await Runtime.start(config);
await ControlServer.start(rt);
let agent1Id = "";
let agent2Id = "";
let workA = "";
let workB = "";
const tasksA: string[] = [];
try {
  // 真实 CLI 按产品环境变量发现数据目录（含 socket 与 owner.token）
  const session = await rt.createSession({ projectName: "smoke12", cwd: workDir });
  const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "委派 A", modelSelection: rt.defaultSelection });
  await waitFor("父任务完成（已委派 A）", () => rt.store.getTask(parent.id)!.status === "completed");
  const firstWork = rt.store.listWorkDelegationsBySession(session.id)[0]!;
  workA = firstWork.id;
  const agent1 = rt.store.getSubAgent(firstWork.subAgentId)!;
  agent1Id = agent1.id;
  const taskA1 = rt.store.listTasksByWork(workA)[0]!;
  tasksA.push(taskA1.id);
  await waitFor("A 首次完成", () => rt.store.getTask(taskA1.id)!.status === "completed", 60_000);
  await waitIdle(rt, agent1Id);
  const summaryA1 = rt.store.getTask(taskA1.id)!.resultSummary;
  const refA1 = rt.store.getTask(taskA1.id)!.resultRef;

  await check("A1 继续委派与复用的执行记录相互独立", async () => {
    // 继续原工作 A
    const cont = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk2", request: "继续分析 A", workId: workA, readPaths: [fileA], paramsDigest: "d-sk2" });
    tasksA.push(cont.task.id);
    await waitFor("A 继续完成", () => rt.store.getTask(cont.task.id)!.status === "completed", 60_000);
    await waitIdle(rt, agent1Id);
    // 复用同一 Agent 承接工作 B
    const reuse = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk3", request: "分析另一项 B", subAgentId: agent1Id, readPaths: [fileB], paramsDigest: "d-sk3" });
    workB = reuse.work.id;
    tasksA.push(reuse.task.id);
    await waitFor("B 完成", () => rt.store.getTask(reuse.task.id)!.status === "completed", 60_000);
    await waitIdle(rt, agent1Id);
    // 三只 ID 组分别核实：同一 Agent/同一子会话；两条工作；三次独立执行
    assert.equal(new Set(tasksA).size, 3, "三次执行任务各自独立");
    assert.equal(reuse.agent.id, agent1Id);
    assert.notEqual(workB, workA);
    assert.equal(rt.store.listTasksBySession(agent1.sessionId).length, 3);
    assert.deepEqual(cont.task.readScope?.paths.map((p) => p.path), [fs.realpathSync(fileA)], "A 继续只读 A");
    assert.deepEqual(reuse.task.readScope?.paths.map((p) => p.path), [fs.realpathSync(fileB)], "B 只读 B");
    assert.equal(rt.store.getSubAgent(agent1Id)!.activeWorkId, workB, "activeWorkId 切换");
    const a1 = rt.store.getTask(taskA1.id)!;
    assert.equal(a1.resultSummary, summaryA1, "A 首次结果摘要逐字节不变");
    assert.equal(a1.resultRef, refA1, "A 首次结果引用逐字节不变");
    assert.ok(rt.readTaskReply(reuse.task.id, 0, 4096)!.text.includes("SMOKE12-SUB-B-DONE"));
    evidence.push(`workA ${workA}（任务 ${taskA1.id}、${cont.task.id}）→ 复用 workB ${workB}（任务 ${reuse.task.id}）`);
  });

  await check("A2 复用后旧路径在真实容器中实际被拒", () => {
    const texts = server.calls.filter((c) => afterTool(c) && inputText(c).includes("分析另一项 B")).map(lastToolText);
    bToolResults.push(...texts);
    assert.ok(texts.some((x) => /只读范围|No such|ENOENT/i.test(x)), `B 读取旧路径未被实际拒绝：${texts.join(" | ")}`);
    assert.ok(!texts.some((x) => x.includes(secretA)), "B 不能拿到 A 的正文");
  });

  await check("A3 空闲期间无残余容器", () => {
    for (const taskId of tasksA) {
      const containers = docker(["ps", "-a", "--filter", `name=ruukoto-task-${taskId}`, "--format", "{{.Names}}"]);
      assert.equal(containers, "", `任务 ${taskId} 残余容器：${containers}`);
    }
  });

  await check("A4 真实 CLI work close 后，继续与复用委派均被拒", async () => {
    const env = { ...process.env, RUUKOTO_CODE_DATA_DIR: dataDir };
    // 异步 spawn：同进程的控制面需要事件循环服务 CLI 的连接（execFileSync 会阻塞）
    const { stdout: out } = await execFileAsync(process.execPath, [path.join(repoRoot, "bin", "ruukoto-code.mjs"), "work", "close", agent1Id], { encoding: "utf8", env, timeout: 60_000 });
    assert.match(out, /"alreadyClosed": false/, out);
    assert.equal(rt.store.getSubAgent(agent1Id)!.closedBy, "owner");
    await assert.rejects(() => rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk4", request: "x", workId: workA, readPaths: [fileA], paramsDigest: "d-sk4" }), /已关闭/);
    await assert.rejects(() => rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk5", request: "x", subAgentId: agent1Id, readPaths: [fileB], paramsDigest: "d-sk5" }), /已关闭/);
    evidence.push(`CLI 输出：${out.trim().split("\n").slice(0, 3).join(" / ")}`);
  });

  await check("A5 关闭后历史、产物与目录仍在", async () => {
    const agent = rt.store.getSubAgent(agent1Id)!;
    assert.ok(fs.existsSync(agent.workDir), "工作目录保留");
    for (const taskId of tasksA) {
      assert.ok(rt.store.getTask(taskId)!.resultSummary !== null, `任务 ${taskId} 结果保留`);
    }
    assert.ok(rt.readTaskReply(tasksA[0]!, 0, 4096)!.text.includes("SMOKE12-SUB-A-DONE"), "独立 JSONL 历史可读");
    assert.notEqual(rt.store.getSession(agent.sessionId), null, "子会话记录保留");
    const client = await connectAuthedClient(rt);
    try {
      const shown = (await client.request<any>("work_get", { work_id: workA })) as any;
      assert.ok(shown.agent.closedAt !== null, "work_get 仍可读且标明已关闭");
      assert.equal(shown.tasks.length, 2, "工作 A 的两次执行保留");
    } finally {
      client.close();
    }
  });

  await check("A6 重启后关闭状态保持、空闲 Agent 仍可复用", async () => {
    // 另一个空闲 Agent（重启前完成首项工作）
    const pre = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk6", request: "预先分析 B", readPaths: [fileB], paramsDigest: "d-sk6" });
    agent2Id = pre.agent.id;
    await waitFor("预置 Agent 完成", () => rt.store.getTask(pre.task.id)!.status === "completed", 60_000);
    await waitIdle(rt, agent2Id);
    await rt.stop("smoke_restart");
    rt = await Runtime.start(config);
    await ControlServer.start(rt);
    const closed = rt.store.getSubAgent(agent1Id)!;
    assert.ok(closed.closedAt !== null && closed.closedBy === "owner", "关闭状态跨重启保持");
    await assert.rejects(
      () => rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk7", request: "x", subAgentId: agent1Id, readPaths: [fileB], paramsDigest: "d-sk7" }),
      /已关闭/,
      "重启后已关闭 Agent 仍拒绝委派",
    );
    const idle = rt.store.getSubAgent(agent2Id)!;
    assert.equal(idle.closedAt, null);
    const again = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sk8", request: "重启后继续分析 B", subAgentId: agent2Id, readPaths: [fileB], paramsDigest: "d-sk8" });
    await waitFor("重启后复用完成", () => rt.store.getTask(again.task.id)!.status === "completed", 60_000);
    await waitIdle(rt, agent2Id);
    assert.ok(rt.readTaskReply(again.task.id, 0, 4096)!.text.includes("SMOKE12-SUB-RE-DONE"), "重启后复用产生新执行");
    assert.equal(rt.store.listTasksByWork(again.work.id).length, 1, "复用登记独立工作");
    evidence.push(`重启：agent1 ${agent1Id} 保持关闭；agent2 ${agent2Id} 复用成功（新任务 ${again.task.id}）`);
  });
} finally {
  await rt.stop("smoke_end");
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- 汇总 ----------
console.log("\n===== 证据 =====");
for (const line of evidence) console.log(line);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `，${failed.length} FAIL` : ""}`);
process.exit(failed.length ? 1 : 0);
