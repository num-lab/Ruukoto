/**
 * 集成与单元：结构化审批与单次消费（issue 03 §4/§6.2/§6.3）。
 *
 * 覆盖：
 * - 越界文件读取/写入需拥有者批准；批准只消费到该次操作；
 * - 拒绝只阻止该操作，模型按拒绝结果继续（不产生效果不明）；
 * - 符号链接组件、控制面/数据目录目标在提出审批前被拒绝；
 * - 单次 HTTP 请求：批准前计数为零、批准后仅对应请求执行一次，其他
 *   目标/方法/任务不能复用批准，重定向不自动跟随；
 * - 凭据按目标绑定注入，不转发到其他地址；
 * - 无客户端时一直等待、重连后参数完整；
 * - 任务结束后的迟到批准被拒绝；
 * - 等待期间目标被替换/内容变化导致批准失效（执行器级）；
 * - 批准的消费资格（store 级）：重复消费、权限版本变化、任务结束均拒绝。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  taskStatus,
  connectAuthedClient,
  pendingConfirmation,
  realTools,
  writeModelsJson,
} from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { executeApprovedFileOp, executeApprovedHttpRequest, sha256Hex, type FileOpRequest } from "../src/agent/execution/approved-ops.ts";

// ---------- 本地模拟外部服务 ----------

interface MockService {
  url: string;
  hits: Map<string, number>;
  headers: Array<Record<string, string>>;
  close(): Promise<void>;
}

async function startMockService(): Promise<MockService> {
  const hits = new Map<string, number>();
  const headers: Array<Record<string, string>> = [];
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    headers.push(req.headers as Record<string, string>);
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/ok" });
      res.end("redirecting");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`ok:${req.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    headers,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 首个工具调用发出指定工具调用，之后以文本收尾。 */
function oneToolResponder(name: string, args: Record<string, unknown>): Responder {
  return (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: `c_${name}`, name, arguments: args }] };
    return { kind: "text", text: "已根据工具结果继续" };
  };
}

// ---------- 越界文件操作 ----------

