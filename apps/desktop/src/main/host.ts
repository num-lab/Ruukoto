import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { CodeController, serializeFailure } from "./controller.ts";
import { adoptEnvironment, codeTargetConfig, DesktopError, selectEnvironment } from "./environment.ts";
import { handleRequest, ipcResult } from "./ipc.ts";
import { BrowserDocuments } from "./browser-documents.ts";
import { PersonalController } from "./personal-controller.ts";
import { loadPersonalConfig, savePersonalConfig, personalOrigin, legacyPersonalMaintenance, acknowledgeLegacyPersonalMaintenance } from "./personal-config.ts";
import type { PersonalCredentialStorage } from "./personal-credentials.ts";
import { PersonalSettingsController } from "./personal-settings-controller.ts";
import { DesktopNotifications, type DesktopNotice } from "./notifications.ts";
import { pickAttachments, stageAttachments } from "./attachments.ts";
import type { DesktopSkillPreview, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import type { DirIdentity } from "@ruukoto/core/dir-identity.ts";
import { spawn } from "node-pty";
import { TerminalManager, type PtyFactory } from "./terminal.ts";

export interface DesktopPlatform {
  publish(target: DesktopTarget, update: DesktopUpdate): void | Promise<void>;
  focused(): boolean;
  notice(notice: DesktopNotice): void;
  badge(count: number): void;
  credentials?: PersonalCredentialStorage;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-connection-startup.md
export class DesktopHost {
  private controller: CodeController | null = null;
  private initialization: Promise<void> | null = null;
  private environment: Promise<Awaited<ReturnType<typeof selectEnvironment>>> | null = null;
  private readonly environmentAbort = new AbortController();
  private personal: PersonalController | null = null;
  private personalInitialization: Promise<void> | null = null;
  private personalGeneration = 0;
  private personalSettings: PersonalSettingsController | null = null;
  private closing: Promise<void> | null = null;
  private readonly subscribed = new Set<DesktopTarget>();
  private readonly lastState: Record<DesktopTarget, DesktopUpdate> = { code: { type: "state", state: "connecting" }, personal: { type: "state", state: "closed", detail: "尚未配置 Personal 连接" } };
  private readonly navigation = new Map<DesktopTarget, Extract<DesktopUpdate, { type: "navigate" }>>();
  private readonly attachmentConnections = new WeakMap<object, string>();
  /** 新对话草稿暂存的附件：token → 本机路径，建好会话后再上传。 */
  private draftAttachments = new Map<string, string>();
  private readonly notificationState: DesktopNotifications;
  private readonly browserDocuments: BrowserDocuments;
  private readonly terminals: TerminalManager;
  private readonly terminalRoots = new Map<string, DirIdentity>();
  private terminalInstance: string | null = null;
  private terminalGeneration = 0;
  private terminalReset: Promise<void> = Promise.resolve();
  private readonly terminalOpening = new Set<string>();
  private readonly terminalCanceled = new Set<string>();
  private skillSelection: { ticket: string; source: CodeController; connection: object; instanceId: string; preview: DesktopSkillPreview | null; used: boolean } | null = null;

  constructor(private readonly repository: string, private readonly userData: string, private readonly platform: DesktopPlatform, private readonly prepareEnvironment = (signal: AbortSignal) => selectEnvironment(process.env, undefined, signal), terminalFactory: PtyFactory = spawn) {
    this.browserDocuments = new BrowserDocuments([userData]);
    this.terminals = new TerminalManager(terminalFactory, update => this.platform.publish("code", update));
    this.notificationState = new DesktopNotifications(platform.focused, platform.notice, platform.badge, (target, taskId) => {
      const source = target === "code" ? this.controller : null;
      if (!source) throw new ControlClientError("connection_unavailable", "连接不可用", "not_sent");
      return source.request("get_task", { task_id: taskId });
    }, (planId, offset) => {
      if (!this.controller) throw new ControlClientError("connection_unavailable", "连接不可用：运行结果待核实", "not_sent");
      return this.controller.request("code_schedule", { plan_id: planId, run_offset: offset });
    });
    this.warmEnvironment();
  }
  private publish(target: DesktopTarget, update: DesktopUpdate): void {
    if (target === "code" && update.type === "snapshot") {
      const instance = update.result.snapshot.instanceId;
      if (this.terminalInstance && (update.instanceChanged || this.terminalInstance !== instance)) this.resetTerminals();
      this.terminalInstance = instance;
      this.terminalRoots.clear();
      for (const project of update.result.snapshot.projects) if (project.rootDir) this.terminalRoots.set(project.id, project.rootDir);
    }
    if (target === "code" && update.type === "event") {
      const body = update.event.body;
      if ((body.type === "project.created" || body.type === "project.root_attached") && body.rootDir) this.terminalRoots.set(body.projectId, body.rootDir);
    }
    this.notificationState.update(target, update);
    if (update.type === "state") this.lastState[target] = update;
    if (this.subscribed.has(target)) void Promise.resolve(this.platform.publish(target, update)).catch(() => { process.stderr.write("[ruukoto:desktop] 界面更新未送达，请重新打开应用核实当前状态。\n"); });
  }
  private warmEnvironment(): NonNullable<DesktopHost["environment"]> {
    this.environment ??= this.prepareEnvironment(this.environmentAbort.signal);
    // 预热失败留给首次连接消费并报告；这里仅防止订阅前的未处理拒绝。
    void this.environment.catch(() => {});
    return this.environment;
  }
  private async getEnvironment() {
    const reading = this.warmEnvironment();
    let source: Awaited<typeof reading>;
    try { source = await reading; }
    catch (error) { if (this.environment === reading) this.environment = null; throw error; }
    if (!this.closing) adoptEnvironment(source.env);
    return source;
  }
  private async initializeController(): Promise<void> {
    const source = await this.getEnvironment();
    if (this.closing) return;
    const config = codeTargetConfig(this.repository, source);
    this.controller = new CodeController(config, update => this.publish("code", update), undefined, new PendingRequestStore(path.join(this.userData, "pending", "code", createHash("sha256").update(config.controlDir).digest("hex"))));
  }
  reconnectPersonal(replace = false): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.personalInitialization && !replace) return this.personalInitialization;
    const generation = ++this.personalGeneration;
    const previous = this.personalInitialization;
    const closing = Promise.all([this.personal?.close(), this.personalSettings?.close()]);
    this.personalSettings = null;
    this.personalInitialization = (async () => {
      try {
        await closing;
        await previous;
        if (this.closing || generation !== this.personalGeneration) return;
        const config = loadPersonalConfig(this.userData);
        if (!config) return;
        if (this.closing || generation !== this.personalGeneration) return;
        this.personal = new PersonalController(config, this.userData, update => { if (generation === this.personalGeneration) this.publish("personal", update); }, this.platform.credentials);
        await this.personal.reconnect();
      } catch (error) { if (generation === this.personalGeneration && !this.closing) this.publish("personal", { type: "state", state: "failed", error: serializeFailure(error) }); }
    })().finally(() => { if (generation === this.personalGeneration) this.personalInitialization = null; });
    return this.personalInitialization;
  }
  private reconnect(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      if (!this.controller) {
        try { await this.initializeController(); }
        catch (error) { if (!this.closing) this.publish("code", { type: "state", state: "failed", error: serializeFailure(error) }); return; }
      }
      if (!this.closing) await this.controller!.reconnect();
    })().finally(() => { this.initialization = null; });
    return this.initialization;
  }
  subscribe(target: unknown): void {
    if (target !== "code" && target !== "personal") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
    this.subscribed.add(target);
    if (target === "code") this.resetTerminals();
    this.publish(target, this.lastState[target]);
    const intent = this.navigation.get(target);
    if (intent) { this.navigation.delete(target); this.publish(target, intent); }
    if (target === "code" && (!this.controller || this.controller.status.state === "online")) void this.reconnect();
    if (target === "personal" && (!this.personal || this.personal.status.state === "online")) void this.reconnectPersonal();
  }
  navigate(notice: DesktopNotice): void {
    const update: Extract<DesktopUpdate, { type: "navigate" }> = { type: "navigate", instanceId: notice.instanceId, navigation: { sessionId: notice.sessionId, taskId: notice.taskId } };
    if (this.subscribed.has(notice.target)) this.publish(notice.target, update);
    else this.navigation.set(notice.target, update);
  }
  request(target: unknown, op: unknown, params: unknown) {
    if (target === "personal" && op !== "desktop_browser_open" && op !== "desktop_browser_release") return this.personalRequest(op, params);
    if (op === "desktop_skill_import") return ipcResult(() => {
      if (target !== "code") throw new DesktopError("op_not_allowed", "本机技能导入只向 Code 开放。");
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 1 || !("selection_id" in params)) throw new DesktopError("invalid_params", "请确认本次系统选择的技能目录。");
      const selection = this.currentSkillSelection();
      if (!selection.preview || selection.preview.id !== params.selection_id || selection.used) throw new DesktopError("skill_selection_expired", "本次选择已提交或失效，请先读回原技能核实，再重新选择。");
      const preview = selection.preview;
      // 一次选择只发送一次；丢答后由 renderer 按原 preview.id 读取，不再复制。
      selection.used = true;
      return selection.source.request("skill_import", { skill_id: preview.id, source_dir: preview.sourceDir, content_revision: preview.contentRevision, expected_revision: preview.revision });
    });
    // 本机文档能力属于宿主，不依赖 Code/Personal 的连接或后台文件权限。
    if (op === "desktop_browser_open" || op === "desktop_browser_release") return ipcResult(async () => {
      if (target !== "code" && target !== "personal") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 1) throw new DesktopError("invalid_params", "本地预览参数无效，请重新打开文档。");
      if (this.closing) throw new DesktopError("browser_document_closed", "本地预览已关闭，请重新打开应用。");
      if (op === "desktop_browser_open" && "url" in params) return this.browserDocuments.open(params.url);
      if (op === "desktop_browser_release" && "id" in params) return this.browserDocuments.release(params.id);
      throw new DesktopError("invalid_params", "本地预览参数无效，请重新打开文档。");
    });
    return handleRequest(target, op, params, () => target === "personal" ? this.reconnectPersonal() : this.reconnect(), (op, params) => {
      if (!this.controller) throw new ControlClientError("connection_unavailable", "连接不可用：请求未发送", "not_sent");
      return this.controller.dispatch(op, params);
    }, (op, params) => {
      if (op !== "desktop_pending_read" && op !== "desktop_pending_clear") return this.terminalRequest(op, params);
      const source = this.controller;
      if (!source?.submissions) throw new DesktopError("connection_unavailable", "请等待连接恢复后再处理原输入。");
      return source.submissions.local(op, params);
    });
  }
  private async getPersonal(): Promise<PersonalController> {
    if (!this.personal) await this.reconnectPersonal();
    if (this.closing || !this.personal) throw new DesktopError("personal_unconfigured", "请先保存个人 Agent 的 HTTPS 地址并配对。");
    return this.personal;
  }
  private personalRequest(op: unknown, params: unknown) {
    return ipcResult(async () => {
      if (this.closing) throw new DesktopError("personal_closed", "个人连接宿主已关闭，请重新打开应用。");
      if (typeof op !== "string" || !params || typeof params !== "object" || Array.isArray(params)) throw new DesktopError("invalid_params", "个人操作参数无效，请重新打开原页面。");
      const input = params as Record<string, unknown>;
      const expect = (keys: string[]) => { if (Object.keys(input).length !== keys.length || keys.some(key => !(key in input))) throw new DesktopError("invalid_params", "个人操作参数无效，请重新读取原页面。"); };
      if (op === "desktop_personal_config_read") { expect([]); return loadPersonalConfig(this.userData); }
      if (op === "desktop_personal_config_save") {
        expect(["origin"]);
        const origin = personalOrigin(input.origin), previous = loadPersonalConfig(this.userData);
        let release: (() => void) | undefined;
        if (previous && previous.origin !== origin) {
          const original = await this.getPersonal();
          release = await original.assertSwitchable();
        }
        try {
          const config = savePersonalConfig(this.userData, { v: 1, origin, ...(previous?.origin === origin && previous.binding ? { binding: previous.binding } : {}) });
          await this.reconnectPersonal(true); return config;
        } finally {
          release?.();
        }
      }
      if (op === "desktop_personal_legacy_read") { expect([]); return { paths: legacyPersonalMaintenance(this.userData, loadPersonalConfig(this.userData)?.origin ?? "") }; }
      if (op === "desktop_personal_legacy_acknowledge") {
        expect(["verified"]);
        const config = loadPersonalConfig(this.userData);
        if (!config || input.verified !== true) throw new DesktopError("legacy_maintenance_unverified", "请先在服务器核实旧维护的原服务与配置，再确认核实结果。");
        acknowledgeLegacyPersonalMaintenance(this.userData, config.origin); return { paths: [] };
      }
      if (op === "reconnect") { expect([]); return this.reconnectPersonal(); }
      const controller = await this.getPersonal(), generation = this.personalGeneration;
      let result: unknown;
      if (op === "desktop_personal_pair") {
        expect(["code", "label"]);
        if (typeof input.code !== "string" || typeof input.label !== "string") throw new DesktopError("invalid_params", "请输入服务器配对码与桌面名称。");
        result = await controller.pair(input.code, input.label);
      } else if (op === "desktop_personal_pair_reconcile") { expect([]); result = await controller.reconcilePairing(); }
      else if (op === "desktop_personal_pair_restore") { expect([]); result = await controller.restorePairing(); }
      else if (op === "desktop_personal_input_submit") {
        expect(["text"]); if (typeof input.text !== "string") throw new DesktopError("invalid_params", "请输入文本消息。");
        result = await controller.submitInput(input.text);
      } else if (op === "desktop_personal_input_reconcile") { expect([]); result = await controller.reconcileInput(); }
      else if (op === "desktop_personal_input_restore") { expect([]); result = await controller.restoreInput(); }
      else if (op === "desktop_personal_request") {
        if (Object.keys(input).some(key => !["method", "path", "body"].includes(key)) || !("method" in input) || !("path" in input)) throw new DesktopError("invalid_params", "个人请求参数无效。");
        result = await controller.business(input.method, input.path, input.body);
        if (input.method === "GET" && typeof input.path === "string") this.notificationState.personalPending(controller.instanceId()!, input.path, result);
      } else if (["desktop_personal_settings_read", "desktop_personal_settings_request", "desktop_personal_settings_apply", "desktop_personal_settings_operation", "desktop_personal_settings_restore", "desktop_personal_settings_finish"].includes(op)) {
        expect(op === "desktop_personal_settings_request" || op === "desktop_personal_settings_apply" ? ["request"] : op === "desktop_personal_settings_operation" ? ["id"] : []);
        this.personalSettings ??= new PersonalSettingsController(controller, this.userData);
        const settings = this.personalSettings;
        result = op === "desktop_personal_settings_read" ? await settings.read() : op === "desktop_personal_settings_request" ? await settings.request(input.request) : op === "desktop_personal_settings_apply" ? await settings.apply(input.request) : op === "desktop_personal_settings_operation" ? await settings.operation(String(input.id)) : op === "desktop_personal_settings_restore" ? await settings.restore() : await settings.finish();
      } else throw new DesktopError("op_not_allowed", "此操作未向个人 Agent 开放。");
      if (controller !== this.personal || generation !== this.personalGeneration || this.closing) throw new ControlClientError("personal_identity_changed", "个人连接已变化，请核实原请求；未采用迟到结果。", "unknown");
      return result;
    });
  }
  resetTerminals(): void {
    ++this.terminalGeneration;
    this.terminalReset = this.terminalReset.then(() => this.terminals.reset());
    // 保留失败给后续打开消费；诊断由 TerminalManager 报告。
    void this.terminalReset.catch(() => {});
  }
  // Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-code-skills.md
  beginSkillSelection(target: unknown, instanceId: unknown): string {
    if (target !== "code") throw new DesktopError("op_not_allowed", "本机技能目录只用于 Code；请选择 Code 后导入。");
    const source = this.controller;
    const connection = source?.connectionIdentity();
    if (this.closing || !source || source.status.state !== "online" || !connection || !instanceId || source.instanceId() !== instanceId) throw new DesktopError("skill_target_changed", "Code 连接或实例已变化，请恢复原连接后重新选择。");
    const ticket = randomUUID();
    this.skillSelection = { ticket, source, connection, instanceId: source.instanceId()!, preview: null, used: false };
    return ticket;
  }
  private currentSkillSelection(ticket?: unknown) {
    const selection = this.skillSelection;
    if (this.closing || !selection || ticket !== undefined && ticket !== selection.ticket || selection.source !== this.controller || selection.source.status.state !== "online" || selection.source.connectionIdentity() !== selection.connection || selection.source.instanceId() !== selection.instanceId) throw new DesktopError("skill_target_changed", "技能选择所属连接已变化，未继续导入；请核实原实例后重新选择。");
    return selection;
  }
  async previewSkillSelection(ticket: unknown, directory: unknown): Promise<DesktopSkillPreview | null> {
    const selection = this.currentSkillSelection(ticket);
    if (directory === null) { this.skillSelection = null; return null; }
    if (typeof directory !== "string") throw new DesktopError("invalid_params", "请选择单个含 SKILL.md 的技能目录。");
    const preview = await selection.source.request("skill_import_preview", { source_dir: directory });
    this.currentSkillSelection(ticket);
    selection.preview = preview;
    return preview;
  }
  async pickSkillFolder(target: unknown, instanceId: unknown, pick: () => Promise<string | null>): Promise<DesktopSkillPreview | null> {
    const ticket = this.beginSkillSelection(target, instanceId);
    return this.previewSkillSelection(ticket, await pick());
  }
  private async terminalRequest(op: string, params: Record<string, unknown>) {
    if (this.closing) throw new DesktopError("terminal_closed", "终端宿主已关闭，请重新打开应用。");
    const keys = op === "desktop_terminal_open" ? ["id", "workspace_id", "instance_id", "cols", "rows"] : op === "desktop_terminal_input" ? ["id", "data"] : op === "desktop_terminal_resize" ? ["id", "cols", "rows"] : ["id"];
    if (Object.keys(params).length !== keys.length || keys.some(key => !(key in params))) throw new DesktopError("invalid_params", "终端参数无效，请重新打开终端。");
    if (op === "desktop_terminal_input") return this.terminals.input(params.id, params.data);
    if (op === "desktop_terminal_resize") return this.terminals.resize(params.id, params.cols, params.rows);
    if (op === "desktop_terminal_kill") { if (typeof params.id === "string" && this.terminalOpening.has(params.id)) this.terminalCanceled.add(params.id); return this.terminals.kill(params.id); }
    const generation = this.terminalGeneration;
    if (typeof params.workspace_id !== "string" || params.instance_id !== this.terminalInstance || !this.terminalInstance) throw new DesktopError("terminal_workspace_changed", "终端工作区已变化，请重新选择工作区。");
    const root = this.terminalRoots.get(params.workspace_id);
    if (!root) throw new DesktopError("terminal_workspace_missing", "工作区尚未就绪，请连接 Code 后选择工作区。");
    if (typeof params.id !== "string" || this.terminalOpening.has(params.id)) throw new DesktopError("invalid_params", "终端引用无效或正在打开，请切换到原标签。");
    const id = params.id;
    this.terminalOpening.add(id);
    try {
      const environment = await this.getEnvironment();
      await this.terminalReset;
      if (this.closing || this.terminalCanceled.has(id) || generation !== this.terminalGeneration || this.terminalRoots.get(params.workspace_id) !== root) throw new DesktopError("terminal_workspace_changed", "终端工作区已变化或标签已关闭，请重新选择工作区。");
      return this.terminals.open(id, root, params.cols, params.rows, environment.env);
    } finally { this.terminalOpening.delete(id); this.terminalCanceled.delete(id); }
  }
  private attachmentSource(target: unknown) {
    if (target !== "code") throw new DesktopError("op_not_allowed", "个人 Agent 的附件功能尚未开放，请在 Code 会话中附加文件。");
    const source = this.controller;
    if (!source || source.status.state !== "online" || !source.instanceId() || !source.connectionIdentity()) throw new DesktopError("connection_unavailable", "请等待连接恢复后附加文件。");
    return source;
  }
  attachmentInstance(target: unknown = "code"): string {
    const source = this.attachmentSource(target);
    const connection = source.connectionIdentity()!;
    let id = this.attachmentConnections.get(connection);
    if (!id) { id = randomUUID(); this.attachmentConnections.set(connection, id); }
    return `${id}:${source.instanceId()}`;
  }
  pickAttachments(sessionId: unknown, pick: () => Promise<string[]>, expectedSelection?: string, target: unknown = "code") {
    const source = this.attachmentSource(target);
    if (typeof sessionId !== "string") throw new DesktopError("invalid_params", "请选择会话后附加文件。");
    if (expectedSelection !== undefined && this.attachmentInstance(target) !== expectedSelection) throw new DesktopError("attachment_instance_changed", "连接目标已变化，未附加文件；请重新选择。");
    const connection = source.connectionIdentity();
    const current = () => this.controller === source && source.status.state === "online" && source.connectionIdentity() === connection;
    return pickAttachments(sessionId, {
      instanceId: () => current() ? source.instanceId() : null,
      pick,
      upload: params => {
        if (!current()) throw new DesktopError("attachment_instance_changed", "连接目标已变化，未附加文件；请重新选择。");
        return source.request("put_attachment", params);
      },
    });
  }
  /** 会话尚未创建时先登记所选文件；返回的 id 是仅本次应用有效的暂存 token。 */
  pickDraftAttachments(pick: () => Promise<string[]>) {
    return pick().then(files => {
      const staged = stageAttachments(files);
      for (const item of staged) this.draftAttachments.set(item.token, item.path);
      return staged.map(({ token, name, size }) => ({ id: token, name, size }));
    });
  }
  uploadDraftAttachments(sessionId: unknown, tokens: unknown, target: unknown = "code") {
    if (!Array.isArray(tokens) || tokens.some(token => typeof token !== "string")) throw new DesktopError("invalid_params", "附件引用无效，请重新选择。");
    const files = tokens.map(token => this.draftAttachments.get(token));
    if (files.some(file => file === undefined)) throw new DesktopError("attachment_expired", "附件已失效，请重新选择。");
    return this.pickAttachments(sessionId, async () => files as string[], undefined, target).then(attachments => {
      for (const token of tokens) this.draftAttachments.delete(token);
      return attachments;
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    ++this.personalGeneration;
    this.controller?.close();
    this.environmentAbort.abort();
    this.closing = Promise.all([this.terminals.close(), this.terminalReset, this.browserDocuments.close(), this.personal?.close(), this.personalSettings?.close(), this.personalInitialization, this.initialization, this.environment?.catch(() => { /* 退出取消的读取不再用于连接，连接期间的失败由消费方报告。 */ })]).then(() => {});
    return this.closing;
  }
}
