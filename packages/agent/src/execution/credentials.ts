/**
 * 拥有者预配置的凭据绑定（服务凭据，独立于任务与模型凭据保护）。
 *
 * - 绑定 = 名称 + 目标主机 + 注入头 + 用途 + 秘密值；
 * - 秘密只存在 <agentDir>/credentials.json（0700 目录、0600 文件，后台保管；完全访问与后台同账户，可经文件系统读取）；审批展示与事件只含名称与用途，不含值；
 * - 模型只能按名称引用；执行器校验请求目标主机与绑定主机一致后才注入，
 *   凭据不会被转发到其他地址，不通过 HTTP 工具返回凭据值。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CredentialBinding {
  name: string;
  /** 允许注入的目标主机（URL host，小写比较）。 */
  host: string;
  /** 注入的请求头名（如 Authorization）。 */
  header: string;
  purpose: string;
  /** 秘密值；任何展示/日志路径都不得包含。 */
  secret: string;
  /**
   * 可选使用范围（issue 06 引入，issue 16/17 后由 MCP 等通用入口使用）：
   * 限定项目 / 仓库 / 操作类别。
   * 设置后，通用 http_request 不得借用该凭据（防止同名凭据绕过专用边界）；
   * 仅匹配全部限定条件的调用方可注入。
   */
  scope?: {
    projectId?: string;
    /** 核实的远端仓库/资源 ID（如 GitHub repository ID）。 */
    repoId?: number;
    /** 允许的操作类别（如 "mcp" / 历史遗留的 "github_read" / "github_publish"）。 */
    operations?: string[];
  };
}

export interface CredentialBindingView {
  name: string;
  host: string;
  header: string;
  purpose: string;
}

interface CredentialsFile {
  bindings: CredentialBinding[];
}

export class CredentialStore {
  private readonly file: string;
  private cache: CredentialsFile | null = null;

  constructor(private readonly agentDir: string) {
    this.file = path.join(agentDir, "credentials.json");
  }

  private load(): CredentialsFile {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")) as CredentialsFile;
    } catch {
      this.cache = { bindings: [] };
    }
    return this.cache;
  }

  private save(): void {
    fs.mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(this.load(), null, 2), { mode: 0o600 });
  }

  /** 展示视图（无秘密值）。 */
  list(): CredentialBindingView[] {
    return this.load().bindings.map(({ name, host, header, purpose }) => ({ name, host, header, purpose }));
  }

  get(name: string): CredentialBinding | null {
    return this.load().bindings.find((b) => b.name === name) ?? null;
  }

  /**
   * 按名称取凭据并核对使用范围：带 scope 的绑定仅允许匹配全部限定条件的调用；
   * 通用 http_request（无 scope 上下文）一律不得使用带 scope 的凭据。
   */
  getForUse(
    name: string,
    use?: { projectId?: string; repoId?: number; operation?: string },
  ): CredentialBinding | null {
    const binding = this.get(name);
    if (!binding) return null;
    if (!binding.scope) return binding;
    if (!use) return null;
    const s = binding.scope;
    if (s.projectId !== undefined && s.projectId !== use.projectId) return null;
    if (s.repoId !== undefined && s.repoId !== use.repoId) return null;
    if (s.operations !== undefined && (use.operation === undefined || !s.operations.includes(use.operation))) return null;
    return binding;
  }

  upsert(binding: CredentialBinding): void {
    const data = this.load();
    const idx = data.bindings.findIndex((b) => b.name === binding.name);
    if (idx >= 0) data.bindings[idx] = binding;
    else data.bindings.push(binding);
    this.save();
  }

  remove(name: string): boolean {
    const data = this.load();
    const idx = data.bindings.findIndex((b) => b.name === name);
    if (idx === -1) return false;
    data.bindings.splice(idx, 1);
    this.save();
    return true;
  }
}
