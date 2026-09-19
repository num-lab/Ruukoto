/**
 * 真实模型连通性检查（默认跳过，凭 RUN_MODEL_CHECK=1 开启）。
 *
 * 与 issue 01 的验证方式一致：每个 provider 一次短往返，不设置质量门槛。
 * 逐个尝试 models.json 里的 provider（可用 RUN_MODEL_CHECK_PROVIDER 显式
 * 指定）；全部不可达或凭据缺失时如实报告，不把失败写成通过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Runtime } from "../src/runtime/runtime.ts";
import { ControlServer } from "../src/control/server.ts";
import { ControlClient } from "../src/control/client.ts";
import { waitFor, taskStatus } from "./helpers/testkit.ts";

interface ProviderAttempt {
  provider: string;
  status: string;
  detail: string;
}

test("真实模型连通性（RUN_MODEL_CHECK=1 开启）", { skip: process.env.RUN_MODEL_CHECK !== "1" }, async () => {
  const userAgentDir = path.join(os.homedir(), ".pi", "agent");
  if (!fsSync.existsSync(path.join(userAgentDir, "models.json"))) {
    console.log("跳过：缺少 ~/.pi/agent/models.json（无模型配置）");
    return;
  }
  const raw = JSON.parse(fsSync.readFileSync(path.join(userAgentDir, "models.json"), "utf8")) as {
    providers?: Record<string, { models?: Array<{ id: string }> }>;
  };
  const configured = Object.entries(raw.providers ?? {}).filter(([, p]) => (p.models?.length ?? 0) > 0);
  if (configured.length === 0) {
    console.log("跳过：models.json 中没有 provider");
    return;
  }

  const attempts: ProviderAttempt[] = [];
  const explicit = process.env.RUN_MODEL_CHECK_PROVIDER;
  const queue = explicit
    ? configured.filter(([name]) => name === explicit)
    : configured;

  for (const [provider, def] of queue) {
    const modelId = def.models![0]!.id;
    const root = await fsSync.promises.mkdtemp(path.join(os.tmpdir(), "ruukoto-modelcheck-"));
    let runtime: Runtime | null = null;
    try {
      runtime = await Runtime.start({
        dataDir: path.join(root, "data"),
        agentDir: userAgentDir,
        thinkingLevel: "off",
        modelProvider: provider,
        modelId,
      });
      await ControlServer.start(runtime);
      const client = await ControlClient.connect(runtime.socketPath());
      await client.handshake();
      const project = await client.request<any>("create_project", { name: "model-check" });
      const session = await client.request<any>("create_session", {
        project_id: project.id,
        cwd: root,
      });
      const task = await client.request<any>("submit", {
        session_id: session.id,
        request_id: `model-check-${provider}`,
        input: "请只回复两个字母：OK",
      });
      await waitFor(
        "真实模型往返完成",
        async () => {
          const s = (await taskStatus(client, task.id)).task.status;
          return ["completed", "failed", "interrupted", "canceled"].includes(s);
        },
        90_000,
      );
      const { task: final } = await taskStatus(client, task.id);
      attempts.push({
        provider: `${provider}/${modelId}`,
        status: final.status,
        detail: String(final.errorMessage ?? final.interruptReason ?? ""),
      });
      client.close();
      await runtime.stop("model_check_provider_done");
      runtime = null;
      if (final.status === "completed") break; // 一次成功即验证连通
    } catch (err) {
      attempts.push({ provider: `${provider}/${modelId}`, status: "error", detail: (err as Error).message });
    } finally {
      if (runtime) await runtime.stop("model_check_cleanup").catch(() => {});
      await fsSync.promises.rm(root, { recursive: true, force: true });
    }
  }

  console.log("连通性结果：", JSON.stringify(attempts, null, 2));
  const ok = attempts.find((a) => a.status === "completed");
  if (!ok && attempts.length === 0) {
    console.log(explicit ? `跳过：指定 provider ${explicit} 不在 models.json 中` : "跳过：没有可尝试的 provider");
    return;
  }
  assert.ok(ok, `所有 provider 均未连通：${JSON.stringify(attempts)}`);
});
