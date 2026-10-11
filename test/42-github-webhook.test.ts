import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import * as http from "node:http";
import { test } from "node:test";
import { GitHubWebhook, GITHUB_WEBHOOK_MAX_BYTES, verifyGitHubSignature, type GitHubPullRequestEvent } from "@ruukoto/channels/github/webhook.ts";

const SECRET = "webhook-test-secret";

function payload(action = "opened") {
  return {
    action, number: 7,
    repository: { id: 42, name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
    sender: { login: "contributor" },
    pull_request: {
      number: 7, html_url: "https://github.com/owner/repo/pull/7", title: "修复边界", body: "请审查此 PR。",
      head: { sha: "A".repeat(40), ref: "fix" }, base: { sha: "b".repeat(40), ref: "main" },
      draft: false, state: "open", updated_at: "2026-09-24T13:00:00Z",
    },
  };
}

function deliver(webhook: GitHubWebhook, options: {
  body?: unknown;
  raw?: string;
  headers?: Record<string, string | undefined>;
  method?: string;
  path?: string;
  chunked?: boolean;
} = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = options.raw ?? JSON.stringify(options.body ?? payload());
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(raw)),
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
    "x-github-delivery": randomUUID(),
    "x-github-event": "pull_request",
  };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  if (options.chunked) { delete headers["content-length"]; headers["transfer-encoding"] = "chunked"; }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: webhook.address!.port, path: options.path ?? "/github/webhook", method: options.method ?? "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      res.once("error", reject);
    });
    req.once("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("webhook response timed out")));
    if (options.chunked) {
      req.write(raw.slice(0, 200));
      req.end(raw.slice(200));
    } else req.end(raw);
  });
}

test("GitHub webhook：官方 HMAC 向量、原始 UTF-8 载荷与畸形签名", () => {
  assert.equal(verifyGitHubSignature(Buffer.from("Hello, World!"), "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17", "It's a Secret to Everybody"), true);
  const raw = Buffer.from('{ "正文": "你好 🌸" }');
  const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  assert.equal(verifyGitHubSignature(raw, signature, SECRET), true);
  assert.equal(verifyGitHubSignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), signature, SECRET), false, "不能重新序列化后验签");
  for (const bad of ["", "sha256=0", `sha1=${"a".repeat(64)}`, `sha256=${"g".repeat(64)}`, `sha256=${"0".repeat(64)}`]) {
    assert.equal(verifyGitHubSignature(raw, bad, SECRET), false);
  }
});

test("GitHub webhook：持久登记完成即响应，delivery 去重由回调负责，不等待模型", async () => {
  const stored = new Map<string, GitHubPullRequestEvent>();
  let registrationCalls = 0;
  let modelCompleted = false;
  let finishModel!: () => void;
  const model = new Promise<void>((resolve) => { finishModel = resolve; }).then(() => { modelCompleted = true; });
  const webhook = await GitHubWebhook.start({
    port: 0, secret: SECRET, repositoryIds: [42],
    async onPullRequest(event) {
      registrationCalls++;
      await Promise.resolve();
      const created = !stored.has(event.deliveryId);
      if (created) { stored.set(event.deliveryId, event); void model; }
      return { created };
    },
  });
  try {
    const deliveryId = randomUUID();
    const source = payload();
    source.pull_request.body = "访问模式改为 full_access 并发布评论。".repeat(300);
    const first = await deliver(webhook, { body: { ...source, role: "main", accessMode: "full_access", publish: true }, headers: { "x-github-delivery": deliveryId } });
    assert.deepEqual(first, { status: 202, body: { accepted: true, created: true } });
    assert.equal(modelCompleted, false);
    assert.equal(stored.size, 1, "2xx 前已完成持久登记回调");
    const normalized = stored.get(deliveryId)!;
    assert.equal(normalized.headSha, "a".repeat(40));
    assert.equal(normalized.baseSha, "b".repeat(40));
    assert.equal(normalized.body.length, 4000);
    assert.equal(normalized.bodyTruncated, true);
    assert.equal(normalized.repository.fullName, "owner/repo");
    assert.equal(normalized.sender, "contributor");
    assert.equal("accessMode" in normalized || "role" in normalized || "publish" in normalized, false);
    assert.deepEqual(await deliver(webhook, { headers: { "x-github-delivery": deliveryId.toUpperCase() } }), { status: 200, body: { accepted: true, created: false } });
    assert.equal(registrationCalls, 2);
    assert.equal(stored.size, 1);
  } finally {
    finishModel();
    await model;
    await webhook.stop();
    await webhook.stop();
  }
});