test("越界文件读取/写入：形成具体审批，批准后按批准的对象与内容执行一次", async () => {
  // restrictedResolve 拒绝符号链接组件：临时目录统一取 realpath（macOS 的 /var 是符号链接）
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-fileapprove-")));
  try {
    const outside = path.join(root, "outside-config.txt");
    fs.writeFileSync(outside, "external-config-value\n", "utf8");
    const responder: Responder = (req) => {
      const done = req.messages.filter((m) => m?.role === "tool").length;
      if (done === 0) {
        return {
          kind: "tool_calls",
          calls: [{ id: "f_read", name: "request_file_access", arguments: { path: outside, operation: "read", reason: "查看外部配置" } }],
        };
      }
      if (done === 1) {
        return {
          kind: "tool_calls",
          calls: [{ id: "f_write", name: "request_file_access", arguments: { path: outside, operation: "write", content: "updated-by-agent\n", reason: "更新外部配置" } }],
        };
      }
      return { kind: "text", text: "外部配置已更新" };
    };
    const t = await startTestRuntime("approve-file", responder, { workDirs: 1, config: realTools() });
    try {
      const { sessionId } = await createProjectSession(t.client, t.work[0]!);
      const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sessionId,
        request_id: "af-1",
        input: "读取并更新外部配置",
      });

      // 读审批：结构化范围含目标、访问级别
      const readConf = await pendingConfirmation(t.client, task.id);
      assert.equal(readConf.toolName, "request_file_access");
      assert.equal(readConf.scope.kind, "file_operation");
      assert.equal(readConf.scope.path, outside);
      assert.equal(readConf.scope.access, "read");
      assert.equal(readConf.params.reason, "查看外部配置");
      const statusBefore = await taskStatus(t.client, task.id);
      assert.equal(statusBefore.task.status, "awaiting_confirmation");
      assert.equal(statusBefore.toolOps[0].resultSummary, null, "批准前不得执行");
      assert.equal(fs.readFileSync(outside, "utf8"), "external-config-value\n", "批准前文件不变");

      await t.client.request("respond_confirmation", { confirmation_id: readConf.id, decision: "approve" });

      // 写审批：范围含待写内容的指纹与字节数、原文版本指纹
      const writeConf = await pendingConfirmation(t.client, task.id);
      assert.equal(writeConf.scope.access, "read_write");
      assert.equal(writeConf.scope.contentBytes, Buffer.byteLength("updated-by-agent\n"));
      assert.equal(typeof writeConf.scope.contentSha256, "string");
      assert.equal(writeConf.scope.originalSha256, sha256Hex(fs.readFileSync(outside)), "写入绑定原文版本");
      await t.client.request("respond_confirmation", { confirmation_id: writeConf.id, decision: "approve" });

      await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);
      assert.equal(fs.readFileSync(outside, "utf8"), "updated-by-agent\n", "批准后按批准内容写入");

      const detail = await taskStatus(t.client, task.id);
      const readOp = detail.toolOps.find((op: any) => op.sdkCallId === "f_read");
      assert.equal(readOp.isError, false);
      assert.match(readOp.resultSummary, /external-config-value/, "读结果返回文件内容");
      assert.equal(detail.confirmations.every((c: any) => c.consumedAt !== null), true, "批准均单次消费");
    } finally {
      await t.shutdown();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("符号链接组件与控制面/数据目录目标：提出审批前即拒绝", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-filedeny-")));
  try {
    const realDir = path.join(root, "real");
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, "secret.txt"), "s\n", "utf8");
    const linkDir = path.join(root, "link");
    fs.symlinkSync(realDir, linkDir);

    let protectedTarget = "";
    const responder: Responder = (req) => {
      const done = req.messages.filter((m) => m?.role === "tool").length;
      if (done === 0) {
        return {
          kind: "tool_calls",
          calls: [{ id: "f_link", name: "request_file_access", arguments: { path: path.join(linkDir, "secret.txt"), operation: "read", reason: "经符号链接读取" } }],
        };
      }
      if (done === 1) {
        return {
          kind: "tool_calls",
          calls: [{ id: "f_protected", name: "request_file_access", arguments: { path: protectedTarget, operation: "read", reason: "读取控制面数据" } }],
        };
      }
      return { kind: "text", text: "两次申请都被前置拒绝" };
    };
    const t = await startTestRuntime("deny-file", responder, { workDirs: 1, config: realTools() });
    try {
      protectedTarget = path.join(fs.realpathSync(t.dirs.dataDir), "ruukoto.db");
      const { sessionId } = await createProjectSession(t.client, t.work[0]!);
      const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sessionId,
        request_id: "df-1",
        input: "读取被拒目标",
      });
      await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);

      const detail = await taskStatus(t.client, task.id);
      assert.equal(detail.confirmations.length, 0, "前置拒绝不得形成审批");
      const linkOp = detail.toolOps.find((op: any) => op.sdkCallId === "f_link");
      assert.equal(linkOp.isError, true);
      assert.match(linkOp.resultSummary, /符号链接/, "符号链接组件被拒绝");
      const protectedOp = detail.toolOps.find((op: any) => op.sdkCallId === "f_protected");
      assert.equal(protectedOp.isError, true);
      assert.match(protectedOp.resultSummary, /始终排除/, "控制面/数据目录目标始终排除");
      assert.equal(fs.readFileSync(path.join(realDir, "secret.txt"), "utf8"), "s\n", "目标文件未被读取影响");
    } finally {
      await t.shutdown();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("执行器级：等待期间目标被替换、内容变化、符号链接与保护目录都失败", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-fileop-")));
  const protectedDir = path.join(root, "data");
  fs.mkdirSync(protectedDir, { recursive: true });
  try {
    const target = path.join(root, "outside.txt");
    fs.writeFileSync(target, "original\n", "utf8");
    const st = fs.lstatSync(target);
    const base: FileOpRequest = {
      path: target,
      access: "read",
      targetDev: st.dev,
      targetIno: st.ino,
      originalSha256: null,
      protectedRoots: [protectedDir],
    };

    // 正常读取
    const ok = executeApprovedFileOp(base);
    assert.equal(ok.ok, true);
    assert.equal(ok.content, "original\n");

    // 等待期间目标被替换（dev/ino 变化）
    const replaced = executeApprovedFileOp({ ...base, targetDev: st.dev, targetIno: st.ino + 1 });
    assert.equal(replaced.ok, false);
    assert.match(replaced.message, /已被替换/);

    // 写入：原文版本不一致 → 批准失效
    const staleWrite = executeApprovedFileOp({
      ...base,
      access: "read_write",
      content: "new\n",
      originalSha256: sha256Hex(Buffer.from("别的原文")),
    });
    assert.equal(staleWrite.ok, false);
    assert.match(staleWrite.message, /原文版本不一致/);

    // 写入：版本一致 → 成功
    const writeOk = executeApprovedFileOp({
      ...base,
      access: "read_write",
      content: "new\n",
      originalSha256: sha256Hex(fs.readFileSync(target)),
    });
    assert.equal(writeOk.ok, true);
    assert.equal(fs.readFileSync(target, "utf8"), "new\n");

    // 符号链接组件
    const linkDir = path.join(root, "link-dir");
    fs.symlinkSync(root, linkDir);
    const viaLink = executeApprovedFileOp({ ...base, path: path.join(linkDir, "outside.txt") });
    assert.equal(viaLink.ok, false);
    assert.match(viaLink.message, /符号链接/);

    // 保护目录始终排除
    const protectedFile = path.join(protectedDir, "ruukoto.db");
    fs.writeFileSync(protectedFile, "db", "utf8");
    const protectedOp = executeApprovedFileOp({ ...base, path: protectedFile });
    assert.equal(protectedOp.ok, false);
    assert.match(protectedOp.message, /始终排除/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 单次 HTTP 请求 ----------

test("单次 HTTP 请求：批准前零调用、批准后仅一次；其他目标需新的批准", async () => {
  const service = await startMockService();
  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "h_ok", name: "http_request", arguments: { method: "GET", url: `${service.url}/ok`, reason: "读取服务状态" } }],
      };
    }
    if (done === 1) {
      return {
        kind: "tool_calls",
        calls: [{ id: "h_other", name: "http_request", arguments: { method: "POST", url: `${service.url}/other`, body: "payload", reason: "提交数据" } }],
      };
    }
    return { kind: "text", text: "两次请求都处理完" };
  };
  const t = await startTestRuntime("approve-http", responder, { workDirs: 1, config: realTools() });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "ah-1",
      input: "访问外部服务",
    });

    const first = await pendingConfirmation(t.client, task.id);
    assert.equal(first.toolName, "http_request");
    assert.equal(first.scope.kind, "http_request");
    assert.equal(first.scope.method, "GET");
    assert.match(first.scope.url, /\/ok$/);
    assert.equal(service.hits.size, 0, "批准前不得发出任何请求");

    await t.client.request("respond_confirmation", { confirmation_id: first.id, decision: "approve" });
    // 第二次请求出现自己的审批：第一个批准不能复用到其他目标/方法
    let second: any = null;
    await waitFor("第二个审批出现", async () => {
      const status = await taskStatus(t.client, task.id);
      second = status.confirmations.find((c: any) => c.status === "pending" && c.id !== first.id) ?? null;
      return second !== null;
    }, 60_000);
    assert.equal(second.scope.method, "POST");
    assert.match(second.scope.url, /\/other$/);
    assert.equal(service.hits.get("GET /ok"), 1, "第一次请求只执行一次");
    assert.equal(service.hits.get("POST /other"), undefined, "第二个目标在批准前不得执行");

    await t.client.request("respond_confirmation", { confirmation_id: second.id, decision: "approve" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);
    assert.equal(service.hits.get("POST /other"), 1);

    const detail = await taskStatus(t.client, task.id);
    const consumed = detail.confirmations.filter((c: any) => c.consumedAt !== null);
    assert.equal(consumed.length, 2, "两次批准都被消费且只消费一次");
  } finally {
    await t.shutdown();
    await service.close();
  }
});

