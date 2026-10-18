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
import { savePersonalSkills } from "../../apps/ruukoto/src/personal-skills-config.ts";
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
  const skillDirectory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-real-skills-")));
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
    const marker = `PERSONAL_CHECK_${randomUUID().replaceAll("-", "")}`, skillMarker = `SKILL_CHECK_${randomUUID().replaceAll("-", "")}`;
    const skill = path.join(skillDirectory, "skills", "acceptance-reference"); fs.mkdirSync(skill, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(skill, "SKILL.md"), `---\nname: acceptance-reference\ndescription: 隔离验收技能，要求时加载并按正文回复。\n---\n本技能只供参考，不增加工具或权限。本次任务完成后的最终回答必须仅为：${skillMarker}\n`, { mode: 0o600 });
    await savePersonalSkills(directory, { version: 1, directory: skillDirectory });
    running = true;
    await launchPersonalServer(directory);
    const answer = async (message: string, expected = marker) => {
      const input = preparePersonalInput(directory, message);
      await personalControl(directory, "POST", "/inputs", input);
      let status: PersonalInputStatus = { status: "missing" };
      await waitUntil(async () => {
        status = await checkPersonalInput(directory, input);
        assert.notEqual(status.status, "unanswered", "真实模型未能完成回答");
        return status.status === "done";
      }, 120000);
      assert.ok(status.answer?.includes(expected), "回答没有包含本次隔离校验标记");
    };
    await answer(`请使用memory的create保存一条长期偏好，类别preference，正文是“个人隔离验收偏好标记：${marker}”。这是拥有者明确要求长期保存的偏好，来源用本轮输入即可。成功后只回复标记${marker}。`);
    const saved = await personalControl<{ items: { memory: number; version: number }[] }>(directory, "GET", `/memories?query=${marker}`);
    assert.equal(saved.items.length, 1, "真实模型必须已通过memory工具保存偏好");
    await stop();
    const beforeRestartDb = new DatabaseSync(path.join(directory, "personal.sqlite"), { readOnly: true });
    let beforeRestart: number;
    try { beforeRestart = Number((beforeRestartDb.prepare("SELECT max(json_extract(record, '$.id')) AS entry FROM entries").get() as { entry: number }).entry); } finally { beforeRestartDb.close(); }
    running = true;
    await launchPersonalServer(directory);
    await answer(`请使用memory的search查找“个人隔离验收偏好标记”，再用read读取匹配条目的完整正文，从正文取出校验标记并只回复标记。`);
    await answer("请使用skill加载acceptance-reference，按该技能正文要求完成本次回答。", skillMarker);
    await stop();
    const db = new DatabaseSync(path.join(directory, "personal.sqlite"), { readOnly: true });
    try {
      const entries = db.prepare("SELECT record FROM entries WHERE json_extract(record, '$.kind') = 'ruukoto.model-request'").all() as { record: string }[];
      assert.ok(entries.length >= 10 && entries.length % 2 === 0, "记忆保存/重启读取及技能加载须逐次保留两阶段请求证据");
      const records = entries.map(entry => JSON.parse(entry.record) as { id: number; data: { requestId: string; payload?: unknown; references?: { memory: { memory: number; version: number }[] } } });
      for (const id of new Set(records.map(entry => entry.data.requestId))) assert.equal(records.filter(entry => entry.data.requestId === id).length, 2, "同次请求应恰有规范输入和实际payload");
      assert.ok(records.some(entry => entry.id > beforeRestart && entry.data.references?.memory.some(item => item.memory === saved.items[0].memory && item.version === saved.items[0].version)), "重启后请求须引用已保存记忆版本");
      const history = (db.prepare("SELECT record FROM entries").all() as { record: string }[]).map(row => JSON.parse(row.record) as { id: number; byTaskId?: number; model?: { role: string; toolCallId?: string; toolName?: string; isError?: boolean; content: string | { type: string; id?: string; name?: string; arguments?: { action?: string }; text?: string }[] }[] });
      const tasks = (db.prepare("SELECT record FROM tasks WHERE json_extract(record, '$.kind') = 'pi.tool'").all() as { record: string }[]).map(row => JSON.parse(row.record) as { id: number; input: { assistant?: number; callId?: string } });
      const succeeded = tasks.flatMap(task => {
        const call = history.find(entry => entry.id === task.input.assistant)?.model?.flatMap(message => Array.isArray(message.content) ? message.content : []).find(part => part.type === "toolCall" && part.id === task.input.callId);
        const result = history.filter(entry => entry.byTaskId === task.id).flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult" && message.toolCallId === task.input.callId && !message.isError);
        return call && result ? [{ call, result, afterRestart: (task.input.assistant ?? 0) > beforeRestart }] : [];
      });
      for (const action of ["create", "search", "read"]) assert.ok(succeeded.some(({ call, result, afterRestart }) => {
        if (call.name !== "memory" || call.arguments?.action !== action || action !== "create" && !afterRestart) return false;
        const text = typeof result.content === "string" ? result.content : result.content.filter(part => part.type === "text").map(part => part.text).join("");
        const value = JSON.parse(text) as { memory?: number; items?: { memory: number }[] };
        return value.memory === saved.items[0].memory || value.items?.some(item => item.memory === saved.items[0].memory);
      }), `真实模型须成功执行memory.${action}并返回原记忆，查询和读取须发生在重启后`);
      assert.ok(succeeded.some(({ call, result }) => call.name === "skill" && JSON.stringify(result.content).includes(skillMarker)), "真实模型须成功加载技能正文");
      assert.ok(entries.every(entry => !entry.record.includes(credential)), "请求证据不应包含认证值");
    } finally { db.close(); }
    process.stdout.write(`真实个人模型往返、独立进程重启与上下文延续通过：${requested}；记忆保存、重启查阅与技能驱动共3次输入，请求及工具原文均已核实，无IM。\n`);
    return 0;
  } finally {
    try { await stop(); } finally {
      if (!running) { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(skillDirectory, { recursive: true, force: true }); }
      if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous;
    }
  }
}

try { process.exitCode = await main(); } catch (error) {
  process.stderr.write(error instanceof PersonalError ? `[ruukoto:personal] 真实模型验收未通过：${error.code}；未输出配置或凭据。\n` : "[ruukoto:personal] 真实模型验收未通过，请检查目标配置、网络和后台状态；未输出配置或凭据。\n");
  process.exitCode = 1;
}
