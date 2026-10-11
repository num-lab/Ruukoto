/** 旧实例导入的共用快照、表校验、文件与回执；产品策略由各 app 持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "./db.ts";
import { probeLockHolder } from "./instance-lock.ts";
import { PRODUCT_META_KEY } from "./product.ts";
import type { SessionBranchSource } from "./types.ts";

export class LegacyImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new LegacyImportError(code, message);
}

export interface LegacyImportDeps {
  targetDataDir: string;
  targetAgentDir: string;
  /** 测试故障注入钩（生产路径不传）：文件复制后 / 导入事务内各一次。 */
  __testHooks?: { afterFilesCopied?: () => void; insideImportTx?: () => void };
}

// ---------- 表级策略：旧库的每张表都必须登记为“导入”或“排除 + 理由” ----------

/**
 * 导入 / 排除登记（allow-list）。导入前核对源快照与目标库的全部表都已登记——
 * 新表未登记时拒绝导入，避免新表默认被漏判或被复制。列集合在导入表上两库
 * 必须一致（快照已迁到当前 schema，理应恒等）。
 */
/** 表级策略条目的形状；两个导入方向各自登记一份（allow-list，未登记即拒绝）。 */
export type TablePolicy = Record<string, { policy: "import" } | { policy: "exclude"; reason: string }>;

/** 账本条目类别与插入表的对照（v30 全集；各方向只用其中子集）。 */
export type LedgerKind =
  | "project"
  | "session"
  | "sub_agent"
  | "work_delegation"
  | "memory"
  | "grant"
  | "mcp"
  | "meta"
  | "file"
  | "agent_role"
  | "schedule"
  | "platform_config"
  | "standing_permission"
  | "credential";

export type Row = Record<string, unknown>;

/** 名称与来源随会话行保留；限定来源缺对象时拒绝导入，不能删字段后扩大范围。 */
export function verifyImportedBranchSources(sessions: Row[], tasks: Row[], artifacts: Row[], works: Row[]): void {
  for (const session of sessions) {
    if (!session.branch_source) continue;
    let source: SessionBranchSource;
    try { source = JSON.parse(String(session.branch_source)) as SessionBranchSource; }
    catch { fail("source_corrupt", "分支来源记录不是合法 JSON"); }
    if (!source || typeof source.sessionId !== "string" || typeof source.entryId !== "string" || !Number.isSafeInteger(source.number) || source.number < 1 || !Number.isSafeInteger(source.messageCount) || source.messageCount < 1 || !Array.isArray(source.excluded) || source.excluded.some(value => typeof value !== "string") ||
        !Array.isArray(source.taskIds) || !Array.isArray(source.artifacts) || !Array.isArray(source.results) ||
        !sessions.some(s => s.id === source.sessionId) || source.taskIds.some(id => !tasks.some(t => t.id === id)) ||
        source.artifacts.some(a => !a || !Number.isSafeInteger(a.byteCount) || a.byteCount < 0 || (a.status !== "complete" && a.status !== "partial") || !artifacts.some(r => r.id === a.id && r.task_id === a.taskId && r.session_id === a.sessionId && Number(r.byte_count) >= a.byteCount && r.mime_type === a.mimeType && r.content_hash === a.contentHash)) ||
        source.results.some(r => !r || !Array.isArray(r.taskIds) || !works.some(w => w.id === r.workId) || r.taskIds.some(id => !tasks.some(t => t.id === id && t.work_id === r.workId && t.status === "completed")))) {
      fail("source_scope_unavailable", "分支的限定来源对象缺失或不在本次导入范围，请先核实完整来源");
    }
  }
}

export function allRows(db: Db, sql: string, params: unknown[] = []): Row[] {
  return db.prepare(sql).all(...(params as any[])) as unknown as Row[];
}

/** 分块 IN 查询（避免超大参数列表）。 */
export function rowsIn(db: Db, table: string, column: string, ids: string[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(",");
    out.push(...(allRows(db, `SELECT * FROM ${table} WHERE ${column} IN (${marks})`, chunk) as Row[]));
  }
  return out;
}

