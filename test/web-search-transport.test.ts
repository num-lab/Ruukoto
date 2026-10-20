import assert from "node:assert/strict";
import { test } from "node:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { requestTavily, resolveTavilyTarget, WebSearchError } from "@ruukoto/agent/web-search-transport.ts";

const SECRET = "tavily-private-key";

async function mockTavily(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    deps: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credential: { header: "authorization", secret: SECRET } },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("无状态搜索保留字段截断前的完整原响应，凭据只用于认证", async () => {
  const longSummary = "摘要".repeat(2000);
  const payload = JSON.stringify({
    request_id: "request-1",
    results: [
      { title: "结果", url: "https://example.com/source", content: `${longSummary}${SECRET}`, published_date: "2026-10-17" },
      { title: "凭据回显地址", url: `https://example.com/${SECRET}`, content: "x" },
      { title: "第三条", url: "https://example.com/third", content: "保留在原响应" },
    ],
    provider_metadata: "原始额外字段",
  });
  let hits = 0;
  const mock = await mockTavily((request, response) => {
    hits++;
    assert.equal(request.url, "/search");
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), {
        query: "新闻", max_results: 2, search_depth: "fast", topic: "news", include_published_date: true,
        time_range: "day", include_domains: ["example.com"],
      });
      response.end(payload);
    });
  });
  try {
    const captured = await requestTavily(mock.deps, {
      query: " 新闻 ", topic: "news", max_results: 2, search_depth: "fast", time_range: "day", include_domains: ["EXAMPLE.COM"],
    });
    assert.equal(hits, 1);
    assert.equal(captured.partial, false);
    assert.equal(captured.result.items.length, 1);
    assert.equal(captured.result.items[0].summary.length, 2000);
    assert.equal(captured.result.items[0].publishedAt, "2026-10-17");
    assert.equal(captured.result.fieldsTruncated, true);
    assert.equal(captured.result.dropped, 1);
    assert.equal(captured.result.totalResults, 3);
    assert.equal(captured.response.toString(), payload.replaceAll(SECRET, "[REDACTED]"));
    assert.doesNotMatch(JSON.stringify(captured.result), new RegExp(SECRET));
  } finally {
    await mock.close();
  }
});

test("错误响应、超限和非法JSON保留有界脱敏原响应，不重试", async () => {
  let hits = 0;
  const mock = await mockTavily((request, response) => {
    hits++;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { query } = JSON.parse(body);
      if (query === "auth") {
        response.statusCode = 401;
        response.end(JSON.stringify({ detail: { error: SECRET } }));
      } else if (query === "large") {
        response.end(`${SECRET}${"x".repeat(300 * 1024)}`);
      } else {
        response.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`not-json ${SECRET}`)]));
      }
    });
  });
  try {
    for (const [query, code, partial] of [["auth", "auth_failed", false], ["large", "response_too_large", true], ["bad", "malformed_response", false]] as const) {
      await assert.rejects(requestTavily(mock.deps, { query }), (error: unknown) => {
        assert.ok(error instanceof WebSearchError);
        assert.equal(error.code, code);
        assert.ok(error.capture);
        assert.equal(error.capture.partial, partial);
        assert.ok(error.capture.body.length <= 256 * 1024);
        assert.doesNotMatch(error.capture.body.toString(), new RegExp(SECRET));
        assert.doesNotMatch(error.message, new RegExp(SECRET));
        if (query === "bad") assert.deepEqual(error.capture.body.subarray(0, 2), Buffer.from([0xff, 0xfe]));
        return true;
      });
    }
    assert.equal(hits, 3);
  } finally {
    await mock.close();
  }
});

test("中断响应流保留已接收原文和partial状态，取消后不重发", async () => {
  let hits = 0;
  const controller = new AbortController();
  const mock = await mockTavily((_request, response) => {
    hits++;
    response.write(`{"results":[],"pending":"${SECRET}`);
    setTimeout(() => controller.abort(), 100);
  });
  try {
    await assert.rejects(requestTavily(mock.deps, { query: "q" }, controller.signal), (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "canceled");
      assert.equal(error.capture?.partial, true);
      assert.match(error.capture!.body.toString(), /pending/);
      assert.doesNotMatch(error.capture!.body.toString(), new RegExp(SECRET));
      return true;
    });
    assert.equal(hits, 1);
  } finally {
    await mock.close();
  }
});

test("未知参数在发请求前拒绝，目标拒绝user info且不回显凭据", async () => {
  let hits = 0;
  const mock = await mockTavily((_request, response) => { hits++; response.end("{}"); });
  try {
    await assert.rejects(requestTavily(mock.deps, { query: "q", api_key: SECRET }), (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "invalid_params");
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    });
    assert.equal(hits, 0);
    assert.throws(() => resolveTavilyTarget(`https://owner:${SECRET}@example.com`), (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "invalid_target");
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    });
    assert.equal(resolveTavilyTarget("http://[::1]:1234/foo").href, "http://[::1]:1234/search");
  } finally {
    await mock.close();
  }
});

for (const encoding of ["raw", "json", "url"] as const) test(`响应截界：${encoding}秘密的尾部前缀不会进入产物`, async () => {
  const secret = 'private-token/"?&rest', encoded = encoding === "json" ? JSON.stringify(secret).slice(1, -1) : encoding === "url" ? encodeURIComponent(secret) : secret;
  const prefix = encoded.slice(0, encoded.indexOf("rest")), fill = Buffer.alloc(256 * 1024 - Buffer.byteLength(prefix), 0x7a);
  const mock = await mockTavily((_request, response) => { response.end(Buffer.concat([fill, Buffer.from(encoded)])); });
  try {
    await assert.rejects(requestTavily({ ...mock.deps, credential: { header: "authorization", secret } }, { query: "q" }), (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "response_too_large");
      assert.equal(error.capture?.partial, true);
      assert.ok(error.capture!.body.length <= 256 * 1024);
      assert.ok(!error.capture!.body.includes(Buffer.from(prefix)));
      assert.ok(!error.capture!.body.includes(Buffer.from("private-token")));
      assert.ok(error.capture!.body.subarray(0, fill.length).equals(fill));
      return true;
    });
  } finally { await mock.close(); }
});

for (const encoding of ["raw", "json", "url"] as const) test(`响应流中断：${encoding}秘密的尾部前缀不会进入产物`, async () => {
  const secret = 'private-token/"?&rest', encoded = encoding === "json" ? JSON.stringify(secret).slice(1, -1) : encoding === "url" ? encodeURIComponent(secret) : secret;
  const prefix = encoded.slice(0, encoded.indexOf("rest")), controller = new AbortController();
  const mock = await mockTavily((_request, response) => {
    response.write(`original-bytes:${prefix}`);
    setTimeout(() => controller.abort(), 100);
  });
  try {
    await assert.rejects(requestTavily({ ...mock.deps, credential: { header: "authorization", secret } }, { query: "q" }, controller.signal), (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "canceled");
      assert.equal(error.capture?.partial, true);
      assert.equal(error.capture!.body.toString(), "original-bytes:[REDACTED]");
      return true;
    });
  } finally { await mock.close(); }
});
