import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../../../../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalModel, personalProvider } from "../../../../apps/ruukoto/src/personal-model.ts";
import { PersonalWorkDoc, personalWorkResult } from "../../../../apps/ruukoto/src/personal-work.ts";
import { personalReportResult } from "../../../../apps/ruukoto/src/personal-report.ts";
import { PersonalError } from "../../../../apps/ruukoto/src/personal-error.ts";

// 本探针只证明真实模型委派、身份复用、重启和本机报告；真实 IM、并发聊天、取消和外部效果另验。
const output = path.dirname(fileURLToPath(import.meta.url));
const context = BACKGROUND_CONTEXT;
const source = process.env.RUN_PERSONAL_MODELS_FILE;
const requested = process.env.RUN_PERSONAL_MODEL;
if (process.env.RUN_MODEL_CHECK !== "1" || !source || !requested) {
  process.stderr.write("[ruukoto:personal] 37 模型探针需要显式模型开关、配置文件和模型选择；未发请求。\n");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(source, "utf8")) as { providers: Record<string, { api: string; baseUrl: string; apiKey: string; headers?: Record<string, string>; models: { id: string; api?: string; contextWindow?: number; maxTokens?: number }[] }> };
const selected = Object.entries(raw.providers).flatMap(([id, provider]) => provider.models.filter(model => `${id}/${model.id}` === requested).map(model => ({ provider, model })));
assert.equal(selected.length, 1);
const { provider, model } = selected[0];
assert.ok(provider.apiKey && !provider.apiKey.startsWith("!") && !Object.keys(provider.headers ?? {}).length);
const credential = process.env[provider.apiKey] ?? provider.apiKey;
const credentialName = "PERSONAL_37_MODEL_KEY";
assert.equal(process.env[credentialName], undefined);
process.env[credentialName] = credential;
const config = parsePersonalModel({ api: model.api ?? provider.api, baseUrl: provider.baseUrl, modelId: model.id, apiKeyEnv: credentialName, contextWindow: model.contextWindow ?? 128000, maxTokens: Math.min(model.maxTokens ?? 4096, 4096) });
const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk37-model-"));
const marker = `LIVE37_${randomUUID().replaceAll("-", "")}`;
const result: Record<string, unknown> = { startedAt: new Date().toISOString(), model: requested, directory, marker, realModel: true, realIm: false, externalOperations: false, passed: false, stopped: false };
let personal: PersonalHarness | undefined;
const bounded = async <T>(operation: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("probe_timeout")), 120000); })]); }
  finally { clearTimeout(timer!); }
};
const open = async () => personal = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId });
try {
  let p = await open();
  result.firstAnswer = await bounded(p.answer(`这是隔离验收。请用 background_work 的 delegate 创建一个名为“37验收分析员”的后台分析，完整任务为“仅回复 ${marker}_FIRST，不调用工具”。本轮暂不安排report。登记成功后简短回复。`, `${marker}-first`));
  const firstTasks = await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 16), context);
  assert.equal(firstTasks.items.length, 1, "模型应恰好委派一项工作");
  const firstTask = firstTasks.items[0];
  const first = (await p.harness.snapshot(PersonalWorkDoc, String(firstTask.input.requestId), context))!.ref!;
  await bounded(p.harness.waitForTask(first.taskId, context));
  const firstResult = await p.harness.commit(tx => personalWorkResult(tx, first), context);
  assert.ok(firstResult.text?.includes(`${marker}_FIRST`), "子 Agent 必须实际完成第一项分析");
  result.firstWork = { ref: first, result: firstResult };
  await p.close(); personal = undefined;
  p = await open();
  result.secondAnswer = await bounded(p.answer(`继续隔离验收。请用 background_work 的 delegate 复用刚才名为“37验收分析员”的原身份（agent=${first.agentId}），新任务完整内容为“仅回复 ${marker}_SECOND，不调用工具”。这是新委托，不续派之前委托。登记后为这次新委托调用report安排最终汇总，然后结束本轮。`, `${marker}-second`));
  const secondTasks = await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 16), context);
  assert.equal(secondTasks.items.length, 2, "重启后应只增加一项工作");
  const secondTask = secondTasks.items.find(task => task.id !== first.taskId)!;
  const second = (await p.harness.snapshot(PersonalWorkDoc, String(secondTask.input.requestId), context))!.ref!;
  assert.equal(second.agentId, first.agentId, "模型应复用原子 Agent 身份");
  await bounded(p.harness.waitForTask(second.taskId, context));
  const secondResult = await p.harness.commit(tx => personalWorkResult(tx, second), context);
  assert.ok(secondResult.text?.includes(`${marker}_SECOND`));
  result.secondWork = { ref: second, result: secondResult };
  const reports = await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.delegation-report" }, 16), context);
  assert.equal(reports.items.length, 1, "模型应为新委托只登记一个汇总");
  const reportTask = reports.items[0];
  await bounded(p.harness.waitForTask(reportTask.id, context));
  const report = await p.harness.commit(tx => personalReportResult(tx, reportTask.input.delegation), context);
  assert.equal(report.delivery, "local");
  assert.ok(report.text?.includes(`${marker}_SECOND`));
  assert.equal((await p.work.list()).length, 1);
  result.report = report;
  await p.close(); personal = undefined;
  const database = new DatabaseSync(path.join(directory, "personal.sqlite"), { readOnly: true });
  try {
    const entries = database.prepare("SELECT record FROM entries").all().map(row => JSON.parse(String(row.record)));
    const evidence = entries.filter(entry => entry.kind === "ruukoto.model-request");
    const requests = [...new Set(evidence.map(entry => entry.data.requestId))];
    assert.ok(requests.length >= 6, "主/子/汇总须有真实模型请求");
    for (const request of requests) {
      const pair = evidence.filter(entry => entry.data.requestId === request);
      assert.equal(pair.length, 2);
      assert.ok(pair.some(entry => entry.data.payload));
      assert.ok(pair.some(entry => entry.data.input));
    }
    assert.ok(!JSON.stringify(entries).includes(credential), "证据不得含认证值");
    result.requestCount = requests.length;
    result.requestEvidenceEntries = evidence.length;
  } finally { database.close(); }
  const bytes = fs.readFileSync(path.join(directory, "personal.sqlite"));
  assert.ok(!bytes.includes(Buffer.from(credential)));
  fs.writeFileSync(path.join(output, "model-personal.sqlite.gz"), gzipSync(bytes), { mode: 0o600 });
  result.databaseSha256 = createHash("sha256").update(bytes).digest("hex");
  result.passed = true;
} catch (error) {
  result.error = error instanceof PersonalError ? { type: error.name, code: error.code } : { type: error instanceof Error ? error.name : "unknown" };
  process.exitCode = 1;
} finally {
  if (personal) {
    try { await personal.close(); personal = undefined; }
    catch (error) { result.cleanupError = error instanceof PersonalError ? error.code : "close_failed"; process.exitCode = 1; }
  }
  result.stopped = personal === undefined;
  delete process.env[credentialName];
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, "model-result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed: result.passed, stopped: result.stopped, requestCount: result.requestCount, error: result.error }) + "\n");
}
