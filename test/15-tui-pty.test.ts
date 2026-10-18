/**
 * PTY 端到端：真实终端行为（issue 04 §6.6）。
 *
 * 以独立进程启动真实后台（mock 模型），TUI 经 Python 标准库 pty 在伪终端
 * 中运行：验证宽窄布局、工作流逐层选择、中文输入、流式输出、Ctrl+C 与 /quit
 * 退出后终端恢复（进程退出、alt screen 离开）、退出后后台任务继续执行。
 *
 * 需要 python3；无 python3 时跳过（在诚实清单中标注）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeTestDirs,
  cleanupDirs,
  writeModelsJson,
  waitFor,
  lastUserText,
  startTestRuntime,
} from "./helpers/testkit.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { getWorkflowQuestion, listWorkflowRuns, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import type { SessionCompactionRequest } from "@ruukoto/core/types.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { ControlClient } from "@ruukoto/control/client.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";

test("FakeTerminal：完整 CSI、SS3 与缩放回调保持终端输入边界", () => {
  const terminal = new FakeTerminal(), inputs: string[] = [], sizes: number[][] = [];
  terminal.start(data => inputs.push(data), () => sizes.push([terminal.columns, terminal.rows]));
  terminal.send("/workflow\r\x1b[6~\x1b[1;5C\x1b[<0;10;3M\x1bOP\t\x1b");
  assert.deepEqual(inputs, ["/workflow", "\r", "\x1b[6~", "\x1b[1;5C", "\x1b[<0;10;3M", "\x1bOP", "\t", "\x1b"]);
  terminal.resize(140, 30);
  terminal.resize(70, 22);
  assert.deepEqual(sizes, [[140, 30], [70, 22]]);
});

function hasPython3(): boolean {
  try {
    execFileSync("python3", ["-c", "import pty"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 在 PTY 中运行 TUI 的 Python 驱动脚本。 */
const PTY_DRIVER = `
import os, pty, select, struct, fcntl, termios, subprocess, sys, time, json, signal

argv = json.loads(sys.argv[1])
cmd = argv["cmd"]              # TUI 命令与参数
env = dict(os.environ, **argv["env"])
inputs = argv["inputs"]        # [(delaySec, data 或尺寸), ...]
expect = argv["expect"]        # 需要依次看到的子串
timeout = argv.get("timeout", 60)

master, slave = pty.openpty()
size = argv.get("size", {"columns": 80, "rows": 24})
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", size["rows"], size["columns"], 0, 0))
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True, start_new_session=True)
os.close(slave)

collected = b""
segments = [b""]
deadline = time.time() + timeout
expect_idx = 0
input_idx = 0
start = time.time()
exit_code = None

def elapsed():
    return time.time() - start

while time.time() < deadline:
    # 发送到时输入
    while input_idx < len(inputs) and elapsed() >= inputs[input_idx][0]:
        action = inputs[input_idx][1]
        segments.append(b"")
        if isinstance(action, str):
            os.write(master, action.encode("utf-8"))
        else:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", action["rows"], action["columns"], 0, 0))
            os.killpg(proc.pid, signal.SIGWINCH)
        input_idx += 1
    r, _, _ = select.select([master], [], [], 0.1)
    if master in r:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        collected += chunk
        segments[-1] += chunk
        text = collected.decode("utf-8", errors="replace")
        while expect_idx < len(expect) and expect[expect_idx] in text:
            expect_idx += 1
    if proc.poll() is not None:
        break

# 收尾：再等剩余的输入/输出一会
cleanup_deadline = time.monotonic() + 6
cleanup_error = None
for _ in range(30):
    if proc.poll() is not None:
        break
    r, _, _ = select.select([master], [], [], 0.2)
    if master in r:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        collected += chunk
        segments[-1] += chunk

try:
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (PermissionError, ProcessLookupError) as error:
            # macOS 在僵尸回收窗口可报 EPERM；仅以随后正常退出为准。
            try:
                code = proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                cleanup_error = str(error) + "; 子进程仍未退出"
                proc.kill()
            else:
                if code != 0:
                    cleanup_error = str(error) + "; 子进程退出码 " + str(code)
    os.set_blocking(master, False)
    while True:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        collected += chunk
        segments[-1] += chunk
    exit_code = proc.wait(timeout=max(0, cleanup_deadline - time.monotonic()))
except Exception as error:
    cleanup_error = (cleanup_error + "; " if cleanup_error else "") + str(error)
os.close(master)

text = collected.decode("utf-8", errors="replace")
print(json.dumps({
    "exitCode": exit_code,
    "expectSeen": expect_idx,
    "expectTotal": len(expect),
    "tail": text[-3000:],
    "all": text,
    "segments": [segment.decode("utf-8", errors="replace") for segment in segments],
    "cleanupError": cleanup_error,
}))
`;

