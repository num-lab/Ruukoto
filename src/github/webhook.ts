/**
 * GitHub webhook 传输入口：验证原始载荷签名并登记 PR 快照，不持有任务或发布能力。
 * onPullRequest 必须只持久登记；delivery 去重与异步派发由宿主入站事件处理。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const GITHUB_SOURCE = "github";
export const GITHUB_WEBHOOK_PATH = "/github/webhook";
export const GITHUB_WEBHOOK_MAX_BYTES = 1024 * 1024;
export const GITHUB_PR_ACTIONS = ["opened", "reopened", "synchronize", "ready_for_review", "edited", "closed", "converted_to_draft"] as const;
export type GitHubPullRequestAction = (typeof GITHUB_PR_ACTIONS)[number];

/** 全部字段均为外部资料；身份、角色、工具与发布策略只能由宿主决定。 */
export interface GitHubPullRequestEvent {
  deliveryId: string;
  action: GitHubPullRequestAction;
  repository: { id: number; owner: string; name: string; fullName: string };
  number: number;
  url: string;
  title: string;
  body: string;
  bodyTruncated: boolean;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  sender: string | null;
  draft: boolean;
  state: "open" | "closed";
  updatedAt: string;
}

export interface GitHubWebhookOptions {
  port: number;
  host?: string;
  path?: string;
  /** 生产由宿主从 CredentialStore 读取；不放进 argv、任务或 worker 环境。 */
  secret: string | (() => string);
  /** 宿主固定的仓库 ID 允许列表；payload 不能扩大范围。 */
  repositoryIds: readonly number[];
  /** 仅在持久登记完成后返回。不能等待模型或子任务完成。 */
  onPullRequest(event: GitHubPullRequestEvent): { created: boolean } | Promise<{ created: boolean }>;
  log?(message: string): void;
}

class WebhookError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebhookError(400, "Invalid payload");
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > max) throw new WebhookError(400, "Invalid payload");
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new WebhookError(400, "Invalid payload");
  return value;
}

function revision(value: unknown): string {
  const sha = text(value, 64);
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha)) throw new WebhookError(400, "Invalid revision");
  return sha.toLowerCase();
}

function normalizePullRequest(payload: Record<string, unknown>, deliveryId: string, action: GitHubPullRequestAction): GitHubPullRequestEvent {
  const repo = object(payload.repository);
  const pr = object(payload.pull_request);
  const head = object(pr.head);
  const base = object(pr.base);
  const owner = text(object(repo.owner).login, 100);
  const name = text(repo.name, 100);
  if (![owner, name].every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..")) throw new WebhookError(400, "Invalid repository");
  const fullName = `${owner}/${name}`;
  if (repo.full_name !== fullName) throw new WebhookError(400, "Invalid repository");
  const number = positiveInteger(payload.number);
  if (pr.number !== number) throw new WebhookError(400, "Invalid pull request number");
  const url = text(pr.html_url, 2048);
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { throw new WebhookError(400, "Invalid pull request URL"); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.host !== "github.com" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || parsedUrl.pathname !== `/${fullName}/pull/${number}`) {
    throw new WebhookError(400, "Invalid pull request URL");
  }
  const title = text(pr.title, 4096).slice(0, 512);
  const body = pr.body === null ? "" : text(pr.body, GITHUB_WEBHOOK_MAX_BYTES, true);
  const updatedAt = text(pr.updated_at, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) throw new WebhookError(400, "Invalid updated_at");
  if (typeof pr.draft !== "boolean" || (pr.state !== "open" && pr.state !== "closed")) throw new WebhookError(400, "Invalid pull request state");
  return {
    deliveryId, action,
    repository: { id: positiveInteger(repo.id), owner, name, fullName },
    number, url: parsedUrl.href, title, body: body.slice(0, 4000), bodyTruncated: body.length > 4000,
    headSha: revision(head.sha), baseSha: revision(base.sha),
    headRef: text(head.ref, 1024), baseRef: text(base.ref, 1024),
    sender: payload.sender == null ? null : text(object(payload.sender).login, 100),
    draft: pr.draft, state: pr.state, updatedAt,
  };
}

/** 不重编码原始 bytes；长度先验证，再作等长常量时间比较。 */
export function verifyGitHubSignature(body: Buffer, signature: string, secret: string): boolean {
  if (!secret || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(body).digest(), Buffer.from(signature.slice(7), "hex"));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: Error) => { cleanup(); req.resume(); reject(error); };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > GITHUB_WEBHOOK_MAX_BYTES) fail(new WebhookError(413, "Payload too large"));
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = () => fail(new WebhookError(400, "Incomplete request"));
    const onAborted = () => fail(new WebhookError(400, "Incomplete request"));
    req.on("data", onData).once("end", onEnd).once("error", onError).once("aborted", onAborted);
  });
}

