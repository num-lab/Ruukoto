import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { savePersonalConfig } from "../../apps/ruukoto/src/personal-config.ts";
import { parsePersonalModel } from "../../apps/ruukoto/src/personal-model.ts";
import { personalControl, startPersonalServer, type PersonalInputStatus } from "../../apps/ruukoto/src/personal-control.ts";
import { readPersonalSettings, savePersonalSettings } from "../../apps/ruukoto/src/personal-settings.ts";

type SourceProvider = { api?: string; baseUrl: string; apiKey?: string; headers?: Record<string, string>; models: { id: string; api?: string; contextWindow?: number; maxTokens?: number }[] };
async function until<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) { const value = await read(); if (value !== undefined) return value; assert.ok(Date.now() < deadline, "配置在线验收超时"); await delay(100); }
}
let stage = "setup";
async function main(): Promise<number> {
  const source = process.env.RUN_PERSONAL_MODELS_FILE, requested = process.env.RUN_PERSONAL_MODEL;
  if (process.env.RUN_MODEL_CHECK !== "1" || !source || !requested) { process.stderr.write("[ruukoto:configuration] 需要显式模型开关、配置文件与模型选择；未发送请求。\n"); return 2; }
  const raw = JSON.parse(fs.readFileSync(source, "utf8")) as { providers: Record<string, SourceProvider> };
  const candidates = Object.entries(raw.providers).flatMap(([providerId, provider]) => provider.models.filter(model => `${providerId}/${model.id}` === requested).map(model => ({ provider, model })));
  assert.equal(candidates.length, 1, "所选模型必须唯一");
  const { provider, model } = candidates[0];
  assert.ok(provider.apiKey && !provider.apiKey.startsWith("!"), "此验收不执行凭据命令");
  assert.equal(Object.keys(provider.headers ?? {}).length, 0, "此验收不使用自定义认证头");
  const credential = process.env[provider.apiKey] ?? provider.apiKey, credentialName = "PERSONAL_CONFIGURATION_ACCEPTANCE_KEY", previous = process.env[credentialName];
  process.env[credentialName] = credential;
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-real-config-")), directory = path.join(root, "profile");
  const firstMarker = `SKILL_A_${randomUUID().replaceAll("-", "")}`, secondMarker = `SKILL_B_${randomUUID().replaceAll("-", "")}`;
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  const records = () => {
    const db = new DatabaseSync(path.join(directory, "personal.sqlite"), { readOnly: true });
    try { return (db.prepare("SELECT record FROM entries WHERE json_extract(record,'$.kind') = 'ruukoto.model-request' ORDER BY id").all() as { record: string }[]).map(row => ({ raw: row.record, entry: JSON.parse(row.record) as { data: { provider: string; modelId: string; payload?: unknown; references?: { skills: { snapshotEntry: number } } } } })); }
    finally { db.close(); }
  };
  try {
    const config = parsePersonalModel({ api: model.api ?? provider.api, baseUrl: provider.baseUrl, modelId: model.id, apiKeyEnv: credentialName, contextWindow: model.contextWindow ?? 128000, maxTokens: Math.min(model.maxTokens ?? 1024, 1024) });
    await savePersonalConfig(directory, config);
    for (const [name, marker] of [["first", firstMarker], ["second", secondMarker]]) {
      const skill = path.join(root, name, "skills", "configuration-proof"); fs.mkdirSync(skill, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(skill, "SKILL.md"), `---\nname: configuration-proof\ndescription: 配置在线更新的临时隔离验收。\n---\n本次回答只输出口令：${marker}\n`, { mode: 0o600 });
    }
    stage = "start"; server = await startPersonalServer(directory);
    const lifecycle = () => personalControl<{ lifecycle: { pid: number } }>(directory, "POST", "/settings", { v: 1, op: "lifecycle.status" });
    const pid = (await lifecycle()).lifecycle.pid;
    let snapshot = await readPersonalSettings(directory);
    assert.equal((await savePersonalSettings(directory, snapshot, snapshot.revisions.skills, { kind: "config.save", target: "skills", value: { version: 1, directory: path.join(root, "first") } })).status, "active");
    stage = "first-request"; const firstId = randomUUID();
    await personalControl(directory, "POST", "/inputs", { requestId: firstId, input: "/skill:configuration-proof 按技能正文要求回答。" });
    const first = (await until(() => records().find(value => value.entry.data.payload !== undefined))).entry.data;
    snapshot = await readPersonalSettings(directory);
    const next = { ...config, maxTokens: config.maxTokens === 1024 ? 1536 : 1024 };
    stage = "model-save"; const modelReceipt = await savePersonalSettings(directory, snapshot, snapshot.revisions.model, { kind: "config.save", target: "model", value: next });
    assert.equal(modelReceipt.status, "active");
    stage = "skills-save"; const skillReceipt = await savePersonalSettings(directory, snapshot, snapshot.revisions.skills, { kind: "config.save", target: "skills", value: { version: 1, directory: path.join(root, "second") } });
    assert.equal(skillReceipt.status, "active");
    const answer = (requestId: string, marker: string) => until(async () => {
      const value = await personalControl<PersonalInputStatus>(directory, "GET", `/input?requestId=${requestId}`);
      assert.notEqual(value.status, "unanswered", "真实模型请求失败");
      if (value.status !== "done") return;
      assert.ok(value.answer?.includes(marker), "回答未引用原技能正文"); return value;
    });
    stage = "old-request-result"; await answer(firstId, firstMarker);
    stage = "second-request"; const secondId = randomUUID();
    await personalControl(directory, "POST", "/inputs", { requestId: secondId, input: "/skill:configuration-proof 按本次技能正文要求回答，历史口令不用于本轮。" });
    stage = "second-request-result"; await answer(secondId, secondMarker);
    const second = records().filter(value => value.entry.data.payload !== undefined).at(-1)!.entry.data;
    stage = "version-evidence"; assert.notEqual(first.provider, second.provider); assert.notEqual(first.references?.skills.snapshotEntry, second.references?.skills.snapshotEntry);
    assert.equal((await lifecycle()).lifecycle.pid, pid);
    stage = "restart"; await server.stop(); server = undefined;
    server = await startPersonalServer(directory);
    stage = "cold-request"; const thirdId = randomUUID();
    await personalControl(directory, "POST", "/inputs", { requestId: thirdId, input: "/skill:configuration-proof 按当前技能正文只输出口令。" });
    await answer(thirdId, secondMarker);
    assert.equal(records().filter(value => value.entry.data.payload !== undefined).at(-1)!.entry.data.provider, second.provider);
    assert.ok(records().every(value => !value.raw.includes(credential)), "请求证据不得包含认证值");
    process.stdout.write(`真实配置在线更新通过：${requested}；同PID、旧/新Skills正文、独立provider版本及冷恢复，3次拥有者输入；无IM。\n`);
    return 0;
  } finally {
    await server?.stop(); fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous;
  }
}
try { process.exitCode = await main(); }
catch (error) { process.stderr.write(`[ruukoto:configuration] 真实模型配置验收未通过（${stage}）：${error instanceof Error && "code" in error ? String(error.code) : "assertion_or_environment"}${error instanceof assert.AssertionError ? `；${error.message.slice(0, 240)}` : ""}；未输出配置或凭据。\n`); process.exitCode = 1; }
