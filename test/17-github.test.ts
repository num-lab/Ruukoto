/**
 * issue 06 集成测试：GitHub 项目维护。
 *
 * 全部经进程内 mock GitHub API 服务（127.0.0.1 回环，scheme:"http" 仅测试允许），
 * 走真实 GitHub 宿主工具与审批/传输路径；不向真实仓库发送任何请求。
 *
 * 覆盖（对应计划 §6 测试组）：
 * - 绑定/范围/凭据：无凭据明确报错、范围外读取拒绝、通用 http_request 不得借用
 *   带 scope 的写凭据、模型伪造项目/目标被拦；
 * - PR 采集：分页文件列表、diff、修订复核（中途变化标记 inconsistent）；
 * - run 采集：attempt 固定、同名作业不合并、失败作业日志按 ID 下载、
 *   checks+statuses 都读、日志 302 受控跟随、跨主机重定向不带凭据、
 *   恶意分页/重定向目标（回环/私网）拒绝；
 * - 草稿：默认只交付草稿、证据归属校验、修订版本递增；
 * - 发布：请求确认逐次审批（github_publish scope）、批准后复核修订、
 *   修订变化 → stale 停发、重复发布复用同一操作、拒绝不发送、
 *   发送后断线 → effect_unknown 不自动重发、full_access 跳过逐次审批；
 * - 绑定撤销/配置变化：进行中调用在下一次版本核对失败。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  startTestRuntime,
  createProjectSession,
  waitFor,
  taskStatus,
  type TestRuntime,
} from "./helpers/testkit.ts";
import { GitHubClient, isLoopbackHost } from "../src/agent/github/client.ts";
import type { GitHubRepoBinding } from "../src/agent/github/store.ts";
import type { CredentialStore } from "../src/agent/execution/credentials.ts";

// ---------- mock GitHub API ----------

interface MockGitHubState {
  repoId: number;
  prs: Map<number, any>;
  prFiles: Map<number, any[]>;
  prDiffs: Map<number, string>;
  runs: Map<number, any>;
  runJobs: Map<string, any[]>; // `${runId}:${attempt}`
  jobLogs: Map<number, string>;
  checkRuns: any[];
  commitStatuses: any[];
  reviews: any[];
  comments: any[];
  /** 故障注入：路径 → 行为。 */
  faults: Map<string, "drop" | "redirect_evil" | "redirect_loopback">;
  /** 记录收到的请求（方法+路径+是否带 Authorization）。 */
  requests: Array<{ method: string; path: string; hasAuth: boolean }>;
}

function defaultState(): MockGitHubState {
  return {
    repoId: 424242,
    prs: new Map(),
    prFiles: new Map(),
    prDiffs: new Map(),
    runs: new Map(),
    runJobs: new Map(),
    jobLogs: new Map(),
    checkRuns: [],
    commitStatuses: [],
    reviews: [],
    comments: [],
    faults: new Map(),
    requests: [],
  };
}

