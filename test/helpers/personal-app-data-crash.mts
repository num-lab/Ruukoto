import { openPersonalHarness } from "../../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../../apps/ruukoto/src/personal-model.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const [directory, baseUrl, phase] = process.argv.slice(2);
if (!directory || !baseUrl) throw new Error("缺少测试档案或模型替身地址");
const p = await openPersonalHarness({ directory, modelId: "app-data-model", provider: personalProvider({ api: "openai-completions", baseUrl, modelId: "app-data-model", apiKeyEnv: "APP_DATA_TEST_KEY", contextWindow: 128000, maxTokens: 2048 }), openStorage: async file => {
  const storage = await openNodeSqliteStorage(file), commit = storage.commit.bind(storage);
  storage.commit = (writes, context) => {
    if (phase === "initialize" && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.app-data-binding")) return commit(writes, context).then(result => { process.kill(process.pid, "SIGKILL"); return result; });
    if (writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.app-data-observation" && write.value.data && typeof write.value.data === "object" && !Array.isArray(write.value.data) && write.value.data.result && typeof write.value.data.result === "object" && !Array.isArray(write.value.data.result) && write.value.data.result.effect === "committed")) process.kill(process.pid, "SIGKILL");
    return commit(writes, context);
  };
  return storage;
} });
await p.answer("强杀窗口插入", "crash-source");
throw new Error("未触发预期强杀窗口");