test("重定向不自动跟随；凭据按目标绑定注入，不转发到其他地址", async () => {
  const service = await startMockService();
  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "h_redir", name: "http_request", arguments: { method: "GET", url: `${service.url}/redirect`, reason: "跟随跳转" } }],
      };
    }
    if (done === 1) {
      return {
        kind: "tool_calls",
        calls: [{ id: "h_secret", name: "http_request", arguments: { method: "GET", url: `${service.url}/secure`, credential: "svc", reason: "带凭据访问" } }],
      };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("approve-http2", responder, { workDirs: 1, config: realTools() });
  try {
    const host = new URL(service.url).host;
    await t.client.request("add_credential", {
      name: "svc",
      host,
      header: "authorization",
      purpose: "本地模拟服务",
      secret: "Bearer s3cret",
    });
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "ah-2",
      input: "带凭据与跳转的访问",
    });

    const redir = await pendingConfirmation(t.client, task.id);
    assert.match(redir.scope.url, /\/redirect$/);
    await t.client.request("respond_confirmation", { confirmation_id: redir.id, decision: "approve" });

    const secure = await pendingConfirmation(t.client, task.id);
    assert.deepEqual(secure.scope.credentials, [{ name: "svc", purpose: "本地模拟服务" }]);
    assert.equal(JSON.stringify(secure.scope).includes("s3cret"), false, "审批展示不得含凭据值");
    await t.client.request("respond_confirmation", { confirmation_id: secure.id, decision: "approve" });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);

    assert.equal(service.hits.get("GET /redirect"), 1);
    assert.equal(service.hits.get("GET /ok"), undefined, "重定向不得自动跟随");
    assert.equal(service.hits.get("GET /secure"), 1);
    const secureHeaders = service.headers.at(-1)!;
    assert.equal(secureHeaders["authorization"], "Bearer s3cret", "凭据在目标主机匹配时注入");
    assert.equal(JSON.stringify(service.headers).includes("s3cret"), true);

    // 凭据不得转发到其他地址：绑定主机不匹配时在提出审批前即失败
    const mismatch = await startTestRuntime("approve-http3", oneToolResponder("http_request", {
      method: "GET",
      url: "http://127.0.0.1:1/elsewhere",
      credential: "svc",
      reason: "转发凭据",
    }), { workDirs: 1, config: realTools() });
    try {
      await mismatch.client.request("add_credential", {
        name: "svc",
        host,
        header: "authorization",
        purpose: "本地模拟服务",
        secret: "Bearer s3cret",
      });
      const { sessionId: sid2 } = await createProjectSession(mismatch.client, mismatch.work[0]!);
      const task2 = await mismatch.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sid2,
        request_id: "ah-3",
        input: "转发凭据",
      });
      await waitFor("任务完成", async () => (await taskStatus(mismatch.client, task2.id)).task.status === "completed", 60_000);
      const detail2 = await taskStatus(mismatch.client, task2.id);
      assert.equal(detail2.confirmations.length, 0, "主机不匹配时不得形成审批");
      assert.match(detail2.toolOps[0].resultSummary, /不一致/, "应说明凭据绑定与目标不一致");
    } finally {
      await mismatch.shutdown();
    }
  } finally {
    await t.shutdown();
    await service.close();
  }
});