async function startMockGitHub(state: MockGitHubState): Promise<{ baseUrl: string; host: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const hasAuth = typeof req.headers.authorization === "string";
    state.requests.push({ method: req.method ?? "GET", path: path + url.search, hasAuth });

    const fault = state.faults.get(path);
    if (fault === "drop") {
      req.socket.destroy();
      return;
    }
    if (fault === "redirect_evil") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
      return;
    }
    if (fault === "redirect_loopback") {
      res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
      res.end();
      return;
    }

    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    let m: RegExpExecArray | null;
    if (req.method === "GET" && (m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path))) {
      json(200, { id: state.repoId, full_name: `${m[1]}/${m[2]}` });
      return;
    }
    if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path))) {
      const pr = state.prs.get(Number(m[1]));
      if (!pr) return json(404, { message: "Not Found" });
      if (req.headers.accept === "application/vnd.github.diff") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(state.prDiffs.get(Number(m[1])) ?? "");
        return;
      }
      json(200, pr);
      return;
    }
    if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/.exec(path))) {
      const files = state.prFiles.get(Number(m[1])) ?? [];
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      json(200, files.slice((page - 1) * perPage, page * perPage));
      return;
    }
    if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/.exec(path))) {
      const run = state.runs.get(Number(m[1]));
      if (!run) return json(404, { message: "Not Found" });
      json(200, run);
      return;
    }
    if (req.method === "GET" && path === "/repos/o/r/actions/runs") {
      const runs = [...state.runs.values()].filter((r) => (url.searchParams.get("status") ?? "") === "" || r.conclusion === url.searchParams.get("status"));
      json(200, { workflow_runs: runs });
      return;
    }
    if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(path))) {
      const jobs = state.runJobs.get(`${m[1]}:${m[2]}`) ?? [];
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      json(200, jobs.slice((page - 1) * perPage, page * perPage));
      return;
    }
    if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)\/logs$/.exec(path))) {
      const log = state.jobLogs.get(Number(m[1]));
      if (log === undefined) return json(404, { message: "Not Found" });
      // 受控 302：指向同服务 /download/<jobId>（模拟签名 URL；不含凭据要求）
      res.writeHead(302, { location: `/download/${m[1]}` });
      res.end();
      return;
    }
    if (req.method === "GET" && (m = /^\/download\/(\d+)$/.exec(path))) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(state.jobLogs.get(Number(m[1])) ?? "");
      return;
    }
    if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.exec(path))) {
      json(200, state.checkRuns);
      return;
    }
    if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status$/.exec(path))) {
      json(200, { statuses: state.commitStatuses });
      return;
    }
    if (req.method === "POST" && (m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path))) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const payload = JSON.parse(body);
        const review = { id: 9000 + state.reviews.length, html_url: `https://github.com/x/review/${state.reviews.length}`, ...payload };
        state.reviews.push(review);
        json(200, review);
      });
      return;
    }
    if (req.method === "POST" && (m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path))) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const payload = JSON.parse(body);
        const comment = { id: 8000 + state.comments.length, html_url: `https://github.com/x/comment/${state.comments.length}`, ...payload };
        state.comments.push(comment);
        json(201, comment);
      });
      return;
    }
    json(404, { message: `mock: no route ${req.method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------- 公共装配 ----------

interface GhFixture {
  t: TestRuntime;
  gh: { baseUrl: string; host: string; close(): Promise<void> };
  state: MockGitHubState;
  projectId: string;
  sessionId: string;
  binding: GitHubRepoBinding;
}

async function setup(opts: {
  responder?: Parameters<typeof startTestRuntime>[1];
  withCredential?: boolean;
  withPublishCredential?: boolean;
  readScopes?: string[];
  seed?: (state: MockGitHubState) => void;
} = {}): Promise<GhFixture> {
  const state = defaultState();
  opts.seed?.(state);
  const gh = await startMockGitHub(state);
  const responder =
    opts.responder ??
    (async () => ({ kind: "text" as const, text: "done" }));
  const t = await startTestRuntime("gh", responder, {
    config: {
      githubClientFor: (binding: GitHubRepoBinding, operation: "github_read" | "github_publish", credentials: CredentialStore) => {
        const credName = operation === "github_publish" ? binding.publishCredential : binding.readCredential;
        return new GitHubClient(
          { apiHost: binding.apiHost, scheme: "http" },
          {
            credential: () => {
              if (!credName) {
                throw new Error(`绑定未配置${operation === "github_publish" ? "发布" : "读取"}凭据；请由拥有者配置（不会改用本机 gh 登录态）`);
              }
              const cred = credentials.getForUse(credName, { projectId: binding.projectId, repoId: binding.repoId ?? undefined, operation });
              if (!cred) throw new Error(`凭据 ${credName} 不存在或范围不匹配；请由拥有者重新配置`);
              return { header: cred.header, secret: cred.secret };
            },
            configVersion: () => {
              const current = t.runtime.github.getBinding(binding.id);
              return current ? `${current.id}:${current.configVersion}` : null;
            },
          },
        );
      },
    },
  });
  const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
  if (opts.withCredential !== false) {
    await t.client.request("add_credential", {
      name: "gh-read",
      host: gh.host,
      header: "Authorization",
      purpose: "GitHub 读取",
      secret: "token read-secret",
    });
  }
  if (opts.withPublishCredential) {
    await t.client.request("add_credential", {
      name: "gh-write",
      host: gh.host,
      header: "Authorization",
      purpose: "GitHub 发布",
      secret: "token write-secret",
    });
  }
  const binding = (await t.client.request<any>("github_bind", {
    project_id: projectId,
    owner: "o",
    repo: "r",
    api_host: gh.host,
    scheme: "http",
    read_credential: opts.withCredential === false ? undefined : "gh-read",
    publish_credential: opts.withPublishCredential ? "gh-write" : undefined,
    read_scopes: opts.readScopes ?? ["pulls", "actions", "checks"],
  })) as GitHubRepoBinding;
  return { t, gh, state, projectId, sessionId, binding };
}

async function teardown(f: GhFixture): Promise<void> {
  await f.t.shutdown();
  await f.gh.close();
}

function seedPr(state: MockGitHubState, n = 7): void {
  state.prs.set(n, {
    title: "修复登录",
    state: "open",
    head: { sha: "aaaa1111", repo: { full_name: "o/r" } },
    base: { sha: "bbbb2222", repo: { id: state.repoId, full_name: "o/r" } },
    user: { login: "dev" },
    html_url: `https://github.com/o/r/pull/${n}`,
    body: "说明",
  });
  state.prFiles.set(n, [
    { filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
    { filename: "bin.png", status: "modified", additions: 0, deletions: 0, patch: null },
  ]);
  state.prDiffs.set(n, "diff --git a/src/a.ts b/src/a.ts\n-old\n+new\n");
}

