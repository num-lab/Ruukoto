import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parsePersonalModel } from "../../apps/ruukoto/src/personal-model.ts";
import { savePersonalConfig } from "../../apps/ruukoto/src/personal-config.ts";
import { lockPersonalProfile } from "../../apps/ruukoto/src/personal-profile.ts";
import { personalControl, type PersonalInputStatus } from "../../apps/ruukoto/src/personal-control.ts";
import { launchPersonalServer, preparePersonalInput, checkPersonalInput } from "../../apps/ruukoto/src/personal-cli.ts";
import { PersonalError } from "../../apps/ruukoto/src/personal-error.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
type SourceModel = { id: string; api?: string; contextWindow?: number; maxTokens?: number };
type SourceProvider = { api?: string; baseUrl: string; apiKey?: string; models: SourceModel[]; headers?: Record<string, string> };

async function waitUntil(check: () => Promise<boolean> | boolean, milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) { assert.ok(Date.now() < deadline, "隔离实例验证超时"); await delay(100); }
}

async function main() {
  const source = process.env.RUN_PERSONAL_MODELS_FILE;
  const requested = process.env.RUN_PERSONAL_MODEL;
  if (process.env.RUN_MODEL_CHECK !== "1" || !source || !requested) {
    process.stderr.write("[ruukoto:personal] 真实模型验收需要 RUN_MODEL_CHECK=1、RUN_PERSONAL_MODELS_FILE 和 RUN_PERSONAL_MODEL；未执行模型请求。\n");
    return 2;
  }
  // 文件或 stdin 是拥有者显式选择的验收配置；只把所选凭据放进子进程环境，不复制到个人档案。
  const raw = JSON.parse(fs.readFileSync(source === "-" ? 0 : source, "utf8")) as { providers: Record<string, SourceProvider> };
  const selected = Object.entries(raw.providers).flatMap(([id, provider]) => provider.models.filter(model => `${id}/${model.id}` === requested).map(model => ({ id, provider, model })));
  assert.equal(selected.length, 1, "指定配置中必须恰有一个目标模型");
  const { provider, model } = selected[0];
  assert.ok(provider.apiKey && !provider.apiKey.startsWith("!"), "此窄验收只支持显式凭据或已有环境变量，不执行凭据命令");
  assert.ok(!provider.headers || Object.keys(provider.headers).length === 0, "此窄验收尚不支持自定义认证头");
  const credential = process.env[provider.apiKey] ?? provider.apiKey;
  const credentialName = "PERSONAL_ACCEPTANCE_MODEL_KEY";
  const previous = process.env[credentialName];
  process.env[credentialName] = credential;
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-real-")));
  let running = false;
  const stop = async () => {
    if (!running) return;
    await personalControl(directory, "POST", "/stop");
    await waitUntil(() => {
      try { const lock = lockPersonalProfile(directory); lock.release(); return true; } catch (error) {
        if (error instanceof PersonalError && error.code === "profile_busy") return false;
        throw error;
      }
    }, 10000);
    running = false;
  };
  try {
    savePersonalConfig(directory, parsePersonalModel({ api: model.api ?? provider.api, baseUrl: provider.baseUrl, modelId: model.id, apiKeyEnv: credentialName, contextWindow: model.contextWindow ?? 128000, maxTokens: Math.min(model.maxTokens ?? 4096, 4096) }));
    running = true;
    await launchPersonalServer(directory);
    const marker = `PERSONAL_CHECK_${randomUUID().replaceAll("-", "")}`;
    const answer = async (message: string) => {
      const input = preparePersonalInput(directory, message);
      await personalControl(directory, "POST", "/inputs", input);
      let status: PersonalInputStatus = { status: "missing" };
      await waitUntil(async () => {
        status = await checkPersonalInput(directory, input);
        assert.notEqual(status.status, "unanswered", "真实模型未能完成回答");
        return status.status === "done";
      }, 120000);
      assert.ok(status.answer?.includes(marker), "回答没有包含本次隔离校验标记");
    };
    await answer(`本次会话的校验标记是 ${marker}。请只回复这个标记。`);
    await stop();
    running = true;
    await launchPersonalServer(directory);
    await answer("上一条用户消息指定的校验标记是什么？请只回复那个标记。");
    await stop();
    const db = new DatabaseSync(path.join(directory, "personal.sqlite"), { readOnly: true });
    try {
      const entries = db.prepare("SELECT record FROM entries WHERE json_extract(record, '$.kind') = 'ruukoto.model-request'").all() as { record: string }[];
      assert.equal(entries.length, 4, "两次模型调用应各有规范输入与实际 payload 证据");
      assert.ok(entries.every(entry => !entry.record.includes(credential)), "请求证据不应包含认证值");
    } finally { db.close(); }
    process.stdout.write(`真实个人模型往返、独立进程重启与上下文延续通过：${requested}；2 次输入、4 条请求证据，无 IM 或外部工具。\n`);
    return 0;
  } finally {
    try { await stop(); } finally {
      if (!running) fs.rmSync(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous;
    }
  }
}

try { process.exitCode = await main(); } catch (error) {
  process.stderr.write(error instanceof PersonalError ? `[ruukoto:personal] 真实模型验收未通过：${error.code}；未输出配置或凭据。\n` : "[ruukoto:personal] 真实模型验收未通过，请检查目标配置、网络和后台状态；未输出配置或凭据。\n");
  process.exitCode = 1;
}