test("拒绝只阻止该操作；无客户端时保持等待，重连后参数完整", async () => {
  const service = await startMockService();
  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "h_rej", name: "http_request", arguments: { method: "DELETE", url: `${service.url}/danger`, reason: "删除远端数据" } }],
      };
    }
    return { kind: "text", text: "已按拒绝结果继续" };
  };
  const t = await startTestRuntime("approve-reject", responder, { workDirs: 1, config: realTools() });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "arej-1",
      input: "删除远端数据",
    });
    const confirmation = await pendingConfirmation(t.client, task.id);
    assert.equal(confirmation.params.url, `${service.url}/danger`, "审批保存不可变参数");

    // 无客户端时一直等待（其他目录任务可继续，这里只断言等待态与占用保留）
    t.client.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(t.runtime.store.getTask(task.id)!.status, "awaiting_confirmation", "无客户端时保持等待");
    assert.ok(
      t.runtime.store.getOccupancyByDir(fs.realpathSync(t.work[0]!)) !== null,
      "等待确认期间保留目录占用",
    );

    // 重连后状态与操作内容完整，可继续决策
    const client2 = await connectAuthedClient(t.runtime);
    try {
      const status = await taskStatus(client2, task.id);
      const pending = status.confirmations.find((c: any) => c.id === confirmation.id);
      assert.equal(pending.status, "pending");
      assert.equal(pending.params.url, `${service.url}/danger`);
      assert.equal(pending.scope.method, "DELETE");

      await client2.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "reject" });
      await waitFor("任务按拒绝结果完成", async () => (await taskStatus(client2, task.id)).task.status === "completed", 60_000);
      const detail = await taskStatus(client2, task.id);
      assert.equal(detail.toolOps[0].isError, true);
      assert.match(detail.toolOps[0].resultSummary, /拒绝/);
      assert.equal(detail.task.effectUnknown, false, "拒绝的操作为已知未执行");
      assert.equal(service.hits.size, 0, "拒绝的操作不得执行");
    } finally {
      client2.close();
    }
  } finally {
    await t.shutdown();
    await service.close();
  }
});

