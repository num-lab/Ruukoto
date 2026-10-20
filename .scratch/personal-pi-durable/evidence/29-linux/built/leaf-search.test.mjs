// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/web-search-transport.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as http from "node:http";

// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/packages/agent/src/web-search-transport.ts
var TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
var QUERY_CAP_CHARS = 500;
var MAX_RESULTS_CAP = 5;
var DEFAULT_TIMEOUT_MS = 15e3;
var RESPONSE_CAP_BYTES = 256 * 1024;
var TITLE_CAP_CHARS = 300;
var URL_CAP_CHARS = 2048;
var CONTENT_CAP_CHARS = 2e3;
var DATE_CAP_CHARS = 100;
var DOMAIN_LIST_CAP = 20;
var ERROR_DETAIL_CAP = 300;
var WebSearchError = class extends Error {
  constructor(code, message, capture) {
    super(message);
    this.capture = capture;
    this.code = code;
  }
  capture;
  code;
};
var ALLOWED_KEYS = /* @__PURE__ */ new Set(["query", "topic", "time_range", "include_domains", "max_results", "search_depth"]);
var TIME_RANGES = /* @__PURE__ */ new Set(["day", "week", "month", "year"]);
var SEARCH_DEPTHS = /* @__PURE__ */ new Set(["basic", "fast", "ultra-fast"]);
function isDomain(value) {
  if (value.length > 100 || !value.includes(".")) return false;
  return value.split(".").every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label));
}
function validateParams(params) {
  for (const key of Object.keys(params)) {
    if (!ALLOWED_KEYS.has(key)) throw new WebSearchError("invalid_params", `\u672A\u77E5\u53C2\u6570\uFF1A${key}\uFF08\u4EC5\u5F00\u653E ${[...ALLOWED_KEYS].join("/")}\uFF09`);
  }
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) throw new WebSearchError("invalid_params", "query \u4E0D\u80FD\u4E3A\u7A7A");
  if (query.length > QUERY_CAP_CHARS) {
    throw new WebSearchError("invalid_params", `query \u8D85\u957F\uFF08${query.length} \u5B57\u7B26 > \u4E0A\u9650 ${QUERY_CAP_CHARS}\uFF09`);
  }
  const topic = params.topic === void 0 ? "general" : String(params.topic);
  if (topic !== "general" && topic !== "news") {
    throw new WebSearchError("invalid_params", `topic \u53EA\u652F\u6301 general/news\uFF1A${topic}`);
  }
  let timeRange;
  if (params.time_range !== void 0) {
    timeRange = String(params.time_range);
    if (!TIME_RANGES.has(timeRange)) {
      throw new WebSearchError("invalid_params", `time_range \u53EA\u652F\u6301 day/week/month/year\uFF1A${timeRange}`);
    }
  }
  let includeDomains;
  if (params.include_domains !== void 0) {
    if (!Array.isArray(params.include_domains) || params.include_domains.some((d) => typeof d !== "string")) {
      throw new WebSearchError("invalid_params", "include_domains \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
    }
    const domains = params.include_domains.map((d) => d.trim().toLowerCase());
    if (domains.length > DOMAIN_LIST_CAP) {
      throw new WebSearchError("invalid_params", `include_domains \u6700\u591A ${DOMAIN_LIST_CAP} \u4E2A\uFF08\u6536\u5230 ${domains.length}\uFF09`);
    }
    const bad = domains.find((d) => !isDomain(d));
    if (bad !== void 0) {
      throw new WebSearchError("invalid_params", `include_domains \u53EA\u63A5\u53D7\u88F8\u57DF\u540D\uFF08\u4E0D\u542B\u534F\u8BAE/\u8DEF\u5F84/\u7AEF\u53E3\uFF09\uFF1A${bad}`);
    }
    includeDomains = domains;
  }
  let maxResults = MAX_RESULTS_CAP;
  if (params.max_results !== void 0) {
    const n = Number(params.max_results);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RESULTS_CAP) {
      throw new WebSearchError("invalid_params", `max_results \u5FC5\u987B\u662F 1-${MAX_RESULTS_CAP} \u7684\u6574\u6570\uFF1A${String(params.max_results)}`);
    }
    maxResults = n;
  }
  const searchDepth = params.search_depth === void 0 ? "basic" : String(params.search_depth);
  if (!SEARCH_DEPTHS.has(searchDepth)) {
    throw new WebSearchError("invalid_params", `search_depth \u53EA\u652F\u6301 basic/fast/ultra-fast\uFF1A${searchDepth}`);
  }
  return { query, topic, timeRange, includeDomains, maxResults, searchDepth };
}
function resolveTavilyTarget(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl ?? TAVILY_DEFAULT_BASE_URL);
  } catch {
    throw new WebSearchError("invalid_target", "Web Search \u76EE\u6807\u914D\u7F6E\u65E0\u6CD5\u89E3\u6790\uFF0C\u8BF7\u62E5\u6709\u8005\u68C0\u67E5\u914D\u7F6E");
  }
  if (url.username || url.password) throw new WebSearchError("invalid_target", "Web Search \u76EE\u6807\u4E0D\u63A5\u53D7 URL \u5185\u5D4C\u51ED\u636E\uFF0C\u8BF7\u62E5\u6709\u8005\u68C0\u67E5\u914D\u7F6E");
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new WebSearchError("invalid_target", `Web Search \u76EE\u6807\u5FC5\u987B\u662F https\uFF08http \u4EC5\u9650 loopback \u6D4B\u8BD5\uFF09\uFF1A${url.protocol}//${url.host}`);
  }
  return new URL("/search", url);
}
async function postSearch(target, cred, req, taskSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = taskSignal ? AbortSignal.any([taskSignal, timeoutSignal]) : timeoutSignal;
  const body = JSON.stringify({
    query: req.query,
    max_results: req.maxResults,
    search_depth: req.searchDepth,
    topic: req.topic,
    include_published_date: true,
    ...req.timeRange ? { time_range: req.timeRange } : {},
    ...req.includeDomains ? { include_domains: req.includeDomains } : {}
  });
  let res;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", [cred.header.toLowerCase()]: `Bearer ${cred.secret}` },
      body,
      signal,
      redirect: "error"
    });
  } catch (err) {
    throw classifyFetchError(err, timeoutSignal, taskSignal, timeoutMs);
  }
  const retryAfter = res.headers.get("retry-after");
  if (!res.body) return { status: res.status, retryAfter, body: Buffer.alloc(0), truncated: false };
  const chunks = [];
  let total = 0;
  let truncated = false;
  const reader = res.body.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (total + chunk.length > RESPONSE_CAP_BYTES) {
        chunks.push(chunk.subarray(0, RESPONSE_CAP_BYTES - total));
        truncated = true;
        await reader.cancel().catch(() => {
        });
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch (err) {
    const error = classifyFetchError(err, timeoutSignal, taskSignal, timeoutMs);
    throw new WebSearchError(error.code, error.message, { body: Buffer.concat(chunks), meta: { status: res.status, reason: error.code }, partial: true });
  }
  return { status: res.status, retryAfter, body: Buffer.concat(chunks), truncated };
}
function classifyFetchError(err, timeoutSignal, taskSignal, timeoutMs) {
  if (taskSignal?.aborted) return new WebSearchError("canceled", "\u4EFB\u52A1\u5DF2\u505C\u6B62\uFF0C\u641C\u7D22\u8BF7\u6C42\u5DF2\u4E2D\u6B62");
  if (timeoutSignal.aborted) return new WebSearchError("timeout", `\u8BF7\u6C42\u8D85\u8FC7 ${timeoutMs}ms \u8D85\u65F6\uFF08\u672A\u81EA\u52A8\u91CD\u8BD5\uFF09`);
  return new WebSearchError("unavailable", `\u8FDE\u63A5\u641C\u7D22\u670D\u52A1\u5931\u8D25\uFF1A${err.message}\uFF08\u672A\u81EA\u52A8\u91CD\u8BD5\uFF09`);
}
function extractDetail(bodyText, redact) {
  try {
    const data = JSON.parse(bodyText);
    const detail = data?.detail;
    const text = typeof detail?.error === "string" ? detail.error : detail ? JSON.stringify(detail) : "";
    const clean = cleanText(redact(text), ERROR_DETAIL_CAP);
    return clean ? `\uFF1A${clean}` : "";
  } catch {
    return "";
  }
}
function httpError(res, redact) {
  const detail = extractDetail(res.body.toString("utf8"), redact);
  switch (res.status) {
    case 400:
    case 422:
      return new WebSearchError("invalid_params", `\u641C\u7D22\u670D\u52A1\u62D2\u7EDD\u8BF7\u6C42\u53C2\u6570\uFF08HTTP ${res.status}\uFF09${detail}`);
    case 401:
      return new WebSearchError("auth_failed", `\u641C\u7D22\u670D\u52A1\u8BA4\u8BC1\u5931\u8D25\uFF08HTTP 401\uFF09\uFF1A\u51ED\u636E\u65E0\u6548\u6216\u5DF2\u64A4\u9500\uFF0C\u8BF7\u62E5\u6709\u8005\u68C0\u67E5 credentials \u914D\u7F6E${detail}`);
    case 429:
      return new WebSearchError(
        "rate_limited",
        `\u641C\u7D22\u670D\u52A1\u9650\u6D41\uFF08HTTP 429${res.retryAfter ? `\uFF0C\u670D\u52A1\u5EFA\u8BAE ${cleanText(redact(res.retryAfter), ERROR_DETAIL_CAP)}s \u540E\u91CD\u8BD5` : ""}\uFF09\uFF1B\u672C\u5DE5\u5177\u4E0D\u81EA\u52A8\u91CD\u8BD5${detail}`
      );
    case 432:
    case 433:
      return new WebSearchError("quota_exceeded", `\u641C\u7D22\u670D\u52A1\u914D\u989D/\u5957\u9910\u4E0A\u9650\uFF08HTTP ${res.status}\uFF09${detail}`);
    default:
      if (res.status >= 500) return new WebSearchError("service_error", `\u641C\u7D22\u670D\u52A1\u5185\u90E8\u9519\u8BEF\uFF08HTTP ${res.status}\uFF09${detail}`);
      return new WebSearchError("unexpected_status", `\u641C\u7D22\u670D\u52A1\u8FD4\u56DE\u975E\u9884\u671F\u72B6\u6001 HTTP ${res.status}${detail}`);
  }
}
function cleanText(value, cap) {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, cap);
}
function cleanUrl(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > URL_CAP_CHARS) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return text;
  } catch {
    return null;
  }
}
async function requestTavily(deps, params, signal) {
  const cred = deps.credential;
  const secretForms = /* @__PURE__ */ new Set([cred.secret, JSON.stringify(cred.secret).slice(1, -1), encodeURIComponent(cred.secret)]);
  const redact = (text) => {
    for (const secret of secretForms) if (secret) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  };
  const redactBody = (body, partial = false) => {
    let secretSuffix = false;
    if (partial) for (const secret of secretForms) {
      const needle = Buffer.from(secret);
      for (let length = Math.min(body.length, needle.length - 1); length > 0; length--) {
        if (body.subarray(body.length - length).equals(needle.subarray(0, length))) {
          body = body.subarray(0, body.length - length);
          secretSuffix = true;
          break;
        }
      }
    }
    for (const secret of secretForms) {
      if (!secret) continue;
      const needle = Buffer.from(secret);
      const chunks = [];
      let offset = 0;
      let match;
      while ((match = body.indexOf(needle, offset)) !== -1) {
        chunks.push(body.subarray(offset, match), Buffer.from("[REDACTED]"));
        offset = match + needle.length;
      }
      if (offset) body = Buffer.concat([...chunks, body.subarray(offset)]);
    }
    return secretSuffix ? Buffer.concat([body, Buffer.from("[REDACTED]")]) : body;
  };
  const queriedAt = (/* @__PURE__ */ new Date()).toISOString();
  try {
    if (!cred.secret) throw new WebSearchError("not_configured", "Web Search \u51ED\u636E\u4E3A\u7A7A\uFF0C\u8BF7\u62E5\u6709\u8005\u68C0\u67E5\u914D\u7F6E");
    const req = validateParams(params);
    const target = resolveTavilyTarget(deps.baseUrl);
    const res = await postSearch(target, cred, req, signal, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const capture = (reason) => {
      const body = redactBody(res.body, res.truncated);
      return {
        body: body.subarray(0, RESPONSE_CAP_BYTES),
        meta: { target: redact(target.host), queriedAt, status: res.status, reason },
        partial: res.truncated || body.length > RESPONSE_CAP_BYTES
      };
    };
    if (res.status !== 200) {
      const error = httpError(res, redact);
      throw new WebSearchError(error.code, error.message, capture(error.code));
    }
    if (res.truncated) {
      throw new WebSearchError("response_too_large", `\u641C\u7D22\u54CD\u5E94\u8D85\u8FC7 ${RESPONSE_CAP_BYTES} \u5B57\u8282\u4E0A\u9650\uFF0C\u5DF2\u622A\u65AD\uFF08\u672A\u89E3\u6790\u3001\u672A\u8FD4\u56DE\u90E8\u5206\u5185\u5BB9\uFF09`, capture("response_cap"));
    }
    let data;
    try {
      data = JSON.parse(res.body.toString("utf8"), (_key, value) => typeof value === "string" ? redact(value) : value);
    } catch {
      throw new WebSearchError("malformed_response", "\u641C\u7D22\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON", capture("malformed_json"));
    }
    if (!data || !Array.isArray(data.results)) {
      throw new WebSearchError("malformed_response", "\u641C\u7D22\u54CD\u5E94\u7F3A\u5C11 results \u6570\u7EC4", capture("missing_results"));
    }
    const items = [];
    let dropped = 0;
    let fieldsTruncated = false;
    for (const raw of data.results.slice(0, req.maxResults)) {
      const url = cleanUrl(raw?.url);
      if (!url || url.includes("[REDACTED]")) {
        dropped++;
        continue;
      }
      if (typeof raw?.title === "string" && raw.title.length > TITLE_CAP_CHARS) fieldsTruncated = true;
      if (typeof raw?.content === "string" && raw.content.length > CONTENT_CAP_CHARS) fieldsTruncated = true;
      items.push({
        url,
        title: cleanText(raw?.title, TITLE_CAP_CHARS) || "\uFF08\u65E0\u6807\u9898\uFF09",
        summary: cleanText(raw?.content, CONTENT_CAP_CHARS),
        publishedAt: cleanText(raw?.published_date, DATE_CAP_CHARS) || null
      });
    }
    const captured = capture("complete");
    return {
      response: captured.body,
      partial: captured.partial,
      result: {
        queriedAt,
        requestId: cleanText(data.request_id, 100) || null,
        items,
        params: JSON.parse(JSON.stringify(req), (_key, value) => typeof value === "string" ? redact(value) : value),
        dropped,
        fieldsTruncated,
        totalResults: data.results.length
      }
    };
  } catch (err) {
    if (err instanceof WebSearchError) {
      const capture = err.capture ? { ...err.capture, body: redactBody(err.capture.body, err.capture.partial).subarray(0, RESPONSE_CAP_BYTES), meta: { ...err.capture.meta, queriedAt } } : void 0;
      throw new WebSearchError(err.code, redact(err.message), capture);
    }
    throw new WebSearchError("unavailable", `\u641C\u7D22\u5931\u8D25\uFF1A${redact(err.message)}`);
  }
}

// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/web-search-transport.test.ts
var SECRET = "tavily-private-key";
async function mockTavily(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    deps: { baseUrl: `http://127.0.0.1:${server.address().port}`, credential: { header: "authorization", secret: SECRET } },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
test("\u65E0\u72B6\u6001\u641C\u7D22\u4FDD\u7559\u5B57\u6BB5\u622A\u65AD\u524D\u7684\u5B8C\u6574\u539F\u54CD\u5E94\uFF0C\u51ED\u636E\u53EA\u7528\u4E8E\u8BA4\u8BC1", async () => {
  const longSummary = "\u6458\u8981".repeat(2e3);
  const payload = JSON.stringify({
    request_id: "request-1",
    results: [
      { title: "\u7ED3\u679C", url: "https://example.com/source", content: `${longSummary}${SECRET}`, published_date: "2026-10-17" },
      { title: "\u51ED\u636E\u56DE\u663E\u5730\u5740", url: `https://example.com/${SECRET}`, content: "x" },
      { title: "\u7B2C\u4E09\u6761", url: "https://example.com/third", content: "\u4FDD\u7559\u5728\u539F\u54CD\u5E94" }
    ],
    provider_metadata: "\u539F\u59CB\u989D\u5916\u5B57\u6BB5"
  });
  let hits = 0;
  const mock = await mockTavily((request, response) => {
    hits++;
    assert.equal(request.url, "/search");
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), {
        query: "\u65B0\u95FB",
        max_results: 2,
        search_depth: "fast",
        topic: "news",
        include_published_date: true,
        time_range: "day",
        include_domains: ["example.com"]
      });
      response.end(payload);
    });
  });
  try {
    const captured = await requestTavily(mock.deps, {
      query: " \u65B0\u95FB ",
      topic: "news",
      max_results: 2,
      search_depth: "fast",
      time_range: "day",
      include_domains: ["EXAMPLE.COM"]
    });
    assert.equal(hits, 1);
    assert.equal(captured.partial, false);
    assert.equal(captured.result.items.length, 1);
    assert.equal(captured.result.items[0].summary.length, 2e3);
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
test("\u9519\u8BEF\u54CD\u5E94\u3001\u8D85\u9650\u548C\u975E\u6CD5JSON\u4FDD\u7559\u6709\u754C\u8131\u654F\u539F\u54CD\u5E94\uFF0C\u4E0D\u91CD\u8BD5", async () => {
  let hits = 0;
  const mock = await mockTavily((request, response) => {
    hits++;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const { query } = JSON.parse(body);
      if (query === "auth") {
        response.statusCode = 401;
        response.end(JSON.stringify({ detail: { error: SECRET } }));
      } else if (query === "large") {
        response.end(`${SECRET}${"x".repeat(300 * 1024)}`);
      } else {
        response.end(Buffer.concat([Buffer.from([255, 254]), Buffer.from(`not-json ${SECRET}`)]));
      }
    });
  });
  try {
    for (const [query, code, partial] of [["auth", "auth_failed", false], ["large", "response_too_large", true], ["bad", "malformed_response", false]]) {
      await assert.rejects(requestTavily(mock.deps, { query }), (error) => {
        assert.ok(error instanceof WebSearchError);
        assert.equal(error.code, code);
        assert.ok(error.capture);
        assert.equal(error.capture.partial, partial);
        assert.ok(error.capture.body.length <= 256 * 1024);
        assert.doesNotMatch(error.capture.body.toString(), new RegExp(SECRET));
        assert.doesNotMatch(error.message, new RegExp(SECRET));
        if (query === "bad") assert.deepEqual(error.capture.body.subarray(0, 2), Buffer.from([255, 254]));
        return true;
      });
    }
    assert.equal(hits, 3);
  } finally {
    await mock.close();
  }
});
test("\u4E2D\u65AD\u54CD\u5E94\u6D41\u4FDD\u7559\u5DF2\u63A5\u6536\u539F\u6587\u548Cpartial\u72B6\u6001\uFF0C\u53D6\u6D88\u540E\u4E0D\u91CD\u53D1", async () => {
  let hits = 0;
  const controller = new AbortController();
  const mock = await mockTavily((_request, response) => {
    hits++;
    response.write(`{"results":[],"pending":"${SECRET}`);
    setTimeout(() => controller.abort(), 100);
  });
  try {
    await assert.rejects(requestTavily(mock.deps, { query: "q" }, controller.signal), (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "canceled");
      assert.equal(error.capture?.partial, true);
      assert.match(error.capture.body.toString(), /pending/);
      assert.doesNotMatch(error.capture.body.toString(), new RegExp(SECRET));
      return true;
    });
    assert.equal(hits, 1);
  } finally {
    await mock.close();
  }
});
test("\u672A\u77E5\u53C2\u6570\u5728\u53D1\u8BF7\u6C42\u524D\u62D2\u7EDD\uFF0C\u76EE\u6807\u62D2\u7EDDuser info\u4E14\u4E0D\u56DE\u663E\u51ED\u636E", async () => {
  let hits = 0;
  const mock = await mockTavily((_request, response) => {
    hits++;
    response.end("{}");
  });
  try {
    await assert.rejects(requestTavily(mock.deps, { query: "q", api_key: SECRET }), (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "invalid_params");
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    });
    assert.equal(hits, 0);
    assert.throws(() => resolveTavilyTarget(`https://owner:${SECRET}@example.com`), (error) => {
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
for (const encoding of ["raw", "json", "url"]) test(`\u54CD\u5E94\u622A\u754C\uFF1A${encoding}\u79D8\u5BC6\u7684\u5C3E\u90E8\u524D\u7F00\u4E0D\u4F1A\u8FDB\u5165\u4EA7\u7269`, async () => {
  const secret = 'private-token/"?&rest', encoded = encoding === "json" ? JSON.stringify(secret).slice(1, -1) : encoding === "url" ? encodeURIComponent(secret) : secret;
  const prefix = encoded.slice(0, encoded.indexOf("rest")), fill = Buffer.alloc(256 * 1024 - Buffer.byteLength(prefix), 122);
  const mock = await mockTavily((_request, response) => {
    response.end(Buffer.concat([fill, Buffer.from(encoded)]));
  });
  try {
    await assert.rejects(requestTavily({ ...mock.deps, credential: { header: "authorization", secret } }, { query: "q" }), (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "response_too_large");
      assert.equal(error.capture?.partial, true);
      assert.ok(error.capture.body.length <= 256 * 1024);
      assert.ok(!error.capture.body.includes(Buffer.from(prefix)));
      assert.ok(!error.capture.body.includes(Buffer.from("private-token")));
      assert.ok(error.capture.body.subarray(0, fill.length).equals(fill));
      return true;
    });
  } finally {
    await mock.close();
  }
});
for (const encoding of ["raw", "json", "url"]) test(`\u54CD\u5E94\u6D41\u4E2D\u65AD\uFF1A${encoding}\u79D8\u5BC6\u7684\u5C3E\u90E8\u524D\u7F00\u4E0D\u4F1A\u8FDB\u5165\u4EA7\u7269`, async () => {
  const secret = 'private-token/"?&rest', encoded = encoding === "json" ? JSON.stringify(secret).slice(1, -1) : encoding === "url" ? encodeURIComponent(secret) : secret;
  const prefix = encoded.slice(0, encoded.indexOf("rest")), controller = new AbortController();
  const mock = await mockTavily((_request, response) => {
    response.write(`original-bytes:${prefix}`);
    setTimeout(() => controller.abort(), 100);
  });
  try {
    await assert.rejects(requestTavily({ ...mock.deps, credential: { header: "authorization", secret } }, { query: "q" }, controller.signal), (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, "canceled");
      assert.equal(error.capture?.partial, true);
      assert.equal(error.capture.body.toString(), "original-bytes:[REDACTED]");
      return true;
    });
  } finally {
    await mock.close();
  }
});
