/**
 * 整项工作取消（agent-direction issue 14）的本机冒烟。
 *
 * 模拟：模型（MockModelServer 确定性脚本）与消息平台（不启用）。
 * 真实：Runtime + 控制面 + SQLite 库 + 独立 JSONL + 真实受限工具工作进程
 * （Docker 容器后端，04/11/12 已验证的 macOS 受限执行边界）+ 真实 CLI
 * （bin/ruukoto-dev.mjs work cancel，经 socket 与拥有者令牌）。
 *
 * 覆盖（与工单验收对应）：
 *  A1. 同一父会话两项工作并行：经真实 CLI `work cancel` 取消其中一项；
 *  A2. 被取消工作的排队任务直接 canceled、从未启动（零模型请求）；
 *  A3. 被取消工作的运行中容器实际退出；
 *  A4. 另一项工作照常完成，SubAgent 不受影响；
 *  A5. 迟到结果保存为事实可查（事件 / work_get 标明取消与发起者），但没有
 *      唤醒、dev 下一轮上下文不注入；
 *  A6. 空闲期间无残余容器；
 *  A7. 重启后取消状态保持，旧任务不运行。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL；2 = docker/镜像不可用。
 * TMPDIR 可换位置。容器 uid/gid 约定同 smoke-12。
 *
 * `--remote`：本机只做驱动——rsync 当前仓库（HEAD + 未提交改动）到
 * tx:/tmp/ruukoto-smoke14-src，远端 npm ci 后在 tx 的既有受限执行环境
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
import { subAgentTaskRequestId } from "../../src/runtime/subagents.ts";

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
  const RDIR = "/tmp/ruukoto-smoke14-src";
  const SELF = ".scratch/agent-direction/smoke-14-cancel-work.mts";
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
const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "ruukoto-smoke14-")));
const workDir = path.join(root, "workspace");
fs.mkdirSync(workDir, { recursive: true });
const fileA = path.join(workDir, "a.txt");
const fileB = path.join(workDir, "b.txt");
const secretA = `CANCEL-A-${Math.random().toString(36).slice(2, 10)}`;
const secretB = `CANCEL-B-${Math.random().toString(36).slice(2, 10)}`;
fs.writeFileSync(fileA, `资料 A ${secretA}\n`, "utf8");
fs.writeFileSync(fileB, `资料 B ${secretB}\n`, "utf8");

function afterTool(req: RecordedRequest): boolean {
  return req.messages[req.messages.length - 1]?.role === "tool";
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
const latches = new Map<string, () => void>();
let nextRoundText = "";

const responder: Responder = async (req) => {
  const text = lastUserText(req);
  if (text.includes("[SubAgent 委派")) {
    if (text.includes("分析慢工作 A")) {
      if (afterTool(req)) {
        // 第二轮模型调用挂起：子任务停在「容器活着、模型在途」的状态
        await new Promise<void>((res) => latches.set("a-slow", res));
        return { kind: "text", text: "SMOKE14-A-迟到的回复" };
      }
      return { kind: "tool_calls", calls: [{ id: "a1", name: "read", arguments: { path: fileA } }] };
    }
    if (text.includes("分析快工作 B")) return { kind: "text", text: "SMOKE14-B-DONE 结论" };
    return { kind: "text", text: "SMOKE14-SUB-DONE" };
  }
  if (text.includes("dev下一轮")) {
    nextRoundText = inputText(req);
    return { kind: "text", text: "收到" };
  }
  if (afterTool(req)) return { kind: "text", text: "已委派" };
  if (text.includes("委派 A")) return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "分析慢工作 A", key: "sc1", read_paths: [fileA] } }] };
  if (text.includes("委派 B")) return { kind: "tool_calls", calls: [{ id: "d2", name: "subagent_delegate", arguments: { request: "分析快工作 B", key: "sc2", read_paths: [fileB] } }] };
  return { kind: "text", text: "收到" };
};

// ============ ruukoto-dev：真实容器 worker + 真实 CLI ============
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
  productType: "ruukoto-dev",
  ...realTools(),
  execution: { backend: "container", container: { uid: UID, gid: GID } },
};

let rt = await Runtime.start(config);
await ControlServer.start(rt);
let workA = "";
let workB = "";
let agentA = "";
let agentASession = "";
let taskA1 = "";
let taskA2 = "";
let taskB = "";
const env = { ...process.env, RUUKOTO_DEV_DATA_DIR: dataDir };
try {
  const session = await rt.createSession({ projectName: "smoke14", cwd: workDir });
  // —— 工作 A：running（模型挂起前的真实容器）+ 直接落库的排队任务 ——
  const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "委派 A", modelSelection: rt.defaultSelection });
  await waitFor("父任务完成（已委派 A）", () => rt.store.getTask(parent.id)!.status === "completed");
  workA = rt.store.listWorkDelegationsBySession(session.id)[0]!.id;
  const agent1 = rt.store.getSubAgent(rt.store.getWorkDelegation(workA)!.subAgentId)!;
  agentA = agent1.id;
  agentASession = agent1.sessionId;
  taskA1 = rt.store.listTasksByWork(workA)[0]!.id;
  await waitFor("A 第二轮模型调用在途（真实容器存活）", () => latches.has("a-slow"), 60_000);

  // —— 工作 B：同一父会话下另一 SubAgent ——
  const parentB = await rt.submit({ sessionId: session.id, requestId: "p2", input: "委派 B", modelSelection: rt.defaultSelection });
  await waitFor("父任务 2 完成（已委派 B）", () => rt.store.getTask(parentB.id)!.status === "completed");
  workB = rt.store.listWorkDelegationsBySession(session.id).find((w) => w.id !== workA)!.id;
  taskB = rt.store.listTasksByWork(workB)[0]!.id;

  // A 的排队任务（真实登记行；它的会话正忙，停在 queued）
  rt.store.withTx(() => {
    rt.store.insertQueuedTask({
      sessionId: agentASession,
      requestId: subAgentTaskRequestId(workA, "sc-queued"),
      input: "工作A排队任务SMOKE14-Q",
      accessMode: "confirm",
      modelSelection: rt.defaultSelection,
      submissionDigest: "smoke14-queued",
      parentTaskId: parent.id,
      workId: workA,
      subAgentId: agentA,
    });
  });
  taskA2 = rt.store.listTasksByWork(workA).find((x) => x.id !== taskA1)!.id;

  await check("A1 两项工作并行，经真实 CLI work cancel 取消其中一项", async () => {
    const containers = docker(["ps", "--filter", `name=ruukoto-task-${taskA1}`, "--format", "{{.Names}}"]);
    assert.notEqual(containers, "", "取消前 A 的真实容器应在运行");
    // 异步 spawn：同进程的控制面需要事件循环服务 CLI 的连接（execFileSync 会阻塞）
    const { stdout: out } = await execFileAsync(process.execPath, [path.join(repoRoot, "bin", "ruukoto-dev.mjs"), "work", "cancel", workA, "--reason", "smoke14 验证取消"], { encoding: "utf8", env, timeout: 60_000 });
    assert.match(out, /"alreadyCanceled": false/, out);
    assert.match(out, /"canceledBy": "owner"/, out);
    const record = rt.store.getWorkDelegation(workA)!;
    assert.ok(record.canceledAt !== null && record.cancelReason === "smoke14 验证取消");
    evidence.push(`CLI 输出：${out.trim().split("\n").slice(0, 4).join(" / ")}`);
  });

  await check("A2 被取消工作的排队任务直接 canceled、从未启动（零模型请求）", async () => {
    const queued = rt.store.getTask(taskA2)!;
    assert.equal(queued.status, "canceled");
    assert.equal(queued.errorMessage, "work_canceled");
    assert.equal(queued.startedAt, null, "排队任务未启动");
    assert.equal(server.calls.filter((c) => inputText(c).includes("SMOKE14-Q")).length, 0, "排队任务零模型请求");
  });

  await check("A3 被取消工作的运行中容器实际退出", async () => {
    await waitFor("A 的容器已回收", () => docker(["ps", "-a", "--filter", `name=ruukoto-task-${taskA1}`, "--format", "{{.Names}}"]) === "", 60_000);
    const running = rt.store.getTask(taskA1)!;
    assert.equal(running.status, "canceled");
    assert.equal(running.cancelRequested, true);
    latches.get("a-slow")!();
  });

  await check("A4 另一项工作照常完成，SubAgent 不受影响", async () => {
    await waitFor("B 完成", () => rt.store.getTask(taskB)!.status === "completed", 60_000);
    assert.equal(rt.store.getWorkDelegation(workB)!.canceledAt, null, "其他工作不受影响");
    const agentB = rt.store.getWorkDelegation(workB)!.subAgentId;
    await waitIdle(rt, agentB);
    await waitIdle(rt, agentA);
    assert.equal(rt.store.getSubAgent(agentA)!.closedAt, null, "取消不关闭 SubAgent");
    evidence.push(`workA ${workA} 已取消（任务 ${taskA1}、${taskA2}）；workB ${workB} 照常完成（任务 ${taskB}）`);
  });

  await check("A5 迟到结果保存为事实可查，但不唤醒、下一轮不注入", async () => {
    await waitFor("A 迟到结果已登记", () => rt.store.getTask(taskA1)!.resultSummary !== null);
    const client = await connectAuthedClient(rt);
    try {
      const shown = (await client.request<any>("work_get", { work_id: workA })) as any;
      assert.equal(shown.work.canceledBy, "owner", "work_get 标明取消发起者");
      assert.equal(shown.work.cancelReason, "smoke14 验证取消");
      assert.ok(shown.tasks.every((x: any) => x.resultSummary !== null), "两次执行的结果都保留");
    } finally {
      client.close();
    }
    assert.equal(rt.store.listTasksBySession(session.id).filter((x) => x.requestId.startsWith("wake:")).length, 0, "不产生唤醒任务");
    const failedEvents = (rt.store.db.prepare("SELECT body FROM events WHERE session_id = ?").all(session.id) as Array<{ body: string }>)
      .map((r) => JSON.parse(r.body))
      .filter((b) => b.type === "subagent_task.failed" || b.type === "work_delegation.canceled");
    assert.ok(failedEvents.some((b) => b.type === "work_delegation.canceled" && b.workId === workA), "取消事件保存为事实");
    const callsBefore = server.calls.length;
    const next = await rt.submit({ sessionId: session.id, requestId: "p3", input: "dev下一轮", modelSelection: rt.defaultSelection });
    await waitFor("dev 下一轮完成", () => rt.store.getTask(next.id)!.status === "completed");
    assert.ok(nextRoundText.includes(`- 工作 ${workB} ·`), "未取消的 B 结果正常注入（对照）");
    assert.ok(!nextRoundText.includes(`- 工作 ${workA} ·`), "已取消工作的结果不注入下一轮上下文");
    assert.equal(server.calls.filter((c) => inputText(c).includes("SMOKE14-A-迟到的回复")).length, 0, "迟到回复没有成为新输入");
    assert.ok(server.calls.length <= callsBefore + 1, "下一轮只有一次父模型调用");
  });

  await check("A6 空闲期间无残余容器", async () => {
    for (const taskId of [taskA1, taskA2, taskB]) {
      const containers = docker(["ps", "-a", "--filter", `name=ruukoto-task-${taskId}`, "--format", "{{.Names}}"]);
      assert.equal(containers, "", `任务 ${taskId} 残余容器：${containers}`);
    }
  });

  await check("A7 重启后取消状态保持，旧任务不运行", async () => {
    await rt.stop("smoke_restart");
    rt = await Runtime.start(config);
    await ControlServer.start(rt);
    const record = rt.store.getWorkDelegation(workA)!;
    assert.ok(record.canceledAt !== null && record.canceledBy === "owner", "取消状态跨重启保持");
    assert.equal(rt.store.getSubAgent(agentA)!.closedAt, null, "关闭状态跨重启保持（未关闭）");
    assert.equal(rt.store.getTask(taskA2)!.status, "canceled", "旧排队任务保持 canceled，不启动");
    const queuedUnderCanceled = (
      rt.store.db.prepare("SELECT COUNT(*) AS n FROM tasks t JOIN work_delegations w ON w.id = t.work_id WHERE w.canceled_at IS NOT NULL AND t.status = 'queued'").get() as any
    ).n;
    assert.equal(queuedUnderCanceled, 0, "不变式：已取消工作下不存在 queued 任务");
    const callsBefore = server.calls.length;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(server.calls.length, callsBefore, "重启后旧任务不产生新模型调用");
    evidence.push(`重启：workA 取消保持（canceledBy=owner）；queued 任务保持 canceled`);
  });
} finally {
  for (const release of latches.values()) release();
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