test("任务结束后的迟到批准被拒绝，操作不执行", async () => {
  const service = await startMockService();
  const t = await startTestRuntime(
    "approve-late",
    oneToolResponder("http_request", { method: "GET", url: `${service.url}/late`, reason: "迟到的批准" }),
    { workDirs: 1, config: realTools() },
  );
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "alate-1",
      input: "等待批准的操作",
    });
    const confirmation = await pendingConfirmation(t.client, task.id);

    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务中断", async () => (await taskStatus(t.client, task.id)).task.status === "interrupted", 30_000);

    await assert.rejects(
      () => t.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" }),
      (err: any) => err.code === "stale_confirmation",
      "任务结束后的批准必须被拒绝",
    );
    const detail = await taskStatus(t.client, task.id);
    assert.equal(detail.confirmations[0].status, "stale");
    assert.equal(detail.confirmations[0].consumedAt, null, "失效批准不得被消费");
    assert.equal(service.hits.size, 0, "失效批准不得执行");
  } finally {
    await t.shutdown();
    await service.close();
  }
});

// ---------- 批准消费资格（store 级） ----------

test("批准消费：重复消费、权限版本变化、任务结束后都拒绝", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-consume-"));
  const db = new Db(root);
  try {
    const store = new Store(db);
    const project = store.createProject("p");
    const session = store.createSession({
      projectId: project.id,
      cwd: root,
      cwdReal: root,
      cwdDev: 1,
      cwdIno: 1,
      piSessionId: "pi-1",
      confirmTools: [],
    });
    const { task } = store.insertQueuedTask({ sessionId: session.id, requestId: "r1", input: "i", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: "r1" });
    store.transitionTask(task.id, ["queued"], "running", {});
    const confirmation = store.createConfirmation({
      taskId: task.id,
      sessionId: session.id,
      toolOpId: "op_1",
      toolName: "http_request",
      params: { url: "http://example.test/" },
      scope: { kind: "http_request", method: "GET", url: "http://example.test/", credentials: [] },
      permissionVersion: task.permissionVersion,
    });

    // 未批准不得消费
    assert.equal(
      store.consumeApproval({ confirmationId: confirmation.id, expectedPermissionVersion: 1, activeStatuses: ["running"] }),
      false,
    );
    store.respondConfirmation(confirmation.id, "approved");
    assert.equal(
      store.consumeApproval({ confirmationId: confirmation.id, expectedPermissionVersion: 2, activeStatuses: ["running"] }),
      false,
      "权限版本不匹配的批准不得消费",
    );
    assert.equal(
      store.consumeApproval({ confirmationId: confirmation.id, expectedPermissionVersion: 1, activeStatuses: ["running"] }),
      true,
    );
    assert.equal(
      store.consumeApproval({ confirmationId: confirmation.id, expectedPermissionVersion: 1, activeStatuses: ["running"] }),
      false,
      "批准只能消费一次",
    );

    // 任务结束后：新的批准不得消费
    const second = store.createConfirmation({
      taskId: task.id,
      sessionId: session.id,
      toolOpId: "op_2",
      toolName: "http_request",
      params: {},
      scope: { kind: "http_request", method: "GET", url: "http://example.test/2", credentials: [] },
      permissionVersion: store.getTask(task.id)!.permissionVersion,
    });
    store.respondConfirmation(second.id, "approved");
    store.transitionTask(task.id, ["running"], "completed", {});
    assert.equal(
      store.consumeApproval({
        confirmationId: second.id,
        expectedPermissionVersion: store.getTask(task.id)!.permissionVersion,
        activeStatuses: ["running", "awaiting_confirmation"],
      }),
      false,
      "任务已结束时批准不得消费",
    );

    // 模式切换使旧批准失效（不自动执行旧待批准操作）
    const third = store.createConfirmation({
      taskId: task.id,
      sessionId: session.id,
      toolOpId: "op_3",
      toolName: "http_request",
      params: {},
      scope: { kind: "http_request", method: "GET", url: "http://example.test/3", credentials: [] },
      permissionVersion: 1,
    });
    store.applyModeSwitch(task.id, "full_access");
    assert.equal(store.getConfirmation(third.id)!.status, "stale", "模式切换后未决审批失效");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("崩溃恢复区分审批消费状态：已消费标 effect_unknown，未消费为已知未执行（计划 §6.6）", async () => {
  const server = new MockModelServer(() => ({ kind: "text", text: "noop" }));
  const baseUrl = await server.start();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-recover-approve-")));
  const dirs = { root, dataDir: path.join(root, "data"), agentDir: path.join(root, "agent") };
  fs.mkdirSync(dirs.dataDir, { recursive: true });
  fs.mkdirSync(dirs.agentDir, { recursive: true });
  await writeModelsJson(dirs, baseUrl);
  try {
    // 预写崩溃现场：任务 running，两个工具操作——一个批准已消费（执行已
    // 开始但结果未落盘），一个批准未消费（已知未执行）
    const db = new Db(dirs.dataDir);
    const store = new Store(db);
    const project = store.withTx(() => store.createProject("rec"));
    const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-recover-ws-")));
    const session = store.withTx(() =>
      store.createSession({
        projectId: project.id,
        cwd: workdir,
        cwdReal: workdir,
        cwdDev: 1,
        cwdIno: 1,
        piSessionId: "pi-rec-1",
        confirmTools: [],
      }),
    );
    const { task } = store.withTx(() =>
      store.insertQueuedTask({ sessionId: session.id, requestId: "r-rec", input: "注入恢复场景", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: "r-rec" }),
    );
    store.withTx(() => {
      store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date().toISOString() });
      store.recordToolIntent({ id: "op_consumed", taskId: task.id, sessionId: session.id, toolName: "http_request", sdkCallId: "c_1", params: {} });
      store.recordToolIntent({ id: "op_pending", taskId: task.id, sessionId: session.id, toolName: "request_file_access", sdkCallId: "c_2", params: {} });
      const consumed = store.createConfirmation({
        taskId: task.id,
        sessionId: session.id,
        toolOpId: "op_consumed",
        toolName: "http_request",
        params: { url: "http://example.test/" },
        scope: { kind: "http_request", method: "GET", url: "http://example.test/", credentials: [] },
        permissionVersion: 1,
      });
      store.respondConfirmation(consumed.id, "approved");
      assert.equal(
        store.consumeApproval({ confirmationId: consumed.id, expectedPermissionVersion: 1, activeStatuses: ["running"] }),
        true,
      );
      store.createConfirmation({
        taskId: task.id,
        sessionId: session.id,
        toolOpId: "op_pending",
        toolName: "request_file_access",
        params: { path: "/x" },
        scope: { kind: "file_operation", path: "/x", access: "read", originalSha256: null, contentSha256: null, contentBytes: null },
        permissionVersion: 1,
      });
    });
    db.close();

    // 重启：恢复必须在一次逻辑事务内区分两种事实
    const { Runtime } = await import("../src/runtime/runtime.ts");
    const runtime = await Runtime.start({
      dataDir: dirs.dataDir,
      agentDir: dirs.agentDir,
      socketPath: path.join(root, "c.sock"),
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
    });
    try {
      const recovered = runtime.store.getTask(task.id)!;
      assert.equal(recovered.status, "interrupted");
      assert.equal(recovered.interruptReason, "backend_restart");

      const consumedOp = runtime.store.getToolOp("op_consumed")!;
      assert.equal(consumedOp.resultSummary, null, "已消费操作没有伪造结果");
      assert.equal(consumedOp.effectUnknown, true, "批准已消费且结果缺失 → effect_unknown");

      const pendingOp = runtime.store.getToolOp("op_pending")!;
      assert.notEqual(pendingOp.resultSummary, null, "未消费操作记录已知未执行");
      assert.match(pendingOp.resultSummary!, /已知未执行/);
      assert.equal(pendingOp.effectUnknown, false, "审批未消费 = 已知未执行，不算效果不明");
      assert.equal(recovered.effectUnknown, true, "任务保留效果不明事实");

      const events = runtime.getEventLog(0, 10_000);
      assert.ok(
        events.some((e) => e.body.type === "task.tool_effect_unknown" && e.body.toolOpId === "op_consumed"),
        "已消费未落盘操作发出 effect_unknown 事件",
      );
      assert.ok(
        !events.some((e) => e.body.type === "task.tool_effect_unknown" && e.body.toolOpId === "op_pending"),
        "已知未执行操作不标 effect_unknown",
      );
    } finally {
      await runtime.stop("test_end");
    }
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DNS 在批准时固定：不可解析目标在提出审批前失败（防重绑定的前置校验）", async () => {
  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "h_nx", name: "http_request", arguments: { method: "GET", url: "http://nonexistent.invalid/", reason: "不可达目标" } }],
      };
    }
    return { kind: "text", text: "已处理解析失败" };
  };
  const t = await startTestRuntime("approve-dns", responder, { workDirs: 1, config: realTools() });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "adns-1",
      input: "访问不可解析目标",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 60_000);
    const detail = await taskStatus(t.client, task.id);
    assert.equal(detail.confirmations.length, 0, "解析失败不得形成审批");
    assert.equal(detail.toolOps[0].isError, true);
    assert.match(detail.toolOps[0].resultSummary, /解析失败/);
  } finally {
    await t.shutdown();
  }
});

