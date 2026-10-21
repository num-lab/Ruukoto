import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const remoteRoot = "/tmp/ruukoto-personal-04.YNFVXZ7o", loader = "/tmp/ruukoto-file-search-linux.kKxATk/repo/node_modules/tsx/dist/loader.mjs";
const relative = ".scratch/agent-tool-completion/evidence/personal-background-model", directory = path.dirname(fileURLToPath(import.meta.url));
let credential = "";
const safe = value => String(value).replaceAll(credential || "\0", "[REDACTED]");
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function child(program, args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(program, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }); let stdout = "", stderr = "";
    process.stdout.setEncoding("utf8"); process.stderr.setEncoding("utf8"); process.stdout.on("data", value => { stdout += value; }); process.stderr.on("data", value => { stderr += value; });
    process.once("error", reject); process.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (input !== undefined) { process.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); }); process.stdin.end(input); }
  });
}

try {
  assert.equal(process.env.RUN_MODEL_CHECK, "1", "真实模型验收需要RUN_MODEL_CHECK=1");
  const modelsFile = process.argv[2] ?? process.env.RUN_PERSONAL_MODELS_FILE; assert.ok(modelsFile, "请传入拥有者指定的models.json路径");
  const raw = JSON.parse(fs.readFileSync(modelsFile, "utf8")), provider = raw.providers?.deepseek;
  assert.ok(object(provider) && Array.isArray(provider.models), "未找到deepseek提供商");
  const selected = provider.models.find(value => object(value) && value.id === "deepseek-flash"); assert.ok(selected, "未找到deepseek/deepseek-flash");
  assert.ok(typeof provider.apiKey === "string" && provider.apiKey.length > 0 && !provider.apiKey.startsWith("!"), "凭据必须是环境变量名或已有字面值"); assert.ok(!provider.headers || object(provider.headers) && Object.keys(provider.headers).length === 0, "此验收不支持额外凭据头");
  credential = process.env[provider.apiKey] ?? provider.apiKey; assert.ok(credential.length >= 16, "模型凭据不可用");
  const model = { api: selected.api ?? provider.api, baseUrl: provider.baseUrl, modelId: selected.id, contextWindow: selected.contextWindow ?? 128000, maxTokens: Math.min(selected.maxTokens ?? 4096, 4096) };
  assert.ok(["openai-completions", "openai-responses", "anthropic-messages"].includes(model.api)); assert.equal(typeof model.baseUrl, "string"); assert.ok(Number.isSafeInteger(model.contextWindow) && model.contextWindow >= 1024 && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 && model.maxTokens < model.contextWindow);
  const address = new URL(model.baseUrl); assert.equal(address.protocol, "https:"); assert.ok(!address.username && !address.password && !address.search && !address.hash);
  const remote = await child("ssh", ["tx", "env", "RUN_MODEL_CHECK=1", "node", "--import", loader, `${remoteRoot}/${relative}/remote-probe.mts`], JSON.stringify({ model, credential }) + "\n");
  let summary; try { summary = JSON.parse(remote.stdout.trim()); } catch { throw new Error(`远程probe未返回摘要：${safe(remote.stderr).slice(-2000)}`); }
  assert.ok(object(summary) && typeof summary.evidenceRelative === "string" && /^runs\/[0-9TZ.\-]+-[a-f0-9]{8}$/.test(summary.evidenceRelative), "远程证据路径不符"); assert.ok(!remote.stdout.includes(credential), "远程摘要包含凭据，已拒绝保存");
  fs.mkdirSync(path.join(directory, "runs"), { recursive: true, mode: 0o700 });
  const copied = await child("scp", ["-r", `tx:${remoteRoot}/${relative}/${summary.evidenceRelative}`, path.join(directory, "runs")]);
  assert.equal(copied.code, 0, `证据取回失败：${safe(copied.stderr).slice(-2000)}`);
  process.stdout.write(JSON.stringify({ ...summary, evidence: path.join(directory, summary.evidenceRelative), remoteExitCode: remote.code, evidenceCopied: true }) + "\n");
  if (remote.stderr.trim()) process.stderr.write(safe(remote.stderr));
  if (remote.code !== 0 || !summary.passed) process.exitCode = 1;
} catch (error) { process.stderr.write(`[ruukoto:acceptance] ${safe(error instanceof Error ? error.message : error)}\n`); process.exitCode = 1; }
