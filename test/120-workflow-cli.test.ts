import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { test } from "node:test";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { getWorkflowQuestion, listWorkflowRuns, rememberWorkflowDefinition, requireWorkflowRun, saveWorkflowDefinition } from "@ruukoto/core/workflow.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";

test("Coding CLI 实际进程保存、列出、带参运行、原键核实、查看阶段、回答与取消", async () => {
  const t = await startTestRuntime("workflow-cli", async () => ({ kind: "text", text: "FINAL" }), { config: { product: codeProduct.runtime, socketPath: undefined } });
  const cli = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ["node_modules/.bin/tsx", "apps/ruukoto-code/src/main.ts", "workflow", ...args], {
      cwd: process.cwd(), timeout: 15000,
      env: { ...process.env, RUUKOTO_OWNER_TOKEN: undefined, RUUKOTO_OWNER_TOKEN_FILE: undefined,
        RUUKOTO_CODE_DATA_DIR: t.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: t.dirs.agentDir, RUUKOTO_CODE_CONTROL_DIR: t.runtime.controlDir() },
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "cli", cwd: t.work[0] });
    const file = path.join(t.dirs.root, "script.js");
    fs.writeFileSync(file, 'await progress("phase",{text:input.text}); return await ask("q",{prompt:"选择"});\n');
    const saved = await cli(["save", "batch", "--script-file", file, "--request-id", "save"]);
    assert.equal(saved.code, 0, saved.stderr);
    const definition = JSON.parse(saved.stdout) as OpResult<"workflow_save">;
    assert.equal((await cli(["saved", "--request-id", "save"])).code, 0);
    const definitions = await cli(["definitions"]);
    assert.match(definitions.stdout, /batch/);
    const runArgs = ["run", "batch", "--session", session.id, "--request-id", "run", "--input-json", '{"text":"CLI  PHASE"}'];
    const started = await cli(runArgs);
    assert.equal(started.code, 0, started.stderr);
    const first = JSON.parse(started.stdout) as OpResult<"workflow_start">;
    assert.equal(first.run.displayName, "batch"); assert.equal(first.run.description, null);
    await waitFor("CLI 人工等待", () => requireWorkflowRun(rt.store, first.run.id).status === "waiting");
    assert.match((await cli(["logs", first.run.id])).stdout, /CLI  PHASE/);
    assert.match((await cli(["show", first.run.id])).stdout, /waiting/);
    const update = await cli(["save", "batch", "--script-file", file, "--request-id", "update", "--expected-digest", definition.digest]);
    assert.equal(update.code, 0, update.stderr);
    assert.equal((JSON.parse((await cli(runArgs)).stdout) as OpResult<"workflow_start">).run.id, first.run.id);
    assert.match((await cli(["find", "--session", session.id, "--request-id", "run"])).stdout, new RegExp(first.run.id));
    const q = getWorkflowQuestion(rt.store, first.run.id, "q")!;
    const answered = await cli(["answer", first.run.id, "q", "--request-id", "answer", "--run-version", String(q.runVersion), "--question-version", String(q.version), "--answer-json", '"yes"']);
    assert.equal(answered.code, 0, answered.stderr);
    await waitFor("CLI 业务回答完成", () => requireWorkflowRun(rt.store, first.run.id).status === "succeeded");
    const missingKey = await cli(["run", "batch", "--session", session.id]);
    assert.equal(missingKey.code, 1); assert.match(missingKey.stderr, /request-id/);
    assert.equal(listWorkflowRuns(rt.store).length, 1);
    const second = JSON.parse((await cli(["run", "batch", "--session", session.id, "--request-id", "second"])).stdout) as OpResult<"workflow_start">;
    await waitFor("第二项等待", () => requireWorkflowRun(rt.store, second.run.id).status === "waiting");
    const current = requireWorkflowRun(rt.store, second.run.id);
    const cancel = await cli(["cancel", current.id, "--expected-version", String(current.version), "--request-id", "cancel"]);
    assert.equal(cancel.code, 0, cancel.stderr); assert.match(cancel.stdout, /canceled/);
    rt.store.withTx(() => {
      for (let i = 0; i < 101; i++) rememberWorkflowDefinition(rt.store, "batch", saveWorkflowDefinition(rt.store, "return " + i + ";"));
    });
    const firstPage = JSON.parse((await cli(["definition", "batch", "--length", "1"])).stdout) as OpResult<"workflow_definition">;
    assert.equal(firstPage.versions.length, 100); assert.equal(firstPage.nextVersionOffset, 100);
    const nextPage = JSON.parse((await cli(["definition", "batch", "--length", "1", "--version-offset", "100"])).stdout) as OpResult<"workflow_definition">;
    assert.equal(nextPage.versions.length, 2); assert.equal(nextPage.nextVersionOffset, null);
    assert.equal(firstPage.text, nextPage.text);
    const missingTitle = await cli(["run", "--script-file", file, "--session", session.id, "--request-id", "temporary"]);
    assert.equal(missingTitle.code, 1); assert.match(missingTitle.stderr, /--title/);
    const temporary = await cli(["run", "--script-file", file, "--title", "临时核对", "--description", "等待确认", "--session", session.id, "--request-id", "temporary", "--input-json", '{"text":"TEMP"}']);
    assert.equal(temporary.code, 0, temporary.stderr);
    const temporaryRun = (JSON.parse(temporary.stdout) as OpResult<"workflow_start">).run;
    assert.equal(temporaryRun.displayName, "临时核对"); assert.equal(temporaryRun.description, "等待确认");
    assert.equal((await cli(["help"])).code, 0);
  } finally { await t.shutdown(); }
});