interface PtyResult {
  exitCode: number | null;
  expectSeen: number;
  expectTotal: number;
  tail: string;
  all: string;
  segments: string[];
  cleanupError: string | null;
}

async function runTuiInPty(opts: {
  env: Record<string, string>;
  sessionId?: string;
  inputs: Array<[number, string | { columns: number; rows: number }]>;
  size?: { columns: number; rows: number };
  expect: string[];
  timeout?: number;
}): Promise<PtyResult> {
  const args = ["tui"];
  if (opts.sessionId) args.push("--session", opts.sessionId);
  const payload = JSON.stringify({
    cmd: ["npx", "tsx", "apps/ruukoto-code/src/main.ts", ...args],
    env: { ...opts.env, RUUKOTO_OWNER_TOKEN: "", RUUKOTO_OWNER_TOKEN_FILE: "" },
    inputs: opts.inputs,
    size: opts.size,
    expect: opts.expect,
    timeout: opts.timeout ?? 90,
  });
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", PTY_DRIVER, payload], { cwd: process.cwd() });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("close", () => {
      try {
        const result = JSON.parse(out.trim().split("\n").at(-1)!) as PtyResult;
        if (result.cleanupError) reject(new Error(`PTY 驱动清理失败：${result.cleanupError}\n原输出：${result.all}`));
        else resolve(result);
      } catch (e) {
        reject(new Error(`PTY 驱动输出解析失败：${(e as Error).message}\nstderr: ${err}\nstdout: ${out.slice(-2000)}`));
      }
    });
    child.on("error", reject);
  });
}

