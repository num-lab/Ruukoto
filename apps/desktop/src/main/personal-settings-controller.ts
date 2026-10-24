import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { legacyPersonalMaintenance, personalProfile } from "./personal-config.ts";
import type { PersonalController } from "./personal-controller.ts";
import type { PersonalMaintenanceRecord, PersonalManagementView, PersonalSettingsSnapshot } from "../shared/personal-settings.ts";

const READ_OPS = ["settings.read", "lifecycle.status", "config.preflight", "model.test", "mcp.discover", "mcp.cua-targets", "mcp.cua-status", "mcp.cua-control", "mcp.cua-image", "mcp.get", "skills.list", "skills.get", "skills.select-directory", "skills.preview-import"];
const WRITE_OPS = ["config.save", "mcp.migrate", "mcp.set-enabled", "mcp.remove", "mcp.save-service", "skills.import", "skills.set-enabled", "skills.remove"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const failure = (code: string, message: string, unknown = false) => new ControlClientError(code, message, unknown ? "unknown" : "not_sent");
function receipt(value: unknown): PersonalMaintenanceRecord & { saved: boolean | null; started: boolean; code?: string } {
  if (!object(value) || value.v !== 1 || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) || !personalProfile(value.profile) || typeof value.op !== "string" || !WRITE_OPS.includes(value.op) || !["model", "skills", "mcp"].includes(String(value.target)) || typeof value.expectedRevision !== "string" || typeof value.requestDigest !== "string" || typeof value.saveAttempted !== "boolean" || !["stopping", "stopped", "saving", "saved", "starting", "complete"].includes(String(value.stage)) || ![true, false, null].includes(value.saved as boolean | null) || typeof value.started !== "boolean") throw failure("personal_protocol", "原维护回执无法核实，请保留原请求并检查远程版本。", true);
  return value as unknown as PersonalMaintenanceRecord & { saved: boolean | null; started: boolean; code?: string };
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export class PersonalSettingsController {
  private busy = false;
  private readPromise: Promise<PersonalManagementView> | null = null;
  private observed = false;
  private closed = false;
  constructor(private readonly connection: PersonalController, private readonly userData: string) {}
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw failure("management_closed", "设置连接已关闭，请重新打开原个人连接。");
    if (this.busy) throw failure("management_busy", "原设置操作仍在处理，请先等待并核实。");
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  private profile(value: unknown): void {
    if (!personalProfile(value) || !isDeepStrictEqual(value, this.connection.config.binding?.profile)) throw failure("settings_profile_changed", "设置档案与原连接不匹配，请重新核实原档案；未采用迟到结果。", true);
  }
  private async inspect(): Promise<PersonalManagementView> {
    const value = await this.connection.request("GET", "/management");
    if (!object(value) || !object(value.settings) || value.settings.product !== "ruukoto" || typeof value.settings.online !== "boolean" || !object(value.settings.revisions) || !Array.isArray(value.settings.blockers) || !object(value.settings.lifecycle) || !object(value.maintenance) || typeof value.maintenance.online !== "boolean" || typeof value.maintenance.writable !== "boolean" || typeof value.maintenance.reason !== "string") throw failure("personal_protocol", "远程设置应答无法核实，请检查版本后重新读取。", true);
    this.profile(value.settings.profile); this.profile(value.maintenance.profile);
    let pending = value.pending === null ? null : receipt(value.pending);
    let completed: ReturnType<typeof receipt> | null = null;
    const local = this.connection.maintenance();
    if (local) {
      const known = await this.connection.request("GET", `/maintenance?id=${encodeURIComponent(local.id)}`);
      if (known !== null) {
        const original = receipt(known); this.profile(original.profile);
        if (original.id !== local.id) throw failure("personal_protocol", "维护回执不属于原请求，请保留原关联。", true);
        if (original.stage === "complete") { completed = original; this.connection.recordMaintenance(undefined); }
        else pending = original;
      }
    }
    if (pending) this.profile(pending.profile);
    const unknown = !!this.connection.maintenance() && pending === null;
    const saved = pending ? pending.saved : completed?.saved ?? false;
    this.observed = true;
    return { settings: value.settings as PersonalSettingsSnapshot, maintenance: value.maintenance as unknown as PersonalManagementView["maintenance"], pending, saved, message: unknown ? "原维护是否接纳仍待核实，请查询服务器原记录；不会换键重新保存。" : pending ? saved === true ? "配置已保存，请查询原操作的启动与读回结果。" : saved === null ? "原保存结果待核实，不会自动重发保存。" : "原维护已接纳，请等待后查询原操作。" : completed?.saved === true ? completed.started ? "配置已保存且已启动，请核对实际配置。" : "配置已保存，请核实当前服务状态。" : value.maintenance.reason };
  }
  read(): Promise<PersonalManagementView> {
    if (this.closed) return Promise.reject(failure("management_closed", "设置连接已关闭，请重新打开原个人连接。"));
    if (this.readPromise) return this.readPromise;
    const reading = this.exclusive(() => this.inspect()).finally(() => { if (this.readPromise === reading) this.readPromise = null; });
    this.readPromise = reading;
    return reading;
  }
  request(value: unknown): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      if (!object(value) || value.v !== 1 || typeof value.op !== "string" || !READ_OPS.includes(value.op)) throw failure("op_not_allowed", "此设置操作尚未开放，请重新读取原配置。");
      if (value.profile !== undefined) this.profile(value.profile);
      const result = await this.connection.request("POST", "/settings", value);
      if (!object(result)) throw failure("personal_protocol", "设置应答无法核实，请查询原操作。", true);
      this.profile(result.profile); return result;
    });
  }
  apply(value: unknown): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (legacyPersonalMaintenance(this.userData, this.connection.config.origin).length) throw failure("legacy_maintenance_pending", "仍有旧桌面的维护待核实，请先在服务器核实原服务与配置。");
      if (!object(value) || value.v !== 1 || typeof value.op !== "string" || !WRITE_OPS.includes(value.op)) throw failure("op_not_allowed", "请选择一项有效设置操作。");
      this.profile(value.profile);
      if (this.connection.maintenance()) throw failure("maintenance_pending", "原维护结果仍待核实，请先查询原操作；未接纳第二项保存。");
      const id = randomUUID();
      this.connection.recordMaintenance({ id, requestDigest: createHash("sha256").update(JSON.stringify(value)).digest("hex") });
      let response: unknown;
      try { response = await this.connection.request("POST", "/maintenance", { v: 1, id, request: value }); }
      catch (error) { if (error instanceof ControlClientError && error.outcome === "rejected") this.connection.recordMaintenance(undefined); throw error; }
      const result = receipt(response);
      this.profile(result.profile);
      if (result.id !== id) throw failure("personal_protocol", "维护应答不属于原请求，请保留原关联。", true);
      return this.inspect();
    });
  }
  private action(action: "restore" | "finish"): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (legacyPersonalMaintenance(this.userData, this.connection.config.origin).length) throw failure("legacy_maintenance_pending", "旧维护结果尚未核实，请先检查服务器原服务与配置。");
      if (action === "finish" && !this.observed) throw failure("maintenance_unverified", "请先读取原配置与服务，再确认人工核实结果。");
      const view = await this.inspect(), id = this.connection.maintenance()?.id ?? view.pending?.id;
      if (!id) throw failure("maintenance_missing", "没有待恢复的原维护操作，请读取当前设置。");
      const result = receipt(await this.connection.request("POST", `/maintenance/${action}`, { v: 1, id }));
      this.profile(result.profile);
      if (result.id !== id) throw failure("personal_protocol", "维护应答不属于原请求，请保留原关联。", true);
      if (result.stage === "complete") this.connection.recordMaintenance(undefined);
      return this.inspect();
    });
  }
  restore(): Promise<PersonalManagementView> { return this.action("restore"); }
  finish(): Promise<PersonalManagementView> { return this.action("finish"); }
  async close(): Promise<void> { this.closed = true; this.readPromise = null; }
}
