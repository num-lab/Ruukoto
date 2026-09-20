/**
 * GitHub 采集（issue 06 §2/§3）：PR 元数据/文件列表/diff、workflow run/作业/日志、
 * check runs 与 commit statuses。
 *
 * 边界：
 * - 全程固定采集开始时的配置版本；分页、重试、日志下载前重新核对（client 内完成）；
 * - PR 读取后复核 head/base SHA 与状态；中途变化 → 保留旧数据并标记 inconsistent，
 *   绝不混合修订；
 * - 文件列表走 PR files API 分页（3000 上限），diff 单独获取；缺失 patch/二进制/
 *   超限文件记为未覆盖；
 * - fork PR 源仓库内容仅在绑定显式允许时读取；
 * - 日志按作业 ID 下载（302 签名 URL 由 client 受控跟随，签名 URL 不进入产物/事件）；
 * - 不 checkout、不执行 PR 代码。
 */

import { GitHubError, type GitHubClient } from "./client.ts";
import type { GitHubRepoBinding, GitHubReadScope } from "./store.ts";

export interface PrSnapshot {
  repoId: number;
  number: number;
  title: string;
  state: string;
  headSha: string;
  baseSha: string;
  headRepoFullName: string | null;
  baseRepoFullName: string | null;
  /** fork PR 且绑定未允许读取源内容。 */
  forkContentBlocked: boolean;
  author: string | null;
  url: string;
  body: string | null;
  readAt: string;
}

export interface PrFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** 缺失 patch（二进制/超限）时为 null 并计入 uncovered。 */
  patch: string | null;
}

export interface PrCollection {
  snapshot: PrSnapshot;
  files: PrFileEntry[];
  /** 未覆盖说明（3000 上限、缺失 patch、二进制、超限等）。 */
  uncovered: string[];
  /** diff 原文（可能因超限被截断；截断时 diffTruncated=true）。 */
  diff: string;
  diffTruncated: boolean;
  /** 采集中途修订变化：保留的旧数据标记不一致。 */
  inconsistent: boolean;
  inconsistentReason: string | null;
}

export interface RunJobStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: RunJobStep[];
  /** 日志产物 id（下载后填充）；null = 未下载/不可用。 */
  logArtifactId: string | null;
  /** 日志捕获状态。 */
  logStatus: "captured" | "partial" | "unavailable" | "skipped";
  logNote: string | null;
}

export interface CheckEntry {
  source: "check_run" | "commit_status";
  name: string;
  status: string;
  conclusion: string | null;
  /** 第三方检查无日志时仅状态 + 链接。 */
  detailsUrl: string | null;
}

export interface RunCollection {
  repoId: number;
  runId: number;
  runAttempt: number;
  name: string | null;
  event: string | null;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string;
  readAt: string;
  jobs: RunJob[];
  checks: CheckEntry[];
  uncovered: string[];
  inconsistent: boolean;
  inconsistentReason: string | null;
}

const DIFF_CAP_BYTES = 4 * 1024 * 1024;
const PER_PAGE = 100;
const MAX_PAGES = 30; // 3000 文件上限（GitHub PR files API 同限）

function requireScope(binding: GitHubRepoBinding, scope: GitHubReadScope): void {
  if (!binding.readScopes.includes(scope)) {
    throw new GitHubError("scope_denied", `绑定未开放 ${scope} 读取范围（已开放：${binding.readScopes.join(", ") || "无"}）`);
  }
}

