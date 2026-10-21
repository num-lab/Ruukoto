import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = "/tmp/ruukoto-personal-04.YNFVXZ7o", loader = "/tmp/ruukoto-file-search-linux.kKxATk/repo/node_modules/tsx/dist/loader.mjs";
const output = path.dirname(fileURLToPath(import.meta.url));
const modelsFile = process.argv[2]; assert.ok(modelsFile, "请传入拥有者指定的models.json路径");
const raw = JSON.parse(fs.readFileSync(modelsFile, "utf8")), provider = raw.providers?.deepseek, selected = provider?.models?.find(value => value.id === "deepseek-flash"); assert.ok(selected, "未找到deepseek/deepseek-flash");
const model = { api: selected.api ?? provider.api, baseUrl: provider.baseUrl, modelId: selected.id, apiKeyEnv: "PERSONAL_IM_ACCEPTANCE_MODEL_KEY", contextWindow: selected.contextWindow ?? 128000, maxTokens: Math.min(selected.maxTokens ?? 4096, 4096) };
const program = `
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { lockPersonalProfile } from ${JSON.stringify(repository + "/apps/ruukoto/src/personal-profile.ts")};
import { savePersonalConfig } from ${JSON.stringify(repository + "/apps/ruukoto/src/personal-config.ts")};
import { savePersonalTools } from ${JSON.stringify(repository + "/apps/ruukoto/src/personal-tools-config.ts")};
import { savePersonalCommands } from ${JSON.stringify(repository + "/apps/ruukoto/src/personal-command-config.ts")};
assert.equal(process.platform, "linux");
const model = ${JSON.stringify(model)}, root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-personal-im-prep-"))), profile = path.join(root, "profile"), files = path.join(root, "files"), commands = path.join(root, "commands");
fs.chmodSync(root, 0o700); fs.mkdirSync(files, { mode: 0o700 }); fs.mkdirSync(commands, { mode: 0o700 });
const fileStat = fs.statSync(files), commandStat = fs.statSync(commands), lock = lockPersonalProfile(profile);
try {
  await savePersonalConfig(lock, model);
  await savePersonalTools(lock, { version: 1, generation: randomUUID(), workspace: files, identity: { dev: fileStat.dev, ino: fileStat.ino }, credentials: [] });
  await savePersonalCommands(lock, { version: 1, workspace: commands, identity: { dev: commandStat.dev, ino: commandStat.ino }, machineId: fs.readFileSync("/etc/machine-id", "utf8").trim(), tmpdir: fs.realpathSync(tmpdir()) });
} finally { lock.release(); }
const names = fs.readdirSync(profile); for (const absent of ["telegram.json", "qq.json", "personal.sqlite", "control.sock", "control.token", "backend.log"]) assert.ok(!names.includes(absent), "出现非预期入口或运行状态：" + absent);
const sources = ["personal-profile.ts", "personal-config.ts", "personal-model.ts", "personal-tools-config.ts", "personal-command-config.ts", "personal-cli.ts", "personal-qq-cli.ts"].map(name => "apps/ruukoto/src/" + name);
const result = { preparedAt: new Date().toISOString(), root, profile, files, commands, model, credentialTransferred: false, backendStarted: false, realImConnected: false, telegramConfigured: false, qqConfigured: false, filesCreated: names.map(name => ({ name, mode: (fs.statSync(path.join(profile, name)).mode & 0o777).toString(8) })), sourceSha256: Object.fromEntries(sources.map(name => [name, createHash("sha256").update(fs.readFileSync(path.join(${JSON.stringify(repository)}, name))).digest("hex")])), existingEntryMetadata: { environmentNames: Object.keys(process.env).filter(name => /(TELEGRAM|ONEBOT|NAPCAT|(^|_)QQ(_|$))/.test(name)), defaultProfiles: [".ruukoto-durable", ".ruukoto-durable-dev"].map(name => ({ name, exists: fs.existsSync(path.join(homedir(), name)), telegramConfigExists: fs.existsSync(path.join(homedir(), name, "telegram.json")), qqConfigExists: fs.existsSync(path.join(homedir(), name, "qq.json")) })) }, cli: { menu: "RUUKOTO_PERSONAL_DIR=" + profile + " node --import " + ${JSON.stringify(loader)} + " " + ${JSON.stringify(repository + "/apps/ruukoto/src/personal-entry.ts")}, serve: "RUUKOTO_PERSONAL_DIR=" + profile + " node --import " + ${JSON.stringify(loader)} + " " + ${JSON.stringify(repository + "/apps/ruukoto/src/personal-entry.ts")} + " serve" } };
process.stdout.write(JSON.stringify(result) + "\\n");
`;
const remote = spawn("ssh", ["tx", "node", "--import", loader, "--input-type=module", "-"], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = ""; remote.stdout.setEncoding("utf8"); remote.stderr.setEncoding("utf8"); remote.stdout.on("data", value => { stdout += value; }); remote.stderr.on("data", value => { stderr += value; }); remote.stdin.end(program);
const code = await new Promise((resolve, reject) => { remote.once("error", reject); remote.once("close", resolve); });
assert.equal(code, 0, "远端准备失败；请检查隔离目录和源码依赖");
const result = JSON.parse(stdout.trim()); assert.equal(result.credentialTransferred, false); assert.equal(result.backendStarted, false); assert.equal(result.realImConnected, false);
fs.writeFileSync(path.join(output, "prepared.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
if (stderr.trim()) fs.writeFileSync(path.join(output, "prepare-diagnostics.txt"), stderr, { mode: 0o600 });
process.stdout.write(JSON.stringify({ prepared: true, profile: result.profile, files: result.files, commands: result.commands, realImConnected: false, evidence: path.join(output, "prepared.json") }) + "\n");
