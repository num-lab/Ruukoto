import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { shellQuote } from "./recovery.ts";
import { DesktopError } from "./environment.ts";
import { commandArgs, forwardArgs, SshProcess } from "./personal-ssh.ts";
import { personalManagementSocket, validatePersonalManagementConfig, type PersonalManagementConfig } from "./personal-config.ts";
import type { PersonalMaintenanceRecord, PersonalMaintenanceStatus, PersonalManagementView, PersonalProfileIdentity, PersonalSettingsSnapshot } from "../shared/personal-settings.ts";

const REQUEST_LIMIT = 128 * 1024, RESPONSE_LIMIT = 256 * 1024;
const READ_OPS = ["settings.read", "lifecycle.status", "config.preflight", "model.test", "mcp.discover", "mcp.cua-targets", "mcp.cua-status", "mcp.cua-control", "mcp.cua-image", "mcp.get", "skills.list", "skills.get", "skills.select-directory", "skills.preview-import"];
const WRITE_OPS = ["config.save", "mcp.migrate", "mcp.set-enabled", "mcp.remove", "mcp.save-service", "skills.import", "skills.set-enabled", "skills.remove"];
const WRITE_REJECTIONS = ["settings_pending", "settings_profile_changed", "settings_revision_changed", "skills_revision_conflict", "settings_stop_required", "profile_busy"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameProfile = (a: PersonalProfileIdentity, b: PersonalProfileIdentity) => a.id === b.id && a.directory === b.directory;
const validRevision = (value: unknown): value is string => typeof value === "string" && /^(missing|sha256:[0-9a-f]{64})$/.test(value);
function identity(value: unknown): value is PersonalProfileIdentity {
  return object(value) && typeof value.directory === "string" && typeof value.id === "string" && /^sha256:[0-9a-f]{64}$/.test(value.id);
}
const failure = (code: string, message: string, mutation = false) => new ControlClientError(code, message, mutation ? "unknown" : "not_sent");
export function personalMachineCommand(config: PersonalManagementConfig, entry: "settings" | "maintenance"): string {
  return `env RUUKOTO_PERSONAL_DIR=${shellQuote(config.profileDir)} ${shellQuote(config.program)} ${entry}`;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-settings-ssh.md
export class PersonalSettingsController {
  readonly config: PersonalManagementConfig;
  readonly socketPath: string;
  private readonly journal: string;
  private readonly processes = new Set<SshProcess>();
  private readonly requests = new Set<http.ClientRequest>();
  private readonly tokens = new Set<string>();
  private forward: SshProcess | null = null;
  private ownsSocket = false;
  private closed = false;
  private busy = false;
  private reading: Promise<PersonalManagementView> | null = null;
  private generation = 0;
  private profile: PersonalProfileIdentity | null = null;
  private pending: PersonalMaintenanceRecord | null = null;
  private observed = false;
  constructor(config: PersonalManagementConfig, userData: string, private readonly env: NodeJS.ProcessEnv = process.env, private readonly deps: { ssh?: string; timeoutMs?: number } = {}) {
    this.config = validatePersonalManagementConfig(config, userData);
    this.socketPath = personalManagementSocket(userData);
    this.journal = path.join(userData, "pending", "personal-settings", hash(this.config) + ".json");
    let raw: string;
    try { raw = fs.readFileSync(this.journal, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new DesktopError("maintenance_journal", "原维护记录无法读取，请恢复应用数据目录权限后核实原服务。"); }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new DesktopError("maintenance_journal", "原维护记录无法解析，请保留记录并核实原服务；未重发操作。"); }
    if (!object(value) || value.v !== 1 || !identity(value.profile) || typeof value.id !== "string" || typeof value.op !== "string" || !WRITE_OPS.includes(value.op) || !["model", "skills", "mcp"].includes(String(value.target)) || !validRevision(value.expectedRevision) || typeof value.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.requestDigest) || typeof value.saveAttempted !== "boolean" || value.rejected !== undefined && typeof value.rejected !== "string" || !["stopping", "stopped", "saving", "saved", "starting", "complete"].includes(String(value.stage)) || value.savedRevision !== undefined && !validRevision(value.savedRevision)) throw new DesktopError("maintenance_journal", "原维护记录不受支持，请保留记录并核实原服务；未重发操作。");
    this.pending = value as unknown as PersonalMaintenanceRecord;
    this.profile = this.pending.profile;
  }
  private current(generation = this.generation, mutation = !!this.pending): void {
    if (this.closed || generation !== this.generation) throw failure("management_changed", "设置管理连接已变化，请核实原档案；未继续维护。", mutation);
  }
  private redact(value: string): string {
    for (const token of this.tokens) value = value.replaceAll(token, "[令牌已隐藏]");
    return value;
  }
  private async ssh(args: string[], input?: string, mutation = false, limit = RESPONSE_LIMIT): Promise<string> {
    this.current();
    const generation = this.generation;
    const child = new SshProcess(this.deps.ssh ?? "ssh", args, this.env, true, input, limit);
    this.processes.add(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void child.stop(); }, this.deps.timeoutMs ?? 55_000);
    try {
      let result: Awaited<SshProcess["done"]>;
      try { result = await child.done; }
      catch { throw failure("management_transport", "远端应答无法读取，请核实原配置与服务；未自动重试。", mutation); }
      this.current(generation);
      if (timedOut || result.code !== 0 && result.code !== 1) throw failure(timedOut ? "management_timeout" : "management_ssh", "SSH 或新 Personal 程序不可用，请核实连接、升级程序并查询原配置与服务；未自动重试。", mutation);
      return result.stdout;
    } finally { clearTimeout(timer); this.processes.delete(child); }
  }
  private envelope(raw: string, machine: boolean, mutation: boolean): Record<string, unknown> {
    let response: unknown;
    try { response = JSON.parse(raw); }
    catch { throw failure("personal_protocol", "远端未提供新 Personal 设置协议，请升级所选程序并核实原操作。", mutation); }
    if (!object(response) || response.v !== 1 || machine && response.product !== "ruukoto" || typeof response.ok !== "boolean") throw failure("personal_protocol", "远端版本或产品不匹配，请升级新 Personal 程序；未回退旧连接。", mutation);
    if (!response.ok) {
      if (typeof response.code !== "string" || typeof response.message !== "string") throw failure("personal_protocol", "远端错误应答无效，请核实原配置与服务。", mutation);
      throw new ControlClientError(response.code, this.redact(response.message.slice(0, 1024)), mutation && !WRITE_REJECTIONS.includes(response.code) ? "unknown" : "rejected");
    }
    if (!object(response.result)) throw failure("personal_protocol", "远端结果无效，请核实原配置与服务。", mutation);
    return response.result;
  }
  private checkProfile(result: Record<string, unknown>, mutation = false): void {
    if (!identity(result.profile) || result.profile.directory !== this.config.profileDir || this.profile && !sameProfile(this.profile, result.profile)) throw failure("settings_profile_changed", "远端档案身份不匹配，请核实原档案；未继续维护。", mutation);
    this.profile = result.profile;
  }
  private async machine(entry: "settings" | "maintenance", request: Record<string, unknown>, mutation = false): Promise<Record<string, unknown>> {
    const input = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(input) > REQUEST_LIMIT) throw new ControlClientError("settings_request_large", "本次配置超过请求上限，请缩小表单。", "not_sent");
    const raw = await this.ssh(commandArgs(this.config.host, personalMachineCommand(this.config, entry)), input, mutation);
    const result = this.envelope(raw, true, mutation);
    this.checkProfile(result, mutation);
    return result;
  }
  private async maintenance(op: "inspect" | "stop" | "start"): Promise<PersonalMaintenanceStatus> {
    const result = await this.machine("maintenance", { v: 1, op, lifecycle: this.config.lifecycle, program: this.config.program, ...(this.profile ? { profile: this.profile } : {}) }, op !== "inspect");
    if (typeof result.online !== "boolean" || typeof result.writable !== "boolean" || typeof result.code !== "string" || typeof result.reason !== "string" || !object(result.lifecycle) || result.lifecycle.kind !== this.config.lifecycle || typeof result.lifecycle.state !== "string") throw failure("personal_protocol", "远端维护协议无效，请升级程序后核实原服务。", op !== "inspect");
    return result as unknown as PersonalMaintenanceStatus;
  }
  private async ensureForward(): Promise<void> {
    this.current();
    if (this.forward) return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(this.socketPath), 0o700);
    const forward = new SshProcess(this.deps.ssh ?? "ssh", forwardArgs({ host: this.config.host, controlDir: this.config.profileDir }, this.socketPath), this.env, false);
    this.forward = forward; this.processes.add(forward);
    this.ownsSocket = true;
    void forward.done.catch(() => { /* 原请求在有界 HTTP 失败处报告转发中断。 */ }).finally(() => { this.processes.delete(forward); if (this.forward === forward) this.forward = null; });
    const deadline = Date.now() + (this.deps.timeoutMs ?? 10_000);
    while (this.forward === forward && !fs.existsSync(this.socketPath) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); this.current(); }
    if (!fs.existsSync(this.socketPath) || this.forward !== forward) throw failure("management_forward", "SSH 转发未建立，请重新连接设置管理；原服务状态仍需核实。");
  }
  private async online(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mutation = request.op === "mcp.cua-control";
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > REQUEST_LIMIT) throw failure("settings_request_large", "本次配置超过请求上限，请缩小表单。");
    await this.ensureForward();
    const tokenPath = shellQuote(path.posix.join(this.config.profileDir, "control.token"));
    const rawToken = await this.ssh(commandArgs(this.config.host, `test -f ${tokenPath} && test ! -L ${tokenPath} && cat -- ${tokenPath}`), undefined, false, 128);
    const token = rawToken.trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw failure("management_token", "远端认证令牌无效，请核实后台账户与新 Personal 档案。");
    this.tokens.add(token);
    const generation = this.generation;
    const raw = await new Promise<string>((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method: "POST", path: "/settings", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" } });
      this.requests.add(req);
      const timer = setTimeout(() => req.destroy(), this.deps.timeoutMs ?? 35_000);
      req.once("close", () => { clearTimeout(timer); this.requests.delete(req); });
      req.on("error", () => reject(failure("management_http", "后台应答中断，请重新读取原配置；未重放请求。", mutation)));
      req.on("response", response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > RESPONSE_LIMIT) { response.destroy(); reject(failure("settings_response_large", "后台结果超过上限，请缩小分页后读取。", mutation)); } else chunks.push(chunk); });
        response.on("error", () => reject(failure("management_http", "后台应答中断，请重新读取原配置。", mutation)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.end(input);
    });
    this.current(generation, mutation);
    const result = this.envelope(raw, false, mutation);
    this.checkProfile(result, mutation);
    return result;
  }
  private snapshot(result: Record<string, unknown>): PersonalSettingsSnapshot {
    if (result.product !== "ruukoto" || typeof result.online !== "boolean" || !object(result.revisions) || ![result.revisions.model, result.revisions.skills, result.revisions.mcp].every(validRevision) || !Array.isArray(result.blockers) || !object(result.lifecycle)) throw failure("personal_protocol", "远端配置协议不匹配，请升级程序并重新读取原档案。");
    return result as unknown as PersonalSettingsSnapshot;
  }
  private record(value: PersonalMaintenanceRecord | null): void {
    try {
      if (value) {
        fs.mkdirSync(path.dirname(this.journal), { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.journal + ".tmp", JSON.stringify(value) + "\n", { mode: 0o600 });
        fs.renameSync(this.journal + ".tmp", this.journal);
      } else fs.rmSync(this.journal, { force: true });
    } catch { throw failure("maintenance_journal", "维护记录未能保存，请保留应用数据并核实原服务；未继续操作。"); }
    this.pending = value; this.observed = false;
  }
  private stage(stage: PersonalMaintenanceRecord["stage"], receipt?: { savedRevision?: string; rejected?: string }): void { this.record({ ...this.pending!, stage, ...receipt }); }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.current();
    if (this.busy) throw failure("management_busy", "原维护操作仍在进行，请等待后核实。");
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  private async inspect(): Promise<PersonalManagementView> {
    const maintenance = await this.maintenance("inspect");
    const settings = this.snapshot(await this.machine("settings", { v: 1, op: "settings.read", limit: 1 }));
    const current = settings.online ? this.snapshot(await this.online({ v: 1, op: "settings.read", limit: 1 })) : settings;
    const saved = this.pending?.savedRevision ? true : !this.pending?.saveAttempted || !!this.pending.rejected ? false : null;
    this.observed = true;
    return { settings: current, maintenance, pending: this.pending, saved, message: !this.pending ? maintenance.reason : saved === true ? current.online ? "配置已保存；请核对当前配置与生效状态。" : "配置已保存，后台尚未启动；可显式恢复原服务。" : saved === false ? "本次未保存；请核实服务状态，必要时恢复原服务。" : "保存结果待核实；请比较原修订与当前配置，不会自动重发。" };
  }
  async read(): Promise<PersonalManagementView> {
    this.current();
    this.reading ??= this.exclusive(() => this.inspect()).finally(() => { this.reading = null; });
    return this.reading;
  }
  hasPendingOperation(): boolean { return this.pending !== null; }
  probe(): Promise<PersonalMaintenanceStatus> {
    return this.exclusive(async () => { const maintenance = await this.maintenance("inspect"); this.snapshot(await this.machine("settings", { v: 1, op: "settings.read", limit: 1 })); return maintenance; });
  }
  request(value: unknown): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      if (!object(value) || value.v !== 1 || typeof value.op !== "string" || !READ_OPS.includes(value.op)) throw failure("op_not_allowed", "此设置查询不受支持，请更新客户端。");
      if ("profile" in value && (!identity(value.profile) || !this.profile || !sameProfile(this.profile, value.profile))) throw failure("settings_profile_changed", "请求不属于当前档案，请重新读取原配置。");
      if (value.op === "mcp.cua-image" || value.op === "mcp.cua-control") return this.online(value);
      const view = await this.inspect();
      return view.settings.online ? this.online(value) : this.machine("settings", value);
    });
  }
  apply(value: unknown): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (this.pending) throw failure("maintenance_pending", "原维护结果仍待核实，请先查询原配置与服务。");
      if (!object(value) || value.v !== 1 || typeof value.op !== "string" || !WRITE_OPS.includes(value.op) || !identity(value.profile) || !validRevision(value.expectedRevision)) throw failure("op_not_allowed", "请选择单项配置后显式停止、保存并启动。");
      if (Buffer.byteLength(JSON.stringify(value)) > REQUEST_LIMIT) throw failure("settings_request_large", "本次配置超过请求上限，请缩小表单。");
      const view = await this.inspect();
      if (!sameProfile(view.settings.profile, value.profile)) throw failure("settings_profile_changed", "档案身份已变化，未停止服务；请重新读取。");
      if (!view.settings.online || !view.maintenance.writable || view.settings.lifecycle.managedDevelopment) throw new ControlClientError("maintenance_read_only", view.maintenance.reason || "原服务环境尚未核实，请先按部署说明配置并启动原服务。", "rejected");
      if (view.settings.blockers.length) throw new ControlClientError("settings_pending", "仍有未决输入、工作或外部占用，请用原配置处理后再保存。", "rejected");
      if (view.settings.model?.credential.state !== "available") throw new ControlClientError("model_environment_unverified", "实际后台的模型凭据不可用，未停止服务；请恢复原服务环境。", "rejected");
      if (value.op === "config.save") {
        const preflight = await this.online({ ...value, op: "config.preflight" });
        if (!Array.isArray(preflight.blockers) || preflight.blockers.length) throw new ControlClientError("settings_pending", "配置预检存在未决事项，未停止服务；请刷新后处理。", "rejected");
        if (value.target === "model" && (!object(preflight.credential) || preflight.credential.state !== "available")) throw new ControlClientError("model_environment_unverified", "所选凭据引用在实际后台不可用，未停止服务；请先配置服务环境。", "rejected");
      }
      const target = value.op.startsWith("skills.") ? "skills" : value.op.startsWith("mcp.") ? "mcp" : value.target;
      if (target !== "model" && target !== "skills" && target !== "mcp") throw failure("invalid_params", "请选择一个有效配置类别。");
      this.record({ v: 1, id: randomUUID(), profile: value.profile, op: value.op, target, expectedRevision: value.expectedRevision, requestDigest: hash(value), saveAttempted: false, stage: "stopping" });
      const stopped = await this.maintenance("stop");
      if (stopped.online || stopped.lifecycle.state !== "stopped") throw failure("maintenance_stop_unverified", "停止尚未核实，未保存；请查询原服务与档案锁。");
      this.stage("stopped");
      this.record({ ...this.pending!, stage: "saving", saveAttempted: true });
      let result: Record<string, unknown>;
      try { result = await this.machine("settings", value, true); }
      catch (error) {
        if (error instanceof ControlClientError && error.outcome === "rejected" && WRITE_REJECTIONS.includes(error.code)) this.stage("stopped", { rejected: error.code });
        throw error;
      }
      if (result.saved !== true || !validRevision(result.revision)) throw failure("maintenance_save_unverified", "未取得有效保存回执，请核实原配置；不会重发保存。", true);
      this.pending = { ...this.pending!, savedRevision: result.revision };
      this.stage("saved", { savedRevision: result.revision });
      this.stage("starting");
      try { await this.maintenance("start"); }
      catch { return { ...await this.inspect(), saved: true, message: "配置已保存，但启动未核实；请查询状态或显式恢复原服务。" }; }
      const after = await this.inspect();
      const observedRevision = value.op.startsWith("skills.") && object(after.settings.skills) ? after.settings.skills.revision : after.settings.revisions[target];
      if (after.settings.online && observedRevision === result.revision) {
        this.record(null);
        return { ...after, pending: null, saved: true, message: "配置已保存且已启动，请核对实际配置；连接尚未测试。" };
      }
      return { ...after, saved: true, message: "配置已保存，启动或实际修订仍待核实；请查询原服务与当前配置。" };
    }).catch(error => {
      if (error instanceof ControlClientError && ["maintenance_pending", "management_busy"].includes(error.code)) throw error;
      if (this.pending?.savedRevision) throw failure("maintenance_saved_start_unverified", "配置已保存，启动或读回尚未核实；请查询原配置与服务，再显式恢复启动。", true);
      throw error;
    });
  }
  restore(): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (!this.pending) throw failure("maintenance_missing", "没有待恢复的原维护操作，请先读取当前状态。");
      const before = await this.inspect();
      if (!before.settings.online) { this.stage("starting"); await this.maintenance("start"); }
      return this.inspect();
    });
  }
  finish(): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (!this.observed) throw failure("maintenance_unverified", "请先查询原配置与服务，再确认人工核实结果。");
      const view = await this.inspect();
      this.record(null);
      return { ...view, pending: null, message: "已结束人工核实的维护记录；当前配置与服务状态见上方。" };
    });
  }
  async close(): Promise<void> {
    this.closed = true; ++this.generation;
    for (const request of this.requests) request.destroy();
    await Promise.all([...this.processes].map(process => process.stop()));
    if (this.ownsSocket) fs.rmSync(this.socketPath, { force: true }); this.tokens.clear();
  }
}
