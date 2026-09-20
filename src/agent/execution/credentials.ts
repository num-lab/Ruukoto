/**
 * 拥有者预配置的凭据绑定（服务凭据，独立于任务与模型凭据保护）。
 *
 * - 绑定 = 名称 + 目标主机 + 注入头 + 用途 + 秘密值；
 * - 秘密只存在 <agentDir>/credentials.json（0700 目录、0600 文件，仅后台
 *   可读）；审批展示与事件只含名称与用途，不含值；
 * - 模型只能按名称引用；执行器校验请求目标主机与绑定主机一致后才注入，
 *   凭据不会被转发到其他地址，也不会把值交给项目进程。
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
