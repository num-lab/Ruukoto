import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../../../../apps/ruukoto/src/personal-harness.ts";
import { parsePersonalModel, personalProvider } from "../../../../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../../../../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalPermissionsDoc } from "../../../../apps/ruukoto/src/personal-permissions.ts";
import { personalBackgroundProcesses } from "../../../../apps/ruukoto/src/personal-background-processes.ts";
import { PersonalDirectoryClaimsDoc } from "../../../../apps/ruukoto/src/personal-directory-claims.ts";
import { toolOperations } from "../../../../apps/ruukoto/src/personal-tools.ts";
import { linuxNativeScopeEmpty } from "../../../../packages/agent/src/execution/native-linux.ts";

const context = BACKGROUND_CONTEXT, envName = "PERSONAL_BACKGROUND_ACCEPTANCE_KEY";
const evidenceRoot = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(evidenceRoot, "../../../..");
const runId = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID().slice(0, 8), output = path.join(evidenceRoot, "runs", runId);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
let credential = "", previous = process.env[envName], personal: PersonalHarness | undefined, temporary = "", runtime: { pid: number; url: string } | undefined;
let failure: string | undefined, completed = false;
const stages: unknown[] = [], cleanupErrors: string[] = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const safe = (error: unknown) => String(error instanceof Error ? `${error.name}: ${error.message}` : error).replaceAll(credential || "\0", "[REDACTED]");
const save = (name: string, value: unknown) => { const body = JSON.stringify(value, null, 2) + "\n"; assert.ok(!credential || !body.includes(credential), "证据包含模型凭据，已拒绝写入"); fs.writeFileSync(path.join(output, name), body, { mode: 0o600 }); };
const sources = ["apps/ruukoto/src/personal-harness.ts", "apps/ruukoto/src/personal-model.ts", "apps/ruukoto/src/personal-background-processes.ts", "apps/ruukoto/src/personal-directory-claims.ts", "apps/ruukoto/src/personal-tool-policy.ts", "apps/ruukoto/src/personal-tools.ts", "apps/ruukoto/src/personal-source.ts", "apps/ruukoto/src/personal-tool-source.ts", "apps/ruukoto/src/personal-command-config.ts", "apps/ruukoto/src/personal-permissions.ts", "packages/agent/src/execution/background.ts", "packages/agent/src/execution/native-linux-identity.ts", "packages/agent/src/execution/native-linux.ts", "packages/agent/src/execution/launchers.ts", "worker/background-worker.mjs", "worker/personal-command-worker.mjs"];
const sourceHashes = () => Object.fromEntries(sources.map(name => [name, hash(fs.readFileSync(path.join(repository, name)))]));
async function until(check: () => Promise<boolean>, label: string) { const end = Date.now() + 30_000; while (!await check()) { assert.ok(Date.now() < end, label); await delay(25); } }
async function entries() { const all: EntryRecord[] = []; let cursor: Cursor | undefined; do { const page = await personal!.main.entries({ order: "ascending" }, 256, cursor, context); all.push(...page.items); cursor = page.next; } while (cursor); return all; }
function calls(all: EntryRecord[]) { return all.flatMap(entry => (entry.model ?? []).flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [{ entry: entry.id, callId: part.id, name: part.name, arguments: part.arguments }] : []) : [])); }
function results(all: EntryRecord[]) { return all.flatMap(entry => (entry.model ?? []).flatMap(message => { if (message.role !== "toolResult") return []; const text = message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"); let value: unknown; try { value = JSON.parse(text); } catch { value = text; } return [{ entry: entry.id, callId: message.toolCallId, name: message.toolName, isError: message.isError, text, value }]; })); }
async function facts() { return personal!.harness.commit(async tx => { const value = { background: await personalBackgroundProcesses(tx), claims: (await tx.doc(PersonalDirectoryClaimsDoc)).claims, tools: await toolOperations(tx) }; return JSON.parse(JSON.stringify(value)) as typeof value; }, context); }
async function stage(name: string, prompt: string, expected: string[]) {
  const before = (await entries()).at(-1)?.id ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([personal!.answer(prompt, `real-background-${name}`), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`模型阶段超时：${name}`)), 90_000); })]).finally(() => { if (timer) clearTimeout(timer); });
  const current = (await entries()).filter(entry => entry.id > before), actualCalls = calls(current), actualResults = results(current), snapshot = await facts();
  stages.push({ name, prompt, answer, calls: actualCalls, results: actualResults, facts: snapshot });
  save("stages.json", stages);
  for (const tool of expected) assert.ok(actualCalls.some(call => call.name === tool && actualResults.some(result => result.callId === call.callId && !result.isError)), `${name}缺少实际成功的${tool}`);
  return { answer, calls: actualCalls, results: actualResults, facts: snapshot };
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function secretScan(directory: string) { let checked = 0; for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, item.name); if (item.isDirectory()) checked += secretScan(target); else if (item.isFile()) { assert.ok(!fs.readFileSync(target).includes(Buffer.from(credential)), "隔离资料包含模型凭据，已保留目录并停止交付"); checked++; } } return checked; }
function nativeFacts(profile: string) { const directory = path.join(profile, "background", "executions"); if (!fs.existsSync(directory)) return []; return fs.readdirSync(directory).map(id => ({ id, files: Object.fromEntries(["claim.json", "launcher.json", "observation.json"].flatMap(name => { const target = path.join(directory, id, name); return fs.existsSync(target) ? [[name, JSON.parse(fs.readFileSync(target, "utf8")) as unknown]] : []; })) })); }
function alive(pid: number) { try { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0]); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; } }

