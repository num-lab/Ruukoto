import { product as codingProduct } from "../../apps/ruukoto-code/src/product.ts";
/**
 * 开发机受限/完全访问接入的产品级冒烟（agent-direction issue 04）。
 * Note: 见 .agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md
 * Note: 见 .agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
 *
 * 模型层打桩（MockModelServer，确定性脚本），其余全真：Runtime + 控制面 +
 * 工具工作进程 + 真实容器执行边界 + 真实文件/网络/审批。
 *
 * 覆盖（与工单 04 验收标准对应）：
 *  1. confirm 任务在容器边界内完成一次代码修改与检查，改动宿主可见；
 *  2. 子进程与真实文件/网络同受约束：容器内外联失败、未挂载的宿主真实文件
 *     不可见、只读根文件系统拒绝写入（不止工具参数检查）；
 *  3. 越界读取走结构化审批：request_file_access 待批 → 拥有者批准单次消费后
 *     按批准参数执行；
 *  4. 完全访问缺少执行账户入口时，提交即 execution_unavailable 拒绝、不回退；
 *  5. 中断回收实际执行单元：容器随中断移除，操作沿用未知效果规则补记。
 *
 * 结果约定（沿用 macos-sbx-probe.sh）：0 = 全部通过；1 = 有 FAIL；
 * 2 = 基础设施缺失（docker/镜像不可用）。TMPDIR 可换工作区位置。
 * 容器 uid/gid：macOS Docker Desktop 由 VM 代管（默认 1000 即可）；原生
 * Linux bind mount 无 uid 映射，默认取本进程 uid/gid，可用
 * RUUKOTO_CONTAINER_UID/GID 覆盖（部署固定值见 deploy/systemd）。
 */

import { execFileSync } from "node:child_process";
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

import { requireDocker, requireNoArgs } from "./gate.ts";

requireNoArgs();
const IMAGE = process.env.RUUKOTO_WORKER_IMAGE ?? "ruukoto-worker:latest";
const UID = Number(process.env.RUUKOTO_CONTAINER_UID ?? (process.platform === "darwin" ? 1000 : (process.getuid?.() ?? 1000)));
const GID = Number(process.env.RUUKOTO_CONTAINER_GID ?? (process.platform === "darwin" ? 1000 : (process.getgid?.() ?? 1000)));

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}
function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

requireDocker(IMAGE);
console.log(`环境：${process.platform} ${process.arch}；镜像 ${IMAGE}（${docker(["image", "inspect", "--format", "{{.Id}}", IMAGE])}）；容器 uid:gid ${UID}:${GID}`);

// 完全访问入口判定只认我们的部署环境：脚本清掉 RUUKOTO_EXEC_*，断言固定到「未配置」路径
for (const key of Object.keys(process.env)) {
  if (key.startsWith("RUUKOTO_EXEC_")) delete process.env[key];
}

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
  'import { sum } from "./sum.mjs";\nconst got = sum([1, 2, 3]);\nif (got !== 6) {\n  console.error(`sum 应为 6，实际 ${got}`);\n  process.exit(1);\n}\nconsole.log("check PASS");\n',
  "utf8",
);

const containerWrite = "container-write-check.txt";

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
      if (done === 3) return { kind: "tool_calls", calls: [{ id: "e_check2", name: "bash", arguments: { command: "node check.mjs" } }] };
      return { kind: "text", text: "修改与检查完成" };
    }

    if (text.includes("FLOW-boundary")) {
      const calls = [
        { id: "b_net", name: "bash", arguments: { command: "curl -sS --max-time 8 https://example.com/" } },
        { id: "b_hostfs", name: "bash", arguments: { command: `cat ${outsideFile}` } },
        { id: "b_rofs", name: "bash", arguments: { command: "echo x > /etc/ruukoto-boundary-test" } },
        { id: "b_write", name: "bash", arguments: { command: `echo ok > ${containerWrite}` } },
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

    if (text.includes("FLOW-stop")) {
      if (done === 0) return { kind: "tool_calls", calls: [{ id: "s_sleep", name: "bash", arguments: { command: "sleep 300" } }] };
      return { kind: "text", text: "不应到达：任务已被中断" };
    }

    return { kind: "text", text: `未知流：${text.slice(0, 40)}` };
  };
}

