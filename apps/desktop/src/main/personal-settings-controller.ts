import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { legacyPersonalMaintenance, personalProfile } from "./personal-config.ts";
import type { PersonalController } from "./personal-controller.ts";
import type { PersonalMaintenanceRecord, PersonalManagementView, PersonalSettingsSnapshot, PersonalConfigurationReceipt, PersonalMcpOperationSummary } from "../shared/personal-settings.ts";

const REQUEST_OPS = ["settings.read", "lifecycle.status", "config.preflight", "model.test", "mcp.discover", "mcp.cua-targets", "mcp.cua-status", "mcp.cua-control", "mcp.cua-image", "mcp.get", "mcp.operations", "mcp.operation", "mcp.end", "skills.list", "skills.get"];
const WRITE_OPS = ["config.save", "mcp.migrate", "mcp.set-enabled", "mcp.remove", "mcp.save-service"];
const LEGACY_WRITE_OPS = [...WRITE_OPS, "skills.import", "skills.set-enabled", "skills.remove"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const failure = (code: string, message: string, unknown = false) => new ControlClientError(code, message, unknown ? "unknown" : "not_sent");
const mcpSummary = (value: unknown): value is PersonalMcpOperationSummary => object(value) && Number.isSafeInteger(value.operation) && Number(value.operation) > 0 && typeof value.service === "string" && typeof value.tool === "string" && typeof value.effect === "string" && typeof value.code === "string" && typeof value.canEnd === "boolean" && typeof value.ended === "boolean" && (value.cuaRecovery === undefined || ["frozen", "stopped", "begun", "observed", "accepted"].includes(String(value.cuaRecovery)));
function receipt(value: unknown): PersonalMaintenanceRecord & { saved: boolean | null; started: boolean; code?: string } {
  if (!object(value) || value.v !== 1 || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) || !personalProfile(value.profile) || typeof value.op !== "string" || !LEGACY_WRITE_OPS.includes(value.op) || !["model", "skills", "mcp"].includes(String(value.target)) || typeof value.expectedRevision !== "string" || typeof value.requestDigest !== "string" || typeof value.saveAttempted !== "boolean" || !["stopping", "stopped", "saving", "saved", "starting", "complete"].includes(String(value.stage)) || ![true, false, null].includes(value.saved as boolean | null) || typeof value.started !== "boolean") throw failure("personal_protocol", "原维护回执无法核实，请保留原请求并检查远程版本。", true);
  return value as unknown as PersonalMaintenanceRecord & { saved: boolean | null; started: boolean; code?: string };
}
function configurationReceipt(value: unknown): PersonalConfigurationReceipt {
  const revision = (value: unknown) => value === null || typeof value === "string" && /^(missing|sha256:[0-9a-f]{64})$/.test(value);
  if (!object(value) || value.v !== 2 || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) || !personalProfile(value.profile) || !["model", "skills", "mcp", "web-search", "telegram", "qq", "commands", "services"].includes(String(value.target)) || typeof value.scope !== "string" || !value.scope || value.scope.length > 128 || typeof value.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.requestDigest) || !["rejected", "saved", "waiting", "active", "failed", "unknown", "superseded"].includes(String(value.status)) || !revision(value.savedRevision) || !revision(value.effectiveRevision) || typeof value.code !== "string" || !Array.isArray(value.relatedOperations) || value.relatedOperations.length > 32 || value.relatedOperations.some(item => !object(item) || typeof item.kind !== "string" || typeof item.id !== "string") || value.supersededBy !== undefined && (typeof value.supersededBy !== "string" || !/^[0-9a-f-]{36}$/.test(value.supersededBy))) throw failure("personal_protocol", "原配置回执无法核实，请保留原操作并检查版本。", true);
  return value as unknown as PersonalConfigurationReceipt;
}
const configurationMessage = (value: PersonalConfigurationReceipt) => value.status === "active" ? "配置已保存并生效。" : value.status === "saved" ? "配置已保存，后台启动时应用。" : value.status === "waiting" ? "配置已保存，等待相关操作结束。" : value.status === "failed" ? "配置已保存，生效失败；请核实原更改。" : value.status === "rejected" ? "配置未保存，请刷新并比较草稿。" : value.status === "superseded" ? "原更改已被取代，保存记录保留。" : "保存结果待核实，请查询原更改；不会换键重发。";

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export class PersonalSettingsController {
  private readPromise: Promise<PersonalManagementView> | null = null;
  private observed = false;
  private closed = false;
  constructor(private readonly connection: PersonalController, private readonly userData: string) {}
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw failure("management_closed", "设置连接已关闭，请重新打开原个人连接。");
    return action();
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
    const operations = Array.isArray(value.settings.operations) ? value.settings.operations.map(configurationReceipt) : [];
    const effective = Array.isArray(value.settings.effective) ? [...value.settings.effective] : [];
    for (const key of ["operations", "effective"] as const) {
      let page = value.settings, offset = 0;
      while (page[`${key}NextOffset`] !== undefined) {
        const next = page[`${key}NextOffset`];
        if (!Number.isSafeInteger(next) || next !== offset + 32) throw failure("personal_protocol", "配置事实分页无法核实，请重新读取原档案。", true);
        const result = await this.connection.request("POST", "/settings", { v: 1, op: "settings.read", limit: 1, [`${key}Offset`]: next });
        if (!object(result) || !Array.isArray(result[key]) || result[key].length > 32) throw failure("personal_protocol", "配置事实分页无法核实，请重新读取原档案。", true);
        this.profile(result.profile);
        if (key === "operations") operations.push(...result[key].map(configurationReceipt));
        else effective.push(...result[key]);
        offset = next as number; page = result;
      }
    }
    value.settings.effective = effective;
    delete value.settings.operationsNextOffset; delete value.settings.effectiveNextOffset;
    for (const local of this.connection.settingsOperations()) {
      const known = await this.connection.request("GET", `/maintenance?id=${encodeURIComponent(local.id)}`);
      const result = known === null ? { v: 2 as const, id: local.id, profile: this.connection.config.binding!.profile, target: local.target as PersonalConfigurationReceipt["target"], scope: local.scope, requestDigest: local.requestDigest, status: "unknown" as const, savedRevision: null, effectiveRevision: null, code: "settings_admission_unverified", relatedOperations: [] } : configurationReceipt(known);
      this.profile(result.profile);
      if (result.id !== local.id) throw failure("personal_protocol", "配置回执不属于原请求，请保留原关联。", true);
      const index = operations.findIndex(item => item.id === local.id);
      if (index < 0) operations.push(result); else operations[index] = result;
      if (result.status !== "unknown") this.connection.recordSettingsOperation(local.id);
    }
    const unknown = !!this.connection.maintenance() && pending === null;
    const saved = pending ? pending.saved : completed?.saved ?? false;
    this.observed = true;
    return { settings: value.settings as PersonalSettingsSnapshot, maintenance: value.maintenance as unknown as PersonalManagementView["maintenance"], pending, operations, saved, message: unknown ? "原维护是否接纳仍待核实，请查询服务器原记录；不会换键重新保存。" : pending ? saved === true ? "配置已保存，请查询原操作的启动与读回结果。" : saved === null ? "原保存结果待核实，不会自动重发保存。" : "原维护已接纳，请等待后查询原操作。" : completed?.saved === true ? completed.started ? "配置已保存且已启动，请核对实际配置。" : "配置已保存，请核实当前服务状态。" : value.maintenance.reason };
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
      if (!object(value) || value.v !== 1 || typeof value.op !== "string" || !REQUEST_OPS.includes(value.op)) throw failure("op_not_allowed", "此设置操作尚未开放，请重新读取原配置。");
      if (value.op === "config.preflight" && value.target === "skills") throw failure("op_not_allowed", "技能由后台账户的 $HOME/.agents/skills/ 维护，请刷新技能列表。");
      if (value.op === "mcp.cua-control" && !["pause", "resume", "stop", "observe", "accept"].includes(String(value.action))) throw failure("op_not_allowed", "请选择当前电脑恢复操作；旧开始恢复动作已合并到检查并恢复。");
      if (["mcp.operation", "mcp.end"].includes(value.op) && (!Number.isSafeInteger(value.operation) || Number(value.operation) < 1)) throw failure("op_not_allowed", "请选择原 MCP 调用。");
      if (value.profile !== undefined) this.profile(value.profile);
      const result = await this.connection.request("POST", "/settings", value);
      if (!object(result)) throw failure("personal_protocol", "设置应答无法核实，请查询原操作。", true);
      if (value.op === "mcp.operations" && (!Array.isArray(result.operations) || result.operations.some(item => !mcpSummary(item)) || result.nextOffset !== undefined && (!result.operations.length || !Number.isSafeInteger(result.nextOffset) || result.nextOffset !== Number(value.offset ?? 0) + result.operations.length))) throw failure("personal_protocol", "MCP 调用身份或分页无法核实，请重新读取原调用。", true);
      if (value.op === "mcp.operation" && (!mcpSummary(result.summary) || result.summary.operation !== value.operation || typeof result.text !== "string" || result.nextOffset !== undefined && (!Number.isSafeInteger(result.nextOffset) || Number(result.nextOffset) <= Number(value.offset ?? 0)))) throw failure("personal_protocol", "MCP 原调用应答无法核实，请保留原身份并重新读取。", true);
      if (value.op === "mcp.end" && (result.operation !== value.operation || result.ended !== true)) throw failure("personal_protocol", "MCP 收尾应答不属于原调用，请读取原调用核实。", true);
      this.profile(result.profile); return result;
    });
  }
  apply(value: unknown): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (legacyPersonalMaintenance(this.userData, this.connection.config.origin).length || this.connection.maintenance()) throw failure("legacy_maintenance_pending", "仍有旧维护待核实，请先核实原服务与配置。");
      if (!object(value) || value.v !== 1 || typeof value.op !== "string" || ![...WRITE_OPS, "settings.withdraw"].includes(value.op)) throw failure("op_not_allowed", "请选择一项有效设置操作。");
      if (value.op === "config.save" && value.target === "skills") throw failure("op_not_allowed", "技能由后台账户的 $HOME/.agents/skills/ 维护，请刷新技能列表。");
      this.profile(value.profile);
      const view = await this.inspect();
      if (view.settings.settingsProtocol !== 2) throw failure("settings_upgrade_required", "原后台需要升级后才能在线保存配置；请升级后重新读取。");
      const { v: _v, op, profile, expectedRevision, ...fields } = value;
      const original = op === "settings.withdraw" ? view.operations?.find(item => item.id === fields.id) : undefined;
      const target = original?.target ?? (op === "config.save" ? fields.target : op.startsWith("skills.") ? "skills" : "mcp");
      const scope = original?.scope ?? (op.startsWith("mcp.") && op !== "mcp.migrate" ? op === "mcp.save-service" && object(fields.service) ? fields.service.id : fields.id : op.startsWith("skills.") ? "managed" : "*");
      if (typeof target !== "string" || typeof scope !== "string") throw failure("op_not_allowed", "配置对象无法核实，请刷新原配置。");
      if (this.connection.settingsOperations().some(item => item.target === target && (item.scope === "*" || scope === "*" || item.scope === scope))) throw failure("settings_target_pending", "此对象仍有原保存结果待核实，请先查询原操作。");
      const id = randomUUID(), request = { v: 2, id, profile, expectedRevision, op: { kind: op, ...fields } };
      this.connection.recordSettingsOperation(id, { id, requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"), target, scope });
      let response: unknown;
      try { response = await this.connection.request("POST", "/maintenance", { v: 2, id, request }); }
      catch (error) { if (error instanceof ControlClientError && error.outcome === "rejected") this.connection.recordSettingsOperation(id); throw error; }
      const result = configurationReceipt(response);
      this.profile(result.profile);
      if (result.id !== id) throw failure("personal_protocol", "配置应答不属于原请求，请保留原关联。", true);
      if (result.status !== "unknown") this.connection.recordSettingsOperation(id);
      return { ...await this.inspect(), operation: result, saved: result.savedRevision === null ? result.status === "unknown" ? null : false : true, message: configurationMessage(result) };
    });
  }
  operation(id: string): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw failure("op_not_allowed", "请选择原配置更改。");
      const result = configurationReceipt(await this.connection.request("GET", "/maintenance?id=" + encodeURIComponent(id)));
      this.profile(result.profile);
      if (result.id !== id) throw failure("personal_protocol", "配置回执不属于原请求，请保留原关联。", true);
      if (result.status !== "unknown") this.connection.recordSettingsOperation(id);
      return { ...await this.inspect(), operation: result, saved: result.savedRevision !== null, message: configurationMessage(result) };
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
