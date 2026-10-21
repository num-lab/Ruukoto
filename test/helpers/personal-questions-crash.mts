import * as fs from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness } from "../../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../../apps/ruukoto/src/personal-model.ts";
import { answerPersonalQuestion } from "../../apps/ruukoto/src/personal-questions.ts";
import type { PersonalToolsConfig } from "../../apps/ruukoto/src/personal-tools-config.ts";

const [filename, phase] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(filename, "utf8")) as { directory: string; config: PersonalModelConfig; tools: PersonalToolsConfig; input: Parameters<typeof answerPersonalQuestion>[1] };
const p = await openPersonalHarness({ directory: value.directory, modelId: value.config.modelId, provider: personalProvider(value.config), tools: value.tools, openStorage: async file => {
  const storage = await openNodeSqliteStorage(file), commit = storage.commit.bind(storage);
  storage.commit = (writes, context) => {
    const stop = writes.some(write => write.type === "entry" && write.value.kind === (phase === "question" ? "ruukoto.question-admission" : phase === "answer" ? "ruukoto.question-answer-admission" : "ruukoto.question-answer"));
    return commit(writes, context).then(result => { if (stop) process.kill(process.pid, "SIGKILL"); return result; });
  };
  return storage;
} });
if (phase === "question") { await p.answer("发起提问", "original"); throw new Error("未触发预期的问题接纳窗口"); }
const receipt = await p.harness.commit(tx => answerPersonalQuestion(tx, value.input, { kind: "local" }), BACKGROUND_CONTEXT);
p.harness.resume();
await p.harness.waitForTask(receipt.taskId!, BACKGROUND_CONTEXT);
throw new Error("未触发预期的问题强杀窗口");