export function tableNames(db: Db): string[] {
  return allRows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(
    (r) => String(r.name),
  );
}

export function columnNames(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** 目标/源表登记核对：两库全部表都已登记，导入表的列集合一致。 */
export function checkTablePolicy(snapDb: Db, targetDb: Db | null, policy: TablePolicy): void {
  const checkCoverage = (names: string[], side: string) => {
    for (const name of names) {
      if (!policy[name]) fail("table_policy", `${side}存在未登记表 ${name}：请先在 TABLE_POLICY 登记导入或排除`);
    }
  };
  checkCoverage(tableNames(snapDb), "源库");
  if (targetDb) checkCoverage(tableNames(targetDb), "目标库");
  const targetTableNames = targetDb ? tableNames(targetDb) : [];
  for (const [name, entry] of Object.entries(policy)) {
    if (entry.policy !== "import") continue;
    if (!tableNames(snapDb).includes(name)) continue; // 源侧可能缺少本版本新增的账本类表
    // 目标全新目录可能尚无 v9 起不再创建的遗留表（github_*）：由 apply 按快照
    // DDL 重建后插入，列一致性在那时由同一份 DDL 保证；目标已有该表才比对
    if (targetDb && !targetTableNames.includes(name)) continue;
    const snapCols = columnNames(snapDb, name).sort().join(",");
    const targetCols = targetDb ? columnNames(targetDb, name).sort().join(",") : null;
    if (targetCols !== null && snapCols !== targetCols) {
      fail("table_policy", `导入表 ${name} 两库列集合不一致：源 ${snapCols}，目标 ${targetCols}`);
    }
  }
}

// ---------- 源与目标的读取 ----------

export interface SourceSnapshot {
  dir: string; // 快照临时目录（ruukoto.db 副本所在）
  dataDir: string; // 源数据目录（规范化绝对路径）
  db: Db;
  cleanup(): void;
  instanceId: string;
  product: string | null;
  /** 原始 schema 版本（复制后、迁移前读取）。 */
  originalSchemaVersion: number | null;
}

export function readMetaValue(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * 源快照：实例目录逐文件复制到 mkdtemp（0700），在副本上迁到当前 schema。
 * 不用 sqlite 读连接/VACUUM 直读源目录——读 WAL 库会在源目录生成 -shm/-wal
 * 侧车文件；复制是唯一逐字节零接触的方式（源后台必须已停止，先经探测拒绝）。
 */
export function openSourceSnapshot(from: string): SourceSnapshot {
  const dataDir = path.resolve(from);
  const dbFile = path.join(dataDir, "ruukoto.db");
  if (!fs.existsSync(dbFile)) {
    fail("invalid_params", `源数据目录没有 ruukoto.db：${dataDir}`);
  }
  const probe = probeLockHolder(path.join(dataDir, "runtime.lock"));
  if (probe.held) {
    fail(
      probe.unverifiable ? "source_unverifiable" : "source_active",
      `源实例后台未停止或无法核实（${probe.detail}）；请先停止源后台，或改用它的副本目录`,
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-import-"));
  fs.chmodSync(tmp, 0o700);
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不阻断；系统会回收
    }
  };
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = dbFile + suffix;
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(tmp, "ruukoto.db" + suffix));
    }
    // 原始 schema 版本（在副本上、迁移前读取）
    let originalSchemaVersion: number | null = null;
    {
      const raw = new DatabaseSync(path.join(tmp, "ruukoto.db"));
      try {
        const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
        originalSchemaVersion = row ? Number(row.value) : null;
      } catch {
        originalSchemaVersion = null;
      } finally {
        raw.close();
      }
    }
    const db = new Db(tmp); // 在快照上完成 schema 迁移
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
    if (!integrity || integrity.integrity_check !== "ok") {
      fail("source_corrupt", `源库快照完整性检查失败：${integrity?.integrity_check ?? "无结果"}`);
    }
    const product = readMetaValue(db, PRODUCT_META_KEY);
    if (product !== null && product !== "ruukoto") {
      fail("product_mismatch", `源数据目录已登记为产品 ${product}，不能作为旧 ruukoto 实例导入`);
    }
    return { dir: tmp, dataDir, db, cleanup, instanceId: db.getInstanceId(), product, originalSchemaVersion };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** 目标视图：预览时以副本只读打开（零写入），应用时打开真实目录。 */
export interface TargetView {
  exists: boolean;
  db: Db | null;
  cleanup(): void;
  instanceId: string | null;
  product: string | null;
  schemaVersion: number | null;
}

export function copyDbFiles(dbFile: string, tmp: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = dbFile + suffix;
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(tmp, "ruukoto.db" + suffix));
  }
}