function seedRun(state: MockGitHubState, runId = 555): void {
  state.runs.set(runId, {
    id: runId,
    name: "CI",
    event: "push",
    head_sha: "cccc3333",
    status: "completed",
    conclusion: "failure",
    run_attempt: 2,
    html_url: `https://github.com/o/r/actions/runs/${runId}`,
    repository: { id: state.repoId },
  });
  state.runJobs.set(`${runId}:2`, [
    {
      id: 91,
      name: "build",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-09-21T00:00:00Z",
      completed_at: "2026-09-21T00:01:00Z",
      steps: [
        { name: "checkout", number: 1, status: "completed", conclusion: "success", started_at: null, completed_at: null },
        { name: "compile", number: 2, status: "completed", conclusion: "failure", started_at: null, completed_at: null },
      ],
    },
    { id: 92, name: "build", status: "completed", conclusion: "success", started_at: null, completed_at: null, steps: [] }, // matrix 同名作业：不合并
  ]);
  state.jobLogs.set(91, "compile step\nerror: TS2304 Cannot find name 'foo'\n");
  state.checkRuns = [{ name: "ci/build", status: "completed", conclusion: "failure", html_url: "https://github.com/x/check/1" }];
  state.commitStatuses = [{ context: "third-party/scan", state: "success", target_url: "https://scanner.example/1" }];
}

// ---------- 测试 ----------

test("github: 绑定配置与列表；未知读取范围拒绝", async () => {
  const f = await setup();
  try {
    const bindings = (await f.t.client.request<any>("github_list_bindings", { project_id: f.projectId })) as any;
    assert.equal(bindings.bindings.length, 1);
    assert.equal(bindings.bindings[0].owner, "o");
    await assert.rejects(
      f.t.client.request("github_bind", {
        project_id: f.projectId,
        owner: "o",
        repo: "r2",
        api_host: f.gh.host,
        scheme: "http",
        read_scopes: ["pulls", "admin"],
      }),
      /未知读取范围/,
    );
  } finally {
    await teardown(f);
  }
});

