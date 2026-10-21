import * as fs from "node:fs";
import * as path from "node:path";
import { product } from "../../apps/ruukoto-code/src/product.ts";
import { afterTool, realTools, startTestRuntime, waitFor } from "./testkit.ts";

let command = "";
const t = await startTestRuntime("background-crash", request => afterTool(request) ? { kind: "text", text: "已启动" }
  : { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command } }] }, { workDirs: 1, config: { ...realTools(), product: product.runtime } });
const session = await t.runtime.createSession({ projectName: "crash", cwd: t.work[0], mode: "full_access" });
const script = `require('node:fs').appendFileSync(${JSON.stringify(path.join(t.work[0], "launches"))},'x');setInterval(()=>process.stdout.write('beat\\n'),100)`;
command = `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`;
const task = await t.runtime.submit({ sessionId: session.id, requestId: "start", input: "启动", modelSelection: t.runtime.defaultSelection });
await waitFor("后台完成交接", () => t.runtime.store.getTask(task.id)!.status === "completed" && fs.existsSync(path.join(t.work[0], "launches")), 30_000);
const processId = t.runtime.listBackgroundProcesses(session.id).processes[0].id;
process.stdout.write(JSON.stringify({ ...t.dirs, work: t.work[0], processId }) + "\n");
setInterval(() => {}, 1000);