export function openTargetReadonlyCopy(deps: LegacyImportDeps): TargetView {
  const dbFile = path.join(deps.targetDataDir, "ruukoto.db");
  if (!fs.existsSync(dbFile)) {
    return { exists: false, db: null, cleanup: () => {}, instanceId: null, product: null, schemaVersion: null };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-import-target-"));
  fs.chmodSync(tmp, 0o700);
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 同 openSourceSnapshot
    }
  };
  try {
    copyDbFiles(dbFile, tmp);
    const db = new Db(tmp);
    const product = readMetaValue(db, PRODUCT_META_KEY);
    const schemaVersion = Number(readMetaValue(db, "schema_version") ?? 0);
    return { exists: true, db, cleanup, instanceId: db.getInstanceId(), product, schemaVersion };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---------- 导入集合与各项决策 ----------

export interface FilePlanItem {
  /** 账本标识：sessions/<文件名>、artifacts/<id>.bin、agent-data/main.db[-wal] 或 github-archive-manifest.json。 */
  itemId: string;
  kind: "session" | "artifact" | "app_data" | "manifest";
  /** 关联的会话 / 产物行 id（报告用）。 */
  ownerId: string;
  src: string;
  dest: string;
  name: string;
  bytes: number;
  sha256: string;
  /** apply 后填：copied / skipped_same_sha。 */
  action?: "copied" | "skipped_same_sha";
}

export interface TaskClosing {
  task_id: string;
  from: string;
  to: "canceled" | "interrupted";
}

/** 严格核实登记的目录身份（realpath + dev + ino 三项都要一致）。 */
export function strictDirOk(cwdReal: string, dev: number, ino: number): boolean {
  try {
    const real = fs.realpathSync(cwdReal);
    const stat = fs.statSync(real);
    return stat.isDirectory() && real === cwdReal && stat.dev === Number(dev) && stat.ino === Number(ino);
  } catch {
    return false;
  }
}

/** 记忆来源引用是否全部落在导入范围内（owner_note 不依赖任何行）。 */
export function memoryRefsInScope(
  versions: Row[],
  sessionIds: Set<string>,
  artifactSession: Map<string, string>,
): { ok: boolean; reason: string | null } {
  for (const v of versions) {
    let refs: unknown;
    try {
      refs = JSON.parse(String(v.source_refs));
    } catch {
      return { ok: false, reason: `版本 ${v.version} 的 source_refs 不是合法 JSON` };
    }
    if (!Array.isArray(refs)) return { ok: false, reason: `版本 ${v.version} 的 source_refs 不是数组` };
    for (const ref of refs as Array<Record<string, unknown>>) {
      if (ref?.kind === "owner_note") continue;
      if (ref?.kind === "history_entry") {
        const sid = String(ref.sessionId ?? "");
        if (sessionIds.has(sid)) continue;
        return { ok: false, reason: `来源会话未导入：${sid}` };
      }
      if (ref?.kind === "artifact") {
        const aid = String(ref.artifactId ?? "");
        const owner = artifactSession.get(aid);
        if (owner && sessionIds.has(owner)) continue;
        return { ok: false, reason: `来源产物未导入：${aid}` };
      }
      return { ok: false, reason: `未知来源类别：${String(ref?.kind)}` };
    }
  }
  return { ok: true, reason: null };
}

// ---------- 目标状态合并（冲突、改名、根目录与组织映射决策、修订） ----------

export interface LedgerState {
  /** kind → itemId → 所属导入 id。 */
  items: Map<LedgerKind, Map<string, string>>;
  imports: Array<{ id: string; source_instance_id: string; status: string; created_at: string }>;
}

export function readLedger(db: Db | null): LedgerState {
  if (!db) return { items: new Map(), imports: [] };
  const imports = allRows(db, "SELECT id, source_instance_id, status, created_at FROM instance_imports ORDER BY created_at") as Array<{
    id: string;
    source_instance_id: string;
    status: string;
    created_at: string;
  }>;
  const items = new Map<LedgerKind, Map<string, string>>();
  for (const r of allRows(db, "SELECT kind, item_id, import_id FROM instance_import_items")) {
    const kind = String(r.kind) as LedgerKind;
    if (!items.has(kind)) items.set(kind, new Map());
    items.get(kind)!.set(String(r.item_id), String(r.import_id));
  }
  return { items, imports };
}

// ---------- 应用 ----------

export interface LegacyImportApplyResult {
  ok: true;
  /** true = 同键同参重放，返回原成果未再次执行。 */
  replayed: boolean;
  import_id: string;
  request_key: string;
  event_seq_from: number | null;
  event_seq_to: number | null;
  target_backup_path: string;
  target_backup_sha256: string;
  counts: Record<string, number>;
  report: Record<string, unknown>;
  created_at: string;
}

/** 逐行插入（列以目标表为准；行值为快照原值，保持逐字节忠实）。 */
export function insertRows(db: Db, table: string, rows: Row[], drop: string[] = []): void {
  if (rows.length === 0) return;
  const cols = columnNames(db, table).filter((c) => c in rows[0] && !drop.includes(c));
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const row of rows) {
    stmt.run(...cols.map((c) => (row[c] === undefined ? null : (row[c] as never))));
  }
}