function respond(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export class GitHubWebhook {
  private readonly server: http.Server;
  private readonly repositoryIds: Set<number>;
  private readonly pending = new Set<Promise<void>>();
  private stopping: Promise<void> | null = null;
  private readonly path: string;

  private constructor(private readonly options: GitHubWebhookOptions) {
    this.path = options.path ?? GITHUB_WEBHOOK_PATH;
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("GitHub webhook port 无效");
    if (!this.path.startsWith("/") || /[?#\r\n]/.test(this.path)) throw new Error("GitHub webhook path 无效");
    if (typeof options.secret !== "function" && (typeof options.secret !== "string" || !options.secret)) throw new Error("GitHub webhook secret 不能为空");
    if (!options.repositoryIds.length || options.repositoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("GitHub webhook 必须配置有效的仓库 ID 允许列表");
    this.repositoryIds = new Set(options.repositoryIds);
    this.server = http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (req, res) => {
      req.on("error", () => {});
      res.on("error", () => {});
      const pending = this.receive(req, res).catch((error: unknown) => {
        if (!(error instanceof WebhookError)) this.options.log?.("GitHub webhook 持久登记失败");
        respond(res, error instanceof WebhookError ? error.status : 503, { error: error instanceof WebhookError ? error.message : "Registration unavailable" });
        req.resume();
      });
      this.pending.add(pending);
      void pending.finally(() => this.pending.delete(pending));
    });
  }

  static async start(options: GitHubWebhookOptions): Promise<GitHubWebhook> {
    const webhook = new GitHubWebhook(options);
    await new Promise<void>((resolve, reject) => {
      webhook.server.once("error", reject);
      webhook.server.listen(options.port, options.host ?? "127.0.0.1", () => {
        webhook.server.off("error", reject);
        resolve();
      });
    });
    webhook.server.on("error", () => options.log?.("GitHub webhook HTTP server error"));
    return webhook;
  }

  get address(): AddressInfo | null { return this.server.address() as AddressInfo | null; }

  /** 先停止接收，排空登记回调；慢上传最多等待一秒，停止后不会再写入宿主存储。 */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => this.server.closeAllConnections(), 1000);
          timer.unref();
          this.server.close(() => { clearTimeout(timer); resolve(); });
        });
        await Promise.allSettled([...this.pending]);
      })();
    }
    return this.stopping;
  }

  private async receive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.stopping) throw new WebhookError(503, "Shutting down");
    if (req.url !== this.path) throw new WebhookError(404, "Not found");
    if (req.method !== "POST") throw new WebhookError(405, "POST required");
    const signature = req.headers["x-hub-signature-256"];
    if (typeof signature !== "string" || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) throw new WebhookError(401, "Invalid signature");
    const deliveryId = req.headers["x-github-delivery"];
    if (typeof deliveryId !== "string" || !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(deliveryId)) throw new WebhookError(400, "Invalid delivery ID");
    const event = req.headers["x-github-event"];
    if (typeof event !== "string" || !/^[a-z][a-z_]{0,63}$/.test(event)) throw new WebhookError(400, "Invalid event");
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "") || req.headers["content-encoding"]) throw new WebhookError(415, "JSON required");
    if (Number(req.headers["content-length"]) > GITHUB_WEBHOOK_MAX_BYTES) throw new WebhookError(413, "Payload too large");
    const body = await readBody(req);
    const secret = typeof this.options.secret === "function" ? this.options.secret() : this.options.secret;
    if (typeof secret !== "string" || !secret) throw new WebhookError(503, "Webhook secret unavailable");
    if (!verifyGitHubSignature(body, signature, secret)) throw new WebhookError(401, "Invalid signature");
    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(body.toString("utf8"))); } catch { throw new WebhookError(400, "Invalid JSON payload"); }
    if (event === "ping") { respond(res, 200, { ok: true }); return; }
    if (event !== "pull_request") { respond(res, 202, { ignored: true }); return; }
    if (typeof payload.action !== "string" || !/^[a-z][a-z_]{0,63}$/.test(payload.action)) throw new WebhookError(400, "Invalid action");
    if (!(GITHUB_PR_ACTIONS as readonly string[]).includes(payload.action)) { respond(res, 202, { ignored: true }); return; }
    const normalized = normalizePullRequest(payload, deliveryId.toLowerCase(), payload.action as GitHubPullRequestAction);
    if (!this.repositoryIds.has(normalized.repository.id)) throw new WebhookError(403, "Repository not allowed");
    const result = await this.options.onPullRequest(normalized);
    respond(res, result.created ? 202 : 200, { accepted: true, created: result.created });
  }
}
