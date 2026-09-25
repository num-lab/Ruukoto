import type { Store } from "../core/store.ts";

export const JEV_CREDENTIAL_PURPOSE = "jev_context";
export const JEV_HOST = "api.typesafe.ai";

/** 仅允许测试覆盖为回环服务，生产固定官方主机。 */
export function jevCredentialHost(baseUrl?: string): string {
  if (baseUrl === undefined) return JEV_HOST;
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error("Jev 测试目标必须是无认证信息的回环 HTTP(S) 地址"), { code: "invalid_params" });
  }
  return url.host;
}

export interface JevConfig {
  enabled: boolean;
  credential: string | null;
  configVersion: number;
}

export function jevConfigKey(projectId: string): string {
  return `jev.project.${projectId}`;
}

/** 缺省关闭；损坏配置拒绝使用，不能把无法核实的持久授权当作已启用。 */
export function getProjectJevConfig(store: Store, projectId: string): JevConfig {
  const raw = store.getMetaValue(jevConfigKey(projectId));
  if (raw === null) return { enabled: false, credential: null, configVersion: 0 };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const config = value as Record<string, unknown>;
    if (Object.keys(config).some((key) => !["enabled", "credential", "configVersion"].includes(key)) ||
        typeof config.enabled !== "boolean" ||
        !(config.credential === null || (typeof config.credential === "string" && config.credential.trim().length > 0)) ||
        !Number.isSafeInteger(config.configVersion) || (config.configVersion as number) < 0 ||
        (config.enabled && config.credential === null)) throw new Error();
    return { enabled: config.enabled, credential: config.credential as string | null, configVersion: config.configVersion as number };
  } catch {
    throw Object.assign(new Error("Jev 实验配置损坏，已拒绝使用"), { code: "invalid_jev_config" });
  }
}
