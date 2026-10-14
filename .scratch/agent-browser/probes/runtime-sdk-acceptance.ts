import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { product as personal } from "../../../apps/ruukoto/src/product.ts";
import { product as coding } from "../../../apps/ruukoto-code/src/product.ts";
import { BROWSER_META_KEY, type BrowserBinding } from "@ruukoto/agent/browser-manager.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import type { Artifact, Task } from "@ruukoto/core/types.ts";
import { createProjectSession, lastToolText, startTestRuntime, taskStatus, toolNamesOf, waitFor } from "../../../test/helpers/testkit.ts";
import type { RecordedRequest, MockResponse } from "../../../test/helpers/mock-provider.ts";

const binary = process.env.RUUKOTO_BROWSER_BINARY, chrome = process.env.RUUKOTO_BROWSER_CHROME;
assert.ok(binary && chrome, "需要固定官方 native 与 Chromium 的宿主路径");
const root = process.env.RUUKOTO_BROWSER_SDK_PROBE_DIR ? path.resolve(process.env.RUUKOTO_BROWSER_SDK_PROBE_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), "rk-browser-sdk-"));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const report: { status: string; model: string; platform: string; node: string; cases: Record<string, unknown>[]; error?: string } = { status: "running", model: "scripted mock OpenAI provider; actual SDK/browser/runtime", platform: process.platform, node: process.version, cases: [] };
const reportPath = path.join(root, "results.json");
const submissions = new Map<string, string[]>();
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost"); const label = url.searchParams.get("case"); if (!label) { response.writeHead(404); response.end(); return; }
  if (request.method === "POST" && url.pathname === "/submit") {
    let body = ""; for await (const chunk of request) body += String(chunk);
    const rows = submissions.get(label) ?? []; rows.push(new URLSearchParams(body).get("name") ?? ""); submissions.set(label, rows);
    response.setHeader("Set-Cookie", `${label.replace(/-/g, "_")}=present; Max-Age=86400; HttpOnly; Path=/`);
    response.setHeader("Content-Type", "text/html"); response.end(`<h1>Submitted ${label}</h1><p>Count ${rows.length}</p>`); return;
  }
  response.setHeader("Content-Type", "text/html"); response.end(`<h1>${label}</h1><form method="post" action="/submit?case=${label}"><label for="name">Name</label><input id="name" name="name"><button type="submit">Submit once</button></form>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address === "object");
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function providerImages(request: RecordedRequest): Buffer[] {
  return request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).flatMap((part: unknown) => {
    if (!record(part) || part.type !== "image_url" || !record(part.image_url) || typeof part.image_url.url !== "string") return [];
    const match = /^data:image\/png;base64,(.+)$/.exec(part.image_url.url); return match ? [Buffer.from(match[1], "base64")] : [];
  });
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function cookies(cdpUrl: string): Promise<{ persistent: boolean }> {
  return await new Promise((resolve, reject) => { const ws = new WebSocket(cdpUrl); const timer = setTimeout(() => { ws.close(); reject(new Error("Cookie 核实超时")); }, 5000); ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" })); ws.onmessage = event => { const value: unknown = JSON.parse(String(event.data)); if (!record(value) || value.id !== 1) return; clearTimeout(timer); ws.close(); if (!record(value.result) || !Array.isArray(value.result.cookies)) { reject(new Error("Cookie 核实应答无效")); return; } resolve({ persistent: value.result.cookies.some((cookie: unknown) => record(cookie) && cookie.value === "present" && cookie.httpOnly === true && cookie.session === false && typeof cookie.expires === "number" && cookie.expires > Date.now() / 1000) }); }; ws.onerror = () => { clearTimeout(timer); reject(new Error("Cookie CDP 核实连接中断")); }; });
}

try {
  for (const row of [{ product: personal.runtime, main: true, label: "ruukoto-main" }, { product: coding.runtime, main: false, label: "ruukoto-code-dev" }]) {
    const caseDir = path.join(root, row.label); fs.mkdirSync(caseDir, { mode: 0o700 });
    let textRef: string | null = null, buttonRef: string | null = null;
    const sequence: string[] = [];
    const responder = (request: RecordedRequest, index: number): MockResponse => {
      assert.ok(toolNamesOf(request).includes("browser"));
      const call = (action: string, args: Record<string, unknown> = {}): MockResponse => { sequence.push(action); return { kind: "tool_calls", calls: [{ id: `${row.label}-${index}`, name: "browser", arguments: { action, ...args } }] }; };
      if (index === 0) return call("start");
      if (index === 1) return call("open", { url: `http://127.0.0.1:${address.port}/?case=${row.label}` });
      if (index === 2 || index === 7) return call("snapshot");
      if (index === 3) {
        const snapshot: unknown = JSON.parse(lastToolText(request)); assert.ok(record(snapshot) && record(snapshot.refs));
        const fields = Object.entries(snapshot.refs); textRef = "@" + fields.find(([, value]) => record(value) && value.role === "textbox")?.[0]; buttonRef = "@" + fields.find(([, value]) => record(value) && value.role === "button")?.[0];
        assert.match(textRef, /^@e\d+$/); assert.match(buttonRef, /^@e\d+$/); return call("fill", { ref: textRef, text: "sdk --config" });
      }
      if (index === 4) return call("click", { ref: buttonRef });
      if (index === 5 || index === 8) return call("screenshot");
      assert.ok(index === 6 || index === 9); assert.ok(providerImages(request).length > 0, "视觉请求必须有真实截图字节");
      return { kind: "text", text: "模拟模型收到实际浏览器截图" };
    };
    const t = await startTestRuntime("ab-sdk", responder, { workDirs: 1, config: { product: row.product, browser: { binaryPath: binary, chromePath: chrome, headed: false, noSandbox: process.env.RUUKOTO_BROWSER_NO_SANDBOX === "1" } } });
    try {
      const resolve = t.runtime.modelCatalog.resolve.bind(t.runtime.modelCatalog);
      t.runtime.modelCatalog.resolve = async selection => ({ ...await resolve(selection), input: ["text", "image"] });
      const sessionId = row.main ? t.runtime.store.getAgentRole("main")!.sessionId : (await createProjectSession(t.client, t.work[0])).sessionId;
      const binding = (): BrowserBinding => { const state = t.runtime.store.getMetaValue(BROWSER_META_KEY); assert.ok(state); const parsed = JSON.parse(state) as { bindings: BrowserBinding[] }; const value = parsed.bindings.find(entry => entry.sessionId === sessionId); assert.ok(value); return value; };
      const submit = async (round: number): Promise<Task> => {
        const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: `round-${round}`, input: round === 1 ? "工程组合验收：模拟模型提交一次表单，然后看实际截图" : "工程组合验收：继续当前浏览器，仅取快照与截图", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, access_mode: "full_access" });
        await waitFor("组合任务结束", () => ["completed", "failed", "interrupted"].includes(t.runtime.store.getTask(task.id)!.status), 60_000);
        const ended = t.runtime.store.getTask(task.id)!; assert.equal(ended.status, "completed", ended.errorMessage ?? JSON.stringify(t.server.calls)); return ended;
      };
      const first = await submit(1); await waitFor("实际服务端收到唯一提交", () => (submissions.get(row.label)?.length ?? 0) === 1); assert.deepEqual(submissions.get(row.label), ["sdk --config"]);
      const firstBinding = binding(); assert.equal(firstBinding.state, "ready"); assert.ok(firstBinding.chrome); const cookie = await cookies(firstBinding.cdpUrl!); assert.equal(cookie.persistent, true);
      const second = await submit(2), secondBinding = binding(); assert.equal(secondBinding.generation, firstBinding.generation); assert.equal(secondBinding.chrome?.pid, firstBinding.chrome.pid); assert.equal(secondBinding.daemon?.processIdentity, firstBinding.daemon?.processIdentity); assert.deepEqual(submissions.get(row.label), ["sdk --config"]);
      const artifactEvidence: Record<string, unknown>[] = [];
      for (const [task, modelIndex] of [[first, 6], [second, 9]] as const) {
        const detail = await taskStatus(t.client, task.id); const artifacts = detail.artifacts as Artifact[]; const artifact = artifacts.find(entry => entry.name === "browser-screenshot"); assert.ok(artifact); assert.equal(artifact.status, "complete"); assert.equal(artifact.mimeType, "image/png");
        const raw = await t.client.request<{ data: string }>("read_artifact", { task_id: task.id, artifact_id: artifact.id }); const bytes = Buffer.from(raw.data, "base64"); assert.equal(bytes.length, artifact.byteCount); assert.equal(hash(bytes), artifact.contentHash); assert.ok(bytes.length > 100);
        const inputImages = providerImages(t.server.calls[modelIndex]); assert.equal(inputImages.length, task.id === first.id ? 1 : 2); assert.ok(inputImages.some(image => hash(image) === artifact.contentHash));
        const historyPath = t.runtime.store.getSession(sessionId)!.sessionFile!; const history = parseSessionFile(historyPath); const expectedCall = `${row.label}-${task.id === first.id ? 5 : 8}`; assert.ok(history.some(entry => { const message = entry.message; return record(message) && message.role === "toolResult" && message.toolCallId === expectedCall && Array.isArray(message.content) && message.content.some((part: unknown) => record(part) && part.type === "image" && part.data === bytes.toString("base64")); }));
        const selection = t.runtime.store.listSelectionRecordsByTask(task.id).at(-1)!; const prompt = await t.client.request<{ data: string }>("read_artifact", { task_id: task.id, artifact_id: selection.promptArtifactId }); assert.ok(Buffer.from(prompt.data, "base64").toString().includes(bytes.toString("base64")));
        fs.writeFileSync(path.join(caseDir, `${task.id}.png`), bytes, { mode: 0o600 });
        artifactEvidence.push({ taskId: task.id, artifactId: artifact.id, byteCount: bytes.length, contentHash: hash(bytes), providerImage: true, providerImageCount: inputImages.length, jsonlImage: true, jsonlToolCallId: expectedCall, promptArtifactImage: true });
        const operations = t.runtime.store.listToolOpsByTask(task.id).filter(op => op.toolName === "browser"); assert.equal(operations.length, task.id === first.id ? 6 : 2); assert.ok(operations.every(op => op.authorization?.source === "full_access" && !op.effectUnknown));
      }
      fs.copyFileSync(t.runtime.store.getSession(sessionId)!.sessionFile!, path.join(caseDir, "session.jsonl"));
      fs.writeFileSync(path.join(caseDir, "model-requests.jsonl"), t.server.calls.map(request => JSON.stringify(request)).join("\n") + "\n", { mode: 0o600 });
      fs.writeFileSync(path.join(caseDir, "binding.json"), JSON.stringify(secondBinding, null, 2) + "\n", { mode: 0o600 });
      assert.deepEqual(sequence, ["start", "open", "snapshot", "fill", "click", "screenshot", "snapshot", "screenshot"]); assert.equal(t.server.calls.length, 10);
      report.cases.push({ label: row.label, status: "passed", sessionId, postCount: submissions.get(row.label)!.length, refs: { textRef, buttonRef }, persistentCookie: cookie.persistent, generation: secondBinding.generation, chromePid: secondBinding.chrome!.pid, artifacts: artifactEvidence, sequence, modelRequests: t.server.calls.length, evidenceDir: caseDir });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    } finally { await t.shutdown(); }
  }
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); process.stdout.write(JSON.stringify({ status: report.status, model: "simulated", reportPath }) + "\n"); }
