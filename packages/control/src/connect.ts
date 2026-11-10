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
import { verifyProfile, type ProfilePaths } from "@ruukoto/core/profile.ts";
import { readOwnerToken } from "./owner-token.ts";

export interface ClientConnectConfig {
  profile: ProfilePaths;
  socketPath: string;
  controlDir: string;
  token: string;
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

export function resolveClientConfig(profile: ProfilePaths): ClientConnectConfig {
  verifyProfile(profile);
  return {
    profile,
    socketPath: profile.socketPath,
    controlDir: profile.controlDir,
    token: resolveOwnerToken(profile.controlDir),
  };
}