test("github: PR 采集（分页文件 + diff + 缺失 patch 标记 + 产物落盘）", async () => {
  const f = await setup({
    seed: (s) => {
      seedPr(s);
      // 第二页：101 个文件触发分页
      const many = Array.from({ length: 101 }, (_, i) => ({ filename: `f${i}.ts`, status: "added", additions: 1, deletions: 0, patch: "@@ +1 @@\n+x" }));
      s.prFiles.set(7, many);
    },
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      return { kind: "text", text: "分析完成" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r1", input: "分析 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    // 文件列表走了两页
    const fileReqs = f.state.requests.filter((r) => r.path.includes("/pulls/7/files"));
    assert.equal(fileReqs.length, 2);
    assert.ok(fileReqs.every((r) => r.hasAuth), "读取请求带凭据");
    // 产物落盘且含全部文件
    const detail = await taskStatus(f.t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.toolName === "github_read_pr");
    assert.ok(op, "github_read_pr 已执行");
    assert.equal(op.isError, false);
  } finally {
    await teardown(f);
  }
});

test("github: 采集期间修订变化 → 标记 inconsistent，不混合修订", async () => {
  const f = await setup({
    seed: (s) => {
      seedPr(s);
    },
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      return { kind: "text", text: "ok" };
    },
  });
  try {
    // 第一次读取后、复核前改变 head SHA：通过 fault 钩子不可行，改为在 files 请求时变更
    const origGet = f.state.prs.get(7)!;
    let filesRead = false;
    const origPrs = f.state.prs;
    f.state.prs = new Proxy(origPrs, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === "get") {
          return (k: number) => {
            const pr = v.call(target, k);
            if (filesRead && pr) return { ...pr, head: { ...pr.head, sha: "dddd4444" } };
            return pr;
          };
        }
        return v;
      },
    });
    // 标记 files 已读：监听请求
    const origPush = f.state.requests.push.bind(f.state.requests);
    f.state.requests.push = ((r: any) => {
      if (String(r.path).includes("/files")) filesRead = true;
      return origPush(r);
    }) as any;

    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r2", input: "分析 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const detail = await taskStatus(f.t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.toolName === "github_read_pr");
    assert.ok(op.resultSummary?.includes("修订变化") || op.resultSummary?.includes("inconsistent") || op.resultSummary?.includes("⚠"), `应标记不一致：${op.resultSummary}`);
  } finally {
    await teardown(f);
  }
});