try {
  assert.equal(process.env.RUN_MODEL_CHECK, "1", "真实模型验收需要RUN_MODEL_CHECK=1"); assert.equal(process.platform, "linux", "真实后台验收必须在Linux运行");
  const input: unknown = JSON.parse(fs.readFileSync(0, "utf8")); assert.ok(object(input) && object(input.model) && typeof input.credential === "string" && input.credential.length >= 16, "stdin需要单模型配置与凭据");
  credential = input.credential; delete input.credential;
  const config = parsePersonalModel({ ...input.model, apiKeyEnv: envName }); assert.equal(config.modelId, "deepseek-flash");
  previous = process.env[envName]; process.env[envName] = credential;
  const beforeHashes = sourceHashes(); save("source-sha256.json", { before: beforeHashes, probe: hash(fs.readFileSync(fileURLToPath(import.meta.url))) });
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-personal-bg-model-"))); fs.chmodSync(temporary, 0o700);
  const profile = path.join(temporary, "profile"), workspace = path.join(temporary, "work"); fs.mkdirSync(workspace, { mode: 0o700 });
  const pageMarker = `PAGE_${randomUUID().replaceAll("-", "")}`, stdoutMarker = `STDOUT_${randomUUID().replaceAll("-", "")}`, stderrMarker = `STDERR_${randomUUID().replaceAll("-", "")}`, writeMarker = `AFTER_STOP_${randomUUID().replaceAll("-", "")}`;
  const service = `import * as http from "node:http";\nimport * as fs from "node:fs";\nconst server=http.createServer((_request,response)=>{response.writeHead(200,{"content-type":"text/html; charset=utf-8"});response.end(${JSON.stringify(`<!doctype html><html><head><title>${pageMarker}</title></head><body><p>${pageMarker}</p></body></html>`)});});\nserver.listen(0,"127.0.0.1",()=>{const url="http://127.0.0.1:"+server.address().port;fs.writeFileSync("service-runtime.json",JSON.stringify({pid:process.pid,url})+"\\n",{mode:0o600});process.stdout.write("READY "+url+"\\n${stdoutMarker}\\n");process.stderr.write("${stderrMarker}\\n");});\nsetTimeout(()=>server.close(()=>process.exit(0)),600000).unref();\n`;
  fs.writeFileSync(path.join(workspace, "service.mjs"), service, { mode: 0o600 }); fs.writeFileSync(path.join(output, "service.mjs"), service, { mode: 0o600 });
  const identity = fs.statSync(workspace), commandConfig = { version: 1 as const, workspace, identity: { dev: identity.dev, ino: identity.ino }, machineId: fs.readFileSync("/etc/machine-id", "utf8").trim(), tmpdir: fs.realpathSync(tmpdir()) };
  const tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: commandConfig.identity, credentials: [] });
  personal = await openPersonalHarness({ directory: profile, provider: personalProvider(config), modelId: config.modelId, tools, commands: commandConfig });
  await personal.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'", command = `${quote(process.execPath)} service.mjs`;
  const start = await stage("start", `这是已授权的独立Linux后台验收。请调用一次process_start，command严格使用${JSON.stringify(command)}。随后调用process_output读取该process_id的stdout，从真实日志取出READY后的本机URL；空输出可以再次读取。调用process_status核实running。最后给出实际process_id、URL和running，并结束本轮。服务需要保留到下一拥有者消息。`, ["process_start", "process_output", "process_status"]);
  assert.equal(start.facts.background.length, 1); const background = start.facts.background[0]; assert.equal(background.state, "running"); assert.equal(background.stopped, false);
  assert.equal(start.facts.claims.filter(claim => !claim.released).length, 1);
  const task = await personal.harness.getTask(background.taskId, context); assert.ok(task); assert.equal(task.background, true); assert.equal(task.owner, undefined); save("background-task.json", task);
  await until(async () => fs.existsSync(path.join(workspace, "service-runtime.json")), "服务未保存启动事实");
  const started: unknown = JSON.parse(fs.readFileSync(path.join(workspace, "service-runtime.json"), "utf8")); assert.ok(object(started) && typeof started.pid === "number" && Number.isSafeInteger(started.pid) && started.pid > 0 && typeof started.url === "string"); runtime = { pid: started.pid, url: started.url };
  const url = new URL(runtime.url); assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1"); assert.match(start.answer, new RegExp(runtime.url.replaceAll(".", "\\."))); assert.ok(start.results.some(result => result.name === "process_output" && result.text.includes(runtime!.url)));
  const native = nativeFacts(profile); save("native-running.json", native); assert.ok(native.length > 0);
  const query = await stage("query", `这是下一条拥有者消息。继续保留${background.id}。请实际调用process_output分别读取stdout与stderr，再调用process_status核实该后台仍running；最后逐字给出两路日志各自的STDOUT_与STDERR_校验码及状态，结束本轮。`, ["process_output", "process_status"]);
  const outputCalls = query.calls.filter(call => call.name === "process_output"); for (const stream of ["stdout", "stderr"]) assert.ok(outputCalls.some(call => object(call.arguments) && call.arguments.stream === stream), `跨轮未查询${stream}`);
  assert.ok(query.results.some(result => result.name === "process_output" && result.text.includes(stdoutMarker))); assert.ok(query.results.some(result => result.name === "process_output" && result.text.includes(stderrMarker))); assert.ok(query.answer.includes(stdoutMarker) && query.answer.includes(stderrMarker)); assert.equal(query.facts.background[0].state, "running"); assert.equal(query.facts.background[0].id, background.id);
  const response = await fetch(runtime.url, { method: "GET", signal: AbortSignal.timeout(5000) }), body = await response.text(); assert.equal(response.status, 200); assert.ok(body.includes(pageMarker));
  save("host-http.json", { verification: "宿主fetch真实GET；不构成browser验收", at: new Date().toISOString(), method: "GET", url: runtime.url, status: response.status, expectedPageMarker: pageMarker, body, sha256: hash(body) });
  const stop = await stage("stop", `请对${background.id}实际调用process_stop，随后用process_status查询该process_id，直到真实结果state为stopped且stopVerified为true，再报告核实结果并结束本轮。若仍stop_requested或stop_unverified，继续查询或报告无法核实。本轮完成停止核实即可。`, ["process_stop", "process_status"]);
  assert.ok(stop.results.some(result => result.name === "process_status" && object(result.value) && result.value.state === "stopped" && result.value.stopVerified === true), "模型没有实际查询到停止已核实"); assert.equal(stop.facts.background[0].stopped, true); assert.equal(stop.facts.claims.filter(claim => !claim.released).length, 0);
  const target = path.join(workspace, "after-stop.txt");
  const write = await stage("write", `原后台已经通过process_status核实停止。请实际调用write_file，将${JSON.stringify(target)}的完整内容写成${JSON.stringify(writeMarker)}，不加换行；完成后只回复该校验码。`, ["write_file"]);
  assert.equal(fs.readFileSync(target, "utf8"), writeMarker); const operation = write.facts.tools.find(tool => tool.kind === "write_file" && tool.effect === "returned"); assert.ok(operation?.directoryClaim); assert.equal(operation.origin.permission.mode, "full_access"); assert.equal(operation.origin.source.requestId, "real-background-write");
  const backgroundClaim = write.facts.claims.find(claim => claim.owner.kind === "background"), fileClaim = write.facts.claims.find(claim => claim.owner.kind === "file"); assert.ok(backgroundClaim?.released && fileClaim?.released); assert.ok(fileClaim.acquired > backgroundClaim.released); assert.equal(write.facts.claims.filter(claim => !claim.released).length, 0);
  const afterHashes = sourceHashes(); assert.deepEqual(afterHashes, beforeHashes); save("source-sha256.json", { before: beforeHashes, after: afterHashes, probe: hash(fs.readFileSync(fileURLToPath(import.meta.url))) });
  save("run.json", { model: "deepseek/deepseek-flash", config, node: process.version, platform: process.platform, profile, workspace, runtime, markers: { pageMarker, stdoutMarker, stderrMarker, writeMarker }, browserVerification: { verified: false, reason: "当前Linux Chrome sandbox不可用；本次只执行宿主HTTP GET，不使用noSandbox降级" } });
  completed = true;
} catch (error) { failure = safe(error); }
finally {
  if (personal) {
    if (!completed) { try { await personal.main.abort(context); } catch (error) { cleanupErrors.push(safe(error)); } }
    try { const current = await facts(); for (const record of current.background) if (!record.stopped) { await personal.background!.stop(record.id); await until(async () => (await facts()).background.find(value => value.id === record.id)?.stopped === true, "清理时停止核实超时"); } } catch (error) { cleanupErrors.push(safe(error)); }
    try { const all = await entries(); save("session-entries.json", all); save("model-requests.json", all.filter(entry => entry.kind === "ruukoto.model-request")); save("facts.json", await facts()); save("native-final.json", nativeFacts(path.join(temporary, "profile"))); } catch (error) { cleanupErrors.push(safe(error)); }
    try { await personal.close(); } catch (error) { cleanupErrors.push(safe(error)); }
  }
  if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  const proof: Record<string, unknown> = { at: new Date().toISOString(), errors: cleanupErrors, credentialEnvRestored: process.env[envName] === previous, temporary, runtime, temporaryRemoved: false };
  try {
    const running = runtime ? alive(runtime.pid) : false; let serving = false;
    if (runtime) { try { const response = await fetch(runtime.url, { signal: AbortSignal.timeout(1500) }); await response.arrayBuffer(); serving = true; } catch (error) { if (!(error instanceof Error)) throw error; } }
    const native = temporary ? nativeFacts(path.join(temporary, "profile")) : [], scopes = native.flatMap(value => { const observation = value.files["observation.json"]; return object(observation) && typeof observation.group === "string" ? [{ id: value.id, group: observation.group, empty: linuxNativeScopeEmpty(observation.group) }] : []; });
    Object.assign(proof, { serviceAlive: running, serving, scopes }); assert.equal(running, false, "服务进程仍存活"); assert.equal(serving, false, "服务仍可访问"); if (runtime) assert.ok(scopes.length > 0, "缺少原scope清理依据"); for (const scope of scopes) assert.equal(scope.empty, true, "原scope未核实为空");
    proof.credentialFilesChecked = temporary && credential ? secretScan(temporary) : 0;
    if (temporary && cleanupErrors.length === 0) { fs.rmSync(temporary, { recursive: true }); proof.temporaryRemoved = !fs.existsSync(temporary); }
  } catch (error) { cleanupErrors.push(safe(error)); }
  save("cleanup.json", proof);
  const evidenceCredentialFilesChecked = credential ? secretScan(output) : 0, passed = completed && !failure && cleanupErrors.length === 0;
  const requestsFile = path.join(output, "model-requests.json"), requests: unknown[] = fs.existsSync(requestsFile) ? JSON.parse(fs.readFileSync(requestsFile, "utf8")) : [];
  const summary = { passed, model: "deepseek/deepseek-flash", actualRequests: requests.filter(entry => object(entry) && object(entry.data) && entry.data.payload !== undefined).length, stages: stages.length, failure, cleanupErrors, evidenceCredentialFilesChecked, evidenceRelative: `runs/${runId}`, browserVerified: false, hostHttpVerified: fs.existsSync(path.join(output, "host-http.json")) };
  const estimates = requests.flatMap(entry => {
    if (!object(entry) || !object(entry.data) || !object(entry.data.input) || entry.data.payload === undefined || !Array.isArray(entry.data.input.messages)) return [];
    const systems = entry.data.input.messages.filter(object).filter(message => message.role === "system"), schemas = systems.flatMap(message => Array.isArray(message.toolsAdded) ? message.toolsAdded : []);
    const text = systems.flatMap(message => [typeof message.content === "string" ? message.content : "", ...Object.values(object(message.sections) ? message.sections : {}).filter(value => typeof value === "string")]).join("\n");
    return [{ toolSchemas: Math.ceil(JSON.stringify(schemas).length / 4), toolSchemasBefore: Math.ceil(JSON.stringify(schemas.filter(tool => !object(tool) || !["process_start", "process_status", "process_output", "process_stop"].includes(String(tool.name)))).length / 4), systemPrompt: Math.ceil(text.length / 4), systemPromptBefore: Math.ceil(text.length / 4) }];
  });
  save("request-estimates.json", { estimator: "UTF-16字符数/4向上取整；同次真实请求移除新增process工具得到前值，systemPrompt没有新增固定段落", estimates });
  save("result.json", summary); process.stdout.write(JSON.stringify(summary) + "\n"); if (!passed) process.exitCode = 1;
}