/** 分页收集（Link 头由 client 限定不离开配置主机；此处按 page 参数翻页）。 */
async function collectPages(
  client: GitHubClient,
  path: string,
  config: string,
  opts: { accept?: string; maxPages?: number } = {},
): Promise<{ items: unknown[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const items: unknown[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await client.getJson(`${path}${sep}per_page=${PER_PAGE}&page=${page}`, config, { accept: opts.accept });
    if (!Array.isArray(data)) throw new GitHubError("bad_response", `分页响应不是数组：${path}`);
    items.push(...data);
    if (data.length < PER_PAGE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** 读取并固定 repository ID（改名/迁移核对）。 */
export async function resolveRepoId(client: GitHubClient, binding: GitHubRepoBinding, config: string): Promise<number> {
  const { data } = await client.getJson(`/repos/${binding.owner}/${binding.repo}`, config);
  const id = (data as any)?.id;
  if (typeof id !== "number") throw new GitHubError("bad_response", "仓库响应缺少 id");
  return id;
}

/** 采集 PR：元数据 → 文件列表 → diff，读完后复核修订。 */
export async function collectPullRequest(
  client: GitHubClient,
  binding: GitHubRepoBinding,
  config: string,
  prNumber: number,
): Promise<PrCollection> {
  requireScope(binding, "pulls");
  const base = `/repos/${binding.owner}/${binding.repo}`;
  const readAt = new Date().toISOString();

  const { data: pr } = await client.getJson(`${base}/pulls/${prNumber}`, config);
  const p = pr as any;
  const snapshot: PrSnapshot = {
    repoId: Number(p?.base?.repo?.id ?? 0),
    number: prNumber,
    title: asStr(p?.title) ?? "",
    state: asStr(p?.state) ?? "unknown",
    headSha: asStr(p?.head?.sha) ?? "",
    baseSha: asStr(p?.base?.sha) ?? "",
    headRepoFullName: asStr(p?.head?.repo?.full_name),
    baseRepoFullName: asStr(p?.base?.repo?.full_name),
    forkContentBlocked: false,
    author: asStr(p?.user?.login),
    url: asStr(p?.html_url) ?? "",
    body: asStr(p?.body),
    readAt,
  };
  if (!snapshot.headSha || !snapshot.baseSha) throw new GitHubError("bad_response", "PR 响应缺少 head/base SHA");

  // fork PR：源仓库内容仅在显式允许时读取（文件列表/diff 属 PR 本身数据，经 base 仓库 API 获取；
  // 源仓库额外内容——如 head 仓库的独立文件——本阶段不读取，统一按绑定开关拦截）
  const isFork = snapshot.headRepoFullName !== null && snapshot.headRepoFullName !== snapshot.baseRepoFullName;
  if (isFork && !binding.allowForkContent) {
    snapshot.forkContentBlocked = true;
  }

  const uncovered: string[] = [];
  const { items: fileItems, truncated } = await collectPages(client, `${base}/pulls/${prNumber}/files`, config);
  if (truncated) uncovered.push(`文件列表超过 ${PER_PAGE * MAX_PAGES} 上限，仅覆盖前 ${PER_PAGE * MAX_PAGES} 个文件`);
  const files: PrFileEntry[] = fileItems.map((f: any) => {
    const patch = asStr(f?.patch);
    if (patch === null) uncovered.push(`文件 ${asStr(f?.filename) ?? "?"} 无 patch（二进制或超限），未覆盖`);
    return {
      filename: asStr(f?.filename) ?? "?",
      status: asStr(f?.status) ?? "unknown",
      additions: Number(f?.additions ?? 0),
      deletions: Number(f?.deletions ?? 0),
      patch,
    };
  });

  // diff（media type: diff）；超限截断并标记
  let diff = "";
  let diffTruncated = false;
  {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const res = await client.getStream(`${base}/pulls/${prNumber}`, config, (chunk) => {
      if (bytes >= DIFF_CAP_BYTES) return;
      const room = DIFF_CAP_BYTES - bytes;
      chunks.push(chunk.subarray(0, Math.min(room, chunk.length)));
      bytes += Math.min(room, chunk.length);
    }, { accept: "application/vnd.github.diff" });
    diff = Buffer.concat(chunks).toString("utf8");
    diffTruncated = !res.complete || res.bytes > DIFF_CAP_BYTES;
    if (diffTruncated) uncovered.push(`diff 超过 ${DIFF_CAP_BYTES} 字节上限，已截断`);
  }

  // 复核：读取期间修订变化 → 标记不一致，保留旧数据
  let inconsistent = false;
  let inconsistentReason: string | null = null;
  const { data: pr2 } = await client.getJson(`${base}/pulls/${prNumber}`, config);
  const p2 = pr2 as any;
  const head2 = asStr(p2?.head?.sha);
  const base2 = asStr(p2?.base?.sha);
  const state2 = asStr(p2?.state);
  if (head2 !== snapshot.headSha || base2 !== snapshot.baseSha || state2 !== snapshot.state) {
    inconsistent = true;
    inconsistentReason = `采集期间 PR 修订变化（head ${snapshot.headSha}→${head2}，base ${snapshot.baseSha}→${base2}，state ${snapshot.state}→${state2}）；已保留首次读取的数据，请重新分析`;
  }

  return { snapshot, files, uncovered, diff, diffTruncated, inconsistent, inconsistentReason };
}

export interface LogSink {
  /** 流式写入一个作业的日志；返回产物 id 与捕获状态。 */
  saveJobLog(jobId: number, jobName: string, write: (streamTo: (chunk: Buffer) => void) => Promise<{ complete: boolean; bytes: number }>): Promise<{ artifactId: string; complete: boolean; bytes: number }>;
}

/** 采集 workflow run（固定 run_attempt）：元数据 → 作业分页 → 逐作业日志 → checks/statuses。 */
export async function collectRun(
  client: GitHubClient,
  binding: GitHubRepoBinding,
  config: string,
  runId: number,
  runAttempt: number,
  logSink: LogSink | null,
): Promise<RunCollection> {
  requireScope(binding, "actions");
  const base = `/repos/${binding.owner}/${binding.repo}`;
  const readAt = new Date().toISOString();

  const { data: run } = await client.getJson(`${base}/actions/runs/${runId}`, config);
  const r = run as any;
  const headSha = asStr(r?.head_sha) ?? "";
  if (!headSha) throw new GitHubError("bad_response", "run 响应缺少 head_sha");

  const uncovered: string[] = [];
  // 按 attempt 分页读取作业；同名作业不跨 attempt/matrix 合并（每条记录保留原始 id+name）
  const { items: jobItems, truncated } = await collectPages(
    client,
    `${base}/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
    config,
  );
  if (truncated) uncovered.push("作业列表分页超限，仅覆盖前 3000 条");

  const jobs: RunJob[] = [];
  for (const j of jobItems as any[]) {
    const jobId = Number(j?.id ?? 0);
    const job: RunJob = {
      id: jobId,
      name: asStr(j?.name) ?? "?",
      status: asStr(j?.status) ?? "unknown",
      conclusion: asStr(j?.conclusion),
      startedAt: asStr(j?.started_at),
      completedAt: asStr(j?.completed_at),
      steps: ((j?.steps as any[]) ?? []).map((s) => ({
        name: asStr(s?.name) ?? "?",
        number: Number(s?.number ?? 0),
        status: asStr(s?.status) ?? "unknown",
        conclusion: asStr(s?.conclusion),
        startedAt: asStr(s?.started_at),
        completedAt: asStr(s?.completed_at),
      })),
      logArtifactId: null,
      logStatus: "skipped",
      logNote: null,
    };
    jobs.push(job);
  }

  // 逐作业下载日志（仅失败/被请求的作业由调用方过滤；此处下载全部非成功作业）
  if (logSink) {
    for (const job of jobs) {
      if (job.conclusion === "success") continue;
      try {
        const saved = await logSink.saveJobLog(job.id, job.name, async (streamTo) => {
          const res = await client.getStream(
            `${base}/actions/jobs/${job.id}/logs`,
            config,
            streamTo,
            { allowDownloadHost: true },
          );
          return { complete: res.complete, bytes: res.bytes };
        });
        job.logArtifactId = saved.artifactId;
        job.logStatus = saved.complete ? "captured" : "partial";
        if (!saved.complete) job.logNote = "日志捕获不完整（超限/中断），已保留部分";
      } catch (err) {
        job.logStatus = "unavailable";
        job.logNote = err instanceof GitHubError ? `${err.code}: ${err.message}` : `日志下载失败：${(err as Error).message}`;
        uncovered.push(`作业 ${job.name}（${job.id}）日志不可用：${job.logNote}`);
      }
    }
  }

  // checks（check runs + commit statuses 都读；第三方检查无日志仅状态+链接）
  const checks: CheckEntry[] = [];
  if (binding.readScopes.includes("checks")) {
    try {
      const { items: checkRuns } = await collectPages(client, `${base}/commits/${headSha}/check-runs`, config);
      for (const c of checkRuns as any[]) {
        checks.push({
          source: "check_run",
          name: asStr(c?.name) ?? "?",
          status: asStr(c?.status) ?? "unknown",
          conclusion: asStr(c?.conclusion),
          detailsUrl: asStr(c?.details_url) ?? asStr(c?.html_url),
        });
      }
    } catch (err) {
      uncovered.push(`check runs 读取失败：${(err as Error).message}`);
    }
    try {
      const { data: status } = await client.getJson(`${base}/commits/${headSha}/status`, config);
      for (const s of ((status as any)?.statuses as any[]) ?? []) {
        checks.push({
          source: "commit_status",
          name: asStr(s?.context) ?? "?",
          status: asStr(s?.state) ?? "unknown",
          conclusion: asStr(s?.state),
          detailsUrl: asStr(s?.target_url),
        });
      }
    } catch (err) {
      uncovered.push(`commit statuses 读取失败：${(err as Error).message}`);
    }
  }

  // 复核：run 的 head_sha/状态/attempt 在采集期间变化 → 标记不一致
  //（re-run 保持 head_sha 不变，attempt 递增必须纳入核对）
  let inconsistent = false;
  let inconsistentReason: string | null = null;
  const { data: run2 } = await client.getJson(`${base}/actions/runs/${runId}`, config);
  const r2 = run2 as any;
  if (asStr(r2?.head_sha) !== headSha || asStr(r2?.status) !== asStr(r?.status) || Number(r2?.run_attempt ?? runAttempt) !== runAttempt) {
    inconsistent = true;
    inconsistentReason = `采集期间 run 修订变化（head_sha ${headSha}→${asStr(r2?.head_sha)}，status ${asStr(r?.status)}→${asStr(r2?.status)}，attempt ${runAttempt}→${Number(r2?.run_attempt ?? "?")}）；已保留首次读取的数据，请重新分析`;
  }

  return {
    repoId: Number(r?.repository?.id ?? 0),
    runId,
    runAttempt,
    name: asStr(r?.name),
    event: asStr(r?.event),
    headSha,
    status: asStr(r?.status) ?? "unknown",
    conclusion: asStr(r?.conclusion),
    url: asStr(r?.html_url) ?? "",
    readAt,
    jobs,
    checks,
    uncovered,
    inconsistent,
    inconsistentReason,
  };
}

/** "最近一次失败运行"：列出候选后固定 run ID 与 attempt（不跟随"最新"漂移）。 */
export async function resolveLatestFailedRun(
  client: GitHubClient,
  binding: GitHubRepoBinding,
  config: string,
): Promise<{ runId: number; runAttempt: number }> {
  requireScope(binding, "actions");
  const base = `/repos/${binding.owner}/${binding.repo}`;
  const { data } = await client.getJson(`${base}/actions/runs?status=failure&per_page=1`, config);
  const run = ((data as any)?.workflow_runs as any[])?.[0];
  if (!run) throw new GitHubError("not_found", "没有失败的 workflow run");
  return { runId: Number(run.id), runAttempt: Number(run.run_attempt ?? 1) };
}