test("PTY：Coding Agent /compact 中文指引、真实反馈与退出后的持久结果", { timeout: 60_000 }, async context => {
  if (!hasPython3()) { context.skip("python3 不可用"); return; }
  const t = await startTestRuntime("pty-compact", async request => {
    if (!request.tools?.length) await new Promise(resolve => setTimeout(resolve, 400));
    return { kind: "text", text: request.tools?.length ? "已有对话回复" : "迁移摘要，保留未完成验证" };
  }, { config: { product: codeProduct.runtime, socketPath: undefined } });
  try {
    const session = (await t.runtime.openWorkspace({ cwd: t.work[0]! })).session;
    for (let index = 0; index < 2; index++) {
      const task = await t.runtime.submit({ sessionId: session.id, requestId: `seed-${index}`, input: `迁移任务 ${index}`, modelSelection: t.runtime.defaultSelection });
      await waitFor("种子对话完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    }
    const file = t.runtime.store.getSession(session.id)!.sessionFile!;
    const bytes = fs.readFileSync(file);
    const calls = t.server.calls.length;
    const result = await runTuiInPty({ sessionId: session.id,
      env: { RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CODE_CONTROL_DIR: t.runtime.controlDir(), RUUKOTO_CODE_PENDING_DIR: path.join(t.dirs.root, "pending") },
      inputs: [[4, "/compact 保留  迁移细节\r"], [10, "/quit\r"]],
      expect: ["已接收", "上下文已压缩", "已退出 TUI"], timeout: 30 });
    assert.equal(result.exitCode, 0, result.tail);
    assert.equal(result.expectSeen, result.expectTotal, result.tail);
    const request = await t.client.request<SessionCompactionRequest>("get_session_compaction", { session_id: session.id });
    assert.equal(request.status, "succeeded");
    assert.equal(request.prompt, "保留  迁移细节");
    assert.equal(t.server.calls.length, calls + 1);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, 2);
    assert.ok(result.all.includes("\x1b[?1049l"));
  } finally { await t.shutdown(); }
});

test("PTY：工作流逐层启动与日志、宽窄缩放和 Tab 聊天均保留后台运行", { timeout: 60_000 }, async context => {
  if (!hasPython3()) { context.skip("python3 不可用"); return; }
  const t = await startTestRuntime("pty-workflow", async request => ({ kind: "text", text: "CHAT-OK:" + lastUserText(request) }), { config: { product: codeProduct.runtime, socketPath: undefined } });
  try {
    const session = (await t.runtime.openWorkspace({ cwd: t.work[0] })).session;
    const text = Array.from({ length: 40 }, (_, index) => "STAGE-LOG " + index + " 中文阶段").join("\n");
    await t.runtime.saveWorkflowDefinition({ name: "batch", script: 'await progress("state",{text:' + JSON.stringify(text) + '}); return await ask("q",{prompt:"继续?"});', expectedDigest: null, requestKey: "owner:save" });
    const result = await runTuiInPty({ sessionId: session.id, size: { columns: 140, rows: 30 },
      env: { RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CODE_CONTROL_DIR: t.runtime.controlDir(), RUUKOTO_CODE_PENDING_DIR: path.join(t.dirs.root, "pending") },
      inputs: [[4, "/workflow\r"], [6, "\x1b[B\r"], [7, "\r"], [8, "\r"], [9, "终端逐层操作\r"], [10, "\r"],
        [12, "\r"], [13, "\x1b[B\r"], [14, "\x1b[6~"], [15, { columns: 70, rows: 22 }],
        [16, "\t"], [17, "窄屏聊天\r"], [20, "\t"], [21, { columns: 140, rows: 30 }],
        [22, "\t"], [23, "宽屏聊天\r"], [26, "\t"], [27, "\x1b"], [28, "\x1b"], [29, "\x1b"], [30, "/quit\r"]],
      expect: ["业务参数", "确认启动", "STAGE-LOG", "CHAT-OK:窄屏聊天", "CHAT-OK:宽屏聊天", "已退出 TUI"], timeout: 40 });
    assert.equal(result.exitCode, 0, result.tail); assert.equal(result.expectSeen, result.expectTotal, result.tail);
    assert.ok(result.all.includes("\x1b[?1049l"));
    assert.match(result.segments[9], /STAGE-LOG 1\d/, "PgDn 续读当前日志正文");
    assert.match(result.segments[10], /工作流.*阶段日志/, "缩窄后保留日志层");
    assert.doesNotMatch(result.segments[10], /执行：/, "窄屏窗口隐藏聊天标题");
    assert.match(result.segments[13], /工作流.*阶段日志/, "窄屏 Tab 返回原日志层");
    assert.match(result.segments[14], /工作流.*阶段日志/, "恢复宽屏不丢导航");
    assert.match(result.segments[14], /CHAT-OK:窄屏聊天/, "宽屏同时显示聊天与侧栏");
    assert.match(result.segments[18], /工作流.*运行详情/, "Esc 从日志返回详情");
    assert.match(result.segments[19], /工作流.*当前会话/, "Esc 从详情返回根列表");
    const runs = listWorkflowRuns(t.runtime.store);
    assert.equal(runs.length, 1, "整个键盘路径只启动一次");
    assert.equal(runs[0].displayName, "batch"); assert.equal(runs[0].description, "终端逐层操作");
    assert.deepEqual(runs[0].input, {});
    assert.equal(requireWorkflowRun(t.runtime.store, runs[0].id).status, "waiting");
    assert.equal(getWorkflowQuestion(t.runtime.store, runs[0].id, "q")!.status, "pending");
    assert.equal(t.server.calls.length, 2, "只有宽窄屏的两次聊天调用模型");
  } finally { await t.shutdown(); }
});

/** 以独立进程启动真实后台（mock 模型，mock 工具；正式入口默认 native，本例不运行 worker）。 */
async function startBackendProcess(dirs: { root: string; dataDir: string; agentDir: string }, baseUrl: string) {
  await writeModelsJson(dirs, baseUrl);
  const env = {
    ...process.env,
    RUUKOTO_CODE_DATA_DIR: dirs.dataDir,
    RUUKOTO_CODE_AGENT_DIR: dirs.agentDir,
    RUUKOTO_CODE_PENDING_DIR: path.join(dirs.root, "pending"),
    RUUKOTO_CODE_CONTROL_DIR: path.join(dirs.root, "control"),
    RUUKOTO_OWNER_TOKEN: "",
    RUUKOTO_OWNER_TOKEN_FILE: "",
  };
  const child = spawn("npx", ["tsx", "apps/ruukoto-code/src/main.ts", "start", "--tools", "mock", "--model", "mock/mock-model"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // 独立进程组：npx 垫片被杀时其 node 孙进程随组回收，不遗留持有管道的孤儿
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const controlDir = path.join(dirs.root, "control");
  await waitFor(
    "后台 socket 就绪",
    () => fs.existsSync(path.join(controlDir, "control.sock")) && fs.existsSync(path.join(controlDir, "owner.token")),
    30_000,
  );
  return { child, stderr: () => stderr, controlDir, env };
}
test(
  "PTY：80×24 布局、中文输入、流式输出、Ctrl+C 退出后终端恢复且任务继续",
  { timeout: 180_000 },
  async (t) => {
    if (!hasPython3()) {
      t.skip("python3 不可用");
      return;
    }
    const { dirs, work } = await makeTestDirs("pty", 1);
    const server = new MockModelServer(async (req) => {
      const text = lastUserText(req);
      const slow = text.includes("第二个任务");
      await new Promise((r) => setTimeout(r, slow ? 4000 : 800));
      return { kind: "text", text: slow ? "后台继续完成" : `回声：${text.slice(0, 40)}` };
    });
    const baseUrl = await server.start();
    const { child: backend, controlDir, env } = await startBackendProcess(dirs, baseUrl);
    try {
      // 经 CLI 创建项目与会话
      const token = readOwnerToken(controlDir)!;
      const client = await ControlClient.connect(path.join(controlDir, "control.sock"));
      await client.authenticate(token);
      const project = await client.request<{ id: string }>("create_project", { name: "pty-demo" });
      const session = await client.request<{ id: string }>("create_session", { project_id: project.id, cwd: work[0] });

      // 场景 1：提交中文输入，看到流式回复，/quit 退出
      const run1 = await runTuiInPty({
        env: env as Record<string, string>,
        sessionId: session.id,
        inputs: [
          [8, "你好，PTY"],
          [9, "\r"],
          [16, "/quit\r"],
        ],
        expect: ["会话", "Ask for approval", "你好，PTY", "回声：", "已退出 TUI"],
        timeout: 60,
      });
      assert.equal(run1.expectSeen, run1.expectTotal, `未看到全部期望内容：${run1.tail}`);
      assert.equal(run1.exitCode, 0, "TUI 正常退出");
      // alt screen 离开序列存在（终端恢复）
      assert.ok(run1.all.includes("\x1b[?1049l"), "退出时离开 alt screen");

      // 场景 2：慢任务 + Ctrl+C 退出；后台任务继续执行
      const run2 = await runTuiInPty({
        env: env as Record<string, string>,
        sessionId: session.id,
        inputs: [
          [8, "第二个任务"],
          [9, "\r"],
          [12, "\x03"], // Ctrl+C 退出（空草稿）
        ],
        expect: ["第二个任务", "已退出 TUI"],
        timeout: 60,
      });
      assert.equal(run2.expectSeen, run2.expectTotal, `场景2 未看到全部期望内容：${run2.tail}`);
      assert.equal(run2.exitCode, 0);

      // TUI 退出后任务继续：等其完成
      await waitFor(
        "任务在 TUI 退出后继续完成",
        async () => {
          const snap = await client.request<{ tasks: Array<{ status: string }> }>("list_tasks", { session_id: session.id });
          return snap.tasks.filter((x) => x.status === "completed").length >= 2;
        },
        30_000,
      );
      client.close();
    } finally {
      backend.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      try {
        process.kill(-backend.pid!, "SIGKILL"); // 整组：覆盖 npx 垫片下的真实后台
      } catch {
        backend.kill("SIGKILL");
      }
      backend.stdout?.destroy();
      backend.stderr?.destroy();
      await server.close();
      await cleanupDirs(dirs);
    }
  },
);
