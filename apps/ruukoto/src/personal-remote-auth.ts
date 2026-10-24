import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { PersonalError } from "./personal-error.ts";
import { assertPersonalRemoteDirectory, readPersonalRemoteFile, writePersonalRemoteFile } from "./personal-remote-storage.ts";

export type PersonalRemoteBinding = { origin: string; owner: string; profile: { id: string; directory: string } };
export type PersonalRemoteCredentialId = string;
export type PersonalRemotePairRequest = { v: 1; code: string; label: string };
export type PersonalRemoteCredentialReceipt = { id: PersonalRemoteCredentialId; label: string; createdAt: number; status: "active" | "revoked"; revokedAt?: number; remoteId: string; origin: string; profile: PersonalRemoteBinding["profile"] };
type Credential = { id: PersonalRemoteCredentialId; label: string; digest: string; requestDigest: string; binding: PersonalRemoteBinding; createdAt: number; revokedAt?: number };
type State = { v: 1; remoteId: string; binding: PersonalRemoteBinding; confirmed: boolean; credentials: Credential[]; pairing?: { digest: string; expiresAt: number; errors: number } };
type Options = { initialize?: boolean; home?: () => string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const equalDigest = (a: string, b: string) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const invalid = () => new PersonalError("remote_auth_state_invalid", "远程认证状态无法核实，入口保持关闭；请保留原记录并在服务器检查或恢复。");

function parseBinding(value: unknown): PersonalRemoteBinding {
  if (!object(value) || !keys(value, ["origin", "owner", "profile"]) || typeof value.origin !== "string" || typeof value.owner !== "string" || !value.owner || value.owner.length > 320 || value.owner.trim() !== value.owner || /[\x00-\x20\x7f]/.test(value.owner) || !object(value.profile) || !keys(value.profile, ["id", "directory"]) || typeof value.profile.id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.profile.id) || typeof value.profile.directory !== "string" || !path.isAbsolute(value.profile.directory) || path.resolve(value.profile.directory) !== value.profile.directory || /[\x00-\x1f\x7f]/.test(value.profile.directory)) throw invalid();
  let origin: URL;
  try { origin = new URL(value.origin); } catch { throw invalid(); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.origin !== value.origin) throw invalid();
  return { origin: value.origin, owner: value.owner, profile: { id: value.profile.id, directory: value.profile.directory } };
}

function parseState(raw: string): State {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!object(value) || !keys(value, ["v", "remoteId", "binding", "confirmed", "credentials", "pairing"]) || value.v !== 1 || typeof value.remoteId !== "string" || !UUID.test(value.remoteId) || typeof value.confirmed !== "boolean" || !Array.isArray(value.credentials)) throw invalid();
  const binding = parseBinding(value.binding), ids = new Set<string>();
  const credentials = value.credentials.map((item: unknown): Credential => {
    if (!object(item) || !keys(item, ["id", "label", "digest", "requestDigest", "binding", "createdAt", "revokedAt"]) || typeof item.id !== "string" || !UUID.test(item.id) || ids.has(item.id) || typeof item.label !== "string" || !validLabel(item.label) || typeof item.digest !== "string" || !HASH.test(item.digest) || typeof item.requestDigest !== "string" || !HASH.test(item.requestDigest) || !time(item.createdAt) || item.revokedAt !== undefined && (!time(item.revokedAt) || item.revokedAt < item.createdAt)) throw invalid();
    ids.add(item.id);
    const savedBinding = parseBinding(item.binding);
    if (item.revokedAt === undefined && (!value.confirmed || !isDeepStrictEqual(savedBinding, binding))) throw invalid();
    return { id: item.id, label: item.label, digest: item.digest, requestDigest: item.requestDigest, binding: savedBinding, createdAt: item.createdAt, ...(item.revokedAt === undefined ? {} : { revokedAt: item.revokedAt }) };
  });
  const state: State = { v: 1, remoteId: value.remoteId, binding, confirmed: value.confirmed, credentials };
  if (value.pairing !== undefined) {
    const pairing = value.pairing;
    if (!value.confirmed || !object(pairing) || !keys(pairing, ["digest", "expiresAt", "errors"]) || typeof pairing.digest !== "string" || !HASH.test(pairing.digest) || !time(pairing.expiresAt) || !Number.isInteger(pairing.errors) || Number(pairing.errors) < 0 || Number(pairing.errors) >= 5) throw invalid();
    state.pairing = { digest: pairing.digest, expiresAt: pairing.expiresAt, errors: Number(pairing.errors) };
  }
  return state;
}

function validLabel(label: string) { return !!label.trim() && label.length <= 80 && label.trim() === label && !/[\x00-\x1f\x7f]/.test(label); }
function credential(authorization: string | undefined) {
  const match = authorization?.match(/^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
  if (!match || !UUID.test(match[1]) || Buffer.from(match[2], "base64url").toString("base64url") !== match[2]) throw new PersonalError("remote_credential_invalid", "应用凭据无效，请核实原配对记录；未接纳业务。");
  return { id: match[1], digest: digest(match[2]) };
}

function privateLockFile(filename: string) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw invalid();
  return stat;
}