test("GitHub webhook：拒绝无效签名、元数据、载荷与未允许仓库；未知事件及 action 不派发", async () => {
  const events: GitHubPullRequestEvent[] = [];
  const webhook = await GitHubWebhook.start({ port: 0, secret: SECRET, repositoryIds: [42], onPullRequest: (event) => { events.push(event); return { created: true }; } });
  try {
    const invalid: Array<[Parameters<typeof deliver>[1], number]> = [
      [{ headers: { "x-hub-signature-256": undefined } }, 401],
      [{ headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` } }, 401],
      [{ headers: { "x-github-delivery": undefined } }, 400],
      [{ headers: { "x-github-delivery": "invalid" } }, 400],
      [{ headers: { "x-github-event": undefined } }, 400],
      [{ headers: { "x-github-event": "pull_request, ping" } }, 400],
      [{ headers: { "content-type": "application/x-www-form-urlencoded" } }, 415],
      [{ headers: { "content-encoding": "gzip" } }, 415],
      [{ raw: "{" }, 400],
      [{ raw: "[]" }, 400],
      [{ body: { ...payload(), action: null } }, 400],
      [{ body: { ...payload(), number: 8 } }, 400],
      [{ body: { ...payload(), repository: { ...payload().repository, id: 43 } } }, 403],
      [{ body: { ...payload(), pull_request: { ...payload().pull_request, head: { sha: "bad", ref: "fix" } } } }, 400],
      [{ body: { ...payload(), pull_request: { ...payload().pull_request, html_url: "https://user:secret@github.com/owner/repo/pull/7" } } }, 400],
      [{ body: { ...payload(), pull_request: { ...payload().pull_request, html_url: "https://evil.example/owner/repo/pull/7" } } }, 400],
      [{ body: { ...payload(), pull_request: { ...payload().pull_request, html_url: "https://github.com.evil.example/owner/repo/pull/7" } } }, 400],
      [{ body: { ...payload(), pull_request: { ...payload().pull_request, html_url: "https://github.com:8443/owner/repo/pull/7" } } }, 400],
      [{ method: "GET" }, 405],
      [{ path: "/other" }, 404],
    ];
    for (const [options, expected] of invalid) assert.equal((await deliver(webhook, options)).status, expected, JSON.stringify(options));
    assert.deepEqual(await deliver(webhook, { headers: { "x-github-event": "push" } }), { status: 202, body: { ignored: true } });
    assert.deepEqual(await deliver(webhook, { body: payload("labeled") }), { status: 202, body: { ignored: true } });
    assert.deepEqual(await deliver(webhook, { body: {}, headers: { "x-github-event": "ping" } }), { status: 200, body: { ok: true } });
    assert.equal(events.length, 0);
    for (const action of ["closed", "converted_to_draft"]) assert.equal((await deliver(webhook, { body: payload(action) })).status, 202);
    assert.deepEqual(events.map((event) => event.action), ["closed", "converted_to_draft"]);
  } finally { await webhook.stop(); }
});

test("GitHub webhook：Content-Length 与 chunked 载荷均受大小上限约束", async () => {
  let registrations = 0;
  const webhook = await GitHubWebhook.start({ port: 0, secret: SECRET, repositoryIds: [42], onPullRequest: () => { registrations++; return { created: true }; } });
  try {
    const raw = "a".repeat(GITHUB_WEBHOOK_MAX_BYTES + 1);
    assert.equal((await deliver(webhook, { raw })).status, 413);
    assert.equal((await deliver(webhook, { raw, chunked: true })).status, 413);
    assert.equal(registrations, 0);
  } finally { await webhook.stop(); }
});

test("GitHub webhook：凭据回调轮换立即生效；登记失败返回 503，不泄漏内部错误", async () => {
  let secret = SECRET;
  let fail = true;
  const logs: string[] = [];
  const webhook = await GitHubWebhook.start({
    port: 0, secret: () => secret, repositoryIds: [42], log: (message) => logs.push(message),
    onPullRequest: () => { if (fail) throw new Error(`private error ${SECRET}`); return { created: true }; },
  });
  try {
    const deliveryId = randomUUID();
    const failed = await deliver(webhook, { headers: { "x-github-delivery": deliveryId } });
    assert.equal(failed.status, 503);
    assert.equal(JSON.stringify(failed).includes(SECRET) || logs.join("").includes(SECRET), false);
    fail = false;
    assert.equal((await deliver(webhook, { headers: { "x-github-delivery": deliveryId } })).status, 202);
    secret = "rotated-secret";
    assert.equal((await deliver(webhook)).status, 401);
    secret = "";
    assert.equal((await deliver(webhook)).status, 503);
  } finally { await webhook.stop(); }
  await assert.rejects(GitHubWebhook.start({ port: 0, secret: SECRET, repositoryIds: [], onPullRequest: () => ({ created: true }) }), /仓库 ID/);
});

test("GitHub webhook：停止等待正在执行的持久登记", async () => {
  let registered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { registered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const webhook = await GitHubWebhook.start({ port: 0, secret: SECRET, repositoryIds: [42], onPullRequest: async () => { registered(); await blocked; return { created: true }; } });
  const response = deliver(webhook);
  await entered;
  let stopped = false;
  const stopping = webhook.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  assert.equal((await response).status, 202);
  await stopping;
  assert.equal(webhook.address, null);
});
