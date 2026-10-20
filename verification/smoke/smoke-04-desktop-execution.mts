import { product as codingProduct } from "../../apps/ruukoto-code/src/product.ts";
/** Coding 产品真实原生四工具、边界、审批、当前账户完全访问与中断回收；模型使用本地桩。
 * Note: 见 .agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startTestRuntime,
  createProjectSession,
  taskStatus,
  waitFor,
  realTools,
  type TestRuntime,
} from "../../test/helpers/testkit.ts";
import type { Responder } from "../../test/helpers/mock-provider.ts";

import { assertUnitsStopped, cleanupRuntime, recordRuntimeUnits, requireNative, requireNoArgs } from "./gate.ts";

requireNoArgs();

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true, detail: "" });
    process.stderr.write("[ruukoto:smoke04] " + `PASS ${name}` + "\n");
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
    process.stderr.write("[ruukoto:smoke04] " + `FAIL ${name}: ${(err as Error).message}` + "\n");
  }
}

await requireNative();
process.stderr.write("[ruukoto:smoke04] " + `环境：${process.platform} ${process.arch}；执行 native` + "\n");

// /var → /private/var 符号链接：文件操作守卫要求受限解析后的真实路径
const root = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "ruukoto-smoke04-")));
const workDir = path.join(root, "workspace");
fs.mkdirSync(workDir, { recursive: true });
const outsideFile = path.join(root, "host-secret.txt");
fs.writeFileSync(outsideFile, "HOST-SECRET-7f3a9c\n", "utf8");
// 带·bug 的最小代码：sum 初始值 1 应为 0
fs.writeFileSync(
  path.join(workDir, "sum.mjs"),
  "export function sum(xs) {\n  let total = 1;\n  for (const x of xs) total += x;\n  return total;\n}\n",
  "utf8",
);
fs.writeFileSync(
  path.join(workDir, "check.mjs"),
  'import { sum } from "./sum.mjs";\nconst got = sum([1, 2, 3]);\nif (got !== 6) {\n  process.stderr.write(`[ruukoto:fixture] sum 应为 6，实际 ${got}`);\n  process.exit(1);\n}\nprocess.stdout.write("check PASS");\n',
  "utf8",
);

const nativeWrite = "native-write-check.txt";
const heartbeat = path.join(workDir, "stop-heartbeat.txt");
process.env.RUUKOTO_SMOKE_USER_ENV = "full-access-fixture";

/** 按工具结果计数推进各流；路由按任务输入文本。 */
function flowRouter(): Responder {
  return (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    const text = (() => {
      for (let i = req.messages.length - 1; i >= 0; i--) {
        const m: any = req.messages[i];
        if (m?.role !== "user") continue;
        const c = m.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return c.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
      }
      return "";
    })();

    if (text.includes("FLOW-edit")) {
      if (done === 0) return { kind: "tool_calls", calls: [{ id: "e_read", name: "read", arguments: { path: "sum.mjs" } }] };
      if (done === 1) return { kind: "tool_calls", calls: [{ id: "e_check1", name: "bash", arguments: { command: "node check.mjs" } }] };
      if (done === 2)
        return {
          kind: "tool_calls",
          calls: [{ id: "e_edit", name: "edit", arguments: { path: "sum.mjs", edits: [{ oldText: "let total = 1;", newText: "let total = 0;" }] } }],
        };
      if (done === 3) return { kind: "tool_calls", calls: [{ id: "e_write", name: "write", arguments: { path: "report.txt", content: "native-fixed\n" } }] };
      if (done === 4) return { kind: "tool_calls", calls: [{ id: "e_check2", name: "bash", arguments: { command: "node check.mjs" } }] };
      return { kind: "text", text: "修改与检查完成" };
    }

    if (text.includes("FLOW-boundary")) {
      const calls = [
        { id: "b_net", name: "bash", arguments: { command: "curl -sS --max-time 8 https://example.com/" } },
        { id: "b_hostfs", name: "bash", arguments: { command: `cat ${outsideFile}` } },
        { id: "b_rofs", name: "bash", arguments: { command: "echo x > /etc/ruukoto-boundary-test" } },
        { id: "b_write", name: "bash", arguments: { command: `echo ok > ${nativeWrite}` } },
      ];
      if (done < calls.length) return { kind: "tool_calls", calls: [calls[done]!] };
      return { kind: "text", text: "边界检查结束" };
    }

    if (text.includes("FLOW-approval")) {
      if (done === 0) return { kind: "tool_calls", calls: [{ id: "a_read", name: "read", arguments: { path: outsideFile } }] };
      if (done === 1)
        return {
          kind: "tool_calls",
          calls: [{ id: "a_req", name: "request_file_access", arguments: { path: outsideFile, operation: "read", reason: "读取拥有者指定的宿主文件" } }],
        };
      return { kind: "text", text: "批准内容已读取" };
    }

    if (text.includes("FLOW-full-access")) {
      if (done === 0) return { kind: "tool_calls", calls: [{ id: "full-bash", name: "bash", arguments: {
        command: `cat '${outsideFile}' && node -e 'if(process.getuid()!==${process.getuid?.()}||process.env.RUUKOTO_SMOKE_USER_ENV!=="full-access-fixture")process.exit(1);process.stdout.write("full-access-account-ok")'`,
      } }] };
      return { kind: "text", text: "当前账户完全访问完成" };
    }

    if (text.includes("FLOW-stop")) {
      if (done === 0) return { kind: "tool_calls", calls: [{ id: "s_sleep", name: "bash", arguments: { command: `nohup sh -c 'while true; do echo beat >> "${heartbeat}"; sleep 0.1; done' >/dev/null 2>&1 & sleep 300` } }] };
      return { kind: "text", text: "不应到达：任务已被中断" };
    }

    return { kind: "text", text: `未知流：${text.slice(0, 40)}` };
  };
}