export function personalRemoteDirectory(home: () => string = homedir): string { return path.join(home(), ".config", "ruukoto-remote"); }

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
/** 同步提交串行化认证准入。写入或读回失败后实例关闭；调用方须关闭旧连接，并在释放本锁前停止所有私有入口。 */
export class PersonalRemoteAuth {
  readonly directory: string;
  private readonly owner: DatabaseSync;
  private readonly directoryIdentity: { dev: number; ino: number };
  private state!: State;
  private encoded: string | undefined;
  private closed = false;
  private failed = false;

  constructor(binding: PersonalRemoteBinding, options: Options = {}) {
    binding = parseBinding(binding);
    const home = (options.home ?? homedir)();
    const homeStat = fs.lstatSync(home);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== process.getuid?.() || path.resolve(home) !== home || fs.realpathSync(home) !== home) throw invalid();
    const config = path.join(home, ".config");
    fs.mkdirSync(config, { mode: 0o700, recursive: true });
    const configStat = fs.lstatSync(config);
    if (!configStat.isDirectory() || configStat.isSymbolicLink() || configStat.uid !== process.getuid?.() || (configStat.mode & 0o022) !== 0) throw invalid();
    this.directory = personalRemoteDirectory(() => home);
    fs.mkdirSync(this.directory, { mode: 0o700, recursive: true });
    this.directoryIdentity = assertPersonalRemoteDirectory(this.directory);
    if (Buffer.byteLength(path.join(this.directory, "admin.sock")) > 100) throw new PersonalError("remote_path_long", "远程入口私有 socket 路径过长，请使用较短的服务器账户目录。");
    const lock = path.join(this.directory, "owner.sqlite");
    const fd = fs.openSync(lock, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
    privateLockFile(lock);
    this.owner = new DatabaseSync(lock);
    try { this.owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
    catch (error) {
      this.owner.close();
      if (error instanceof Error && "errcode" in error && error.errcode === 5) throw new PersonalError("remote_busy", "已有远程入口持有认证状态，请连接原入口或等待它退出。", { cause: error });
      throw new PersonalError("remote_lock_failed", "无法锁定远程认证状态，入口保持关闭；请检查私有目录与磁盘。", { cause: error });
    }
    try {
      const filename = path.join(this.directory, "auth.json");
      if (!fs.lstatSync(filename, { throwIfNoEntry: false })) {
        if (!options.initialize) throw new PersonalError("remote_auth_state_missing", "远程认证状态缺失，入口保持关闭；请保留原目录并在服务器显式初始化或恢复。");
        this.save({ v: 1, remoteId: randomUUID(), binding, confirmed: true, credentials: [] });
      } else {
        this.encoded = this.read(); this.state = parseState(this.encoded);
        this.updateBinding(binding);
        this.cancelPairing();
      }
    } catch (error) { this.owner.close(); this.closed = true; throw error; }
  }

  private read(): string {
    return readPersonalRemoteFile(this.directory, "auth.json");
  }

  private check(): void {
    if (this.closed || this.failed) throw new PersonalError("remote_auth_closed", "远程认证入口已关闭，请在服务器检查状态后重新启动。");
    try {
      const current = assertPersonalRemoteDirectory(this.directory);
      if (current.dev !== this.directoryIdentity.dev || current.ino !== this.directoryIdentity.ino) throw invalid();
      if (this.encoded !== undefined && this.read() !== this.encoded || this.encoded === undefined && fs.lstatSync(path.join(this.directory, "auth.json"), { throwIfNoEntry: false })) throw invalid();
    } catch (error) { this.failed = true; throw new PersonalError("remote_auth_state_changed", "远程认证记录已变化或无法读取，入口已关闭；请保留现场并在服务器核实。", { cause: error }); }
  }

  private save(next: State): void {
    this.check();
    const raw = JSON.stringify(next) + "\n";
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) { this.failed = true; throw invalid(); }
    try {
      writePersonalRemoteFile(this.directory, "auth.json", raw);
    } catch (error) { this.failed = true; throw new PersonalError("remote_auth_write_failed", "远程认证提交未核实，入口已关闭；请保留原记录并在服务器检查后重新启动。", { cause: error }); }
    this.state = next; this.encoded = raw;
  }

  private ready(): void {
    this.check();
    if (!this.state.confirmed) throw new PersonalError("remote_binding_unconfirmed", "远程入口归属已变化，旧凭据已撤销；请在服务器确认新归属后重新配对。");
  }

  private receipt(item: Credential): PersonalRemoteCredentialReceipt {
    return { id: item.id, label: item.label, createdAt: item.createdAt, status: item.revokedAt === undefined ? "active" : "revoked", ...(item.revokedAt === undefined ? {} : { revokedAt: item.revokedAt }), remoteId: this.state.remoteId, origin: item.binding.origin, profile: { ...item.binding.profile } };
  }

  identity() { this.check(); return { remoteId: this.state.remoteId, binding: structuredClone(this.state.binding), confirmed: this.state.confirmed }; }
  list(): PersonalRemoteCredentialReceipt[] { this.check(); return this.state.credentials.map(item => this.receipt(item)); }

