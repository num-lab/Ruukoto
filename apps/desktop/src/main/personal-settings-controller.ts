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
const mcpSummary = (value: unknown): value is PersonalMcpOperationSummary => object(value) && Number.isSafeInteger(value.operation) && Number(value.operation) > 0 && typeof value.service === "string" && typeof value.tool === "string" && typeof value.effect === "string" && typeof value.code === "string" && typeof value.canEnd === "boolean" && typeof value.ended === "boolean" && (value.cuaStopUnverified === undefined || typeof value.cuaStopUnverified === "boolean") && (value.cuaRecovery === undefined || ["frozen", "stopped", "begun", "observed", "accepted"].includes(String(value.cuaRecovery)));
function receipt(value: unknown): PersonalMaintenanceRecord & { saved: boolean | null; started: boolean; code?: string } {
  if (!object(value) || value.v !== 1 || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) || !personalProfile(value.profile) || typeof value.op !== "string" || !LEGACY_WRITE_OPS.includes(value.op) || !["model", "skills", "mcp"].includes(String(value.target)) || typeof value.expectedRevision !== "string" || typeof value.requestDigest !== "string" || typeof value.saveAttempted !== "boolean" || !["stopping", "stopped", "saving", "saved", "starting", "complete"].includes(String(value.stage)) || ![true, false, null].includes(value.saved as boolean | null) || typeof value.started !== "boolean") throw failure("personal_protocol", "The original maintenance receipt can't be verified; keep the original request and check the remote version.", true);
  return value as unknown as PersonalMaintenanceRecord & { saved: boolean | null; started: boolean; code?: string };
}
function configurationReceipt(value: unknown): PersonalConfigurationReceipt {
  const revision = (value: unknown) => value === null || typeof value === "string" && /^(missing|sha256:[0-9a-f]{64})$/.test(value);
  if (!object(value) || value.v !== 2 || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) || !personalProfile(value.profile) || !["model", "skills", "mcp", "web-search", "telegram", "qq", "commands", "services"].includes(String(value.target)) || typeof value.scope !== "string" || !value.scope || value.scope.length > 128 || typeof value.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.requestDigest) || !["rejected", "saved", "waiting", "active", "failed", "unknown", "superseded"].includes(String(value.status)) || !revision(value.savedRevision) || !revision(value.effectiveRevision) || typeof value.code !== "string" || !Array.isArray(value.relatedOperations) || value.relatedOperations.length > 32 || value.relatedOperations.some(item => !object(item) || typeof item.kind !== "string" || typeof item.id !== "string") || value.supersededBy !== undefined && (typeof value.supersededBy !== "string" || !/^[0-9a-f-]{36}$/.test(value.supersededBy))) throw failure("personal_protocol", "The original configuration receipt can't be verified; keep the original operation and check the version.", true);
  return value as unknown as PersonalConfigurationReceipt;
}
const configurationMessage = (value: PersonalConfigurationReceipt) => value.status === "active" ? "Configuration saved and effective." : value.status === "saved" ? "Configuration saved; applies when the backend starts." : value.status === "waiting" ? "Configuration saved; waiting for the related operation to finish." : value.status === "failed" ? "Configuration saved but failed to take effect; verify the original change." : value.status === "rejected" ? "Configuration not saved; refresh and compare the draft." : value.status === "superseded" ? "The original change was superseded; the save record is kept." : "Save outcome unverified; query the original change — it won't resend under a new key.";

