import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { MAX_HTTP_RESPONSE_BYTES, executeApprovedHttpRequest } from "@ruukoto/agent/execution/approved-ops.ts";
import { WebFetchError, webPageText } from "@ruukoto/agent/web-fetch.ts";
import { hasNoWriteEffect } from "@ruukoto/agent/tool-op-ledger.ts";
import { classifyForReview } from "@ruukoto/agent/review.ts";
import { afterTool, createProjectSession, lastToolText, lastUserText, pendingConfirmation, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

const HTML = '<!doctype html><title>正文 &amp; 来源</title><header>站点菜单</header><nav>跳转导航</nav><main><h1>你好 🐦</h1><p>实体 &lt;保留&gt; &amp; 中文</p><script>泄漏脚本</script><style>泄漏样式</style><div hidden>隐藏内容</div><nav>内部导航</nav><pre>  const x = 1;\n  x++;</pre></main><footer>页脚</footer>';
const LONG = "正文🙂".repeat(4000) + "结束标记";

async function service(t: TestContext) {
  const hits = new Map<string, number>();
  const server = http.createServer((request, response) => {
    const route = request.url!;
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, undefined);
    hits.set(route, (hits.get(route) ?? 0) + 1);
    if (route === "/redirect") { response.writeHead(302, { location: "/destination" }); response.end(); return; }
    if (route === "/invalid-redirect") { response.writeHead(302, { location: "http://[" }); response.end(); return; }
    if (route === "/unsafe-redirect") { response.writeHead(302, { location: "file:///private.txt" }); response.end(); return; }
    if (route === "/error") { response.writeHead(403); response.end("拒绝"); return; }
    if (route === "/range") { response.writeHead(206, { "content-type": "text/plain", "content-range": "bytes 0-4/100" }); response.end("first"); return; }
    const contentType = route === "/html" || route === "/empty" ? "text/html; charset=utf-8" : route === "/binary" ? "application/pdf" : "text/plain; charset=utf-8";
    response.writeHead(200, { "content-type": contentType, ...(route === "/compressed" ? { "content-encoding": "gzip" } : {}) });
    response.end(route === "/html" ? HTML : route === "/empty" ? "<script>动态页面</script>" : route === "/long" ? LONG : route === "/partial" ? "x".repeat(MAX_HTTP_RESPONSE_BYTES - 1) + "中TAIL" : route === "/binary" ? "%PDF-1.7" : "纯文本 & <保留> 🐦");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("正文解析：保留实体、Unicode和预格式文本，排除脚本导航；非文本与无正文明确失败", () => {
  const page = webPageText(Buffer.from(HTML), { "content-type": "text/html" }, false);
  assert.equal(page.title, "正文 & 来源");
  assert.match(page.text, /你好 🐦/);
  assert.match(page.text, /实体 <保留> & 中文/);
  assert.match(page.text, /  const x = 1;\n  x\+\+;/);
  assert.doesNotMatch(page.text, /菜单|导航|脚本|样式|隐藏|页脚/);
  assert.equal(webPageText(Buffer.from("<article><p>文章</p></article><aside>其他</aside>"), { "content-type": "text/html" }, false).text, "文章");
  assert.equal(webPageText(Buffer.from("<p>普通页面</p>"), { "content-type": "text/html" }, false).text, "普通页面");
  for (const [body, headers, code] of [
    [Buffer.from("%PDF"), { "content-type": "application/pdf" }, "content_unsupported"],
    [Buffer.from("hello"), { "content-type": "text/plain", "content-encoding": "gzip" }, "encoding_unsupported"],
    [Buffer.from("hello"), { "content-type": "text/html;charset=gbk" }, "encoding_unsupported"],
    [Buffer.from([0xff]), { "content-type": "text/plain" }, "encoding_unsupported"],
    [Buffer.from("a\0b"), { "content-type": "text/plain" }, "content_unsupported"],
    [Buffer.from("<script>only()</script>"), { "content-type": "text/html" }, "body_missing"],
  ] as const) assert.throws(() => webPageText(body, headers, false), error => error instanceof WebFetchError && error.code === code);
});

test("web_fetch：真实HTTP正文、长正文续读、截断事实与失败状态进入模型结果", async t => {
  const remote = await service(t), results = new Map<string, string[]>();
  const kit = await startTestRuntime("web-fetch", request => {
    const url = lastUserText(request);
    assert.ok(toolNamesOf(request).includes("web_fetch"));
    if (afterTool(request)) {
      const text = lastToolText(request), current = results.get(url) ?? [];
      current.push(text); results.set(url, current);
      if (url.endsWith("/long") && current.length === 1) {
        const result = JSON.parse(text);
        return { kind: "tool_calls", calls: [{ id: "continue", name: "read_artifact", arguments: { artifact_id: result.artifact_id, offset: result.next_offset } }] };
      }
      return { kind: "text", text: "已核实网页读取结果" };
    }
    return { kind: "tool_calls", calls: [{ id: "fetch", name: "web_fetch", arguments: { url, reason: "读取用户指定网页" } }] };
  }, { workDirs: 1, config: { ...realTools(), product: product.runtime } });
  t.after(() => kit.shutdown());
  for (const route of ["html", "plain", "long", "partial", "range", "binary", "compressed", "empty", "redirect", "invalid-redirect", "unsafe-redirect", "error"]) {
    const { sessionId } = await createProjectSession(kit.client, kit.work[0]);
    const url = `${remote.url}/${route}`;
    const task = await kit.runtime.submit({ sessionId, requestId: route, input: url, modelSelection: kit.runtime.defaultSelection, accessMode: "full_access" });
    await waitFor(`网页 ${route} 完成`, () => kit.runtime.store.getTask(task.id)?.status === "completed", 30_000);
    const operation = kit.runtime.store.listToolOpsByTask(task.id)[0];
    if (route === "html") {
      const { estimates } = kit.runtime.listSelectionRecords({ taskId: task.id })[0];
      t.diagnostic(JSON.stringify({ toolSchemas: estimates.toolSchemas, systemPrompt: estimates.systemPrompt }));
    }
    assert.equal(operation.toolName, "web_fetch");
    assert.equal(operation.effectUnknown, false);
    assert.equal(remote.hits.get(`/${route}`), 1);
    const returned = results.get(url)!;
    if (["html", "plain", "long", "partial", "range"].includes(route)) {
      assert.equal(operation.isError, false);
      const result = JSON.parse(returned[0]);
      assert.equal(result.url, url); assert.equal(result.status, route === "range" ? 206 : 200); assert.equal(result.partial, route === "partial" || route === "range");
      if (route === "range") { assert.equal(result.text, "first"); assert.equal(kit.runtime.store.getArtifact(result.artifact_id)!.status, "partial"); }
      if (route === "html") { assert.equal(result.title, "正文 & 来源"); assert.match(result.text, /你好 🐦/); assert.doesNotMatch(result.text, /脚本|导航/); }
      if (route === "plain") assert.equal(result.text, "纯文本 & <保留> 🐦");
      if (route === "long" || route === "partial") {
        const artifact = kit.runtime.store.getArtifact(result.artifact_id)!;
        assert.equal(artifact.status, route === "partial" ? "partial" : "complete");
        assert.equal(artifact.byteCount, route === "partial" ? MAX_HTTP_RESPONSE_BYTES - 1 : Buffer.byteLength(LONG));
        assert.equal(result.next_offset, Buffer.byteLength(result.text));
        assert.doesNotMatch(result.text, /�/);
        if (route === "long") { assert.match(returned[1], /结束标记/); assert.equal(kit.runtime.artifacts.read(artifact.id).toString(), LONG); }
      }
    } else {
      assert.equal(operation.isError, true);
      assert.match(returned[0], /不支持|不是支持|没有可读取|重定向|读取失败/);
      if (route === "redirect") assert.match(returned[0], new RegExp(`${remote.url}/destination`));
    }
  }
  assert.equal(remote.hits.get("/destination"), undefined);
});

test("web_fetch：审批固定GET、拒绝零发送，URL凭据在审批前拒绝", async t => {
  const remote = await service(t);
  const kit = await startTestRuntime("web-fetch-approval", request => afterTool(request)
    ? { kind: "text", text: "已报告读取未执行" }
    : { kind: "tool_calls", calls: [{ id: "fetch", name: "web_fetch", arguments: { url: lastUserText(request), reason: "读取指定网页" } }] },
  { workDirs: 1, config: { ...realTools(), product: product.runtime } });
  t.after(() => kit.shutdown());
  const { sessionId } = await createProjectSession(kit.client, kit.work[0]);
  const task = await kit.runtime.submit({ sessionId, requestId: "reject", input: remote.url + "/plain", modelSelection: kit.runtime.defaultSelection, accessMode: "confirm" });
  const approval = await pendingConfirmation(kit.client, task.id);
  assert.equal(approval.toolName, "web_fetch");
  assert.deepEqual(approval.scope, { kind: "http_request", method: "GET", url: remote.url + "/plain", credentials: [] });
  assert.equal(classifyForReview(approval.scope), "reviewable");
  assert.equal(remote.hits.size, 0);
  await kit.client.request("respond_confirmation", { confirmation_id: approval.id, decision: "reject" });
  await waitFor("拒绝后完成", () => kit.runtime.store.getTask(task.id)?.status === "completed", 30_000);
  assert.equal(remote.hits.size, 0);
  assert.equal(kit.runtime.store.listToolOpsByTask(task.id)[0].effectUnknown, false);
  assert.equal(hasNoWriteEffect({ toolName: "web_fetch", params: {} }), true);
  const credentialUrl = new URL(remote.url); credentialUrl.username = "secret";
  const second = await createProjectSession(kit.client, kit.work[0]);
  const rejected = await kit.runtime.submit({ sessionId: second.sessionId, requestId: "credential", input: credentialUrl.href, modelSelection: kit.runtime.defaultSelection, accessMode: "confirm" });
  await waitFor("URL凭据拒绝", () => kit.runtime.store.getTask(rejected.id)?.status === "completed", 30_000);
  assert.match(kit.runtime.store.listToolOpsByTask(rejected.id)[0].resultSummary!, /不能包含用户名或密码/);
  assert.equal(remote.hits.size, 0);
});

test("HTTP传输：保留跨越上限数据块的前缀并报告真实truncated", async t => {
  const remote = await service(t);
  const kit = await startTestRuntime("http-capture", () => ({ kind: "text", text: "完成" }), { workDirs: 0 });
  t.after(() => kit.shutdown());
  const result = await executeApprovedHttpRequest({ method: "GET", url: remote.url + "/partial", headers: {} }, kit.runtime.credentials);
  assert.equal(result.truncated, true);
  assert.equal(result.bodyBytes?.length, MAX_HTTP_RESPONSE_BYTES);
  assert.equal(result.bodyBytes?.at(-1), 0xe4);
  assert.equal(result.bodyBytes?.subarray(0, -1).toString(), "x".repeat(MAX_HTTP_RESPONSE_BYTES - 1));
});