  updateBinding(binding: PersonalRemoteBinding): void {
    this.check();
    binding = parseBinding(binding);
    if (isDeepStrictEqual(this.state.binding, binding)) return;
    const next = structuredClone(this.state), now = Date.now();
    for (const item of next.credentials) item.revokedAt ??= Math.max(now, item.createdAt);
    delete next.pairing;
    next.binding = binding; next.confirmed = false;
    this.save(next);
  }

  confirmBinding(): void {
    this.check();
    if (!this.state.confirmed) this.save({ ...structuredClone(this.state), confirmed: true });
  }

  openPairing(): { code: string; expiresAt: number } {
    this.ready();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", code = Array.from(randomBytes(12), byte => alphabet[byte & 31]).join(""), expiresAt = Date.now() + 5 * 60_000;
    this.save({ ...structuredClone(this.state), pairing: { digest: digest(code), expiresAt, errors: 0 } });
    return { code, expiresAt };
  }

  cancelPairing(): void {
    this.check();
    if (!this.state.pairing) return;
    const next = structuredClone(this.state); delete next.pairing; this.save(next);
  }

  private rejectPair(): never {
    const next = structuredClone(this.state);
    if (next.pairing) {
      next.pairing.errors++;
      if (next.pairing.errors >= 5 || next.pairing.expiresAt <= Date.now()) delete next.pairing;
      this.save(next);
    }
    throw new PersonalError("remote_pairing_rejected", "配对未通过，请核实原配对码；窗口失效时在服务器重新开启。");
  }

  pair(login: string | undefined, authorization: string | undefined, request: PersonalRemotePairRequest): PersonalRemoteCredentialReceipt {
    this.ready();
    if (login !== this.state.binding.owner) throw new PersonalError("remote_source_rejected", "当前网络身份不属于此入口的拥有者，未登记凭据。");
    let supplied: ReturnType<typeof credential>;
    try { supplied = credential(authorization); } catch { return this.rejectPair(); }
    const requestDigest = digest(JSON.stringify([request.v, request.code, request.label])), existing = this.state.credentials.find(item => item.id === supplied.id);
    if (existing) {
      if (!equalDigest(existing.digest, supplied.digest) || existing.binding.owner !== login) throw new PersonalError("remote_credential_invalid", "原应用凭据无法核实，未登记其他凭据。");
      if (!equalDigest(existing.requestDigest, requestDigest)) throw new PersonalError("remote_pairing_conflict", "原配对请求内容不一致，请使用原候选凭据核实登记结果。");
      return this.receipt(existing);
    }
    if (!this.state.pairing || this.state.pairing.expiresAt <= Date.now()) {
      this.cancelPairing();
      throw new PersonalError("remote_pairing_closed", "配对窗口已关闭，请在服务器重新开启后配对。");
    }
    if (request.v !== 1 || !/^[A-Z2-7]{12}$/.test(request.code) || !validLabel(request.label) || !equalDigest(this.state.pairing.digest, digest(request.code))) return this.rejectPair();
    const next = structuredClone(this.state), item: Credential = { ...supplied, label: request.label, requestDigest, binding: structuredClone(next.binding), createdAt: Date.now() };
    next.credentials.push(item); delete next.pairing;
    this.save(next);
    return this.receipt(item);
  }

  authenticate(login: string | undefined, authorization: string | undefined): PersonalRemoteCredentialReceipt {
    this.ready();
    if (login !== this.state.binding.owner) throw new PersonalError("remote_source_rejected", "当前网络身份不属于此入口的拥有者，未接纳业务。");
    const supplied = credential(authorization), item = this.state.credentials.find(item => item.id === supplied.id);
    if (!item || !equalDigest(item.digest, supplied.digest)) throw new PersonalError("remote_credential_invalid", "应用凭据无效，请核实原配对记录；未接纳业务。");
    if (item.revokedAt !== undefined) throw new PersonalError("remote_credential_revoked", "此应用凭据已撤销，请在服务器重新配对；原已接纳操作仍可核实。");
    return this.receipt(item);
  }

  revoke(id: PersonalRemoteCredentialId): PersonalRemoteCredentialReceipt {
    this.check();
    const next = structuredClone(this.state), item = next.credentials.find(item => item.id === id);
    if (!item) throw new PersonalError("remote_credential_missing", "原配对记录不存在，请重新读取服务器列表。");
    if (item.revokedAt === undefined) { item.revokedAt = Math.max(Date.now(), item.createdAt); this.save(next); }
    return this.receipt(item);
  }

  close(): void { if (!this.closed) { this.closed = true; this.owner.close(); } }
}

export function openPersonalRemoteAuth(binding: PersonalRemoteBinding, options: Options = {}): PersonalRemoteAuth {
  try { return new PersonalRemoteAuth(binding, options); }
  catch (error) { if (error instanceof PersonalError) throw error; throw new PersonalError("remote_auth_open_failed", "远程认证状态无法打开，入口保持关闭；请保留原记录并在服务器检查目录与磁盘。", { cause: error }); }
}
