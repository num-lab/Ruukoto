import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { callHelper, ServiceHelperError, type ServiceManagerConfig } from "../apps/ruukoto/src/service-helper.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "等待 helper 传输超时"); await delay(5); }
}

function fixture(t: TestContext, body: string) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "rk-helper-transport-"));
  const helperPath = path.join(directory, "helper.mjs");
  const pidFile = path.join(directory, "pid");
  fs.writeFileSync(helperPath, `import * as fs from "node:fs"; const directory = ${JSON.stringify(directory)}; fs.writeFileSync(directory + "/pid", String(process.pid)); ${body}`);
  const kill = process.kill.bind(process);
  const pid = () => Number(fs.readFileSync(pidFile, "utf8"));
  const stop = () => {
    if (!fs.existsSync(pidFile)) return;
    try { kill(-pid(), "SIGKILL"); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  t.after(() => { stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const config: ServiceManagerConfig = { helperPath, policyPath: path.join(directory, "policy"), useSudo: false, sudoPath: "/usr/bin/sudo" };
  return { directory, config, pidFile, pid, stop };
}

for (const cause of ["aborted", "timeout"] as const) test(`helper 传输：${cause} 在调用关闭前保持等待并保留尾部字节`, { timeout: 10000 }, async t => {
  const f = fixture(t, 'process.stdout.write("before-stop\\n"); setInterval(() => { if (fs.existsSync(directory + "/tail")) { process.stdout.write("after-stop\\n"); process.stderr.write("tail-error\\n"); fs.writeFileSync(directory + "/emitted", "yes"); } }, 10);');
  const controller = new AbortController();
  let requested = false;
  let settled = false;
  const kill = process.kill.bind(process);
  // 延迟真实信号送达，确定性打开信号发出至 close 的窗口。
  t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
    if (signal === "SIGKILL" && fs.existsSync(f.pidFile) && pid === -f.pid()) { requested = true; return true; }
    return kill(pid, signal);
  });
  const result = callHelper(f.config, ["inspect", "test.service"], { signal: controller.signal, timeoutMs: cause === "timeout" ? 1000 : 5000 }).then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
  await until(() => fs.existsSync(f.pidFile));
  if (cause === "aborted") controller.abort();
  await until(() => requested);
  assert.equal(settled, false, "信号已发出不等于调用进程已关闭");
  assert.equal(kill(f.pid(), 0), true);
  fs.writeFileSync(path.join(f.directory, "tail"), "emit");
  await until(() => fs.existsSync(path.join(f.directory, "emitted")));
  controller.abort();
  f.stop();
  const error = await result;
  assert.ok(error instanceof ServiceHelperError);
  assert.equal(error.code, cause, "后来的取消不能覆盖首次超时");
  assert.match(error.capture!.stdout.toString(), /before-stop\nafter-stop\n/);
  assert.match(error.capture!.stderr.toString(), /tail-error/);
  assert.throws(() => kill(f.pid(), 0), (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH");
});

test("helper 传输：已取消输入不启动 helper", async t => {
  const f = fixture(t, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(callHelper(f.config, [], { signal: controller.signal, timeoutMs: 1000 }), (error: unknown) => error instanceof ServiceHelperError && error.code === "aborted");
  assert.equal(fs.existsSync(f.pidFile), false);
});

test("helper 传输：spawn 后监听安装前取消仍按取消收尾", async t => {
  const f = fixture(t, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const add = controller.signal.addEventListener.bind(controller.signal);
  t.mock.method(controller.signal, "addEventListener", (...args: Parameters<AbortSignal["addEventListener"]>) => { controller.abort(); add(...args); });
  await assert.rejects(callHelper(f.config, [], { signal: controller.signal, timeoutMs: 1000 }), (error: unknown) => error instanceof ServiceHelperError && error.code === "aborted");
  if (fs.existsSync(f.pidFile)) assert.throws(() => process.kill(f.pid(), 0), (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH");
});

test("helper 传输：输出超限在关闭后返回有界原始捕获", async t => {
  const f = fixture(t, 'process.stdout.write(Buffer.alloc(4096, 97)); setInterval(() => {}, 1000);');
  await assert.rejects(callHelper(f.config, [], { timeoutMs: 1000, maxOutputBytes: 32 }), (error: unknown) => {
    assert.ok(error instanceof ServiceHelperError);
    assert.equal(error.code, "output_limit");
    assert.equal(error.capture!.truncated, true);
    assert.equal(error.capture!.stdout.length + error.capture!.stderr.length, 32);
    assert.throws(() => process.kill(f.pid(), 0), (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH");
    return true;
  });
});

test("helper 传输：异步启动失败收齐 close 后返回原失败码", async t => {
  const f = fixture(t, "");
  await assert.rejects(callHelper({ ...f.config, useSudo: true, sudoPath: path.join(f.directory, "missing-sudo") }, [], { timeoutMs: 1000 }), (error: unknown) => error instanceof ServiceHelperError && error.code === "spawn_failed" && error.capture?.stdout.length === 0);
  assert.equal(fs.existsSync(f.pidFile), false);
});