test("SQLite v1→v2 事务迁移：旧任务默认请求确认，旧未决审批失效，历史与事件保留", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-migrate-")));
  try {
    // 手工构造 v1 库（issue 02 模式：任务无访问模式列、审批无范围/版本/消费时间）
    const raw = new DatabaseSync(path.join(root, "ruukoto.db"));
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        cwd TEXT NOT NULL, cwd_real TEXT NOT NULL, cwd_dev INTEGER NOT NULL, cwd_ino INTEGER NOT NULL,
        pi_session_id TEXT NOT NULL, session_file TEXT,
        confirm_tools TEXT NOT NULL DEFAULT '[]',
        queue_state TEXT NOT NULL DEFAULT 'active', queue_pause_reason TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL, input TEXT NOT NULL,
        status TEXT NOT NULL, interrupt_reason TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0, effect_unknown INTEGER NOT NULL DEFAULT 0,
        error_message TEXT, history_entry_ids TEXT NOT NULL DEFAULT '[]', resumes_task_id TEXT,
        created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
        UNIQUE (session_id, request_id)
      );
      CREATE TABLE occupancy (
        cwd_real TEXT PRIMARY KEY, cwd_dev INTEGER NOT NULL, cwd_ino INTEGER NOT NULL,
        session_id TEXT NOT NULL, task_id TEXT NOT NULL, acquired_at TEXT NOT NULL
      );
      CREATE TABLE confirmations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL,
        tool_op_id TEXT NOT NULL, tool_name TEXT NOT NULL, params TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, responded_at TEXT
      );
      CREATE TABLE tool_ops (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        tool_name TEXT NOT NULL, params TEXT NOT NULL, intent_recorded_at TEXT NOT NULL,
        result_summary TEXT, is_error INTEGER, effect_unknown INTEGER NOT NULL DEFAULT 0,
        recorded_result_at TEXT
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, session_id TEXT,
        body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('p1', 'legacy', '2026-01-01T00:00:00Z');
      INSERT INTO sessions (id, project_id, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, created_at)
        VALUES ('s1', 'p1', '/w', '/w', 1, 1, 'pi-1', '2026-01-01T00:00:00Z');
      INSERT INTO tasks (id, session_id, request_id, input, status, created_at)
        VALUES ('t1', 's1', 'r1', '旧任务输入', 'completed', '2026-01-01T00:00:00Z');
      INSERT INTO tool_ops (id, task_id, tool_name, params, intent_recorded_at)
        VALUES ('old-op-1', 't1', 'bash', '{}', '2026-01-01T00:00:01Z');
      INSERT INTO confirmations (id, task_id, session_id, tool_op_id, tool_name, params, status, created_at)
        VALUES ('c1', 't1', 's1', 'old-op-1', 'mock_gate', '{"note":"x"}', 'pending', '2026-01-01T00:00:02Z');
      INSERT INTO events (task_id, session_id, body, created_at)
        VALUES ('t1', 's1', '{"type":"task.completed","taskId":"t1","sessionId":"s1"}', '2026-01-01T00:00:03Z');
    `);
    raw.close();

    // 打开即迁移
    const db = new Db(root);
    const store = new Store(db);
    try {
      const task = store.getTask("t1")!;
      assert.equal(task.accessMode, "confirm", "旧任务默认请求确认");
      assert.equal(task.permissionVersion, 1);
      assert.deepEqual(task.grantedPaths, []);
      assert.equal(task.modelSelection, null);
      assert.equal(task.submissionDigest, null);
      assert.equal(store.getSession("s1")!.modelSelection, null);
      assert.equal(store.getSession("s1")!.modelSelectionVersion, 0);
      assert.equal(task.input, "旧任务输入", "历史任务内容保留");

      const op = store.getToolOp("old-op-1")!;
      assert.equal(op.sdkCallId, "old-op-1", "旧操作以原 id 回填 SDK 调用 id（不丢失关联）");

      const confirmation = store.getConfirmation("c1")!;
      assert.equal(confirmation.status, "stale", "旧未决审批一律失效");
      assert.notEqual(confirmation.respondedAt, null);

      const events = store.getEventsAfter(0);
      assert.ok(events.some((e) => e.body.type === "task.completed"), "历史事件保留");

      // 重复打开（幂等）：已迁移库不再迁移
      db.close();
      const db2 = new Db(root);
      db2.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
});

test("批准绑定权限版本：版本不匹配的应答被拒绝", async () => {
  const responder: Responder = (req) => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return {
        kind: "tool_calls",
        calls: [{ id: "c_pv", name: "mock_gate", arguments: { note: "版本绑定" } }],
      };
    }
    return { kind: "text", text: "收尾" };
  };
  const t = await startTestRuntime("perm-version", responder, { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!, { confirmTools: ["mock_gate"] });
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: sessionId, request_id: "pv-1", input: "触发审批" });
    const conf = await pendingConfirmation(t.client, task.id);
    assert.ok(conf.permissionVersion >= 1);
    // 错误的权限版本：明确拒绝，不消费批准
    await assert.rejects(
      () =>
        t.client.request("respond_confirmation", {
          confirmation_id: conf.id,
          decision: "approve",
          permission_version: conf.permissionVersion + 1,
        }),
      (err: any) => err.code === "permission_version_mismatch",
    );
    const still = await taskStatus(t.client, task.id);
    assert.equal(still.confirmations[0].status, "pending", "版本不匹配的应答不得消费审批");
    // 正确版本：正常批准
    await t.client.request("respond_confirmation", {
      confirmation_id: conf.id,
      decision: "approve",
      permission_version: conf.permissionVersion,
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    // confirmTools 门也经审批闸门：批准后先消费再放行执行（架构工单 04）
    assert.notEqual(t.runtime.store.getConfirmation(conf.id)!.consumedAt, null, "批准已消费");
    assert.equal(t.runtime.store.getTaskEventsAfter(task.id, 0, 1000).filter((e) => e.body.type === "task.approval_consumed").length, 1);
  } finally {
    await t.shutdown();
  }
});

// issue 17：自旧 GitHub 模块测试迁移的通用凭据保障（专用模块已退役，约束由公共凭据层承载）
test("带 scope 的凭据不得被通用 http_request 借用；同名轮换保留 scope", async () => {
  const t = await startTestRuntime("approve-scoped-cred", async () => ({ kind: "text" as const, text: "done" }), { workDirs: 1 });
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!);
    await t.client.request("add_credential", { name: "svc-scoped", host: "api.example.com", header: "authorization", purpose: "mcp", secret: "scoped-secret" });
    // 带使用范围的凭据（如 MCP 配置收紧后）：通用 http_request 一律不得借用
    t.runtime.credentials.upsert({ ...t.runtime.credentials.get("svc-scoped")!, scope: { projectId, operations: ["mcp"] } });
    const outcome = await executeApprovedHttpRequest(
      { method: "POST", url: "https://api.example.com/x", headers: {}, credentialName: "svc-scoped", body: "" } as any,
      t.runtime.credentials,
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /范围/);
    // 同名轮换（更新秘密值）保留既有 scope，不得清空限制字段
    await t.client.request("add_credential", { name: "svc-scoped", host: "api.example.com", header: "authorization", purpose: "mcp", secret: "rotated" });
    const rotated = t.runtime.credentials.get("svc-scoped")!;
    assert.equal(rotated.secret, "rotated");
    assert.deepEqual(rotated.scope, { projectId, operations: ["mcp"] }, "轮换不得清空 scope");
  } finally {
    await t.shutdown();
  }
});
