/**
 * PTY 端到端：真实终端行为（issue 04 §6.6）。
 *
 * 以独立进程启动真实后台（mock 模型），TUI 经 Python 标准库 pty 在伪终端
 * 中运行：验证 80×24 布局渲染、中文输入提交、流式输出、Ctrl+C 与 /quit
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
} from "./helpers/testkit.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { readOwnerToken } from "../src/control/owner-token.ts";
import { ControlClient } from "../src/control/client.ts";

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
import os, pty, select, struct, fcntl, termios, subprocess, sys, time, json

argv = json.loads(sys.argv[1])
cmd = argv["cmd"]              # TUI 命令与参数
env = dict(os.environ, **argv["env"])
inputs = argv["inputs"]        # [(delaySec, data), ...]
expect = argv["expect"]        # 需要依次看到的子串
timeout = argv.get("timeout", 60)

master, slave = pty.openpty()
# 80x24 窄终端
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
os.close(slave)

collected = b""
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
        os.write(master, inputs[input_idx][1].encode("utf-8"))
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
        text = collected.decode("utf-8", errors="replace")
        while expect_idx < len(expect) and expect[expect_idx] in text:
            expect_idx += 1
    if proc.poll() is not None:
        break

# 收尾：再等剩余的输入/输出一会
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

if proc.poll() is None:
    proc.kill()
try:
    while True:
        chunk = os.read(master, 65536)
        if not chunk:
            break
        collected += chunk
except OSError:
    pass
os.close(master)
exit_code = proc.wait()

text = collected.decode("utf-8", errors="replace")
print(json.dumps({
    "exitCode": exit_code,
    "expectSeen": expect_idx,
    "expectTotal": len(expect),
    "tail": text[-3000:],
    "all": text,
}))
`;

interface PtyResult {
  exitCode: number;
  expectSeen: number;
  expectTotal: number;
  tail: string;
  all: string;
}

async function runTuiInPty(opts: {
  env: Record<string, string>;
  sessionId?: string;
  inputs: Array<[number, string]>;
  expect: string[];
  timeout?: number;
}): Promise<PtyResult> {
  const args = ["tui"];
  if (opts.sessionId) args.push("--session", opts.sessionId);
  const payload = JSON.stringify({
    cmd: ["npx", "tsx", "src/cli.ts", ...args],
    env: opts.env,
    inputs: opts.inputs,
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
        resolve(JSON.parse(out.trim().split("\n").at(-1)!) as PtyResult);
      } catch (e) {
        reject(new Error(`PTY 驱动输出解析失败：${(e as Error).message}\nstderr: ${err}\nstdout: ${out.slice(-2000)}`));
      }
    });
    child.on("error", reject);
  });
}

/** 以独立进程启动真实后台（mock 模型，mock 工具，local 执行后端）。 */
async function startBackendProcess(dirs: { root: string; dataDir: string; agentDir: string }, baseUrl: string) {
  await writeModelsJson(dirs, baseUrl);
  const env = {
    ...process.env,
    RUUKOTO_DATA_DIR: dirs.dataDir,
    RUUKOTO_AGENT_DIR: dirs.agentDir,
  };
  const child = spawn("npx", ["tsx", "src/cli.ts", "start", "--execution", "local", "--tools", "mock", "--model", "mock/mock-model"], {
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
        expect: ["会话", "请求确认", "你好，PTY", "回声：", "已退出 TUI"],
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