let t: TestRuntime | null = null;
let units: ReturnType<typeof recordRuntimeUnits> = [];
try {
  t = await startTestRuntime("smoke04", flowRouter(), {
    workDirs: 0,
    config: {
      product: codingProduct.runtime,
      ...realTools(),
      execution: { backend: "native" },
    },
  });
  units = recordRuntimeUnits(t.runtime);
  const client = t.client;
  check("后台声明原生执行边界", () => {
    const info = t!.runtime.executionInfo();
    assert.equal(info.backend, "native");
    assert.match(info.note, /原生/);
  });

  // 每流一个独立会话：mock 路由按「本会话工具消息数」推进，会话共享会跨任务串计数
  const submit = async (label: string, input: string, mode?: string) => {
    const { sessionId } = await createProjectSession(client, workDir);
    const task = await client.request<any>("submit", {
      session_id: sessionId,
      request_id: label,
      input,
      ...(mode ? { access_mode: mode } : {}),
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
    });
    return task;
  };

  // ---- 1. 代码修改与检查（confirm，原生沙箱内） ----
  {
    const task = await submit("edit-1", "FLOW-edit：修复 sum.mjs 使 check.mjs 通过");
    await waitFor("edit 任务完成", async () => (await taskStatus(client, task.id)).task.status === "completed", 120_000);
    const detail = await taskStatus(client, task.id);
    check("原生沙箱内完成代码修改与检查", () => {
      const content = fs.readFileSync(path.join(workDir, "sum.mjs"), "utf8");
      assert.match(content, /let total = 0;/, "原生沙箱内修改须宿主可见");
      const check1 = detail.toolOps.find((op: any) => op.sdkCallId === "e_check1");
      const check2 = detail.toolOps.find((op: any) => op.sdkCallId === "e_check2");
      assert.equal(check1.isError, true, "修复前检查应失败");
      assert.equal(check2.isError, false, "修复后检查应通过");
    });
  }

  // ---- 2. 子进程与真实文件/网络受约束 ----
  {
    const task = await submit("boundary-1", "FLOW-boundary：探测执行边界");
    await waitFor("boundary 任务完成", async () => (await taskStatus(client, task.id)).task.status === "completed", 120_000);
    const detail = await taskStatus(client, task.id);
    const byCall = (id: string) => detail.toolOps.find((op: any) => op.sdkCallId === id);
    check("边界约束（非仅工具参数检查）", () => {
      assert.equal(byCall("b_net").isError, true, "原生沙箱内不得有外网出口");
      assert.equal(byCall("b_hostfs").isError, true, "未授权宿主真实文件不可见");
      assert.equal(byCall("b_rofs").isError, true, "只读系统根拒绝写入");
      assert.equal(byCall("b_write").isError, false, "工作区内写入正常");
      assert.equal(fs.readFileSync(path.join(workDir, nativeWrite), "utf8"), "ok\n", "原生沙箱内写入宿主可见");
    });
  }

  // ---- 3. 越界读取遵循审批规则 ----
  {
    const task = await submit("approval-1", "FLOW-approval：读取工作区外拥有者指定文件");
    // 待审批出现时批准（拥有者操作）
    const conf = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("审批未如期出现")), 60_000);
      void (async () => {
        for (;;) {
          const detail = await taskStatus(client, task.id);
          const pending = detail.confirmations.find((c: any) => c.status === "pending");
          if (pending) {
            clearTimeout(timer);
            resolve(pending);
            return;
          }
          if (["completed", "failed", "interrupted", "canceled"].includes(detail.task.status)) {
            clearTimeout(timer);
            reject(new Error(`未见审批即终态：${detail.task.status}`));
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })();
    });
    await client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("approval 任务完成", async () => (await taskStatus(client, task.id)).task.status === "completed", 120_000);
    const detail = await taskStatus(client, task.id);
    check("越界读取走审批且获批后按批准参数执行", () => {
      const req = detail.toolOps.find((op: any) => op.toolName === "request_file_access");
      assert.ok(req, "request_file_access 操作已记录");
      assert.equal(req.isError, false, "批准的读取应成功");
      const doneConf = detail.confirmations.find((c: any) => c.id === conf.id);
      assert.equal(doneConf.status, "approved");
      assert.ok(doneConf.consumedAt, "批准须单次消费");
      assert.match(String(req.resultSummary ?? ""), /HOST-SECRET-7f3a9c|读取/, "结果来自批准的宿主文件");
    });
  }

  // ---- 4. 完全访问无需独立执行入口 ----
  {
    const task = await submit("full-access-1", "FLOW-full-access：直接执行", "full_access");
    await waitFor("完全访问任务完成", async () => (await taskStatus(client, task.id)).task.status === "completed", 60_000);
    check("完全访问以当前账户与用户环境读取宿主文件", () => {
      assert.equal(t!.runtime.store.getTask(task.id)?.accessMode, "full_access");
      const op = t!.runtime.store.listToolOpsByTask(task.id).find(item => item.sdkCallId === "full-bash");
      assert.equal(op?.isError, false);
      assert.match(op?.resultSummary ?? "", /full-access-account-ok/);
    });
  }

  // ---- 5. 中断回收实际执行单元（未知效果规则的穷尽断言由 test/64 离线覆盖） ----
  {
    const task = await submit("stop-1", "FLOW-stop：长命令供中断");
    await waitFor("本次后代真实持续写心跳", () => fs.existsSync(heartbeat) && fs.readFileSync(heartbeat, "utf8").split("\n").length >= 3, 60_000);
    // 实际心跳和已观察的 scope/cgroup 分别核实后代与整单元停止。
    await client.request("interrupt", { task_id: task.id }, 120_000);
    await waitFor("停止任务已中断", async () => (await taskStatus(client, task.id)).task.status === "interrupted", 60_000);
    const detail = await taskStatus(client, task.id);
    await assertUnitsStopped(units, task.id);
    const frozen = fs.readFileSync(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 400));
    check("中断即回收实际执行单元（不只终止界面）", () => {
      assert.equal(detail.task.status, "interrupted");
      assert.ok(detail.toolOps.find((o: any) => o.sdkCallId === "s_sleep"), "工具操作已记录");
      assert.equal(fs.readFileSync(heartbeat, "utf8"), frozen, "载体保留且后代心跳冻结");
    });
  }

  await client.close();
} finally {
  if (t) {
    t.client.close();
    const failure = await cleanupRuntime(t.runtime, t.server, t.dirs.root, units);
    if (failure) {
      results.push({ name: "清理本次资源", ok: false, detail: `${failure.message}；保留现场 ${root}；${String(failure.cause)}` });
    } else rmSync(root, { recursive: true, force: true });
  }
  delete process.env.RUUKOTO_SMOKE_USER_ENV;
}

const failed = results.filter((r) => !r.ok);
process.stderr.write("[ruukoto:smoke04] " + `\n结果：${results.length - failed.length}/${results.length} 通过` + "\n");
for (const r of failed) process.stderr.write("[ruukoto:smoke04] " + `  FAIL ${r.name}: ${r.detail}` + "\n");
process.exit(failed.length > 0 ? 1 : 0);