// Note: See .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export class PersonalSettingsController {
  private readPromise: Promise<PersonalManagementView> | null = null;
  private observed = false;
  private closed = false;
  constructor(private readonly connection: PersonalController, private readonly userData: string) {}
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw failure("management_closed", "The settings connection closed; reopen the original personal connection.");
    return action();
  }
  private profile(value: unknown): void {
    if (!personalProfile(value) || !isDeepStrictEqual(value, this.connection.config.binding?.profile)) throw failure("settings_profile_changed", "The settings archive doesn't match the original connection; verify the original archive again. The late result wasn't applied.", true);
  }
  private async inspect(): Promise<PersonalManagementView> {
    const value = await this.connection.request("GET", "/management");
    if (!object(value) || !object(value.settings) || value.settings.product !== "ruukoto" || typeof value.settings.online !== "boolean" || !object(value.settings.revisions) || !Array.isArray(value.settings.blockers) || !object(value.settings.lifecycle) || !object(value.maintenance) || typeof value.maintenance.online !== "boolean" || typeof value.maintenance.writable !== "boolean" || typeof value.maintenance.reason !== "string") throw failure("personal_protocol", "The remote settings response can't be verified; check the version and read again.", true);
    this.profile(value.settings.profile); this.profile(value.maintenance.profile);
    let pending = value.pending === null ? null : receipt(value.pending);
    let completed: ReturnType<typeof receipt> | null = null;
    const local = this.connection.maintenance();
    if (local) {
      const known = await this.connection.request("GET", `/maintenance?id=${encodeURIComponent(local.id)}`);
      if (known !== null) {
        const original = receipt(known); this.profile(original.profile);
        if (original.id !== local.id) throw failure("personal_protocol", "The maintenance receipt doesn't belong to the original request; keep the original association.", true);
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
        if (!Number.isSafeInteger(next) || next !== offset + 32) throw failure("personal_protocol", "Configuration-fact paging can't be verified; read the original archive again.", true);
        const result = await this.connection.request("POST", "/settings", { v: 1, op: "settings.read", limit: 1, [`${key}Offset`]: next });
        if (!object(result) || !Array.isArray(result[key]) || result[key].length > 32) throw failure("personal_protocol", "Configuration-fact paging can't be verified; read the original archive again.", true);
        this.profile(result.profile);
        if (key === "operations") operations.push(...result[key].map(configurationReceipt));
        else effective.push(...result[key]);
        offset = next as number; page = result;
      }
    }
    value.settings.effective = effective;
    delete value.settings.operationsNextOffset; delete value.settings.effectiveNextOffset;
    const unresolved = new Map([...operations.filter(item => ["saved", "waiting", "unknown"].includes(item.status)), ...this.connection.settingsOperations()].map(item => [item.id, item]));
    for (const local of unresolved.values()) {
      const known = await this.connection.request("GET", `/maintenance?id=${encodeURIComponent(local.id)}`);
      const result = known === null ? { v: 2 as const, id: local.id, profile: this.connection.config.binding!.profile, target: local.target as PersonalConfigurationReceipt["target"], scope: local.scope, requestDigest: local.requestDigest, status: "unknown" as const, savedRevision: null, effectiveRevision: null, code: "settings_admission_unverified", relatedOperations: [] } : configurationReceipt(known);
      this.profile(result.profile);
      if (result.id !== local.id) throw failure("personal_protocol", "The configuration receipt doesn't belong to the original request; keep the original association.", true);
      const index = operations.findIndex(item => item.id === local.id);
      if (index < 0) operations.push(result); else operations[index] = result;
      if (result.status !== "unknown") this.connection.recordSettingsOperation(local.id);
    }
    const unknown = !!this.connection.maintenance() && pending === null;
    const saved = pending ? pending.saved : completed?.saved ?? false;
    this.observed = true;
    return { settings: value.settings as PersonalSettingsSnapshot, maintenance: value.maintenance as unknown as PersonalManagementView["maintenance"], pending, operations, saved, message: unknown ? "Whether the original maintenance was admitted is still unverified; query the server's original record — it won't resave under a new key." : pending ? saved === true ? "Configuration saved; query the original operation's start and read-back outcome." : saved === null ? "The original save outcome is unverified; it won't resave automatically." : "The original maintenance was admitted; wait, then query the original operation." : completed?.saved === true ? completed.started ? "Configuration saved and started; check the actual configuration." : "Configuration saved; verify the current service state." : value.maintenance.reason };
  }
  read(): Promise<PersonalManagementView> {
    if (this.closed) return Promise.reject(failure("management_closed", "The settings connection closed; reopen the original personal connection."));
    if (this.readPromise) return this.readPromise;
    const reading = this.exclusive(() => this.inspect()).finally(() => { if (this.readPromise === reading) this.readPromise = null; });
    this.readPromise = reading;
    return reading;
  }
  request(value: unknown): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      if (!object(value) || value.v !== 1 || typeof value.op !== "string" || !REQUEST_OPS.includes(value.op)) throw failure("op_not_allowed", "This settings operation isn't open yet; read the original configuration again.");
      if (value.op === "config.preflight" && value.target === "skills") throw failure("op_not_allowed", "Skills are maintained by the backend account's $HOME/.agents/skills/; refresh the skills list.");
      if (value.op === "mcp.cua-control" && !["pause", "resume", "stop", "observe", "accept"].includes(String(value.action))) throw failure("op_not_allowed", "Choose a current computer recovery operation; the old start-recovery action merged into check-and-recover.");
      if (["mcp.operation", "mcp.end"].includes(value.op) && (!Number.isSafeInteger(value.operation) || Number(value.operation) < 1)) throw failure("op_not_allowed", "Select the original MCP call.");
      if (value.profile !== undefined) this.profile(value.profile);
      const result = await this.connection.request("POST", "/settings", value);
      if (!object(result)) throw failure("personal_protocol", "The settings response can't be verified; query the original operation.", true);
      if (value.op === "mcp.operations" && (!Array.isArray(result.operations) || result.operations.some(item => !mcpSummary(item)) || result.nextOffset !== undefined && (!result.operations.length || !Number.isSafeInteger(result.nextOffset) || result.nextOffset !== Number(value.offset ?? 0) + result.operations.length))) throw failure("personal_protocol", "The MCP call identity or paging can't be verified; read the original call again.", true);
      if (value.op === "mcp.operation" && (!mcpSummary(result.summary) || result.summary.operation !== value.operation || typeof result.text !== "string" || result.nextOffset !== undefined && (!Number.isSafeInteger(result.nextOffset) || Number(result.nextOffset) <= Number(value.offset ?? 0)))) throw failure("personal_protocol", "The original MCP call's response can't be verified; keep the original identity and read again.", true);
      if (value.op === "mcp.end" && (result.operation !== value.operation || result.ended !== true)) throw failure("personal_protocol", "The MCP closure response doesn't belong to the original call; read the original call to verify.", true);
      this.profile(result.profile); return result;
    });
  }
  apply(value: unknown, id: unknown = randomUUID()): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw failure("op_not_allowed", "The save request is invalid; save again.");
      if (legacyPersonalMaintenance(this.userData, this.connection.config.origin).length || this.connection.maintenance()) throw failure("legacy_maintenance_pending", "Legacy maintenance is still unverified; verify the original service and configuration first.");
      if (!object(value) || value.v !== 1 || typeof value.op !== "string" || ![...WRITE_OPS, "settings.withdraw"].includes(value.op)) throw failure("op_not_allowed", "Choose a valid settings operation.");
      if (value.op === "config.save" && value.target === "skills") throw failure("op_not_allowed", "Skills are maintained by the backend account's $HOME/.agents/skills/; refresh the skills list.");
      let view: PersonalManagementView;
      try { view = await this.inspect(); }
      catch (error) { if (error instanceof ControlClientError) throw failure(error.code, error.message); throw error; }
      if (view.settings.settingsProtocol !== 2) throw failure("settings_upgrade_required", "The original backend needs upgrading before online saving works; upgrade and read again.");
      const { v: _v, op, profile: _profile, expectedRevision: _expectedRevision, ...fields } = value;
      const original = op === "settings.withdraw" ? view.operations?.find(item => item.id === fields.id) : undefined;
      const target = original?.target ?? (op === "config.save" ? fields.target : op.startsWith("skills.") ? "skills" : "mcp");
      const scope = original?.scope ?? (op.startsWith("mcp.") && op !== "mcp.migrate" ? op === "mcp.save-service" && object(fields.service) ? fields.service.id : fields.id : op.startsWith("skills.") ? "managed" : "*");
      if (target !== "model" && target !== "mcp" || typeof scope !== "string") throw failure("op_not_allowed", "Choose a valid model or MCP configuration.");
      if (this.connection.settingsOperations().some(item => item.target === target && (item.scope === "*" || scope === "*" || item.scope === scope))) throw failure("settings_target_pending", "This target still has an unverified original save; query the original operation first.");
      const request = { v: 2, id, profile: view.settings.profile, expectedRevision: view.settings.revisions[target], op: { kind: op, ...fields } };
      this.connection.recordSettingsOperation(id, { id, requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"), target, scope });
      let response: unknown;
      try { response = await this.connection.request("POST", "/maintenance", { v: 2, id, request }); }
      catch (error) { if (error instanceof ControlClientError && ["not_sent", "rejected"].includes(error.outcome)) this.connection.recordSettingsOperation(id); throw error; }
      const result = configurationReceipt(response);
      this.profile(result.profile);
      if (result.id !== id) throw failure("personal_protocol", "The configuration response doesn't belong to the original request; keep the original association.", true);
      if (result.status !== "unknown") this.connection.recordSettingsOperation(id);
      return { ...await this.inspect(), operation: result, saved: result.savedRevision === null ? result.status === "unknown" ? null : false : true, message: configurationMessage(result) };
    });
  }
  operation(id: string): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw failure("op_not_allowed", "Select the original configuration change.");
      const result = configurationReceipt(await this.connection.request("GET", "/maintenance?id=" + encodeURIComponent(id)));
      this.profile(result.profile);
      if (result.id !== id) throw failure("personal_protocol", "The configuration receipt doesn't belong to the original request; keep the original association.", true);
      if (result.status !== "unknown") this.connection.recordSettingsOperation(id);
      return { ...await this.inspect(), operation: result, saved: result.savedRevision !== null, message: configurationMessage(result) };
    });
  }
  private action(action: "restore" | "finish"): Promise<PersonalManagementView> {
    return this.exclusive(async () => {
      if (legacyPersonalMaintenance(this.userData, this.connection.config.origin).length) throw failure("legacy_maintenance_pending", "The legacy maintenance outcome isn't verified; check the server's original service and configuration first.");
      if (action === "finish" && !this.observed) throw failure("maintenance_unverified", "Read the original configuration and service before confirming the manual verification.");
      const view = await this.inspect(), id = this.connection.maintenance()?.id ?? view.pending?.id;
      if (!id) throw failure("maintenance_missing", "No original maintenance operation awaiting restore; read the current settings.");
      const result = receipt(await this.connection.request("POST", `/maintenance/${action}`, { v: 1, id }));
      this.profile(result.profile);
      if (result.id !== id) throw failure("personal_protocol", "The maintenance response doesn't belong to the original request; keep the original association.", true);
      if (result.stage === "complete") this.connection.recordMaintenance(undefined);
      return this.inspect();
    });
  }
  restore(): Promise<PersonalManagementView> { return this.action("restore"); }
  finish(): Promise<PersonalManagementView> { return this.action("finish"); }
  async close(): Promise<void> { this.closed = true; this.readPromise = null; }
}
