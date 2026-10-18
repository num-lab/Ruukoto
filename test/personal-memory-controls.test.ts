import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parsePersonalMemoryControl, managePersonalMemory, managePersonalHistory } from "../apps/ruukoto/src/personal-memory-controls.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, startPersonalServer, type PersonalInputStatus } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { setTimeout as delay } from "node:timers/promises";

test("记忆控制：wire拒绝伪造来源、版本、额外字段与内部请求标识", () => {
  const valid = { action: "create", requestId: randomUUID(), category: "preference", content: "简短答复", note: "拥有者确认" };
  assert.deepEqual(parsePersonalMemoryControl(valid), valid);
  for (const value of [{ ...valid, sources: [{ kind: "history", entry: 1 }] }, { ...valid, requestId: "manual" }, { ...valid, content: "" }, { ...valid, category: "fake" }, { action: "revoke", requestId: randomUUID(), memory: 1, expectedVersion: 0 }, { action: "revise", requestId: randomUUID(), memory: 1, expectedVersion: 1, content: "新内容" }]) assert.throws(() => parsePersonalMemoryControl(value), error => error instanceof PersonalError && error.code === "memory_input_invalid");
});

test("记忆控制：可信本机向导保存、读取、修订、撤销，历史检索不要求输入内部编号", { timeout: 15_000 }, async t => {
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk-memory-ui-")), model = new MockModelServer(() => ({ kind: "text", text: "原始回答" }));
  const apiKeyEnv = "MEMORY_UI_TEST_KEY", previous = process.env[apiKeyEnv]; process.env[apiKeyEnv] = "test-only";
  await savePersonalConfig(directory, { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv, contextWindow: 128000, maxTokens: 1024 });
  const server = await startPersonalServer(directory);
  t.after(async () => { await server.stop(); await model.close(); if (previous === undefined) delete process.env[apiKeyEnv]; else process.env[apiKeyEnv] = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const run = async (answers: string[], action: typeof managePersonalMemory) => { let output = ""; await action({ question: async () => { assert.ok(answers.length, output); return answers.shift()!; }, write: value => { output += value; } }, directory); assert.equal(answers.length, 0); return output; };
  assert.match(await run(["2", "1", "测试偏好", "本机拥有者确认", "2"], managePersonalMemory), /记忆已保存/);
  assert.equal(model.calls.length, 0);
  assert.match(await run(["1", "测试偏好", "1", "2", "修订偏好", "拥有者修订", "2", "1"], managePersonalMemory), /记忆修订已保存/);
  const id = randomUUID(); await personalControl(directory, "POST", "/inputs", { requestId: id, input: "历史唯一目标" });
  const deadline = Date.now() + 5000;
  while ((await personalControl<PersonalInputStatus>(directory, "GET", `/input?requestId=${id}`)).status !== "done") { assert.ok(Date.now() < deadline); await delay(10); }
  assert.match(await run(["历史唯一目标", "1", "2"], managePersonalHistory), /历史唯一目标/);
  assert.match(await run(["1", "修订偏好", "1", "3", "2", "2"], managePersonalMemory), /记忆已撤销/);
  const listed = await personalControl<{ items: { revoked: boolean }[] }>(directory, "GET", "/memories"); assert.equal(listed.items[0].revoked, true);
  assert.equal(model.calls.length, 1);
  assert.ok(fs.existsSync(path.join(directory, "personal.sqlite")));
});


test("记忆向导：来源不可用时跳过读取，仅撤销原版本", async t => {
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk-memory-repair-")), token = "a".repeat(64); fs.writeFileSync(path.join(directory, "control.token"), token + "\n", { mode: 0o600 });
  let revoked = false, reads = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.method === "GET" && req.url?.startsWith("/memories?")) res.end(JSON.stringify({ v: 1, ok: true, result: { items: [{ memory: 42, version: 3, category: "experience", revoked, text: "来源不可用的经验", sourceUnavailable: true }] } }));
    else if (req.method === "POST" && req.url === "/memory") {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = parsePersonalMemoryControl(JSON.parse(text)); assert.equal(body.action, "revoke"); assert.ok("memory" in body && body.memory === 42 && body.expectedVersion === 3); revoked = true; res.end(JSON.stringify({ v: 1, ok: true, result: { memory: 42, version: 4, revoked: true } }));
    } else { reads++; res.end(JSON.stringify({ v: 1, ok: false, code: "unexpected_read", message: "不应读取失效来源" })); }
  });
  server.listen(path.join(directory, "control.sock")); await once(server, "listening");
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  const answers = ["1", "", "1", "2", "2"]; let output = "";
  await managePersonalMemory({ question: async () => { assert.ok(answers.length, output); return answers.shift()!; }, write: text => { output += text; } }, directory);
  assert.match(output, /记忆已撤销/); assert.equal(revoked, true); assert.equal(reads, 0); assert.equal(answers.length, 0);
});
