import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_REQUEST_ID } from "./personal-control.ts";
import { executePersonalMaintenance, type PersonalMaintenanceResult } from "./personal-maintenance.ts";
import { executePersonalSettings, parsePersonalSettingsRequest, type PersonalSettingsIdentity, type PersonalSettingsRequest, type PersonalSettingsTarget } from "./personal-settings.ts";
import { readPersonalRemoteFile, writePersonalRemoteFile } from "./personal-remote-storage.ts";

export const PERSONAL_REMOTE_SETTINGS_READ = ["settings.read", "lifecycle.status", "config.preflight", "model.test", "mcp.discover", "mcp.cua-targets", "mcp.cua-status", "mcp.cua-control", "mcp.cua-image", "mcp.get", "skills.list", "skills.get", "skills.select-directory", "skills.preview-import"];
export const PERSONAL_REMOTE_SETTINGS_WRITE = ["config.save", "mcp.migrate", "mcp.set-enabled", "mcp.remove", "mcp.save-service", "skills.import", "skills.set-enabled", "skills.remove"];
type Stage = "stopping" | "stopped" | "saving" | "saved" | "starting" | "complete";
export type PersonalRemoteMaintenanceReceipt = {
  v: 1; id: string; profile: PersonalSettingsIdentity; op: string; target: PersonalSettingsTarget; expectedRevision: string; requestDigest: string;
  stage: Stage; saveAttempted: boolean; savedRevision?: string; saved: boolean | null; started: boolean; code?: string;
};
type Ledger = { v: 1; pending: string | null; receipts: Record<string, PersonalRemoteMaintenanceReceipt> };
type Settings = {
  product: "ruukoto"; profile: PersonalSettingsIdentity; online: boolean; revisions: Record<PersonalSettingsTarget, string>;
  blockers: unknown[]; lifecycle: { managedDevelopment: boolean }; model: { credential: { state: string } } | null;
  skills?: { revision: string };
};
type Dependencies = {
  settings(value: PersonalSettingsRequest): Promise<unknown>;
  maintenance(op: "inspect" | "stop" | "start"): Promise<PersonalMaintenanceResult>;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const revision = (value: unknown): value is string => typeof value === "string" && /^(missing|sha256:[0-9a-f]{64})$/.test(value);
const identity = (value: unknown): value is PersonalSettingsIdentity => object(value) && Object.keys(value).sort().join(",") === "directory,id" && typeof value.directory === "string" && path.isAbsolute(value.directory) && path.resolve(value.directory) === value.directory && !/[\x00-\x1f\x7f]/.test(value.directory) && typeof value.id === "string" && /^sha256:[0-9a-f]{64}$/.test(value.id);
const error = (code: string, message: string) => new PersonalError(code, message);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export class PersonalRemoteMaintenance {
  private ledger: Ledger;
  private busy = false;
  private closing = false;
  private unhealthy = false;
  private running: Promise<void> | undefined;
  private readonly deps: Dependencies;
  constructor(private readonly directory: string, private readonly profile: PersonalSettingsIdentity, options: { initialize?: boolean; dependencies?: Dependencies; failed?: () => void } = {}) {
    this.failed = options.failed ?? (() => {});
    this.deps = options.dependencies ?? {
      settings: value => executePersonalSettings(profile.directory, value),
      maintenance: op => executePersonalMaintenance(profile.directory, { v: 1, op, lifecycle: "systemd", program: fileURLToPath(new URL("../bin/ruukoto.mjs", import.meta.url)), profile }),
    };
    if (options.initialize && !fs.lstatSync(path.join(directory, "maintenance.json"), { throwIfNoEntry: false })) writePersonalRemoteFile(directory, "maintenance.json", JSON.stringify({ v: 1, pending: null, receipts: {} }) + "\n");
    let value: unknown;
    try { value = JSON.parse(readPersonalRemoteFile(directory, "maintenance.json")); }
    catch (failure) { throw error("remote_maintenance_invalid", "维护记录无法读取，请保留原远程状态并恢复记录；未创建空账本。"); }
    if (!object(value) || value.v !== 1 || !object(value.receipts) || value.pending !== null && typeof value.pending !== "string") throw error("remote_maintenance_invalid", "维护记录版本或内容无效，请保留记录并检查原服务。");
    for (const [id, receipt] of Object.entries(value.receipts)) {
      if (!PERSONAL_REQUEST_ID.test(id) || !object(receipt) || receipt.v !== 1 || receipt.id !== id || !identity(receipt.profile) || typeof receipt.op !== "string" || !PERSONAL_REMOTE_SETTINGS_WRITE.includes(receipt.op) || !["model", "skills", "mcp"].includes(String(receipt.target)) || !revision(receipt.expectedRevision) || typeof receipt.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.requestDigest) || !["stopping", "stopped", "saving", "saved", "starting", "complete"].includes(String(receipt.stage)) || typeof receipt.saveAttempted !== "boolean" || ![true, false, null].includes(receipt.saved as boolean | null) || typeof receipt.started !== "boolean" || receipt.savedRevision !== undefined && !revision(receipt.savedRevision) || receipt.code !== undefined && typeof receipt.code !== "string") throw error("remote_maintenance_invalid", "原维护回执无法核实，请保留记录；未重复执行保存。");
      if (receipt.saved === true ? !receipt.saveAttempted || !receipt.savedRevision : receipt.savedRevision !== undefined) throw error("remote_maintenance_invalid", "原保存事实与修订不一致，请保留记录并核实原配置。");
      if (!receipt.saveAttempted && receipt.saved !== false || receipt.started && receipt.stage !== "complete" || receipt.stage === "stopping" && (receipt.saveAttempted || receipt.saved !== false) || receipt.stage === "stopped" && receipt.saved !== false || receipt.stage === "saving" && (!receipt.saveAttempted || receipt.saved !== null) || receipt.stage === "saved" && receipt.saved !== true) throw error("remote_maintenance_invalid", "原维护阶段与保存事实不一致，请保留记录；未继续启停或保存。");
    }
    if (value.pending !== null && (!value.receipts[value.pending] || (value.receipts[value.pending] as PersonalRemoteMaintenanceReceipt).stage === "complete")) throw error("remote_maintenance_invalid", "原未决维护关联无效，请保留记录并核实原服务。");
    const unresolved = Object.values(value.receipts).filter(receipt => (receipt as PersonalRemoteMaintenanceReceipt).stage !== "complete") as PersonalRemoteMaintenanceReceipt[];
    if (value.pending === null ? unresolved.length !== 0 : unresolved.length !== 1 || unresolved[0].id !== value.pending) throw error("remote_maintenance_invalid", "未完成回执与当前维护关联不一致，请保留记录；未接纳另一项保存。");
    this.ledger = value as Ledger;
  }
  private readonly failed: () => void;
  private persist(next: Ledger): void {
    try { writePersonalRemoteFile(this.directory, "maintenance.json", JSON.stringify(next) + "\n"); }
    catch (failure) { this.unhealthy = true; this.closing = true; this.failed(); throw failure; }
    this.ledger = next;
  }
  private update(receipt: PersonalRemoteMaintenanceReceipt): void {
    this.persist({ v: 1, pending: receipt.stage === "complete" ? null : receipt.id, receipts: { ...this.ledger.receipts, [receipt.id]: receipt } });
  }
  pending(): PersonalRemoteMaintenanceReceipt | null { return this.ledger.pending ? this.query(this.ledger.pending) : null; }
  query(id: string): PersonalRemoteMaintenanceReceipt | null {
    if (!PERSONAL_REQUEST_ID.test(id)) throw error("remote_maintenance_request_invalid", "请选择原维护操作；请求标识由程序管理。");
    const receipt = this.ledger.receipts[id];
    return receipt ? structuredClone(receipt) : null;
  }
  private async settings(): Promise<Settings> {
    const value = await this.deps.settings({ v: 1, op: "settings.read", limit: 1 });
    if (!object(value) || value.product !== "ruukoto" || !isDeepStrictEqual(value.profile, this.profile) || typeof value.online !== "boolean" || !object(value.revisions) || !Object.values(value.revisions).every(revision) || !Array.isArray(value.blockers) || !object(value.lifecycle) || typeof value.lifecycle.managedDevelopment !== "boolean" || value.model !== null && (!object(value.model) || !object(value.model.credential) || typeof value.model.credential.state !== "string")) throw error("remote_maintenance_protocol", "原后台配置身份无法核实，请检查原档案；未继续维护。");
    return value as Settings;
  }
  async view() {
    const maintenance = await this.deps.maintenance("inspect");
    if (!isDeepStrictEqual(maintenance.profile, this.profile)) throw error("remote_profile_changed", "原服务档案已变化，请在服务器核实绑定；未操作新档案。");
    return { settings: await this.settings(), maintenance, pending: this.pending() };
  }
  async admit(id: string, value: unknown, authorize: () => void): Promise<PersonalRemoteMaintenanceReceipt> {
    const previous = this.query(id), request = parsePersonalSettingsRequest(value);
    if (!("profile" in request) || !PERSONAL_REMOTE_SETTINGS_WRITE.includes(request.op) || !isDeepStrictEqual(request.profile, this.profile)) throw error("remote_maintenance_request_invalid", "请选择当前档案的一项设置操作；未接纳维护。");
    const requestDigest = createHash("sha256").update(canonical(request)).digest("hex");
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw error("remote_request_conflict", "原请求参数不同，请查询原维护回执；未重复保存。");
      authorize();
      return previous;
    }
    if (this.closing || this.busy || this.ledger.pending) throw error("remote_maintenance_pending", "仍有原维护待核实，请先读取原操作；未接纳另一项保存。");
    this.busy = true;
    try {
      const view = await this.view();
      if (!view.settings.online || !view.maintenance.writable || view.settings.lifecycle.managedDevelopment) throw error("maintenance_read_only", "原服务环境尚未核实，请先配置并启动固定服务；设置保持只读。");
      if (view.settings.blockers.length) throw error("settings_pending", "仍有未决输入、工作或外部占用，请先用原配置处理。");
      if (view.settings.model?.credential.state !== "available") throw error("model_environment_unverified", "实际后台模型凭据不可用，未停止服务；请先恢复原环境。");
      if (request.op === "config.save") {
        const preflight = await this.deps.settings({ ...request, op: "config.preflight" });
        if (!object(preflight) || !Array.isArray(preflight.blockers) || preflight.blockers.length) throw error("settings_pending", "配置预检仍有未决事项，未停止原服务。");
        if (request.target === "model" && (!object(preflight.credential) || preflight.credential.state !== "available")) throw error("model_environment_unverified", "所选模型凭据在实际后台不可用，未停止原服务。");
      }
      const target = request.op === "config.save" ? request.target : request.op.startsWith("skills.") ? "skills" : "mcp";
      const receipt: PersonalRemoteMaintenanceReceipt = { v: 1, id, profile: this.profile, op: request.op, target, expectedRevision: request.expectedRevision, requestDigest, stage: "stopping", saveAttempted: false, saved: false, started: false };
      authorize();
      this.update(receipt);
      this.running = this.run(receipt, request).finally(() => { this.busy = false; });
      void this.running.catch(() => { process.stderr.write("[ruukoto:remote] 维护记录写入失败，远程入口已关闭；请保留状态并核实原服务。\n"); });
      return structuredClone(receipt);
    } catch (failure) { this.busy = false; throw failure; }
  }
  private async run(receipt: PersonalRemoteMaintenanceReceipt, request: PersonalSettingsRequest): Promise<void> {
    const stage = (change: Partial<PersonalRemoteMaintenanceReceipt>) => { receipt = { ...receipt, ...change }; this.update(receipt); };
    try {
      const stopped = await this.deps.maintenance("stop");
      if (stopped.online || stopped.lifecycle.state !== "stopped") throw error("maintenance_stop_unverified", "原服务停止未核实，尚未保存。");
      stage({ stage: "stopped" });
      stage({ stage: "saving", saveAttempted: true, saved: null });
      const saved = await this.deps.settings(request);
      if (!object(saved) || saved.saved !== true || !revision(saved.revision)) throw error("maintenance_save_unverified", "保存回执无效，请比较原修订与当前配置；不会重发保存。");
      stage({ stage: "saved", saved: true, savedRevision: saved.revision });
      stage({ stage: "starting" });
      const started = await this.deps.maintenance("start");
      if (!started.online) throw error("maintenance_start_unverified", "配置已保存，原服务启动尚未核实。");
      const current = await this.settings();
      const observed = receipt.target === "skills" && request.op !== "config.save" ? current.skills?.revision : current.revisions[receipt.target];
      if (!current.online || observed !== receipt.savedRevision) throw error("maintenance_start_unverified", "配置已保存，实际启动或修订仍待核实。");
      stage({ stage: "complete", started: true });
    } catch (failure) {
      if (this.unhealthy) throw failure;
      const code = failure instanceof PersonalError ? failure.code : "remote_maintenance_unverified";
      if (receipt.stage === "saving" && ["settings_pending", "settings_profile_changed", "settings_revision_changed", "skills_revision_conflict", "settings_stop_required", "profile_busy"].includes(code)) stage({ stage: "stopped", saved: false, code });
      else stage({ code });
    }
  }
  async restore(id: string, authorize: () => void): Promise<PersonalRemoteMaintenanceReceipt> {
    if (this.closing || this.busy || this.ledger.pending !== id) throw error("remote_maintenance_pending", "请选择未运行且仍待核实的原维护操作。");
    this.busy = true;
    try {
      let receipt = this.query(id)!;
      if (!isDeepStrictEqual(receipt.profile, this.profile)) throw error("remote_profile_changed", "原维护属于另一档案，请在服务器核实原关联；未启动当前服务。");
      const before = await this.view();
      authorize();
      if (!before.settings.online) {
        receipt = { ...receipt, stage: "starting" }; this.update(receipt);
        await this.deps.maintenance("start");
      }
      const current = await this.settings();
      const observed = receipt.target === "skills" && receipt.op !== "config.save" ? current.skills?.revision : current.revisions[receipt.target];
      if (current.online && receipt.savedRevision && observed === receipt.savedRevision) receipt = { ...receipt, stage: "complete", started: true, code: undefined };
      this.update(receipt);
      return structuredClone(receipt);
    } finally { this.busy = false; }
  }
  async finish(id: string, authorize: () => void): Promise<PersonalRemoteMaintenanceReceipt> {
    if (this.closing || this.busy || this.ledger.pending !== id) throw error("remote_maintenance_pending", "请选择未运行且仍待人工核实的原维护操作。");
    this.busy = true;
    try {
      const view = await this.view(), receipt = this.query(id)!;
      if (!isDeepStrictEqual(receipt.profile, this.profile)) throw error("remote_profile_changed", "原维护属于另一档案，请核实原关联；未结束旧记录。");
      authorize();
      const complete = { ...receipt, stage: "complete" as const, started: view.settings.online };
      this.update(complete);
      return structuredClone(complete);
    } finally { this.busy = false; }
  }
  async close(): Promise<void> { this.closing = true; await this.running; }
}
