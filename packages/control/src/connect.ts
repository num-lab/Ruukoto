/**
 * 客户端连接配置：CLI 与 TUI 共用的 socket 路径与拥有者令牌解析。
 * Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
 *
 * 令牌来源优先级（不进入命令行参数、日志与待确认记录）：
 * 1. RUUKOTO_OWNER_TOKEN 环境变量；
 * 2. RUUKOTO_OWNER_TOKEN_FILE 指定的令牌文件（拥有者与后台不同 UID 的
 *    部署：配置步骤把令牌复制到拥有者可读的位置，由此指向该路径）；
 * 3. 控制面目录的 owner.token（同一账户部署的默认）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dirEnvFor, productFromEnv, productRootDir, type ProductType } from "@ruukoto/core/product.ts";
import { readOwnerToken } from "./owner-token.ts";

export interface ClientConnectConfig {
  socketPath: string;
  controlDir: string;
  token: string;
}

export function defaultDataDir(product: ProductType = productFromEnv()): string {
  return dirEnvFor(product, "DATA") ?? path.join(productRootDir(product), "data");
}

export function defaultAgentDir(product: ProductType = productFromEnv()): string {
  return dirEnvFor(product, "AGENT") ?? path.join(productRootDir(product), "agent");
}

/** 控制面目录：与运行时默认一致（数据目录的兄弟目录 control/）；按产品读对应的环境变量。 */
export function controlDirFor(dataDir: string, product: ProductType = productFromEnv()): string {
  return dirEnvFor(product, "CONTROL") ?? path.join(path.dirname(path.resolve(dataDir)), "control");
}

export function socketPathFor(controlDir: string): string {
  return path.join(controlDir, "control.sock");
}

/** 解析拥有者令牌；失败时抛出含修复指引的错误。 */
export function resolveOwnerToken(controlDir: string): string {
  const fromEnv = process.env.RUUKOTO_OWNER_TOKEN;
  if (fromEnv && fromEnv.trim().length >= 32) return fromEnv.trim();
  const tokenFile = process.env.RUUKOTO_OWNER_TOKEN_FILE;
  if (tokenFile) {
    try {
      const token = fs.readFileSync(tokenFile, "utf8").trim();
      if (token.length >= 32) return token;
    } catch (err) {
      throw new Error(`无法读取拥有者令牌文件 ${tokenFile}：${(err as Error).message}`);
    }
    throw new Error(`拥有者令牌文件 ${tokenFile} 内容无效（至少需要 32 字符）`);
  }
  const fromFile = readOwnerToken(controlDir);
  if (fromFile) return fromFile;
  throw new Error(
    `无法读取拥有者令牌：${path.join(controlDir, "owner.token")} 不存在或不可读；` +
      "也可用 RUUKOTO_OWNER_TOKEN 或 RUUKOTO_OWNER_TOKEN_FILE 指定",
  );
}

/** 探测用宽松解析：同一来源优先级，但取不到（后台尚未启动、令牌未生成）返回 null 而非抛错。 */
export function tryResolveOwnerToken(controlDir: string): string | null {
  try {
    return resolveOwnerToken(controlDir);
  } catch {
    return null;
  }
}

export function resolveClientConfig(opts: { dataDir?: string; controlDir?: string } = {}): ClientConnectConfig {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const controlDir = opts.controlDir ?? controlDirFor(dataDir);
  return {
    socketPath: socketPathFor(controlDir),
    controlDir,
    token: resolveOwnerToken(controlDir),
  };
}
