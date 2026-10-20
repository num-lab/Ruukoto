import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { product } from "../../../../apps/ruukoto-code/src/product.ts";
import { MockModelServer } from "../../../../test/helpers/mock-provider.ts";
import { waitFor, writeModelsJson } from "../../../../test/helpers/testkit.ts";

const [phase, root] = process.argv.slice(2);
assert.ok((phase === "seed" || phase === "check") && root && path.isAbsolute(root));
const dirs = { root, dataDir: path.join(root, "data"), agentDir: path.join(root, "agent") };
const cwd = path.join(root, "work");
const snapshotFile = path.join(root, "snapshot.json");
const historyFile = path.join(root, "history.before.jsonl");
for (const dir of [dirs.dataDir, dirs.agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
const server = new MockModelServer(req => {
  if (phase === "check") assert.match(JSON.stringify(req.messages), /migration-baseline-history/);
  return { kind: "text", text: phase === "seed" ? "migration-baseline-history" : "migration-current-continued" };
});
await writeModelsJson(dirs, await server.start());
let runtime: Runtime | undefined;
try {
  runtime = await Runtime.start({ product: product.runtime, dataDir: dirs.dataDir, agentDir: dirs.agentDir,
    socketPath: path.join(root, "c.sock"), modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off" });
  const rt = runtime;
  if (phase === "seed") {
    const session = await rt.createSession({ projectName: "coding-before-migration", cwd });
    const task = await rt.submit({ sessionId: session.id, requestId: "before-migration", input: "保留原有编码会话", modelSelection: rt.defaultSelection });
    await waitFor("基点任务完成", () => rt.store.getTask(task.id)!.status === "completed");
    const sessionFile = rt.store.getSession(session.id)!.sessionFile!;
    const artifacts = rt.store.listArtifactsByTask(task.id).map(item => ({ id: item.id,
      bytes: fs.readFileSync(path.join(dirs.dataDir, "artifacts", `${item.id}.bin`)).toString("base64") }));
    assert.ok(artifacts.length > 0);
    fs.copyFileSync(sessionFile, historyFile);
    await rt.stop("format_seed"); runtime = undefined;
    const db = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
    try {
      fs.writeFileSync(snapshotFile, JSON.stringify({ sessionId: session.id, taskId: task.id, sessionFile, artifacts,
        schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
        meta: db.prepare("SELECT * FROM meta WHERE key = 'schema_version'").all(),
        task: db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) }, null, 2) + "\n");
    } finally { db.close(); }
  } else {
    const before = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    const db = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all())), before.schema);
      assert.deepEqual(JSON.parse(JSON.stringify(db.prepare("SELECT * FROM meta WHERE key = 'schema_version'").all())), before.meta);
      assert.deepEqual(JSON.parse(JSON.stringify(db.prepare("SELECT * FROM tasks WHERE id = ?").get(before.taskId))), before.task);
    } finally { db.close(); }
    const history = fs.readFileSync(historyFile);
    assert.deepEqual(fs.readFileSync(before.sessionFile), history);
    for (const artifact of before.artifacts) assert.equal(fs.readFileSync(path.join(dirs.dataDir, "artifacts", `${artifact.id}.bin`)).toString("base64"), artifact.bytes);
    assert.equal(rt.readTaskReplyText(before.taskId), "migration-baseline-history");
    assert.equal(server.calls.length, 0);
    const task = await rt.submit({ sessionId: before.sessionId, requestId: "after-migration", input: "继续原有编码会话", modelSelection: rt.defaultSelection });
    await waitFor("当前版本继续旧会话", () => rt.store.getTask(task.id)!.status === "completed");
    assert.equal(rt.readTaskReplyText(task.id), "migration-current-continued");
    assert.deepEqual(fs.readFileSync(before.sessionFile).subarray(0, history.length), history);
    assert.equal(server.calls.length, 1);
    await rt.stop("format_check"); runtime = undefined;
  }
  process.stdout.write(JSON.stringify({ phase, schemaVersion: SCHEMA_VERSION, history: "preserved", replayed: false }) + "\n");
} finally { await runtime?.stop("format_probe_end"); await server.close(); }