export function escapeSqlPath(p: string): string {
  return p.replaceAll("'", "''");
}

// ---------- 回退 ----------

export interface LegacyImportRevertResult {
  ok: boolean;
  import_id: string;
  status: "applied" | "reverted";
  removed: Record<string, number>;
  files_removed: string[];
  files_kept: Array<{ item: string; reason: string }>;
  /** ok=false 时逐项列出的阻挡项（拒绝回退）。 */
  blockers?: string[];
}

// ---------- 列表 ----------

export interface LegacyImportListItem {
  id: string;
  request_key: string;
  source_instance_id: string;
  source_product: string | null;
  source_schema_version: number | null;
  source_dir: string;
  event_seq_from: number | null;
  event_seq_to: number | null;
  status: string;
  item_count: number;
  created_at: string;
  reverted_at: string | null;
}

export function listLegacyImports(deps: LegacyImportDeps): LegacyImportListItem[] {
  const targetDbFile = path.join(deps.targetDataDir, "ruukoto.db");
  if (!fs.existsSync(targetDbFile)) return [];
  const tdb = new Db(deps.targetDataDir);
  try {
    return allRows(
      tdb,
      `SELECT i.id, i.request_key, i.source_instance_id, i.source_product, i.source_schema_version, i.source_dir,
        i.event_seq_from, i.event_seq_to, i.status, i.created_at, i.reverted_at,
        (SELECT count(*) FROM instance_import_items x WHERE x.import_id = i.id) item_count
       FROM instance_imports i ORDER BY i.created_at`,
    ).map((r) => ({
      id: String(r.id),
      request_key: String(r.request_key),
      source_instance_id: String(r.source_instance_id),
      source_product: r.source_product === null ? null : String(r.source_product),
      source_schema_version: r.source_schema_version === null ? null : Number(r.source_schema_version),
      source_dir: String(r.source_dir),
      event_seq_from: r.event_seq_from === null ? null : Number(r.event_seq_from),
      event_seq_to: r.event_seq_to === null ? null : Number(r.event_seq_to),
      status: String(r.status),
      item_count: Number(r.item_count),
      created_at: String(r.created_at),
      reverted_at: r.reverted_at === null ? null : String(r.reverted_at),
    }));
  } finally {
    tdb.close();
  }
}
