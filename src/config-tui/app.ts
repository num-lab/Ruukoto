/**
 * 配置中心应用（issue 21 §3）：在线（控制面）与离线（配置文件直写）共用
 * 一个菜单驱动的界面骨架：
 *
 * - 屏幕是一摞「分区 Screen」：每个分区声明标题、列表加载与条目动作，
 *   通用运行器负责渲染、导航与刷新；Esc 返回上一级，顶层退出；
 * - 编辑器用覆盖层（SelectList 选择器、Input 单行输入、MaskedInput 秘密
 *   输入）；多字段创建用按序向导（wizard），配置修改即改即存（带版本）；
 * - 模型部分经 ModelBackend 抽象按模式切换：在线走 get_model_config 等
 *   控制面操作（带修订），离线走 models.json/auth.json 文件（持有配置锁）；
 * - 每次保存携带最近读取的版本/修订；冲突错误（*_conflict）提示
 *   「配置已被其他客户端修改，已重新加载」并刷新当前分区。
 *
 * 任务执行审批不在此出现：本界面不提供 respond_confirmation 入口。
 * 秘密卫生：API key/凭据值只经 MaskedInput 进入，永不回显、不入重载状态。
 */

import * as fs from "node:fs";
import {
  Input,
  KeybindingsManager,
  ProcessTerminal,
  SelectList,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
  setKeybindings,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { ControlClient } from "../control/client.ts";
import type { ConnectResult } from "../control/protocol.ts";
import { workspaceMappedSources, workspacePickerProjects } from "../control/workspace.ts";
import { productFromEnv, type ProductType } from "../core/product.ts";
import type { ModelSelection, PersistentEvent, Project, Session, DataGrant } from "../core/types.ts";
import { SESSION_DEFAULT_MODES } from "../core/types.ts";
import type { McpServiceConfig } from "../agent/mcp/store.ts";
import { reloadStatePathFromEnv, loadReloadState, saveReloadState } from "../tui/reload-state.ts";
import { OverlayBox, MaskedInput, bold, dim, green, red, selectTheme, yellow } from "./components.ts";
import { thinkingLevelsForCatalogModel, type SummaryModel } from "../agent/model-config.ts";
import { JEV_CREDENTIAL_PURPOSE, JEV_HOST, type JevConfig } from "../agent/jev-config.ts";

/** 摘要模型的数据去向说明（issue 30 §8）。 */
const SUMMARY_MODEL_NOTE = "设置后，main、coding 与开发会话较早的对话（含工具结果）会发给该模型的提供方做摘要";

/** 与脱敏视图对齐的模型配置视图（apiKey 已被替换为 true，永不携带秘密）。 */
export interface ModelConfigView {
  revision: string;
  providers: Record<string, any>;
  credentials: Record<string, { configured: boolean; type?: string }>;
  defaultModel: ModelSelection | null;
  /** 上下文压缩的摘要模型（issue 30；null = 用会话当前模型）。 */
  summaryModel: SummaryModel | null;
  busyProviders: string[];
}

/** 模型配置读写后端：在线 = 控制面操作（修订协商），离线 = 配置文件直写。 */
export interface ModelBackend {
  load(): Promise<ModelConfigView>;
  saveCatalog(providers: Record<string, any>): Promise<void>;
  setApiKey(provider: string, key: string): Promise<void>;
  removeApiKey(provider: string): Promise<void>;
  removeProvider(provider: string): Promise<void>;
  setDefaultModel(selection: ModelSelection): Promise<void>;
  /** null = 清除（用会话当前模型）。 */
  setSummaryModel(model: SummaryModel | null): Promise<void>;
  /** 显式联网探测（离线模式不提供）。 */
  testConnection?(provider: string, modelId: string): Promise<{ ok: boolean; detail: string }>;
}

export interface ConfigTuiAppDeps {
  mode: "online" | "offline";
  modelBackend: ModelBackend;
  /** 离线模式展示用配置目录。 */
  agentDir: string;
  /** 离线启动时的 probeModelConfig 结论。 */
  probeDetail?: string;
  client?: ControlClient;
  snapshot?: ConnectResult["snapshot"];
  terminal?: Terminal;
  /** 产品身份（agent-direction issue 06）：ruukoto-dev 的项目分区按工作区/旧项目分类；缺省按 RUUKOTO_PRODUCT。 */
  product?: ProductType;
  onExit: (code: number) => void;
}

/** 菜单分区：id 用于重载状态路径；watch 决定哪类事件触发刷新。 */
interface Screen {
  /** 必须等于上一层打开本屏幕的菜单项 value：重载恢复按这些 id 逐层重放选择。 */
  id: string;
  title: string;
  /** 标题下的说明行（数据快照，随刷新重建）。 */
  intro?: () => string[];
  load(): Promise<SelectItem[]>;
  onSelect(item: SelectItem): void | Promise<void>;
  watch?: (eventType: string) => boolean;
}

/** 供选择器用的目录模型条目。 */
interface CatalogModelOption {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels: string[];
  available: boolean;
}

/** 正文区单组件容器：换屏即换 child。 */
class SwapBox implements Component {
  child: Component | null = null;
  render(width: number): string[] {
    return this.child ? this.child.render(width) : [];
  }
  invalidate(): void {
    this.child?.invalidate();
  }
}

const ACCESS_MODE_LABELS: Record<string, string> = {
  confirm: "请求确认（越界操作逐次审批）",
  full_access: "完全访问（容器外执行账户，不逐次确认）",
  "auto-review": "自动审查（独立审查调用自动审批，失败转人工）",
};

const GRANT_CATEGORY_LABELS: Record<string, string> = {
  history: "历史",
  artifact: "产物",
  memory: "记忆",
};

export class ConfigTuiApp {
  private readonly deps: ConfigTuiAppDeps;
  private readonly terminal: Terminal;
  private readonly tui: TuiAltScreen;
  private readonly header = new Text("", 1, 0);
  private readonly content = new SwapBox();
  private readonly status = new Text("", 1, 0);
  private readonly footer = new Text("", 1, 0);
  private readonly onExit: (code: number) => void;

  private readonly stack: Screen[] = [];
  private currentBox: OverlayBox | null = null;
  private currentItems: SelectItem[] = [];
  private overlayCount = 0;
  private generation = 0;
  private exiting = false;
  private started = false;

  // 在线快照的本地补丁副本（项目/会话列表；分区每步操作前仍会重读版本）
  private projects: Project[] = [];
  private sessions: Session[] = [];
  // 工作区/旧项目分类所需的角色会话标识（协议快照可选字段，旧后台缺省为 []）
  private roleSessionIds: string[] = [];
  private readonly product: ProductType;
  private instanceId = "";
  private modelView: ModelConfigView | null = null;

  // 重载状态（dev）：RUUKOTO_RELOAD_STATE_FILE 非空且在线时启用
  private readonly reloadFile: string | null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(deps: ConfigTuiAppDeps) {
    this.deps = deps;
    this.terminal = deps.terminal ?? new ProcessTerminal();
    this.onExit = deps.onExit;
    this.product = deps.product ?? productFromEnv();
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
    this.tui = new TuiAltScreen(this.terminal, true);
    if (deps.snapshot) {
      this.projects = deps.snapshot.projects;
      this.sessions = deps.snapshot.sessions;
      this.roleSessionIds = deps.snapshot.roleSessionIds ?? [];
      this.instanceId = deps.snapshot.instanceId;
    }
    this.reloadFile = this.deps.mode === "online" ? reloadStatePathFromEnv() : null;

    const root = new VStack([
      { component: this.header, grow: 0, shrink: 1 },
      { component: this.content, grow: 1, shrink: 1, minSize: 1 },
      { component: this.status, grow: 0, shrink: 1, maxSize: 3 },
      { component: this.footer, grow: 0, shrink: 0 },
    ]);
    this.tui.addChild(root);
    this.tui.setLayoutRoot(root);

    this.header.setText(this.headerText());
    this.footer.setText(dim("↑↓ 选择 · Enter 进入/确认 · Esc 返回/退出 · Ctrl+C 退出"));

    this.tui.addInputListener((data) => {
      if (data === "\x03") {
        this.quit(0);
        return { consume: true };
      }
      return undefined;
    });

    deps.client?.onEvent((event) => this.onBackendEvent(event));
  }

  private headerText(): string {
    const mode = this.deps.mode === "online" ? `在线 · 实例 ${this.instanceId.slice(0, 8) || "?"}` : "离线 · 直接写配置文件";
    const trail = this.stack
      .slice(1)
      .map((s) => s.title)
      .join(" › ");
    return bold(`配置中心（${mode}）`) + (trail ? `  ${dim(trail)}` : "");
  }

  // ---------- 启动 / 退出 ----------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.tui.start();
    await this.pushScreen(this.rootScreen());
    await this.restoreReloadState();
  }

  /** 退出：保存导航状态、恢复终端、关闭由入口层持有的资源（客户端/锁）。 */
  quit(code = 0): void {
    if (this.exiting) return;
    this.exiting = true;
    this.flushReloadState();
    void (async () => {
      try {
        await this.terminal.drainInput(800);
      } catch {
        // 忽略
      }
      this.tui.stop({ preserveScreen: true });
      this.onExit(code);
    })();
  }

  // ---------- 屏幕运行器 ----------

  private async pushScreen(screen: Screen, selectedValue?: string): Promise<void> {
    this.stack.push(screen);
    this.header.setText(this.headerText());
    this.lastSelected = selectedValue;
    await this.showCurrent(selectedValue);
    this.schedulePersist();
  }

  private async popScreen(): Promise<void> {
    if (this.stack.length <= 1) {
      this.quit(0);
      return;
    }
    this.stack.pop();
    this.header.setText(this.headerText());
    this.lastSelected = undefined;
    await this.showCurrent();
    this.schedulePersist();
  }

  /** 重建当前屏幕（加载 → 组件替换）；异步结果按世代丢弃，避免旧结果覆盖新页面。 */
  private async showCurrent(selectedValue?: string): Promise<void> {
    const screen = this.stack[this.stack.length - 1];
    const gen = ++this.generation;
    let items: SelectItem[];
    try {
      items = await screen.load();
    } catch (err) {
      if (gen !== this.generation) return;
      this.notify(`加载失败：${(err as Error).message}`, "red");
      items = [];
    }
    if (gen !== this.generation || this.exiting) return;
    this.currentItems = items;

    const titleLines = [bold(screen.title)];
    for (const line of screen.intro?.() ?? []) titleLines.push(dim(line));
    if (items.length === 0) titleLines.push(dim("（空）"));

    const list = new SelectList(items, Math.min(Math.max(items.length, 3), Math.max(5, this.terminal.rows - 10)), selectTheme);
    if (selectedValue !== undefined) {
      const idx = items.findIndex((i) => i.value === selectedValue);
      if (idx >= 0) list.setSelectedIndex(idx);
    }
    const box = new OverlayBox([{ component: new Text(titleLines.join("\n"), 1, 0), grow: 0 }, { component: list, grow: 1 }]);
    box.forwardTo = list;
    list.onSelect = (item) => {
      this.lastSelected = item.value;
      this.act(() => screen.onSelect(item));
    };
    list.onCancel = () => void this.popScreen();
    this.currentBox = box;
    this.content.child = box;
    if (this.overlayCount === 0) this.tui.setFocus(box);
    this.tui.requestRender();
  }

  /** 刷新当前屏幕（保留选中值）；版本冲突与事件触发的重新加载共用。 */
  private async refresh(): Promise<void> {
    await this.showCurrent(this.lastSelected);
  }

  /** 最近一次在当前屏幕中选中的条目值（刷新时尽量恢复光标位置）。 */
  private lastSelected: string | undefined;

  /** 统一动作入口：捕获异常进通知行；冲突类错误提示重新加载并刷新分区。 */
  private act(fn: () => void | Promise<void>): void {
    void (async () => {
      try {
        await fn();
      } catch (err) {
        const e = err as Error & { code?: string };
        if (typeof e.code === "string" && e.code.endsWith("_conflict")) {
          this.modelView = null; // 缓存视图已过期：重读后再刷新
          // 项目/会话缓存同样已过期：实际重读后台数据，不能只刷新旧缓存
          await this.refreshSnapshotFromServer();
          this.notify("配置已被其他客户端修改，已重新加载", "yellow");
          await this.refresh();
        } else {
          this.notify(e.message, "red");
        }
      }
    })();
  }

  private notify(text: string, color: "red" | "yellow" | "green" = "green"): void {
    const paint = color === "red" ? red : color === "yellow" ? yellow : green;
    this.status.setText(paint(text));
    this.tui.requestRender();
  }

  /** 界面运行期间控制台输出（依赖库的日志等）转入提示行，不污染绘制。 */
  log(text: string): void {
    this.notify(text, "yellow");
  }

  // ---------- 覆盖层 ----------

  private openOverlay(box: OverlayBox, maxHeight = "70%"): OverlayHandle {
    this.overlayCount++;
    const handle = this.tui.showOverlay(box, { width: "85%", anchor: "center", maxHeight: maxHeight as `${number}%` });
    const origHide = handle.hide.bind(handle);
    handle.hide = () => {
      this.overlayCount = Math.max(0, this.overlayCount - 1);
      origHide();
      if (this.currentBox && this.overlayCount === 0) this.tui.setFocus(this.currentBox);
    };
    return handle;
  }

  /** 关闭全部打开的覆盖层（重载状态恢复时放弃半途打开的表单）。 */
  private closeAllOverlays(): void {
    while (this.overlayCount > 0 && this.tui.hasOverlay()) this.tui.hideOverlay();
    this.overlayCount = 0;
    if (this.currentBox) this.tui.setFocus(this.currentBox);
  }

  /** 单选覆盖层；Esc/取消返回 null。 */
  private pick(title: string, items: SelectItem[], opts: { description?: string } = {}): Promise<string | null> {
    return new Promise((resolve) => {
      const list = new SelectList(items, Math.min(items.length, 12), selectTheme);
      const head = [bold(title)];
      if (opts.description) head.push(dim(opts.description));
      const box = new OverlayBox([{ component: new Text(head.join("\n"), 1, 0), grow: 0 }, { component: list, grow: 1 }]);
      box.forwardTo = list;
      const handle = this.openOverlay(box);
      const done = (value: string | null) => {
        handle.hide();
        resolve(value);
      };
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
    });
  }

  /** 单行文本输入；Esc 返回 null。 */
  private inputBox(title: string, opts: { initial?: string; placeholder?: string } = {}): Promise<string | null> {
    return new Promise((resolve) => {
      const input = new Input({ prompt: "> ", placeholder: opts.placeholder });
      input.focused = true;
      if (opts.initial !== undefined) input.setValue(opts.initial);
      const box = new OverlayBox([{ component: new Text(bold(title), 1, 0), grow: 0 }, { component: input, grow: 0 }]);
      box.forwardTo = input;
      const handle = this.openOverlay(box, "40%");
      const done = (value: string | null) => {
        handle.hide();
        resolve(value);
      };
      input.onSubmit = (value) => done(value);
      input.onEscape = () => done(null);
    });
  }

  /** 秘密输入（遮蔽显示）；Esc 返回 null。返回值绝不渲染回界面。 */
  private maskedBox(title: string): Promise<string | null> {
    return new Promise((resolve) => {
      const input = new MaskedInput({ prompt: "> ", placeholder: "输入不会回显明文" });
      const box = new OverlayBox([
        { component: new Text(`${bold(title)}\n${dim("显示为 •••；Enter 提交，Esc 取消")}`, 1, 0), grow: 0 },
        { component: input, grow: 0 },
      ]);
      box.forwardTo = input;
      const handle = this.openOverlay(box, "40%");
      const done = (value: string | null) => {
        handle.hide();
        resolve(value);
      };
      input.onSubmit = (value) => done(value.length > 0 ? value : null);
      input.onEscape = () => done(null);
    });
  }

  private async confirm(title: string, detail: string): Promise<boolean> {
    const value = await this.pick(title, [
      { value: "yes", label: "确认" },
      { value: "no", label: "取消" },
    ], { description: detail });
    return value === "yes";
  }

  // ---------- 重载状态（dev 集成） ----------

  private schedulePersist(): void {
    if (!this.reloadFile) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.flushReloadState(), 150);
  }

  private flushReloadState(): void {
    if (!this.reloadFile) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    saveReloadState(this.reloadFile, {
      kind: "config-tui",
      instanceId: this.instanceId,
      section: this.stack.slice(1).map((s) => s.id),
      updatedAt: "",
    });
  }

  /** 恢复上次所在分区；记录缺失/损坏/实例不符时给出小提示并从主菜单开始。 */
  private async restoreReloadState(): Promise<void> {
    if (!this.reloadFile) return;
    if (!fs.existsSync(this.reloadFile)) return;
    const state = loadReloadState(this.reloadFile);
    if (!state || state.kind !== "config-tui") {
      this.notify("重载状态文件无效，已从主菜单开始", "yellow");
      return;
    }
    if (state.instanceId !== this.instanceId) {
      this.notify("重载状态与当前数据实例不符，已从主菜单开始", "yellow");
      return;
    }
    for (const id of state.section) {
      const top = this.stack[this.stack.length - 1];
      const item = this.currentItems.find((i) => i.value === id);
      if (!item) {
        this.notify(`上次所在分区「${id}」已不存在，从当前菜单继续`, "yellow");
        return;
      }
      const depth = this.stack.length;
      try {
        await top.onSelect(item);
      } catch {
        return;
      }
      // 条目打开的是覆盖层/表单而非子分区：放弃该表单并停止恢复
      if (this.overlayCount > 0) {
        this.closeAllOverlays();
        return;
      }
      if (this.stack.length <= depth) return;
    }
  }

  // ---------- 事件订阅 ----------

  private onBackendEvent(event: PersistentEvent): void {
    const body = event.body;
    // 项目/会话列表的轻量补丁（与任务 TUI 的 ViewState 同源语义，这里只留展示字段）
    switch (body.type) {
      case "project.created":
        this.projects = [...this.projects.filter((p) => p.id !== body.projectId), { id: body.projectId, name: body.name, createRequestId: body.createRequestId, rootDir: body.rootDir ?? null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: event.createdAt } as Project];
        break;
      case "project.settings_changed":
        this.projects = this.projects.map((p) =>
          p.id === body.projectId ? { ...p, instructionFiles: body.instructionFiles, webSearch: body.webSearch, settingsVersion: body.settingsVersion } : p,
        );
        break;
      case "project.root_attached":
        this.projects = this.projects.map((p) => (p.id === body.projectId && !p.rootDir ? { ...p, rootDir: body.rootDir } : p));
        break;
      case "session.model_selection_changed":
        this.sessions = this.sessions.map((s) => (s.id === body.sessionId ? { ...s, modelSelection: body.modelSelection, modelSelectionVersion: body.modelSelectionVersion } : s));
        break;
      case "session.workspace_mapped":
        // agent-direction issue 07：仅组织展示归属，与任务 TUI 的 ViewState 同源更新
        this.sessions = this.sessions.map((s) => (s.id === body.sessionId ? { ...s, workspaceProjectId: body.workspaceProjectId } : s));
        break;
      case "session.default_mode_changed":
        this.sessions = this.sessions.map((s) => (s.id === body.sessionId ? { ...s, defaultAccessMode: body.defaultAccessMode, defaultAccessModeVersion: body.defaultAccessModeVersion } : s));
        break;
      case "session.created":
        void this.refreshSnapshotFromServer();
        break;
      default:
        break;
    }
    if (body.type === "model.config_changed") this.modelView = null; // 失效缓存，下次读取拉新
    const screen = this.stack[this.stack.length - 1];
    if (screen?.watch?.(body.type)) void this.refresh();
  }

  /** 重读后台握手快照（项目/会话/角色会话标识）；事件刷新与冲突重读共用。 */
  private async refreshSnapshotFromServer(): Promise<void> {
    if (!this.deps.client) return;
    try {
      const result = await this.deps.client.handshake();
      this.projects = result.snapshot.projects;
      this.sessions = result.snapshot.sessions;
      this.roleSessionIds = result.snapshot.roleSessionIds ?? [];
    } catch {
      // 刷新失败：保留旧视图，下个事件再试
    }
  }

  // ---------- 根菜单 ----------

  private rootScreen(): Screen {
    const defs: Array<{ id: string; title: string; desc: string; offline: boolean }> = [
      { id: "models", title: "模型与提供方", desc: "模型目录、API key、后台默认模型", offline: true },
      { id: "projects", title: "项目", desc: "指令文件、Web Search、Jev 实验、资料授权", offline: false },
      { id: "sessions", title: "会话", desc: "默认模型、思考档位、权限模式", offline: false },
      { id: "mcp", title: "MCP 服务", desc: "端点、凭据引用、工具允许列表", offline: false },
      { id: "qq", title: "QQ 入口", desc: "连接配置、启停与允许群", offline: false },
      { id: "credentials", title: "服务凭据", desc: "HTTP 凭据绑定（仅展示元数据）", offline: false },
    ];
    const offline = this.deps.mode === "offline";
    return {
      id: "root",
      title: offline ? "配置分区（离线模式：仅模型配置可写）" : "配置分区",
      load: async () => [
        ...defs.map((d) => ({
          value: d.id,
          label: d.title + (!d.offline && offline ? "（需要连接后台）" : ""),
          description: !d.offline && offline ? "离线模式不可管理，启动后台后重进" : d.desc,
        })),
        { value: "__quit", label: "退出配置中心" },
      ],
      onSelect: async (item) => {
        if (item.value === "__quit") {
          this.quit(0);
          return;
        }
        const def = defs.find((d) => d.id === item.value);
        if (!def) return;
        if (offline && !def.offline) {
          this.notify("该分区需要连接后台（离线模式仅提供模型配置）", "yellow");
          return;
        }
        switch (def.id) {
          case "models":
            return this.pushScreen(this.modelsScreen());
          case "projects":
            return this.pushScreen(this.projectsScreen());
          case "sessions":
            return this.pushScreen(this.sessionsScreen());
          case "mcp":
            return this.pushScreen(this.mcpScreen());
          case "qq":
            return this.pushScreen(this.qqScreen());
          case "credentials":
            return this.pushScreen(this.credentialsScreen());
        }
      },
    };
  }

  // ---------- 模型与提供方（在线/离线共用，经 ModelBackend） ----------

  private async modelConfig(): Promise<ModelConfigView> {
    if (!this.modelView) this.modelView = await this.deps.modelBackend.load();
    return this.modelView;
  }

  /** 整份目录回写：脱敏占位（apiKey/headers 值的 true）由保存端还原为原值。 */
  private async saveCatalogEdited(okMsg: string, edit: (payload: Record<string, any>) => void): Promise<void> {
    const view = await this.modelConfig();
    const payload = structuredClone(view.providers);
    edit(payload);
    await this.deps.modelBackend.saveCatalog(payload);
    this.modelView = null;
    this.notify(okMsg);
    await this.refresh();
  }

  private modelsScreen(): Screen {
    return {
      id: "models",
      title: "模型与提供方",
      watch: (t) => t === "model.config_changed",
      intro: () => {
        const lines: string[] = [];
        if (this.deps.mode === "offline") {
          lines.push(`离线模式：直接写 ${this.deps.agentDir}（已持有配置锁）`);
          if (this.deps.probeDetail) lines.push(`配置探测：${this.deps.probeDetail}`);
        }
        const v = this.modelView;
        if (v) {
          const d = v.defaultModel;
          lines.push(`后台默认模型：${d ? `${d.provider}/${d.modelId} · ${d.thinkingLevel}` : "未设置（回退目录首个模型）"}`);
          lines.push(`摘要模型：${v.summaryModel ? `${v.summaryModel.provider}/${v.summaryModel.modelId}` : "未设置（用会话当前模型）"}`);
          if (v.busyProviders.length > 0) lines.push(`有运行/排队任务，修改被暂缓：${v.busyProviders.join("、")}`);
        }
        return lines;
      },
      load: async () => {
        const view = await this.modelConfig();
        const items: SelectItem[] = Object.entries(view.providers).map(([id, def]) => {
          const d = def as any;
          const cred = view.credentials[id]?.configured === true;
          const busy = view.busyProviders.includes(id);
          const modelCount = Array.isArray(d?.models) ? d.models.length : 0;
          return {
            value: `provider:${id}`,
            label: `${typeof d?.name === "string" ? `${d.name}（${id}）` : id}${view.defaultModel?.provider === id ? " · 默认" : ""}`,
            description: `${cred ? "已配置凭据" : "未配置凭据"} · ${modelCount} 个模型${busy ? " · 有运行/排队任务" : ""}`,
          };
        });
        items.push({ value: "default-model", label: "设置后台默认模型", description: "选择提供方/模型/思考档位" });
        items.push({ value: "summary-model", label: "设置摘要模型", description: SUMMARY_MODEL_NOTE });
        items.push({ value: "add-provider", label: "新增提供方" });
        return items;
      },
      onSelect: async (item) => {
        if (item.value === "default-model") return this.pickDefaultModel();
        if (item.value === "summary-model") return this.pickSummaryModel();
        if (item.value === "add-provider") return this.addProvider();
        if (item.value.startsWith("provider:")) return this.pushScreen(this.providerScreen(item.value.slice("provider:".length)));
      },
    };
  }

  private providerScreen(providerId: string): Screen {
    return {
      id: `provider:${providerId}`,
      title: `提供方 ${providerId}`,
      watch: (t) => t === "model.config_changed",
      load: async () => {
        const view = await this.modelConfig();
        const def = view.providers[providerId] as any;
        if (!def) return [];
        const cred = view.credentials[providerId]?.configured === true;
        const items: SelectItem[] = [
          { value: "field:name", label: `名称：${def.name ?? "（未设置）"}` },
          { value: "field:baseUrl", label: `baseUrl：${def.baseUrl ?? "（未设置）"}` },
          { value: "field:api", label: `协议 api：${def.api ?? "（未设置）"}` },
          { value: "field:headers", label: `自定义头：${def.headers ? Object.keys(def.headers as Record<string, string>).join("、") : "（无）"}` },
          { value: "models", label: `模型列表（${Array.isArray(def.models) ? def.models.length : 0}）`, description: "查看/新增/编辑/删除模型条目" },
          { value: "apikey", label: `API key：${cred ? "已配置（不回显）" : "未配置"}`, description: "遮蔽输入，写入 auth.json（0600）" },
        ];
        if (this.deps.modelBackend.testConnection) {
          items.push({ value: "test", label: "测试连接", description: "显式联网探测（1-token 请求，30 秒超时）" });
        }
        items.push({ value: "remove", label: "删除该提供方", description: "仍被引用时会被拒绝（列出引用计数）" });
        return items;
      },
      onSelect: async (item) => {
        const view = await this.modelConfig();
        if (!view.providers[providerId]) {
          this.notify("该提供方已不存在", "yellow");
          return this.popScreen();
        }
        const textField = async (field: "name" | "baseUrl" | "api", label: string): Promise<void> => {
          const def = view.providers[providerId] as any;
          const value = await this.inputBox(`${providerId} 的 ${label}`, { initial: def[field] ?? "" });
          if (value === null) return;
          await this.saveCatalogEdited("已保存", (payload) => {
            const target = payload[providerId];
            if (!target) return;
            const trimmed = value.trim();
            if (trimmed) target[field] = trimmed;
            else delete target[field];
          });
        };
        switch (item.value) {
          case "field:name":
            return textField("name", "名称");
          case "field:baseUrl":
            return textField("baseUrl", "baseUrl（http(s) URL）");
          case "field:api":
            return textField("api", "协议 api（如 openai-completions / anthropic-messages）");
          case "field:headers": {
            const def = view.providers[providerId] as any;
            // 头的值按秘密脱敏：*** 表示沿用原值
            const initial = def.headers ? Object.keys(def.headers as Record<string, unknown>).map((k) => `${k}=***`).join(", ") : "";
            const value = await this.inputBox(`${providerId} 的自定义头（*** 保留原值）`, { initial, placeholder: "k=v，逗号分隔；留空清除" });
            if (value === null) return;
            const headers = parseKeyValueList(value);
            if (headers === null) {
              this.notify("格式无效：需要 k=v 条目，逗号分隔", "red");
              return;
            }
            return this.saveCatalogEdited("已保存", (payload) => {
              const target = payload[providerId];
              if (!target) return;
              if (Object.keys(headers).length > 0) target["headers"] = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v === "***" ? true : v]));
              else delete target["headers"];
            });
          }
          case "models":
            return this.pushScreen(this.modelsOfProviderScreen(providerId));
          case "apikey":
            return this.providerApiKey(providerId);
          case "test": {
            const def = view.providers[providerId] as any;
            const models = ((def.models as any[] | undefined) ?? []).filter((m) => typeof m?.id === "string");
            if (models.length === 0) {
              this.notify("该提供方还没有模型条目", "yellow");
              return;
            }
            const modelId = await this.pick("测试连接：选择模型（将发起真实联网请求）", models.map((m) => ({ value: m.id as string, label: String(m.name ?? m.id) })));
            if (modelId === null) return;
            this.notify("正在联网探测（最长 30 秒）…", "yellow");
            const result = await this.deps.modelBackend.testConnection!(providerId, modelId);
            this.notify(`${result.ok ? "✓" : "✗"} ${result.detail}`, result.ok ? "green" : "red");
            return;
          }
          case "remove": {
            if (!(await this.confirm(`删除提供方 ${providerId}？`, "目录条目与其凭据一并移除；仍被引用时后台会拒绝"))) return;
            await this.deps.modelBackend.removeProvider(providerId);
            this.modelView = null;
            this.notify("提供方已删除");
            return this.popScreen();
          }
        }
      },
    };
  }

  private modelsOfProviderScreen(providerId: string): Screen {
    return {
      id: "models",
      title: `提供方 ${providerId} 的模型`,
      watch: (t) => t === "model.config_changed",
      load: async () => {
        const view = await this.modelConfig();
        const models = (view.providers[providerId] as any)?.models as any[] | undefined;
        const items: SelectItem[] = (models ?? []).map((m, i) => ({
          value: `model:${i}`,
          label: String(m.id),
          description: `${typeof m.name === "string" ? m.name : ""} · 上下文 ${m.contextWindow ?? "?"} · 输出 ${m.maxTokens ?? "?"}${m.reasoning ? " · 支持思考" : ""}`,
        }));
        items.push({ value: "add", label: "新增模型" });
        return items;
      },
      onSelect: async (item) => {
        if (item.value === "add") {
          const id = await this.inputBox("新增模型 id", { placeholder: "服务端模型标识" });
          if (id === null) return;
          const modelId = id.trim();
          if (!modelId) {
            this.notify("模型 id 不能为空", "red");
            return;
          }
          return this.saveCatalogEdited(`已新增模型 ${modelId}`, (payload) => {
            const def = payload[providerId];
            if (!def) return;
            def["models"] = [...((def["models"] as unknown[] | undefined) ?? []), { id: modelId }];
          });
        }
        if (item.value.startsWith("model:")) return this.pushScreen(this.modelEntryScreen(providerId, Number(item.value.slice(6))));
      },
    };
  }

  private modelEntryScreen(providerId: string, index: number): Screen {
    const label = (view: ModelConfigView): any => ((view.providers[providerId] as any)?.models as any[] | undefined)?.[index];
    return {
      id: `model:${index}`,
      title: `模型条目 ${providerId}#${index + 1}`,
      watch: (t) => t === "model.config_changed",
      load: async () => {
        const m = label(await this.modelConfig());
        if (!m) return [];
        return [
          { value: "id", label: `id：${m.id}` },
          { value: "name", label: `名称：${m.name ?? "（未设置）"}` },
          { value: "contextWindow", label: `上下文窗口：${m.contextWindow ?? "（未设置）"}` },
          { value: "maxTokens", label: `最大输出：${m.maxTokens ?? "（未设置）"}` },
          { value: "reasoning", label: `思考能力：${m.reasoning ? "是" : "否"}` },
          { value: "remove", label: "删除该模型" },
        ];
      },
      onSelect: async (item) => {
        const editModel = (okMsg: string, fn: (m: any) => void) =>
          this.saveCatalogEdited(okMsg, (payload) => {
            const list = payload[providerId]?.["models"] as any[] | undefined;
            const m = list?.[index];
            if (m) fn(m);
          });
        switch (item.value) {
          case "id":
          case "name": {
            const value = await this.inputBox(`模型条目的 ${item.value}`, { initial: String(label(await this.modelConfig())?.[item.value] ?? "") });
            if (value === null) return;
            const trimmed = value.trim();
            if (item.value === "id" && !trimmed) {
              this.notify("模型 id 不能为空", "red");
              return;
            }
            return editModel("已保存", (m) => {
              if (trimmed) m[item.value] = trimmed;
              else delete m[item.value];
            });
          }
          case "contextWindow":
          case "maxTokens": {
            const value = await this.inputBox(`模型条目的 ${item.value}（正整数，留空清除）`, { initial: String(label(await this.modelConfig())?.[item.value] ?? "") });
            if (value === null) return;
            const trimmed = value.trim();
            if (trimmed && (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0)) {
              this.notify("必须是正整数", "red");
              return;
            }
            return editModel("已保存", (m) => {
              if (trimmed) m[item.value] = Number(trimmed);
              else delete m[item.value];
            });
          }
          case "reasoning": {
            const value = await this.pick("模型是否支持思考档位", [
              { value: "false", label: "否" },
              { value: "true", label: "是（支持 off/minimal/low/medium/high）" },
            ]);
            if (value === null) return;
            return editModel("已保存", (m) => {
              m["reasoning"] = value === "true";
            });
          }
          case "remove": {
            if (!(await this.confirm("删除该模型条目？", String(label(await this.modelConfig())?.id ?? "")))) return;
            await this.saveCatalogEdited("模型已删除", (payload) => {
              const list = payload[providerId]?.["models"] as any[] | undefined;
              list?.splice(index, 1);
            });
            return this.popScreen();
          }
        }
      },
    };
  }

  /** API key 设置/移除：遮蔽输入，值不回显、不入任何状态文件。 */
  private async providerApiKey(providerId: string): Promise<void> {
    const action = await this.pick(`提供方 ${providerId} 的 API key`, [
      { value: "set", label: "设置/更新 API key", description: "遮蔽输入（•••），写入 auth.json" },
      { value: "remove", label: "移除 API key" },
    ]);
    if (action === "set") {
      const key = await this.maskedBox(`设置 ${providerId} 的 API key`);
      if (key === null) return;
      await this.deps.modelBackend.setApiKey(providerId, key);
      this.modelView = null;
      this.notify("API key 已保存（凭据不回显）");
      await this.refresh();
    } else if (action === "remove") {
      if (!(await this.confirm(`移除 ${providerId} 的 API key？`, "移除后该提供方将因缺少凭据而不可用"))) return;
      await this.deps.modelBackend.removeApiKey(providerId);
      this.modelView = null;
      this.notify("API key 已移除");
      await this.refresh();
    }
  }

  private async addProvider(): Promise<void> {
    const raw = await this.inputBox("新增提供方 id", { placeholder: "字母/数字/-/_，如 my-provider" });
    if (raw === null) return;
    const id = raw.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
      this.notify("提供方 id 只能含字母/数字/-/_，且以字母或数字开头", "red");
      return;
    }
    const view = await this.modelConfig();
    if (id in view.providers) {
      this.notify("提供方已存在", "yellow");
      return;
    }
    await this.saveCatalogEdited(`已新增提供方 ${id}，请继续编辑其 baseUrl/协议/模型`, (payload) => {
      payload[id] = { name: id, models: [] };
    });
  }

  /** 目录模型（选择器数据源）：在线用 list_models（含真实思考档位），离线由目录推导。 */
  private async catalogModels(): Promise<CatalogModelOption[]> {
    if (this.deps.mode === "online" && this.deps.client) {
      const out: CatalogModelOption[] = [];
      let offset = 0;
      for (;;) {
        const page = await this.deps.client.request<any>("list_models", { offset, limit: 100 });
        for (const m of (page.models as any[] | undefined) ?? []) {
          out.push({
            provider: String(m.provider),
            modelId: String(m.modelId),
            name: String(m.name ?? m.modelId),
            thinkingLevels: Array.isArray(m.thinkingLevels) && m.thinkingLevels.length > 0 ? m.thinkingLevels.map(String) : ["off"],
            available: m.available !== false,
          });
        }
        if (page.nextOffset === null || page.nextOffset === undefined) break;
        offset = Number(page.nextOffset);
      }
      return out;
    }
    const view = await this.modelConfig();
    const out: CatalogModelOption[] = [];
    for (const [provider, def] of Object.entries(view.providers)) {
      for (const m of (((def as any)?.models as any[] | undefined) ?? [])) {
        if (typeof m?.id !== "string") continue;
        out.push({
          provider,
          modelId: m.id,
          name: typeof m.name === "string" ? m.name : m.id,
          thinkingLevels: thinkingLevelsForCatalogModel(m),
          available: view.credentials[provider]?.configured === true,
        });
      }
    }
    return out;
  }

  /** provider → 模型 → 思考档位的按序选择；任一步取消返回 null。 */
  private async pickModelAndLevel(title: string, current?: ModelSelection | null): Promise<ModelSelection | null> {
    const models = await this.catalogModels();
    if (models.length === 0) {
      this.notify("目录中没有可用模型", "yellow");
      return null;
    }
    const providerIds = [...new Set(models.map((m) => m.provider))];
    const provider = await this.pick(
      `${title}：提供方`,
      providerIds.map((p) => ({ value: p, label: p, description: `${models.filter((m) => m.provider === p).length} 个模型` })),
    );
    if (provider === null) return null;
    const modelId = await this.pick(
      `${title}：模型`,
      models
        .filter((m) => m.provider === provider)
        .map((m) => ({ value: m.modelId, label: m.name === m.modelId ? m.modelId : `${m.name}（${m.modelId}）`, description: m.available ? "" : "凭据未配置" })),
    );
    if (modelId === null) return null;
    const option = models.find((m) => m.provider === provider && m.modelId === modelId)!;
    const level = await this.pick(
      `${title}：思考档位`,
      option.thinkingLevels.map((l) => ({ value: l, label: l })),
      { description: current ? `当前：${current.thinkingLevel}` : undefined },
    );
    if (level === null) return null;
    return { provider, modelId, thinkingLevel: level as ModelSelection["thinkingLevel"] };
  }

  private async pickDefaultModel(): Promise<void> {
    const view = await this.modelConfig();
    const sel = await this.pickModelAndLevel("后台默认模型", view.defaultModel);
    if (!sel) return;
    await this.deps.modelBackend.setDefaultModel(sel);
    this.modelView = null;
    this.notify(`后台默认模型已保存：${sel.provider}/${sel.modelId} · ${sel.thinkingLevel}`);
    await this.refresh();
  }

  /** 摘要模型只选提供方与模型（不存思考档位，摘要请求不带思考参数）；首项为不设置。 */
  private async pickSummaryModel(): Promise<void> {
    const models = await this.catalogModels();
    const current = (await this.modelConfig()).summaryModel;
    const UNSET = ""; // provider id 不能为空，空串即「不设置」
    const provider = await this.pick(
      "摘要模型：提供方",
      [
        { value: UNSET, label: "不设置（用会话当前模型）" },
        ...[...new Set(models.map((m) => m.provider))].map((p) => ({ value: p, label: p, description: `${models.filter((m) => m.provider === p).length} 个模型` })),
      ],
      { description: `${SUMMARY_MODEL_NOTE}${current ? `；当前：${current.provider}/${current.modelId}` : ""}` },
    );
    if (provider === null) return;
    let model: SummaryModel | null = null;
    if (provider !== UNSET) {
      const modelId = await this.pick(
        "摘要模型：模型",
        models
          .filter((m) => m.provider === provider)
          .map((m) => ({ value: m.modelId, label: m.name === m.modelId ? m.modelId : `${m.name}（${m.modelId}）`, description: m.available ? "" : "凭据未配置" })),
      );
      if (modelId === null) return;
      model = { provider, modelId };
    }
    await this.deps.modelBackend.setSummaryModel(model);
    this.modelView = null;
    this.notify(model ? `摘要模型已保存：${model.provider}/${model.modelId}` : "摘要模型已清除，用会话当前模型");
    await this.refresh();
  }

  // ---------- 项目 ----------

  private findProject(projectId: string): Project | undefined {
    return this.projects.find((p) => p.id === projectId);
  }

  private patchProject(projectId: string, patch: Partial<Project>): void {
    this.projects = this.projects.map((p) => (p.id === projectId ? { ...p, ...patch } : p));
  }

  /** 项目列表顺序与标注：ruukoto-dev 沿用任务界面的工作区/旧项目分类（工作区在前）；ruukoto 平铺不标注。 */
  private orderedProjects(): Array<{ project: Project; tag: "工作区" | "旧项目" | null }> {
    if (this.product !== "ruukoto-dev") return this.projects.map((project) => ({ project, tag: null }));
    const { workspaces, legacy } = workspacePickerProjects({
      projects: this.projects,
      sessions: this.sessions,
      roleSessionIds: this.roleSessionIds,
    });
    return [...workspaces.map((project) => ({ project, tag: "工作区" as const })), ...legacy.map((project) => ({ project, tag: "旧项目" as const }))];
  }

  private projectsScreen(): Screen {
    return {
      id: "projects",
      title: "项目",
      watch: (t) => t === "project.created" || t === "project.settings_changed" || t === "project.root_attached",
      load: async () =>
        this.orderedProjects().map(({ project: p, tag }) => ({
          value: `project:${p.id}`,
          label: tag ? `${tag} · ${p.name}` : p.name,
          description: `${p.rootDir ? `根目录 ${p.rootDir.cwdReal} · ` : ""}指令 ${p.instructionFiles.length} 个 · Web Search ${p.webSearch === "enabled" ? "启用" : "禁用"}`,
        })),
      onSelect: async (item) => {
        if (item.value.startsWith("project:")) return this.pushScreen(this.projectScreen(item.value.slice("project:".length)));
      },
    };
  }

  private projectScreen(projectId: string): Screen {
    return {
      id: `project:${projectId}`,
      title: `项目 ${this.findProject(projectId)?.name ?? projectId}`,
      watch: (t) =>
        t === "project.created" || t === "project.settings_changed" || t === "project.root_attached" || t === "session.workspace_mapped",
      intro: () => {
        if (this.product !== "ruukoto-dev") return [];
        const p = this.findProject(projectId);
        if (!p) return [];
        if (!p.rootDir) return ["旧项目（尚无工作区根目录归属）"];
        const lines = [`工作区 · 根目录：${p.rootDir.cwdReal}`];
        // issue 07 步骤 4：关联旧资料来源并列显示，组织映射不改变资料与配置归属
        const sources = workspaceMappedSources({ sessions: this.sessions }, projectId);
        if (sources.size > 0) lines.push(`关联旧资料来源 ${sources.size} 项：仅组织归属，各来源的配置与资料仍按原项目 ID 读取（不合并）`);
        return lines;
      },
      load: async () => {
        const p = this.findProject(projectId);
        if (!p) return [];
        const items: SelectItem[] = [
          { value: "instructions", label: `指令文件：${p.instructionFiles.join("，") || "（无）"}`, description: `工作区相对路径，逗号分隔 · 设置版本 v${p.settingsVersion}` },
          { value: "websearch", label: `Web Search：${p.webSearch === "enabled" ? "启用" : "禁用"}` },
          { value: "jev", label: "Jev 上下文筛选实验", description: "默认关闭，按项目选择服务凭据与启停" },
          { value: "mcp", label: "MCP 服务", description: "本项目的端点、凭据引用与工具允许列表" },
          { value: "grants", label: "资料授权", description: "跨项目历史/产物/记忆读取授权" },
        ];
        // issue 07 步骤 4：工作区列出关联旧资料来源及原配置入口（并列显示，不推断优先级）
        if (this.product === "ruukoto-dev" && p.rootDir) {
          const sources = workspaceMappedSources({ sessions: this.sessions }, projectId);
          if (sources.size > 0) {
            const grantResult = await this.deps.client!.request<any>("list_data_grants", {});
            const grants = (grantResult.grants as DataGrant[] | undefined) ?? [];
            for (const [sourceId, sessions] of sources) {
              const source = this.findProject(sourceId);
              const mcp = await this.deps.client!.request<{ services: unknown[] }>("mcp_list", { project_id: sourceId });
              const jev = await this.deps.client!.request<JevConfig>("get_project_jev", { project_id: sourceId });
              const outgoing = grants.filter((g) => g.fromProjectId === sourceId && g.revokedAt === null).length;
              const incoming = grants.filter((g) => g.toProjectId === sourceId && g.revokedAt === null).length;
              items.push({
                // ponytail: value 沿用 project:<id>（重载恢复按值匹配菜单，不引入新菜单 id）
                value: `project:${sourceId}`,
                label: `关联旧资料：${source?.name ?? sourceId}`,
                description:
                  `${sessions.length} 个映射会话 · MCP ${mcp.services.length} 项 · Jev ${jev.enabled ? "启用" : "关闭"}` +
                  ` · 授权 出 ${outgoing} / 入 ${incoming} · v${source?.settingsVersion ?? "?"}` +
                  ` · 指令基准 ${source?.rootDir?.cwdReal ?? [...new Set(sessions.map((s) => s.cwdReal))].join("，")}`,
              });
            }
          }
        }
        return items;
      },
      onSelect: async (item) => {
        const client = this.deps.client!;
        const p = this.findProject(projectId);
        if (!p) {
          this.notify("项目已不存在", "yellow");
          return this.popScreen();
        }
        // issue 07 步骤 4：原配置入口——关联来源的设置、MCP/Jev 与授权都按来源项目 ID 与本设置的各自版本访问
        // （关联来源行的值为 project:<来源id>，与本项目自身的功能值不冲突）
        if (item.value.startsWith("project:")) return this.pushScreen(this.projectScreen(item.value.slice("project:".length)));
        switch (item.value) {
          case "instructions": {
            const value = await this.inputBox("项目指令文件（工作区相对路径，逗号/换行分隔；留空清除）", { initial: p.instructionFiles.join(", ") });
            if (value === null) return;
            const files = value.split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);
            // 携带开始编辑时读取的版本；冲突（另一客户端已保存）由 act() 重读后台后刷新
            const saved = await client.request<Project>("set_project_instructions", { project_id: projectId, files, expected_version: p.settingsVersion });
            this.patchProject(projectId, saved);
            this.notify(files.length > 0 ? `已保存 ${files.length} 个指令文件` : "已清除项目指令");
            return this.refresh();
          }
          case "websearch": {
            const value = await this.pick("Web Search 开关", [
              { value: "enabled", label: "启用" },
              { value: "disabled", label: "禁用（立即阻止后续调用）" },
            ]);
            if (value === null) return;
            const saved = await client.request<Project>("set_project_web_search", { project_id: projectId, enabled: value === "enabled", expected_version: p.settingsVersion });
            this.patchProject(projectId, saved);
            this.notify(value === "enabled" ? "Web Search 已启用" : "Web Search 已禁用");
            return this.refresh();
          }
          case "grants":
            return this.pushScreen(this.grantsScreen(projectId));
          case "jev":
            return this.pushScreen(this.jevScreen(projectId));
          case "mcp":
            return this.pushScreen(this.mcpScreen(projectId));
        }
      },
    };
  }

  private jevScreen(projectId: string): Screen {
    let config: JevConfig;
    return {
      id: "jev",
      title: `项目「${this.findProject(projectId)?.name ?? projectId}」的 Jev 实验`,
      watch: (type) => type === "project.jev_changed",
      intro: () => [
        "启用后将当前任务和候选历史文本发送给 TypeSafe；普通账号的零保留未获保证。",
        "启用从下一任务生效；停用后阻止后续请求并丢弃在途结果，已发送内容无法撤回。",
      ],
      load: async () => {
        config = await this.deps.client!.request<JevConfig>("get_project_jev", { project_id: projectId });
        return [
          { value: "enabled", label: `实验：${config.enabled ? "启用" : "关闭"}`, description: `v${config.configVersion}` },
          { value: "credential", label: `凭据引用：${config.credential ?? "（无）"}`, description: "在服务凭据分区新增 purpose=jev_context 的凭据" },
        ];
      },
      onSelect: async (item) => {
        const client = this.deps.client!;
        const loaded = config;
        let enabled = loaded.enabled;
        let credential = loaded.credential;
        if (item.value === "enabled") {
          if (!enabled && !(await this.confirm("启用 Jev 实验？", "将当前任务和候选历史文本发送给 TypeSafe；零保留未获保证"))) return;
          enabled = !enabled;
        } else if (item.value === "credential") {
          const credentials = await client.request<Array<{ name: string; host: string; header: string; purpose: string }>>("list_credentials", {});
          const value = await this.pick("Jev 服务凭据", [
            { value: "", label: "清除凭据并关闭实验" },
            ...credentials.filter((binding) => binding.host === JEV_HOST && binding.header.toLowerCase() === "authorization" && binding.purpose === JEV_CREDENTIAL_PURPOSE)
              .map((binding) => ({ value: binding.name, label: binding.name })),
          ]);
          if (value === null) return;
          credential = value || null;
          if (!credential) enabled = false;
        } else return;
        await client.request("set_project_jev", { project_id: projectId, enabled, credential, expected_version: loaded.configVersion });
        this.notify(enabled ? "Jev 实验已启用，从下一任务生效" : "Jev 实验已关闭");
        return this.refresh();
      },
    };
  }

  private grantsScreen(projectId: string): Screen {
    const projectName = (id: string): string => this.findProject(id)?.name ?? id;
    return {
      id: "grants",
      title: `项目「${projectName(projectId)}」的资料授权`,
      watch: (t) => t === "data_grant.created" || t === "data_grant.revoked",
      load: async () => {
        const result = await this.deps.client!.request<any>("list_data_grants", {});
        const grants = ((result.grants as DataGrant[] | undefined) ?? []).filter(
          (g) => g.revokedAt === null && (g.fromProjectId === projectId || g.toProjectId === projectId),
        );
        const items: SelectItem[] = grants.map((g) => ({
          value: `grant:${g.id}`,
          label: `${projectName(g.fromProjectId)} → ${projectName(g.toProjectId)} · ${GRANT_CATEGORY_LABELS[g.category] ?? g.category}`,
          description: `${g.fromProjectId === projectId ? "出向（本项目的资料可被目标读取）" : "入向（本项目可读取来源的资料）"} · ${g.purpose || "（无用途说明）"} · Enter 撤销`,
        }));
        items.push({ value: "create", label: "新建授权", description: "从本项目授权给其他项目（方向固定：本项目 → 目标）" });
        items.push({ value: "revoked-log", label: "查看已撤销", description: "只读记录（含撤销时间），不可操作" });
        return items;
      },
      onSelect: async (item) => {
        const client = this.deps.client!;
        if (item.value === "revoked-log") {
          const result = await client.request<any>("list_data_grants", { include_revoked: true });
          const revoked = ((result.grants as DataGrant[] | undefined) ?? []).filter(
            (g) => g.revokedAt !== null && (g.fromProjectId === projectId || g.toProjectId === projectId),
          );
          this.showText(
            "已撤销的资料授权",
            revoked.length === 0
              ? ["（无已撤销记录）"]
              : revoked.map(
                  (g) =>
                    `${projectName(g.fromProjectId)} → ${projectName(g.toProjectId)} · ${GRANT_CATEGORY_LABELS[g.category] ?? g.category} · 撤销于 ${g.revokedAt}${g.purpose ? ` · ${g.purpose}` : ""}`,
                ),
          );
          return;
        }
        if (item.value === "create") {
          const others = this.orderedProjects().filter(({ project }) => project.id !== projectId);
          if (others.length === 0) {
            this.notify("没有其他项目可作为授权目标", "yellow");
            return;
          }
          const to = await this.pick("授权目标项目（可读取本项目资料）", others.map(({ project: p, tag }) => ({ value: p.id, label: tag ? `${tag} · ${p.name}` : p.name })));
          if (to === null) return;
          const category = await this.pick(
            "资料类别",
            Object.entries(GRANT_CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
          );
          if (category === null) return;
          const purpose = await this.inputBox("用途说明（可留空）", {});
          if (purpose === null) return;
          await client.request("create_data_grant", {
            from_project_id: projectId,
            to_project_id: to,
            category,
            purpose: purpose.trim() ? purpose.trim() : undefined,
          });
          this.notify("授权已创建");
          return this.refresh();
        }
        if (item.value.startsWith("grant:")) {
          const grantId = item.value.slice(6);
          // 重读有效授权：定位本条并统计同范围（同来源/目标/类别）的其他有效授权
          const result = await client.request<any>("list_data_grants", {});
          const active = ((result.grants as DataGrant[] | undefined) ?? []).filter((g) => g.revokedAt === null);
          const grant = active.find((g) => g.id === grantId);
          if (!grant) {
            this.notify("授权已不存在", "yellow");
            return this.refresh();
          }
          const siblings = active.filter(
            (g) => g.id !== grantId && g.fromProjectId === grant.fromProjectId && g.toProjectId === grant.toProjectId && g.category === grant.category,
          ).length;
          const scope = `${projectName(grant.fromProjectId)} → ${projectName(grant.toProjectId)} · ${GRANT_CATEGORY_LABELS[grant.category] ?? grant.category}`;
          // 撤销按单条授权 ID 执行：同范围还有其他有效授权时，该类访问不会被本条撤销关闭
          const detail =
            siblings > 0
              ? `${scope}；同范围还有 ${siblings} 条有效授权，撤销本条后该类访问仍开放`
              : `${scope}；同范围最后一条有效授权，撤销后该类访问关闭`;
          if (!(await this.confirm("撤销该授权？", detail))) return;
          await client.request("revoke_data_grant", { grant_id: grantId });
          this.notify(siblings > 0 ? `授权已撤销；同范围还有 ${siblings} 条有效授权，该类访问仍开放` : "授权已撤销");
          return this.refresh();
        }
      },
    };
  }

  // ---------- 会话 ----------

  private patchSession(sessionId: string, patch: Partial<Session>): void {
    this.sessions = this.sessions.map((s) => (s.id === sessionId ? { ...s, ...patch } : s));
  }

  private sessionLabel(s: Session): string {
    const project = this.findProject(s.projectId)?.name ?? s.projectId;
    return `${project} · ${s.cwd} · ${s.id.slice(0, 12)}…`;
  }

  private sessionsScreen(): Screen {
    return {
      id: "sessions",
      title: "会话",
      watch: (t) => t.startsWith("session."),
      load: async () =>
        this.sessions.map((s) => {
          const sel = s.modelSelection ? `${s.modelSelection.provider}/${s.modelSelection.modelId} · ${s.modelSelection.thinkingLevel}` : "后台默认";
          return {
            value: `session:${s.id}`,
            label: this.sessionLabel(s),
            description: `模型 ${sel} · ${ACCESS_MODE_LABELS[s.defaultAccessMode]?.split("（")[0] ?? s.defaultAccessMode}`,
          };
        }),
      onSelect: async (item) => {
        if (item.value.startsWith("session:")) return this.pushScreen(this.sessionScreen(item.value.slice("session:".length)));
      },
    };
  }

  private sessionScreen(sessionId: string): Screen {
    return {
      id: `session:${sessionId}`,
      title: `会话 ${sessionId.slice(0, 12)}…`,
      watch: (t) => t.startsWith("session."),
      load: async () => {
        // 每次进入重读：拿最新版本号做条件更新
        const s = await this.deps.client!.request<Session>("get_session", { session_id: sessionId });
        this.patchSession(sessionId, s);
        const sel = s.modelSelection ? `${s.modelSelection.provider}/${s.modelSelection.modelId} · ${s.modelSelection.thinkingLevel}` : "后台默认";
        return [
          { value: "model", label: `默认模型：${sel}`, description: `选择 provider/model/思考档位` },
          { value: "mode", label: `权限模式：${ACCESS_MODE_LABELS[s.defaultAccessMode] ?? s.defaultAccessMode}` },
        ];
      },
      onSelect: async (item) => {
        const client = this.deps.client!;
        const s = await client.request<Session>("get_session", { session_id: sessionId });
        switch (item.value) {
          case "model": {
            const sel = await this.pickModelAndLevel("会话默认模型", s.modelSelection);
            if (!sel) return;
            await client.request("set_session_model", { session_id: sessionId, model_selection: sel, expected_version: s.modelSelectionVersion });
            this.patchSession(sessionId, { modelSelection: sel, modelSelectionVersion: s.modelSelectionVersion + 1 });
            this.notify(`会话默认模型已保存：${sel.provider}/${sel.modelId} · ${sel.thinkingLevel}`);
            return this.refresh();
          }
          case "mode": {
            const value = await this.pick(
              "会话权限模式（新建任务的默认）",
              SESSION_DEFAULT_MODES.map((m) => ({ value: m, label: ACCESS_MODE_LABELS[m] ?? m })),
              { description: `当前：${s.defaultAccessMode}` },
            );
            if (value === null) return;
            await client.request("set_session_mode", { session_id: sessionId, mode: value, expected_version: s.defaultAccessModeVersion });
            this.patchSession(sessionId, { defaultAccessMode: value as Session["defaultAccessMode"], defaultAccessModeVersion: s.defaultAccessModeVersion + 1 });
            this.notify("会话权限模式已保存");
            return this.refresh();
          }
        }
      },
    };
  }

  // ---------- MCP 服务 ----------

  /** MCP 服务列表：传入 projectId 时只列该项目服务（项目详情内入口），新增固定归属；缺省为全局分区。 */
  private mcpScreen(projectId?: string): Screen {
    const scopedName = projectId === undefined ? null : (this.findProject(projectId)?.name ?? projectId);
    return {
      id: "mcp",
      title: scopedName ? `MCP 服务（${scopedName}）` : "MCP 服务",
      watch: (t) => t === "mcp.service_changed",
      load: async () => {
        const result = await this.deps.client!.request<any>("mcp_list", projectId === undefined ? {} : { project_id: projectId });
        const services = (result.services as McpServiceConfig[] | undefined) ?? [];
        const items: SelectItem[] = services.map((s) => ({
          value: `svc:${s.id}`,
          label: `${s.name}${projectId === undefined ? `（${this.findProject(s.projectId)?.name ?? s.projectId}）` : ""}${s.enabled ? "" : " · 已禁用"}`,
          description: `${s.endpoint} · v${s.configVersion}`,
        }));
        items.push({
          value: "add",
          label: "新增服务",
          description:
            projectId === undefined
              ? this.projects.length > 0
                ? "注册 Streamable HTTP MCP 端点"
                : "需要先有项目"
              : `固定归属项目「${scopedName}」`,
        });
        return items;
      },
      onSelect: async (item) => {
        if (item.value === "add") return this.addMcpService(projectId);
        if (item.value.startsWith("svc:")) return this.pushScreen(this.mcpServiceScreen(item.value.slice(4), projectId));
      },
    };
  }

  private async readMcpService(serviceId: string): Promise<McpServiceConfig | null> {
    const result = await this.deps.client!.request<any>("mcp_list", {});
    return (((result.services as McpServiceConfig[] | undefined) ?? []).find((s) => s.id === serviceId)) ?? null;
  }

  /** 服务详情；expectedProjectId 非空时核对实际归属（项目详情内入口不能把其他项目的服务串改）。 */
  private mcpServiceScreen(serviceId: string, expectedProjectId?: string): Screen {
    return {
      id: `svc:${serviceId}`,
      title: `MCP 服务 ${serviceId.slice(0, 12)}…`,
      watch: (t) => t === "mcp.service_changed",
      load: async () => {
        const s = await this.readMcpService(serviceId);
        if (!s) return [];
        if (expectedProjectId !== undefined && s.projectId !== expectedProjectId) {
          this.notify("该服务归属其他项目，已从当前项目返回", "yellow");
          void this.popScreen();
          return [];
        }
        return [
          { value: "endpoint", label: `端点：${s.endpoint}` },
          { value: "credential", label: `凭据引用：${s.credential ?? "（无）"}` },
          { value: "tools", label: `工具允许列表：${s.toolAllowlist.length} 项`, description: formatAllowlist(s.toolAllowlist) || "（空 = 不注册任何工具）" },
          { value: "toggle", label: s.enabled ? "停用该服务" : "启用该服务" },
          { value: "check", label: "连接检查", description: "显式连接端点并列出工具（联网操作）" },
          { value: "remove", label: "删除该服务" },
        ];
      },
      onSelect: async (item) => {
        const client = this.deps.client!;
        const s = await this.readMcpService(serviceId);
        if (!s) {
          this.notify("服务已不存在", "yellow");
          return this.popScreen();
        }
        if (expectedProjectId !== undefined && s.projectId !== expectedProjectId) {
          this.notify("该服务归属其他项目，已从当前项目返回", "yellow");
          return this.popScreen();
        }
        /** 单字段更新：携带当前允许列表与期望版本；凭据缺省 = 保留。 */
        const configure = async (patch: { endpoint?: string; credential?: string | null; toolAllowlist?: unknown[] }, okMsg: string): Promise<void> => {
          await client.request("mcp_configure", {
            project_id: s.projectId,
            name: s.name,
            endpoint: patch.endpoint ?? s.endpoint,
            credential: patch.credential,
            tool_allowlist: patch.toolAllowlist ?? s.toolAllowlist,
            expected_version: s.configVersion,
          });
          this.notify(okMsg);
          await this.refresh();
        };
        switch (item.value) {
          case "endpoint": {
            const value = await this.inputBox("MCP 端点 URL", { initial: s.endpoint });
            if (value === null) return;
            if (!value.trim()) {
              this.notify("端点不能为空", "red");
              return;
            }
            return configure({ endpoint: value.trim() }, "端点已保存");
          }
          case "credential": {
            const creds = (await client.request<any>("list_credentials", {})) as any;
            const names = ((creds as any[] | undefined) ?? (creds.bindings as any[] | undefined) ?? []).map((b: any) => String(b.name));
            const value = await this.pick("凭据引用（须先在「服务凭据」登记）", [
              { value: "", label: "（无凭据）" },
              ...names.map((n: string) => ({ value: n, label: n })),
            ]);
            if (value === null) return;
            return configure({ credential: value === "" ? null : value }, "凭据引用已保存");
          }
          case "tools": {
            const value = await this.inputBox("工具允许列表（name 或 name:write / name:unknown，逗号分隔）", { initial: formatAllowlist(s.toolAllowlist) });
            if (value === null) return;
            const parsed = parseAllowlist(value);
            if (parsed === null) {
              this.notify("格式无效：副作用类别必须是 read | write | unknown", "red");
              return;
            }
            return configure({ toolAllowlist: parsed }, "工具允许列表已保存");
          }
          case "toggle": {
            await client.request("mcp_set_enabled", { service_id: s.id, enabled: !s.enabled, expected_version: s.configVersion });
            this.notify(s.enabled ? "服务已停用" : "服务已启用");
            return this.refresh();
          }
          case "check": {
            this.notify(`正在连接 ${s.endpoint} …`, "yellow");
            const result = await client.request<any>("mcp_check", { service_id: s.id });
            const lines: string[] = [];
            lines.push(`结果：${result.ok ? "✓ 连接成功" : `✗ ${result.error ?? "连接失败"}`}`);
            if (result.serverInfo) lines.push(`服务：${result.serverInfo.name ?? "?"} ${result.serverInfo.version ?? ""} · 协议 ${result.protocolVersion ?? "?"}`);
            for (const t of (result.tools as any[] | undefined) ?? []) {
              lines.push(`${t.allowed ? "✓" : "✗"} ${t.name}${t.effect ? `（${t.effect}）` : ""}${t.allowed ? "" : `：${t.reason ?? "未允许"}`}`);
            }
            this.showText(`连接检查：${s.name}`, lines);
            return;
          }
          case "remove": {
            if (!(await this.confirm(`删除 MCP 服务 ${s.name}？`, s.endpoint))) return;
            await client.request("mcp_remove", { service_id: s.id, expected_version: s.configVersion });
            this.notify("服务已删除");
            return this.popScreen();
          }
        }
      },
    };
  }

  /** 新增服务：fixedProjectId（项目详情入口）跳过项目选择、固定归属；全局入口仍按工作区/旧项目分类选择。 */
  private async addMcpService(fixedProjectId?: string): Promise<void> {
    const client = this.deps.client!;
    let projectId = fixedProjectId ?? null;
    if (projectId !== null && !this.findProject(projectId)) {
      this.notify("目标项目已不存在", "yellow");
      return;
    }
    if (projectId === null) {
      if (this.projects.length === 0) {
        this.notify("需要先有项目", "yellow");
        return;
      }
      projectId = await this.pick("所属项目", this.orderedProjects().map(({ project: p, tag }) => ({ value: p.id, label: tag ? `${tag} · ${p.name}` : p.name })));
      if (projectId === null) return;
    }
    const name = await this.inputBox("服务名（项目内唯一 slug）", { placeholder: "如 docs" });
    if (name === null) return;
    const endpoint = await this.inputBox("端点 URL", { placeholder: "https://…/mcp/（http 仅限回环模拟）" });
    if (endpoint === null) return;
    const credential = await this.inputBox("凭据引用名（可留空 = 无认证）", {});
    if (credential === null) return;
    const tools = await this.inputBox("工具允许列表（name 或 name:write，逗号分隔；留空 = 暂不注册工具）", {});
    if (tools === null) return;
    const parsed = parseAllowlist(tools);
    if (parsed === null) {
      this.notify("工具列表格式无效", "red");
      return;
    }
    await client.request("mcp_configure", {
      project_id: projectId,
      name: name.trim(),
      endpoint: endpoint.trim(),
      credential: credential.trim() ? credential.trim() : null,
      tool_allowlist: parsed,
      enabled: true,
    });
    this.notify("MCP 服务已创建");
    await this.refresh();
  }

  // ---------- QQ ----------

  private qqScreen(): Screen {
    return {
      id: "qq",
      title: "QQ 入口",
      watch: (t) => t === "qq.config_changed",
      load: async () => {
        const st = (await this.deps.client!.request<any>("qq_status", {})) as Record<string, any>;
        const items: SelectItem[] = [];
        if (!st.configured) {
          items.push({ value: "configure", label: "初始化 QQ 入口配置", description: "NapCat OneBot v11 端点与登录号" });
          return items;
        }
        items.push({
          value: "toggle",
          label: st.enabled ? "停用 QQ 入口" : "启用 QQ 入口",
          description: `${st.online ? "当前在线" : "当前离线"} · ${st.stateDetail ?? ""}`,
        });
        items.push({
          value: "configure",
          label: `连接配置：${st.endpoint ?? ""}`,
          description: `登录号 ${st.selfId ?? "?"} · 凭据 ${st.credentialName ?? "（无）"} · 回复上限 ${st.maxReplyChars ?? "默认"} · v${st.configVersion ?? 0}`,
        });
        items.push({ value: "groups", label: `允许群（${Array.isArray(st.groups) ? st.groups.length : 0}）` });
        items.push({ value: "owner", label: `拥有者私聊：${st.ownerUserId ?? "未开启"}`, description: "固定好友 QQ 号，共享 main 会话；需要 token 凭据" });
        return items;
      },
      onSelect: async (item) => {
        const client = this.deps.client!;
        const st = (await client.request<any>("qq_status", {})) as Record<string, any>;
        const version = Number(st.configVersion ?? 0);
        switch (item.value) {
          case "toggle": {
            await client.request("qq_set_enabled", { enabled: !st.enabled, expected_version: version });
            this.notify(st.enabled ? "QQ 入口已停用" : "QQ 入口已启用");
            return this.refresh();
          }
          case "configure": {
            const endpoint = await this.inputBox("OneBot 端点", { initial: typeof st.endpoint === "string" ? st.endpoint : "", placeholder: "ws://127.0.0.1:3001" });
            if (endpoint === null) return;
            const selfId = await this.inputBox("登录号（QQ 号）", { initial: typeof st.selfId === "string" ? st.selfId : st.selfId ? String(st.selfId) : "" });
            if (selfId === null) return;
            const credential = await this.inputBox("token 凭据引用（留空 = 保持不变，输入 - = 清除）", {});
            if (credential === null) return;
            const maxChars = await this.inputBox("回复长度上限（整数，留空 = 默认）", {});
            if (maxChars === null) return;
            if (maxChars.trim() && (!/^\d+$/.test(maxChars.trim()) || Number(maxChars.trim()) <= 0)) {
              this.notify("回复上限必须是正整数", "red");
              return;
            }
            await client.request("qq_configure", {
              endpoint: endpoint.trim(),
              self_id: selfId.trim(),
              credential: credential.trim() === "" ? undefined : credential.trim() === "-" ? null : credential.trim(),
              max_reply_chars: maxChars.trim() ? Number(maxChars.trim()) : undefined,
              expected_version: version,
            });
            this.notify("QQ 配置已保存");
            return this.refresh();
          }
          case "groups":
            return this.pushScreen(this.qqGroupsScreen());
          case "owner": {
            const owner = await this.inputBox("拥有者 QQ 号（留空 = 关闭私聊）", { initial: st.ownerUserId ?? "" });
            if (owner === null) return;
            await client.request("qq_configure", {
              endpoint: st.endpoint,
              self_id: st.selfId,
              owner_user_id: owner.trim() || null,
              expected_version: version,
            });
            this.notify(owner.trim() ? "拥有者私聊已绑定" : "拥有者私聊已关闭");
            return this.refresh();
          }
        }
      },
    };
  }

  private qqGroupsScreen(): Screen {
    return {
      id: "groups",
      title: "QQ 允许群",
      watch: (t) => t === "qq.config_changed",
      load: async () => {
        const st = (await this.deps.client!.request<any>("qq_status", {})) as Record<string, any>;
        const groups = Array.isArray(st.groups) ? (st.groups as string[]) : [];
        const items: SelectItem[] = groups.map((g) => ({ value: `group:${g}`, label: String(g), description: "Enter 移出允许列表" }));
        items.push({ value: "add", label: "添加允许群" });
        return items;
      },
      onSelect: async (item) => {
        const client = this.deps.client!;
        const version = Number(((await client.request<any>("qq_status", {})) as Record<string, any>).configVersion ?? 0);
        if (item.value === "add") {
          const gid = await this.inputBox("群号（数字）", {});
          if (gid === null) return;
          if (!/^\d{4,20}$/.test(gid.trim())) {
            this.notify("群号必须是 4-20 位数字", "red");
            return;
          }
          await client.request("qq_group_update", { group_id: gid.trim(), allow: true, expected_version: version });
          this.notify("群已加入允许列表");
          return this.refresh();
        }
        if (item.value.startsWith("group:")) {
          const gid = item.value.slice(6);
          if (!(await this.confirm(`将群 ${gid} 移出允许列表？`, "该群的排队/运行任务将按取消处理"))) return;
          await client.request("qq_group_update", { group_id: gid, allow: false, expected_version: version });
          this.notify("群已移除");
          return this.refresh();
        }
      },
    };
  }

  // ---------- 服务凭据 ----------

  private credentialsScreen(): Screen {
    return {
      id: "credentials",
      title: "服务凭据",
      load: async () => {
        const list = (await this.deps.client!.request<any>("list_credentials", {})) as Array<{ name: string; host: string; header: string; purpose: string }>;
        const items: SelectItem[] = list.map((b) => ({
          value: `cred:${b.name}`,
          label: b.name,
          description: `${b.host} · ${b.header} · ${b.purpose} · Enter 删除`,
        }));
        items.push({ value: "add", label: "新增凭据", description: "秘密值遮蔽输入，永不回显" });
        return items;
      },
      onSelect: async (item) => {
        const client = this.deps.client!;
        if (item.value === "add") {
          const name = await this.inputBox("凭据名称", {});
          if (name === null) return;
          const host = await this.inputBox("主机（request 域名匹配，如 api.github.com）", {});
          if (host === null) return;
          const header = await this.inputBox("请求头名", { initial: "authorization" });
          if (header === null) return;
          const purpose = await this.inputBox("用途", { placeholder: "如 mcp / qq_onebot / jev_context" });
          if (purpose === null) return;
          const secret = await this.maskedBox(`凭据 ${name.trim()} 的秘密值`);
          if (secret === null) return;
          await client.request("add_credential", {
            name: name.trim(),
            host: host.trim(),
            header: header.trim(),
            purpose: purpose.trim(),
            secret,
          });
          this.notify("凭据已保存（值不回显）");
          return this.refresh();
        }
        if (item.value.startsWith("cred:")) {
          const name = item.value.slice(5);
          if (!(await this.confirm(`删除凭据 ${name}？`, "引用它的 MCP/QQ/Jev 配置将失去认证"))) return;
          await client.request("remove_credential", { name });
          this.notify("凭据已删除");
          return this.refresh();
        }
      },
    };
  }

  // ---------- 通用展示 ----------

  /** 只读文本覆盖层（连接检查结果等）；Esc/q 关闭。 */
  private showText(title: string, lines: string[]): void {
    const box = new OverlayBox([{ component: new Text(`${bold(title)}\n${lines.join("\n")}\n\n${dim("Esc 关闭")}`, 1, 0), grow: 1 }]);
    const handle = this.openOverlay(box, "80%");
    box.onKey = (data) => {
      if (data === "\x1b" || data === "q") handle.hide();
    };
  }
}

/**
 * 解析 "k=v" 逗号列表；空串 → {}；格式错误 → null。
 */
function parseKeyValueList(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const entry of text.split(/[\n,，]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) return null;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

/** 允许列表展示：read 类工具用裸名（与 CLI 输入约定一致）。 */
function formatAllowlist(entries: Array<string | { name: string; effect: string }>): string {
  return entries.map((e) => (typeof e === "string" ? e : e.effect === "read" ? e.name : `${e.name}:${e.effect}`)).join(", ");
}

/**
 * 解析工具允许列表：name = 只读；name:write / name:unknown 标注副作用类别。
 */
function parseAllowlist(text: string): Array<{ name: string; effect: string }> | null {
  const out: Array<{ name: string; effect: string }> = [];
  for (const entry of text.split(/[\n,，]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(":");
    if (idx === -1) {
      out.push({ name: trimmed, effect: "read" });
      continue;
    }
    const effect = trimmed.slice(idx + 1).trim();
    if (!["read", "write", "unknown"].includes(effect)) return null;
    out.push({ name: trimmed.slice(0, idx).trim(), effect });
  }
  return out;
}
