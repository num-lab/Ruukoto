import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../..");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) {
  process.stderr.write("[git-windowing] 未找到 Chrome；设置 CHROME_PATH 后重试。\n");
  process.exit(2);
}
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
function connect(url) {
  const socket = new WebSocket(url), pending = new Map();
  let next = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const ready = new Promise((resolveReady, rejectReady) => { socket.addEventListener("open", resolveReady, { once: true }); socket.addEventListener("error", rejectReady, { once: true }); });
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => { const id = ++next; pending.set(id, { resolve: resolveSend, reject: rejectSend }); socket.send(JSON.stringify({ id, method, params })); });
  return { ready, send, close: () => socket.close() };
}

const fixture = spawn("npx", ["tsx", join(here, "fixture.mts")], { cwd: repository, detached: true, stdio: ["ignore", "pipe", "ignore"] });
const url = await new Promise((resolveUrl, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("fixture 启动超时")), 20_000);
  fixture.stdout.on("data", chunk => {
    buffer += chunk;
    const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\//);
    if (match) { clearTimeout(timer); resolveUrl(match[0]); }
  });
  fixture.on("exit", code => reject(new Error(`fixture 提前退出：${code}`)));
});
const profile = mkdtempSync(join(tmpdir(), "ruukoto-git-window-"));
const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=520,700", url], { stdio: ["ignore", "ignore", "pipe"] });
let client = null;
try {
  const websocket = await new Promise((resolveSocket, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chrome DevTools 启动超时")), 20_000);
    browser.stderr.on("data", chunk => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolveSocket(match[1]); }
    });
    browser.on("exit", code => reject(new Error(`Chrome 提前退出：${code}`)));
  });
  const listing = await (await fetch(`http://127.0.0.1:${new URL(websocket).port}/json/list`)).json();
  const page = listing.find(target => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
  assert.ok(page, "未找到 Chrome 页面 target");
  client = connect(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send("Runtime.enable");
  let encoded = "";
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const evaluated = await client.send("Runtime.evaluate", { expression: 'document.getElementById("result")?.textContent ?? ""', returnByValue: true });
    encoded = evaluated.result?.value ?? "";
    if (encoded) break;
    await wait(200);
  }
  assert.ok(encoded, "fixture 未输出结果");
  const result = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
  writeFileSync(join(here, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${result.checks.map(entry => `${entry.pass ? "PASS" : "FAIL"} ${entry.name}`).join("\n")}\n`);
  if (result.error) {
    process.stderr.write(`fixture error: ${result.error}\n`);
    process.exitCode = 1;
  } else {
    assert.equal(result.failed, 0, `未通过的检查：${result.checks.filter(entry => !entry.pass).map(entry => entry.name).join("、")}`);
    process.stdout.write(`PASS: git graph windowing browser fixture（requests ${result.requests}，viewport ${result.viewportWidth}，content ${result.contentWidth}，scrollLeft ${result.scrollLeft}）\n`);
  }
  process.exitCode = result.error ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  client?.close();
  browser.kill("SIGKILL");
  try { process.kill(-fixture.pid, "SIGKILL"); } catch { /* 子进程组已退出 */ }
  rmSync(profile, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
