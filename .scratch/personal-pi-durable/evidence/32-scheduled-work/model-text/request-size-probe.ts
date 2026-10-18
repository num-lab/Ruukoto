import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalScheduleRunDoc, PersonalSchedulesDoc } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const artifact = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "ruukoto-32-request-size-"))), directory = path.join(artifact, "profile"), workspace = path.join(artifact, "workspace"); fs.mkdirSync(workspace);
const server = new MockModelServer(() => ({ kind: "text", text: "本次独立工作已完成。" }));
const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_SCHEDULE_SIZE_PROBE_KEY", contextWindow: 128000, maxTokens: 4096 };
process.env[config.apiKeyEnv] = "test-only";
const stat = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "schedule-size-probe", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
const p = await openPersonalHarness({ directory, modelId: config.modelId, provider: personalProvider(config), tools });
try {
  await p.answer("量测主聊天，不执行外部操作。", "size-probe-main");
  const instruction = "核对本轮说明并给出简短结果，不执行外部操作。", requestId = randomUUID();
  const plan = await p.harness.commit(tx => p.scheduler.create(tx, { requestId, label: "请求文本量测", instruction, rule: { kind: "once", at: new Date(Date.now() - 1000).toISOString(), timeZone: "Asia/Tokyo" } }, { kind: "local", requestId }), context);
  let runId: string | undefined;
  const end = Date.now() + 15000;
  while (true) {
    const index = await p.harness.snapshot(PersonalSchedulesDoc, context);
    for (const id of index?.runs ?? []) { const saved = await p.harness.snapshot(PersonalScheduleRunDoc, id, context); if (saved?.run?.planId === plan.id) runId = id; }
    if (runId && (await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))?.run?.result) break;
    assert.ok(Date.now() < end, "量测等待超时"); await delay(5);
  }
  assert.equal(server.calls.length, 3);
  const count = (s: string) => ({ chars: s.length, approximateTokens: Math.ceil(s.length / 4) });
  const report = server.calls.map((call, index) => {
    const raw = call.raw, stage = ["main", "scheduled", "summary"][index], definitions = call.tools ?? [], added = definitions.filter(tool => ["schedule_create", "schedule_query", "schedule_cancel"].includes(String((tool.function as { name?: string })?.name)));
    fs.writeFileSync(path.join(artifact, `${stage}-request.json`), JSON.stringify(raw, null, 2) + "\n");
    return { stage, input: count(JSON.stringify({ messages: raw.messages, tools: raw.tools })), wire: count(JSON.stringify(raw)), system: count(call.system ?? ""), messagesWithoutSystem: count(JSON.stringify(call.messages)), tools: count(JSON.stringify(definitions)), toolNames: definitions.map(tool => (tool.function as { name?: string }).name), lastUser: count(String(call.messages.filter(message => message.role === "user").at(-1)?.content ?? "")), addedSchemas: added.map(tool => ({ name: (tool.function as { name?: string }).name, ...count(JSON.stringify(tool)) })), addedSchemasArrayDelta: count(JSON.stringify(definitions).length ? "x".repeat(JSON.stringify(definitions).length - JSON.stringify(definitions.filter(tool => !added.includes(tool))).length) : "") };
  });
  fs.writeFileSync(path.join(artifact, "estimate.json"), JSON.stringify({ method: "UTF-16 JSON string.length / 4 rounded up; approximate input-token size only, not tokenizer or billing", artifact, report }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ artifact, report }, null, 2) + "\n");
} finally { await p.close(); await server.close(); delete process.env[config.apiKeyEnv]; }