let t: TestRuntime | null = null;
const taskIds: string[] = [];
try {
  t = await startTestRuntime("smoke04", flowRouter(), {
    workDirs: 0,
    config: {
      product: codingProduct.runtime,
      ...realTools(),
      execution: { backend: "container", container: { uid: UID, gid: GID } },
    },
  });
  const client = t.client;
  check("后台声明容器执行边界", () => {
    const info = t!.runtime.executionInfo();
    assert.equal(info.backend, "container");
    assert.match(info.note, /容器/);
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
    taskIds.push(task.id);
    return task;
  };

  // ---- 1. 代码修改与检查（confirm，容器内） ----
  {
    const task = await submit("edit-1", "FLOW-edit：修复 sum.mjs 使 check.mjs 通过");
    await waitFor("edit 任务完成", async () => (await taskStatus(client, task.id)).task.status === "completed", 120_000);
    const detail = await taskStatus(client, task.id);
    check("容器内完成代码修改与检查", () => {
      const content = fs.readFileSync(path.join(workDir, "sum.mjs"), "utf8");
      assert.match(content, /let total = 0;/, "容器内修改须宿主可见");
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
      assert.equal(byCall("b_net").isError, true, "容器内不得有外网出口");
      assert.equal(byCall("b_hostfs").isError, true, "未挂载的宿主真实文件在容器内不可见");
      assert.equal(byCall("b_rofs").isError, true, "只读根文件系统拒绝写入");
      assert.equal(byCall("b_write").isError, false, "工作区内写入正常");
      assert.equal(fs.readFileSync(path.join(workDir, containerWrite), "utf8"), "ok\n", "容器内写入宿主可见");
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

  // ---- 4. 完全访问缺执行账户入口：执行前拒绝 ----
  {
    let code = "";
    let message = "";
    try {
      await submit("full-access-1", "FLOW-full-access：不应可提交", "full_access");
    } catch (err: any) {
      code = err.code;
      message = String(err.message);
    }
    check("完全访问缺执行账户入口：执行前拒绝且不回退", () => {
      assert.equal(code, "execution_unavailable");
      assert.match(message, /不回退/);
    });
  }

  // ---- 5. 中断回收实际执行单元（未知效果规则的穷尽断言由 test/64 离线覆盖） ----
  {
    const task = await submit("stop-1", "FLOW-stop：长命令供中断");
    await waitFor("停止任务已开工具", async () => (await taskStatus(client, task.id)).toolOps.length >= 1, 60_000);
    // 中断须核实容器真实退出（docker kill + inspect）；宽限超过控制面默认超时
    await client.request("interrupt", { task_id: task.id }, 120_000);
    await waitFor("停止任务已中断", async () => (await taskStatus(client, task.id)).task.status === "interrupted", 60_000);
    const detail = await taskStatus(client, task.id);
    const leftover = docker(["ps", "-aq", "--filter", `name=ruukoto-task-${task.id}`]);
    check("中断即回收实际执行单元（不只终止界面）", () => {
      assert.equal(detail.task.status, "interrupted");
      assert.ok(detail.toolOps.find((o: any) => o.sdkCallId === "s_sleep"), "工具操作已记录");
      assert.equal(leftover, "", "停止须回收按任务建立的容器");
    });
  }

  await client.close();
} finally {
  if (t) await t.shutdown();
  for (const taskId of taskIds) docker(["ps", "-aq", "--filter", `name=ruukoto-task-${taskId}`])
    .split("\n")
    .filter(Boolean)
    .forEach((id) => {
      try {
        docker(["rm", "-f", id]);
      } catch (err) {
        results.push({ name: `清理本次容器 ${id}`, ok: false, detail: (err as Error).message });
      }
    });
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
for (const r of failed) console.log(`  FAIL ${r.name}: ${r.detail}`);
process.exit(failed.length > 0 ? 1 : 0);