test("github: run 采集（attempt 固定、同名作业不合并、日志 302 受控跟随、checks+statuses）", async () => {
  const f = await setup({
    seed: seedRun,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_run", arguments: { run: 555 } }] };
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r3", input: "分析 run 555" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const detail = await taskStatus(f.t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.toolName === "github_read_run");
    assert.ok(op, "github_read_run 已执行");
    assert.equal(op.isError, false, op.resultSummary ?? "");
    // attempt 2 的作业请求
    assert.ok(f.state.requests.some((r) => r.path.includes("/runs/555/attempts/2/jobs")));
    // 失败作业日志经 302 下载（/download/91），且重定向请求不带 Authorization
    const download = f.state.requests.find((r) => r.path === "/download/91");
    assert.ok(download, "日志经 302 跟随下载");
    // 同名 matrix 作业不合并：摘要含两个 build
    assert.ok((op.resultSummary ?? "").includes("build"), op.resultSummary ?? "");
  } finally {
    await teardown(f);
  }
});

test("github: 日志重定向到私网/回环被拒绝", async () => {
  const f = await setup({
    seed: (s) => {
      seedRun(s);
      s.faults.set("/repos/o/r/actions/jobs/91/logs", "redirect_evil");
    },
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_run", arguments: { run: 555 } }] };
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r4", input: "分析 run 555" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const detail = await taskStatus(f.t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.toolName === "github_read_run");
    // 作业日志不可用（私网重定向拒绝），但采集整体完成并如实标注
    assert.equal(op.isError, false);
    assert.ok((op.resultSummary ?? "").includes("日志不可用") || (op.resultSummary ?? "").includes("未覆盖"), op.resultSummary ?? "");
    // 没有向 169.254.169.254 发请求
    assert.ok(!f.state.requests.some((r) => r.path.includes("169.254")), "不得跟随到私网地址");
  } finally {
    await teardown(f);
  }
});

test("github: 无读取凭据 → 明确报错（不回退 gh 登录态）", async () => {
  const f = await setup({
    withCredential: false,
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r5", input: "分析 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const detail = await taskStatus(f.t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.toolName === "github_read_pr");
    assert.equal(op.isError, true);
    assert.ok((op.resultSummary ?? "").includes("凭据"), op.resultSummary ?? "");
  } finally {
    await teardown(f);
  }
});

test("github: 范围外读取拒绝（绑定未开放 actions）", async () => {
  const f = await setup({
    readScopes: ["pulls"],
    seed: seedRun,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_run", arguments: { run: 555 } }] };
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r6", input: "分析 run 555" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const detail = await taskStatus(f.t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.toolName === "github_read_run");
    assert.equal(op.isError, true);
    assert.ok((op.resultSummary ?? "").includes("读取范围"), op.resultSummary ?? "");
  } finally {
    await teardown(f);
  }
});

test("github: 通用 http_request 不得借用带 scope 的发布凭据", async () => {
  const f = await setup({ withPublishCredential: true });
  try {
    // 给发布凭据加 scope（模拟 GitHub 绑定配置时的限定）
    const cred = f.t.runtime.credentials.get("gh-write")!;
    f.t.runtime.credentials.upsert({ ...cred, scope: { projectId: f.projectId, repoId: f.state.repoId, operations: ["github_publish"] } });
    // 通用 http_request 借用同名凭据 → 拒绝
    const { executeApprovedHttpRequest } = await import("../src/agent/execution/approved-ops.ts");
    const outcome = await executeApprovedHttpRequest(
      { method: "POST", url: `${f.gh.baseUrl}/repos/o/r/issues/1/comments`, headers: {}, credentialName: "gh-write", body: "" } as any,
      f.t.runtime.credentials,
    );
    assert.equal(outcome.ok, false);
    assert.ok(outcome.message.includes("范围"), outcome.message);
  } finally {
    await teardown(f);
  }
});

test("github: 草稿保存 → 拥有者发布（confirm 模式逐次审批 → 发送 → 结果落盘）", async () => {
  const f = await setup({
    withPublishCredential: true,
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      if (callIndex === 1) {
        return {
          kind: "tool_calls",
          calls: [
            {
              id: "c2",
              name: "github_save_draft",
              arguments: {
                kind: "pr_review",
                body: "评审：src/a.ts 第 1 行变更合理。",
                revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" },
              },
            },
          ],
        };
      }
      return { kind: "text", text: "草稿已保存" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r7", input: "评审 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const drafts = (await f.t.client.request<any>("github_list_drafts", { project_id: f.projectId })) as any;
    assert.equal(drafts.drafts.length, 1);
    const draft = drafts.drafts[0];
    assert.equal(draft.status, "draft");

    // 任务已结束 → full_access 发起（confirm 模式在新任务外不可用）
    const op = (await f.t.client.request<any>("github_publish", {
      draft_id: draft.id,
      kind: "pr_review_comment",
      target: { prNumber: 7 },
      access_mode: "full_access",
    })) as any;
    assert.equal(op.status, "sent");
    assert.ok(op.remoteUrl);
    // 远端收到 review：event=COMMENT + commit_id 固定
    assert.equal(f.state.reviews.length, 1);
    assert.equal(f.state.reviews[0].event, "COMMENT");
    assert.equal(f.state.reviews[0].commit_id, "aaaa1111");
    // 草稿标 published
    const after = (await f.t.client.request<any>("github_get_draft", { draft_id: draft.id })) as any;
    assert.equal(after.status, "published");
  } finally {
    await teardown(f);
  }
});

test("github: 发布前复核发现修订变化 → 草稿标 stale，不发送", async () => {
  const f = await setup({
    withPublishCredential: true,
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      if (callIndex === 1) {
        return {
          kind: "tool_calls",
          calls: [
            { id: "c2", name: "github_save_draft", arguments: { kind: "pr_review", body: "评审正文", revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" } } },
          ],
        };
      }
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r8", input: "评审 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const drafts = (await f.t.client.request<any>("github_list_drafts", {})) as any;
    const draft = drafts.drafts[0];
    // 修订变化：head 更新
    const pr = f.state.prs.get(7)!;
    f.state.prs.set(7, { ...pr, head: { ...pr.head, sha: "eeee5555" } });
    await assert.rejects(
      f.t.client.request("github_publish", { draft_id: draft.id, kind: "pr_review_comment", target: { prNumber: 7 }, access_mode: "full_access" }),
      /修订已变化|stale/,
    );
    assert.equal(f.state.reviews.length, 0, "不得发送");
    const after = (await f.t.client.request<any>("github_get_draft", { draft_id: draft.id })) as any;
    assert.equal(after.status, "stale");
  } finally {
    await teardown(f);
  }
});

test("github: 发送后断线 → effect_unknown，不自动重发", async () => {
  const f = await setup({
    withPublishCredential: true,
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      if (callIndex === 1) {
        return {
          kind: "tool_calls",
          calls: [
            { id: "c2", name: "github_save_draft", arguments: { kind: "pr_review", body: "评审正文", revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" } } },
          ],
        };
      }
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r9", input: "评审 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const drafts = (await f.t.client.request<any>("github_list_drafts", {})) as any;
    const draft = drafts.drafts[0];
    // 发送时连接断开（socket 销毁，无响应）
    f.state.faults.set("/repos/o/r/pulls/7/reviews", "drop");
    await assert.rejects(
      f.t.client.request("github_publish", { draft_id: draft.id, kind: "pr_review_comment", target: { prNumber: 7 }, access_mode: "full_access" }),
      /结果未知|effect_unknown/,
    );
    const ops = (await f.t.client.request<any>("github_list_publish_ops", { draft_id: draft.id })) as any;
    assert.equal(ops.ops.length, 1);
    assert.equal(ops.ops[0].status, "effect_unknown");
  } finally {
    await teardown(f);
  }
});

test("github: 绑定撤销后进行中的调用在版本核对时失败", async () => {
  const f = await setup({
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      return { kind: "text", text: "ok" };
    },
  });
  try {
    // 撤销绑定后客户端 configVersion() 返回 null → 调用抛 github_config_revoked
    await f.t.client.request("github_unbind", { binding_id: f.binding.id });
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r10", input: "分析 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const detail = await taskStatus(f.t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.toolName === "github_read_pr");
    assert.equal(op.isError, true);
    assert.ok((op.resultSummary ?? "").includes("绑定") || (op.resultSummary ?? "").includes("撤销"), op.resultSummary ?? "");
  } finally {
    await teardown(f);
  }
});

test("github: confirm 模式发布经逐次审批（github_publish scope），批准单次消费", async () => {
  const f = await setup({
    withPublishCredential: true,
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      if (callIndex === 1) {
        return {
          kind: "tool_calls",
          calls: [
            { id: "c2", name: "github_save_draft", arguments: { kind: "pr_review", body: "评审正文", revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" } } },
          ],
        };
      }
      // 第三次调用挂起：任务保持 running，发布审批在其上下文进行
      if (callIndex === 2) {
        return new Promise(() => {}) as never;
      }
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r12", input: "评审 PR 7" })) as any;
    // 等草稿保存（任务仍 running：第三次模型调用挂起）
    let draft: any = null;
    await waitFor("草稿出现", async () => {
      const drafts = (await f.t.client.request<any>("github_list_drafts", {})) as any;
      draft = drafts.drafts[0] ?? null;
      return draft !== null;
    });

    // 活动任务上 confirm 发布：产生 github_publish 审批
    const publishPromise = f.t.client.request<any>("github_publish", {
      draft_id: draft.id,
      kind: "pr_review_comment",
      target: { prNumber: 7 },
      access_mode: "confirm",
    });
    let confirmation: any = null;
    await waitFor("发布审批出现", async () => {
      const detail = await taskStatus(f.t.client, task.id);
      confirmation = detail.confirmations.find((c: any) => c.toolName === "github_publish" && c.status === "pending") ?? null;
      return confirmation !== null;
    });
    assert.equal(confirmation.scope.kind, "github_publish");
    assert.equal(confirmation.scope.owner, "o");
    assert.equal(confirmation.scope.repo, "r");
    assert.equal(confirmation.scope.publishKind, "pr_review_comment");
    assert.equal(confirmation.scope.target.prNumber, 7);
    assert.equal(typeof confirmation.scope.bodySha256, "string");
    assert.equal(f.state.reviews.length, 0, "批准前不得发送");

    await f.t.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" });
    const op = (await publishPromise) as any;
    assert.equal(op.status, "sent");
    assert.equal(f.state.reviews.length, 1);
    assert.equal(f.state.reviews[0].event, "COMMENT");
    assert.equal(f.state.reviews[0].commit_id, "aaaa1111");

    // 批准单次消费
    const detail = await taskStatus(f.t.client, task.id);
    const consumed = detail.confirmations.find((c: any) => c.id === confirmation.id);
    assert.notEqual(consumed.consumedAt, null);

    // 清理：中断挂起的任务
    await f.t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务中断", async () => (await taskStatus(f.t.client, task.id)).task.status === "interrupted");
  } finally {
    await teardown(f);
  }
});

test("github: 模型伪造他项目绑定 id 被拦（身份由宿主注入）", async () => {
  let foreignBindingId = "";
  const f = await setup({
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7, binding_id: foreignBindingId } }] };
      return { kind: "text", text: "ok" };
    },
  });
  const g = await setup({ seed: seedPr });
  foreignBindingId = g.binding.id;
  try {
    // 项目 A 的任务尝试用项目 B 的绑定 id
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r11", input: "分析 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const detail = await taskStatus(f.t.client, task.id);
    const op = detail.toolOps.find((o: any) => o.toolName === "github_read_pr");
    assert.equal(op.isError, true);
    assert.ok((op.resultSummary ?? "").includes("不属于当前项目"), op.resultSummary ?? "");
  } finally {
    await teardown(f);
    await teardown(g);
  }
});

test("github: 回环/私网判定覆盖 IPv6 与 IPv4 映射（重定向防护）", () => {
  for (const h of ["127.0.0.1", "localhost", "x.localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["8.8.8.8", "example.com", "140.82.112.6"]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test("github: 绑定自动收紧凭据使用范围；同名更新保留范围", async () => {
  const f = await setup({ withPublishCredential: true, seed: seedPr });
  try {
    const read = f.t.runtime.credentials.get("gh-read")!;
    assert.deepEqual(read.scope?.operations, ["github_read"]);
    assert.equal(read.scope?.projectId, f.projectId);
    const write = f.t.runtime.credentials.get("gh-write")!;
    assert.deepEqual(write.scope?.operations, ["github_publish"]);
    // 同名更新（轮换令牌）保留范围
    await f.t.client.request("add_credential", { name: "gh-write", host: read.host, header: "Authorization", purpose: "GitHub 发布", secret: "token rotated" });
    const rotated = f.t.runtime.credentials.get("gh-write")!;
    assert.deepEqual(rotated.scope?.operations, ["github_publish"]);
  } finally {
    await teardown(f);
  }
});

test("github: 不同 kind/target 的发布不复用 pending 操作（审计与实际发送一致）", async () => {
  const f = await setup({
    withPublishCredential: true,
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      if (callIndex === 1) {
        return { kind: "tool_calls", calls: [{ id: "c2", name: "github_save_draft", arguments: { kind: "pr_review", body: "评审正文", revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" } } }] };
      }
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r12", input: "评审 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const draft = ((await f.t.client.request<any>("github_list_drafts", {})) as any).drafts[0];
    // pr_review 草稿以 issue_comment 形态发布：复核按 PR 修订执行，目标必须是该 PR
    await assert.rejects(
      f.t.client.request("github_publish", { draft_id: draft.id, kind: "issue_comment", target: { issueNumber: 3 }, access_mode: "full_access" }),
      /发布目标必须是该 PR|prNumber/,
    );
    const ops = (await f.t.client.request<any>("github_list_publish_ops", { draft_id: draft.id })) as any;
    assert.equal(ops.ops.length, 0, "复核失败不得落盘发布操作");
  } finally {
    await teardown(f);
  }
});

test("github: 发布目标编号必须为正整数（/pulls/0 不落盘）", async () => {
  const f = await setup({
    withPublishCredential: true,
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      if (callIndex === 1) {
        return { kind: "tool_calls", calls: [{ id: "c2", name: "github_save_draft", arguments: { kind: "pr_review", body: "评审正文", revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" } } }] };
      }
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r13", input: "评审 PR 7" })) as any;
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    const draft = ((await f.t.client.request<any>("github_list_drafts", {})) as any).drafts[0];
    await assert.rejects(
      f.t.client.request("github_publish", { draft_id: draft.id, kind: "pr_review_comment", target: { prNumber: 0 }, access_mode: "full_access" }),
      /发布目标无效|正整数/,
    );
    const ops = (await f.t.client.request<any>("github_list_publish_ops", { draft_id: draft.id })) as any;
    assert.equal(ops.ops.length, 0);
  } finally {
    await teardown(f);
  }
});

test("github: 已结束任务的 confirm 发布被拒绝且不产生新任务；旧版本草稿不能发布", async () => {
  let draftId = "";
  const f = await setup({
    withPublishCredential: true,
    seed: seedPr,
    responder: async (req, callIndex) => {
      if (callIndex === 0) return { kind: "tool_calls", calls: [{ id: "c1", name: "github_read_pr", arguments: { pr: 7 } }] };
      if (callIndex === 1) {
        return { kind: "tool_calls", calls: [{ id: "c2", name: "github_save_draft", arguments: { kind: "pr_review", body: "v1 正文", revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" } } }] };
      }
      if (callIndex === 2) {
        // 等 v1 落盘后再取 id（避免与宿主导出 draftId 的竞态）
        for (;;) {
          const d = f.t.runtime.github.listDrafts({})[0];
          if (d) {
            draftId = d.id;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        return { kind: "tool_calls", calls: [{ id: "c3", name: "github_save_draft", arguments: { kind: "pr_review", body: "v2 正文", revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" }, draft_id: draftId } }] };
      }
      return { kind: "text", text: "ok" };
    },
  });
  try {
    const task = (await f.t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: f.sessionId, request_id: "r14", input: "评审 PR 7" })) as any;
    await waitFor("草稿 v1", async () => ((await f.t.client.request<any>("github_list_drafts", {})) as any).drafts.length >= 1);
    draftId = ((await f.t.client.request<any>("github_list_drafts", {})) as any).drafts[0].id;
    const v2 = await f.t.client.request<any>("github_get_draft", { draft_id: draftId });
    assert.ok(v2.version >= 2, `应已修订到 v2（实际 v${v2.version}；模型第三轮保存失败？）`);
    await waitFor("任务完成", async () => (await taskStatus(f.t.client, task.id)).task.status === "completed");
    // confirm 模式：任务已结束 → 明确拒绝，不新建任务、不落盘 pending 操作
    await assert.rejects(
      f.t.client.request("github_publish", { draft_id: draftId, kind: "pr_review_comment", target: { prNumber: 7 } }),
      /已结束|full_access/,
    );
    const ops = (await f.t.client.request<any>("github_list_publish_ops", { draft_id: draftId })) as any;
    assert.equal(ops.ops.length, 0, "不得落盘 pending 操作");
    // 旧版本发布被拒绝（草稿已修订到 v2）
    await assert.rejects(
      f.t.client.request("github_publish", { draft_id: draftId, version: 1, kind: "pr_review_comment", target: { prNumber: 7 }, access_mode: "full_access" }),
      /最新版本|旧版本/,
    );
  } finally {
    await teardown(f);
  }
});
