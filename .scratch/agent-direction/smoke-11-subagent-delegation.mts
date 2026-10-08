/**
 * 通用 SubAgent 委派（agent-direction issue 11）的本机冒烟。
 *
 * 模拟：模型（MockModelServer 确定性脚本）与消息平台（不启用）。
 * 真实：Runtime + 控制面 + SQLite 库 + 独立 JSONL + 真实受限工具工作进程
 * （Docker 容器后端，04 已验证的 macOS 受限执行边界）+ 真实文件读取与只读范围。
 *
 * 覆盖（与工单验收对应）：
 *  A. ruukoto-code 开发会话：登记 → 独立子身份/会话/任务 → 真实受控读取
 *     （范围内可读、范围外实际拒绝）→ 原文件未变 → 子模型挂起期间父第二条
 *     消息先得到回复 → 结果回传与幂等 → 空闲且无残余进程 → 重启后身份保留、
 *     旧子任务不自动运行；
 *  B. ruukoto main：materials 快照委派 → wake:<childId> 回报 → coding_result
 *     经相同窄口读取 → work list/show 控制面查询。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL；2 = docker/镜像不可用。
 * TMPDIR 可换位置。容器 uid/gid 约定同 smoke-04。
 *
 * `--remote`：本机只做驱动——rsync 当前仓库（HEAD + 未提交改动）到
 * tx:/tmp/ruukoto-smoke11-src，远端 npm ci 后在 tx 的既有受限执行环境
 * （docker）自包含跑完全程；远端退出码即结果。真实 QQ/Telegram 平台
 * 无入口，本冒烟不含消息平台证据（模型与平台均为模拟，两处分别记录）。
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  startTestRuntime,
  waitFor,
  lastUserText,
  realTools,
  connectAuthedClient,
  type TestRuntime,
} from "../../test/helpers/testkit.ts";
import type { Responder, RecordedRequest } from "../../test/helpers/mock-provider.ts";

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
  const RDIR = "/tmp/ruukoto-smoke11-src";
  const SELF = ".scratch/agent-direction/smoke-11-subagent-delegation.mts";
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

const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "ruukoto-smoke11-")));
const workDir = path.join(root, "workspace");
fs.mkdirSync(workDir, { recursive: true });
const secretFile = path.join(workDir, "notes.txt");
const secret = `INSCOPE-${Math.random().toString(36).slice(2, 10)}`;
fs.writeFileSync(secretFile, `范围内资料 ${secret}\n第二行\n`, "utf8");
fs.writeFileSync(path.join(root, "outside.txt"), "OUTSIDE-SECRET 不许读\n", "utf8");
const originalBytes = fs.readFileSync(secretFile);

function afterTool(req: RecordedRequest): boolean {
  return req.messages[req.messages.length - 1]?.role === "tool";
}
function lastToolText(req: RecordedRequest): string {
  const m = req.messages[req.messages.length - 1];
  return typeof (m as any)?.content === "string" ? (m as any).content : JSON.stringify((m as any)?.content ?? "");
}

const evidence: string[] = [];

// ============ Phase A：ruukoto-code 开发会话（真实容器 worker） ============
const seenToolErrors: string[] = [];
let releaseChild!: () => void;
const childGate = new Promise<void>((resolve) => {
  releaseChild = resolve;
});
const responderA: Responder = async (req) => {
  const text = lastUserText(req);
  if (text.includes("[SubAgent 委派")) {
    if (afterTool(req)) {
      const toolText = lastToolText(req);
      seenToolErrors.push(toolText);
      // 读到范围内正文后再尝试范围外读取（应被实际拒绝）
      if (toolText.includes("范围内资料")) return { kind: "tool_calls", calls: [{ id: "s2", name: "read", arguments: { path: path.join(root, "outside.txt") } }] };
      await childGate;
      return { kind: "text", text: `SMOKE-SUB-DONE 读到 ${toolText.match(/INSCOPE-[a-z0-9]+/)?.[0] ?? "?"}` };
    }
    return { kind: "tool_calls", calls: [{ id: "s1", name: "read", arguments: { path: secretFile } }] };
  }
  if (text.includes("等结果的同时打个招呼")) return { kind: "text", text: "P2-DONE 仍在正常响应" };
  if (afterTool(req)) return { kind: "text", text: "已委派" };
  return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "读取指定文件并总结", key: "sm1", read_paths: [secretFile] } }] };
};

let tA: TestRuntime | undefined;
try {
  tA = await startTestRuntime("smoke11-dev", responderA, {
    config: {
      ...realTools(),
      productType: "ruukoto-code",
      execution: { backend: "container", container: { uid: UID, gid: GID } },
    },
  });
  const rt = tA.runtime;
  const session = await rt.createSession({ projectName: "smoke11", cwd: workDir });
  evidence.push(`父会话 ${session.id}`);
  const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "委派分析", modelSelection: rt.defaultSelection });
  await check("父任务完成且登记一份工作委托", async () => {
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 1);
  });
  const work = rt.store.listWorkDelegationsBySession(session.id)[0]!;
  const agent = rt.store.getSubAgent(work.subAgentId)!;
  const task = rt.store.listTasksByWork(work.id)[0]!;
  evidence.push(`work ${work.id} · SubAgent ${agent.id} · 子会话 ${agent.sessionId} · 任务 ${task.id}`);

  await check("子身份/独立子会话/任务三件套并固定 confirm", () => {
    assert.notEqual(agent.sessionId, session.id);
    assert.notEqual(agent.workDir, workDir);
    assert.equal(task.workId, work.id);
    assert.equal(task.subAgentId, agent.id);
    assert.equal(task.accessMode, "confirm");
    assert.equal(task.agentId, null);
  });

  await check("子模型挂起期间，父第二条消息先得到回复", async () => {
    await waitFor("子任务开始运行", () => ["running", "awaiting_confirmation"].includes(rt.store.getTask(task.id)!.status));
    const p2 = await rt.submit({ sessionId: session.id, requestId: "p2", input: "等结果的同时打个招呼", modelSelection: rt.defaultSelection });
    await waitFor("第二条已完成（子任务仍挂起）", () => rt.store.getTask(p2.id)!.status === "completed");
    assert.ok(!["completed", "failed", "canceled", "interrupted"].includes(rt.store.getTask(task.id)!.status), "子任务此刻仍未结束");
  });

  releaseChild();
  await check("范围内真实读取成功，范围外读取实际拒绝，原文件未变", async () => {
    await waitFor("子任务完成", () => rt.store.getTask(task.id)!.status === "completed", 60_000);
    const reply = rt.readTaskReply(task.id, 0, 4096)!;
    assert.ok(reply.text.includes("SMOKE-SUB-DONE"), reply.text);
    assert.equal(fs.readFileSync(secretFile).toString("base64"), originalBytes.toString("base64"), "原文件字节未变");
    // 范围内读到的真实正文进入了子上下文（ responder 证明），范围外被实际拒绝
    assert.ok(seenToolErrors.some((t) => t.includes("范围内资料") || t.includes("第二行")), seenToolErrors.join(" | "));
    assert.ok(seenToolErrors.some((t) => /只读范围|No such|ENOENT|拒绝/i.test(t)), seenToolErrors.join(" | "));
  });

  await check("结果与空闲同事务登记；幂等：同键同参返回原记录，异参冲突", async () => {
    const done = rt.store.getTask(task.id)!;
    assert.ok(done.resultSummary && done.resultRef);
    assert.equal(rt.store.getSubAgent(agent.id)!.state, "idle");
    const again = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "sm1", request: "读取指定文件并总结", readPaths: [secretFile], paramsDigest: work.paramsDigest });
    assert.equal(again.created, false);
    assert.equal(again.task.id, task.id);
    await assert.rejects(
      () => rt.subagents!.delegate({ parentTaskId: parent.id, key: "sm1", request: "换了参数", readPaths: [secretFile], paramsDigest: "other" }),
      /幂等键冲突/,
    );
  });

  await check("空闲期间没有残余容器/worker 进程", () => {
    const containers = docker(["ps", "-a", "--filter", `name=ruukoto-task-${task.id}`, "--format", "{{.Names}}"]);
    assert.equal(containers, "", `残余容器：${containers}`);
  });

  await check("控制面 work list/show 只读查询", async () => {
    const client = await connectAuthedClient(rt);
    try {
      const listed = (await client.request<any>("work_list", { session_id: session.id })) as any;
      assert.equal(listed.works.length, 1);
      const shown = (await client.request<any>("work_get", { work_id: work.id })) as any;
      assert.equal(shown.agent.id, agent.id);
      assert.equal(shown.tasks.length, 1);
    } finally {
      client.close();
    }
  });

  await check("重启后身份保留、旧子任务不自动运行", async () => {
    const dataDir = rt.config.dataDir;
    const agentDir = rt.config.agentDir;
    const socketPath = rt.socketPath();
    await rt.stop("smoke_restart");
    const { Runtime } = await import("../../src/runtime/runtime.ts");
    const rt2 = await Runtime.start({ ...tA!.runtime.config, dataDir, agentDir, socketPath });
    try {
      const a = rt2.store.getSubAgent(agent.id)!;
      assert.equal(a.id, agent.id);
      assert.equal(rt2.store.getSubAgentBySession(agent.sessionId)?.id, agent.id);
      const done = rt2.store.getTask(task.id)!;
      assert.ok(done.resultSummary !== null);
      // 重启不自动运行旧子任务：子会话没有排队任务被拉起，结果记录原样保留
      assert.equal(rt2.store.listQueuedTasksFifo(agent.sessionId).length, 0);
      assert.equal(rt2.store.listTasksByWork(work.id).length, 1, "没有新建任何执行");
    } finally {
      await rt2.stop("smoke_end");
    }
    evidence.push("重启后 SubAgent/工作/任务/结果记录全部可查，子队列不自动恢复");
  });
} finally {
  await tA?.shutdown();
}

// ============ Phase B：ruukoto main（materials 快照 + wake + coding_result） ============
let wakeChildId = "";
const responderB: Responder = async (req) => {
  const text = lastUserText(req);
  if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SMOKE-MAIN-SUB-DONE" };
  if (text.includes("[编排器]")) {
    if (afterTool(req)) return { kind: "text", text: "已汇报" };
    const taskId = /子任务：(\S+)（/.exec(text)![1]!;
    return { kind: "tool_calls", calls: [{ id: "r1", name: "coding_result", arguments: { task_id: taskId, part: "result" } }] };
  }
  if (afterTool(req)) return { kind: "text", text: "已委派" };
  return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "分析材料", key: "mb1", materials: [{ kind: "text", text: "SMOKE-材料正文" }] } }] };
};
let tB: TestRuntime | undefined;
try {
  tB = await startTestRuntime("smoke11-main", responderB, {
    config: { ...realTools(), productType: "ruukoto", execution: { backend: "container", container: { uid: UID, gid: GID } } },
  });
  const rt = tB.runtime;
  const main = rt.store.getAgentRole("main")!;
  await check("main 委派 → 快照落子目录 → wake 回报 → coding_result 兼容读取", async () => {
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "pm", input: "分析材料", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const work = rt.store.listWorkDelegationsBySession(main.sessionId)[0]!;
    const agent = rt.store.getSubAgent(work.subAgentId)!;
    const task = rt.store.listTasksByWork(work.id)[0]!;
    wakeChildId = task.id;
    await waitFor("子任务完成", () => rt.store.getTask(task.id)!.status === "completed", 60_000);
    assert.equal(fs.readFileSync(path.join(agent.workDir, "materials-mb1.txt"), "utf8"), "SMOKE-材料正文");
    await waitFor("wake 已建", () => rt.store.findTaskByRequest(main.sessionId, `wake:${task.id}`) !== null);
    const wake = rt.store.findTaskByRequest(main.sessionId, `wake:${task.id}`)!;
    assert.equal(wake.accessMode, "confirm");
    assert.equal(wake.sourceEventId, null);
    await waitFor("wake 完成", () => rt.store.getTask(wake.id)!.status === "completed");
    const toolText = tB!.server.calls.filter((c) => afterTool(c)).map(lastToolText).join("\n");
    assert.match(toolText, /子任务 .*completed/, toolText);
    assert.equal(rt.store.getSubAgent(agent.id)!.state, "idle");
    evidence.push(`main 场景：work ${work.id} · SubAgent ${agent.id} · 任务 ${task.id} · wake ${wake.id}`);
  });
} finally {
  await tB?.shutdown();
}

// ---------- 汇总 ----------
console.log("\n===== 证据 =====");
for (const line of evidence) console.log(line);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `，${failed.length} FAIL` : ""}`);
process.exit(failed.length ? 1 : 0);
