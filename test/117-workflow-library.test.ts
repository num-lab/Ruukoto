import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { WORKFLOW_LIMITS, getWorkflowDefinition } from "@ruukoto/core/workflow.ts";
import { WorkflowLibrary } from "@ruukoto/runtime/workflow-library.ts";
import { validateWorkflowScript } from "@ruukoto/agent/script-worker/validate.ts";

function kit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-library-"));
  const data = path.join(root, "data"), agent = path.join(root, "agent");
  fs.mkdirSync(data); fs.mkdirSync(agent);
  const db = new Db(data), store = new Store(db), library = new WorkflowLibrary(store, agent);
  return { root, data, agent, db, store, library, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("命名定义保存历史与原键回执；后来的文件更新不会被重放覆盖", async () => {
  const k = kit();
  try {
    const first = await k.library.save({ name: "batch", script: "return input;\n", expectedDigest: null, requestKey: "save-1" });
    const second = await k.library.save({ name: "batch", script: "return {new:true};\n", expectedDigest: first.digest, requestKey: "save-2" });
    assert.notEqual(first.id, second.id);
    assert.equal(getWorkflowDefinition(k.store, first.id)!.script, first.script);
    assert.equal((await k.library.save({ name: "batch", script: first.script, expectedDigest: null, requestKey: "save-1" })).id, first.id);
    assert.equal((await k.library.load("batch")).id, second.id);
    await assert.rejects(k.library.save({ name: "batch", script: "return 3;", expectedDigest: null, requestKey: "save-3" }), { code: "definition_version_conflict" });
    await assert.rejects(k.library.save({ name: "other", script: first.script, expectedDigest: null, requestKey: "save-1" }), { code: "request_conflict" });
    assert.equal(fs.existsSync(path.join(k.agent, "workflows", "other.js")), false);
    fs.writeFileSync(path.join(k.agent, "workflows", "batch.js"), "return 4;\n");
    const manual = await k.library.load("batch");
    assert.notEqual(manual.id, second.id);
    assert.equal(k.library.versions("batch").length, 3);
    assert.equal((await k.library.list()).definitions[0].digest, manual.digest);
    fs.unlinkSync(path.join(k.agent, "workflows", "batch.js"));
    assert.equal(k.library.version(first.id).script, first.script);
    await assert.rejects(k.library.load("batch"), { code: "definition_missing" });
    assert.equal(k.library.saved("save-2")!.id, second.id);
  } finally { k.close(); }
});

test("路径、符号链接、非普通文件、UTF-8、大小和语法都明确拒绝，不回退缓存版本", async () => {
  const k = kit();
  try {
    assert.deepEqual((await k.library.list()).definitions, []);
    const first = await k.library.save({ name: "safe", script: "return 1;", expectedDigest: null, requestKey: "safe" });
    for (const name of ["../escape", "/tmp/outside", "a/b", "a\\b", "..", "", "name.js"]) {
      await assert.rejects(k.library.save({ name, script: "return 2;", expectedDigest: null, requestKey: "unsafe" }), { code: "invalid_definition_name" });
    }
    assert.equal(fs.existsSync(path.join(k.agent, "escape.js")), false);
    const root = path.join(k.agent, "workflows"), file = path.join(root, "safe.js");
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
    await assert.rejects(k.library.load("safe"), { code: "definition_invalid_utf8" });
    assert.equal(k.library.version(first.id).script, "return 1;");
    fs.writeFileSync(file, "return (;");
    await assert.rejects(k.library.load("safe"), { code: "invalid_script_syntax" });
    assert.equal((await k.library.list()).definitions[0].error, "invalid_script_syntax");
    fs.writeFileSync(file, " ".repeat(WORKFLOW_LIMITS.scriptBytes + 1));
    await assert.rejects(k.library.load("safe"), { code: "invalid_script" });
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    await assert.rejects(k.library.load("safe"), { code: "definition_path_unsafe" });
    fs.rmdirSync(file);
    const outside = path.join(k.root, "outside.js");
    fs.writeFileSync(outside, "return 'PRIVATE';");
    fs.symlinkSync(outside, file);
    await assert.rejects(k.library.load("safe"), { code: "definition_path_unsafe" });
    await assert.rejects(k.library.save({ name: "safe", script: "return 2;", expectedDigest: first.digest, requestKey: "link" }), { code: "definition_path_unsafe" });
    assert.equal(fs.readFileSync(outside, "utf8"), "return 'PRIVATE';");
    fs.unlinkSync(file); fs.rmdirSync(root); fs.symlinkSync(k.root, root);
    await assert.rejects(k.library.list(), { code: "definition_path_unsafe" });
    await assert.rejects(k.library.save({ name: "outside", script: "return 2;", expectedDigest: null, requestKey: "root-link" }), { code: "definition_path_unsafe" });
    assert.equal(fs.readFileSync(outside, "utf8"), "return 'PRIVATE';");
  } finally { k.close(); }
});

test("QuickJS 校验只编译真实包装，死循环和宿主调用不执行；校验期间文件改变不登记", async () => {
  const k = kit();
  try {
    await validateWorkflowScript('while (true) {} await agent("never",{request:"不得执行"}); return input;');
    assert.equal((k.store.db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n, 0);
    await assert.rejects(validateWorkflowScript("\ud800"), { code: "invalid_script" });
    await assert.rejects(validateWorkflowScript("return (;"), { code: "invalid_script_syntax" });
    const deep = "return " + "(".repeat(30000) + "1" + ")".repeat(30000) + ";";
    assert.ok(Buffer.byteLength(deep) < WORKFLOW_LIMITS.scriptBytes);
    await assert.rejects(validateWorkflowScript(deep), { code: "invalid_script_syntax" });
    await assert.rejects(k.library.save({ name: "deep", script: deep, expectedDigest: null, requestKey: "deep" }), { code: "invalid_script_syntax" });
    assert.equal(k.library.saved("deep"), null);
    assert.equal(fs.existsSync(path.join(k.agent, "workflows", "deep.js")), false);
    await validateWorkflowScript("return 1;");
    const version = await k.library.save({ name: "changing", script: "return 1;", expectedDigest: null, requestKey: "changing" });
    const pending = k.library.load("changing");
    fs.writeFileSync(path.join(k.agent, "workflows", "changing.js"), "return 2;");
    await assert.rejects(pending, { code: "definition_changed" });
    assert.deepEqual(k.library.versions("changing").map(item => item.id), [version.id]);
    await assert.rejects(k.library.save({ name: "canceled", script: "return 1;", expectedDigest: null, requestKey: "canceled" }, () => { throw new Error("来源取消"); }), /来源取消/);
    assert.equal(k.library.saved("canceled"), null);
    assert.equal(fs.existsSync(path.join(k.agent, "workflows", "canceled.js")), false);
  } finally { k.close(); }
});
