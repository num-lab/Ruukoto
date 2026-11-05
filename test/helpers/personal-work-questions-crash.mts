import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness } from "../../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../../apps/ruukoto/src/personal-model.ts";
import { answerPersonalQuestion, PersonalQuestionDoc, PersonalQuestionsDoc } from "../../apps/ruukoto/src/personal-questions.ts";
import { PersonalPermissionsDoc } from "../../apps/ruukoto/src/personal-permissions.ts";
import type { PersonalToolsConfig } from "../../apps/ruukoto/src/personal-tools-config.ts";

const context = BACKGROUND_CONTEXT;
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { directory: string; config: PersonalModelConfig; tools: PersonalToolsConfig; phase: "question" | "answer" | "return" | "result"; requestId: string };
const p = await openPersonalHarness({ directory: value.directory, provider: personalProvider(value.config), modelId: value.config.modelId, tools: value.tools, openStorage: async filename => {
  const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
  storage.commit = async (writes, callContext) => {
    const kill = writes.some(write => write.type === "entry" && (write.value.kind === (value.phase === "question" ? "ruukoto.question-admission" : value.phase === "answer" ? "ruukoto.question-answer-admission" : "ruukoto.work-question-return") && value.phase !== "result" || value.phase === "result" && write.value.model?.some(message => message.role === "toolResult" && message.toolName === "ask_user")));
    const result = await commit(writes, callContext);
    if (kill) process.kill(process.pid, "SIGKILL");
    return result;
  };
  return storage;
} });
await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
await p.answer("拥有者来源", "owner-crash");
const ref = await p.work.delegate({ requestId: "crash", content: "crash question", sourceRequestId: "owner-crash" });
let id: string | undefined;
while (!id) { id = (await p.harness.snapshot(PersonalQuestionsDoc, context))?.ids[0]; if (!id) await delay(5); }
const q = (await p.harness.snapshot(PersonalQuestionDoc, id, context))!.question!;
await p.harness.commit(tx => answerPersonalQuestion(tx, { question: q.id, version: q.version, requestId: value.requestId, answers: [{ text: "甲" }] }, { kind: "local" }), context);
p.harness.resume(); await p.harness.waitForTask(ref.taskId, context);
throw new Error("Expected committed work-question boundary did not kill the process");
