import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../../../../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../../../../apps/ruukoto/src/personal-model.ts";
import { PersonalSchedulesDoc, PersonalScheduleRunDoc } from "../../../../apps/ruukoto/src/personal-scheduler-records.ts";
import { MockModelServer } from "../../../../test/helpers/mock-provider.ts";

const directory = fs.mkdtempSync(path.join(tmpdir(), "rk34-inputs-")), server = new MockModelServer(() => ({ kind: "text", text: "完成" })), previous = process.env.APP_DATA_CAPTURE_KEY;
process.env.APP_DATA_CAPTURE_KEY = "offline-only";
const p = await openPersonalHarness({ directory, provider: personalProvider({ api: "openai-completions", baseUrl: await server.start(), modelId: "estimate-model", apiKeyEnv: "APP_DATA_CAPTURE_KEY", contextWindow: 128000, maxTokens: 1024 }), modelId: "estimate-model" });
try {
  await p.answer("离线验收输入", "estimate-source");
  for (const appData of [false, true]) { const ref = await p.work.delegate({ content: "独立离线验收", sourceRequestId: "estimate-source", requestId: `estimate-child-${appData}`, ...(appData ? { appData } : {}) }); await p.harness.waitForTask(ref.taskId, BACKGROUND_CONTEXT); }
  const plan = await p.harness.commit(tx => p.scheduler.create(tx, { requestId: "estimate-schedule", label: "离线计划", instruction: "离线定时验收", rule: { kind: "once", at: new Date(Date.now() - 1000).toISOString(), timeZone: "Asia/Tokyo" } }, { kind: "local", requestId: "estimate-schedule" }), BACKGROUND_CONTEXT);
  const end = Date.now() + 10000;
  while (true) { const ids = (await p.harness.snapshot(PersonalSchedulesDoc, BACKGROUND_CONTEXT))?.runs ?? []; let done = false; for (const id of ids) { const run = (await p.harness.snapshot(PersonalScheduleRunDoc, id, BACKGROUND_CONTEXT))?.run; if (run?.planId === plan.id && run.result) done = true; } if (done) break; assert.ok(Date.now() < end); await delay(10); }
  assert.equal(server.calls.length, 5);
  const kinds = ["main", "subagent", "subagent-app-data", "scheduled", "summary"], before = JSON.parse(fs.readFileSync(new URL("../33-memory-skills-history/after-requests.json", import.meta.url), "utf8")) as { messages: { role: string; content: string }[]; tools?: unknown[] }[];
  const after = server.calls.map(call => call.raw);
  fs.writeFileSync(new URL("after-requests.json", import.meta.url), JSON.stringify(after, null, 2) + "\n");
  const estimates = (records: typeof before, names: string[]) => records.map((request, i) => ({ kind: names[i], systemPrompt: Math.ceil(request.messages.filter(message => message.role === "system").map(message => message.content).join("\n").length / 4), toolSchemas: Math.ceil(JSON.stringify(request.tools ?? []).length / 4) }));
  fs.writeFileSync(new URL("estimates.json", import.meta.url), JSON.stringify({ method: "ceil(characters/4), actual offline OpenAI-compatible payload; empty memory/skills", baseline: "8bbcbc4; before payloads reused from committed 33-memory-skills-history/after-requests.json", before: estimates(before, ["main", "subagent", "scheduled", "summary"]), after: estimates(after, kinds) }, null, 2) + "\n");
  process.stdout.write("主、未授权子、已授权子、定时初轮及汇总5份实际请求快照通过。\n");
} finally { await p.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.APP_DATA_CAPTURE_KEY; else process.env.APP_DATA_CAPTURE_KEY = previous; }
