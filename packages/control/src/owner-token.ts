/**
 * 拥有者认证令牌：仅拥有者客户端与后台可读的随机令牌。
 *
 * - 后台启动时确保控制面目录存在，令牌缺失则生成（32 字节随机 hex），
 *   文件 0600；已存在则复用（拥有者客户端凭同一令牌认证）；
 * - 令牌不放在命令行、工具环境或日志中；来源只有控制面文件与环境变量
 *   （拥有者客户端自行选择，后台只校验）；
 * - 认证成功前不返回快照、不执行任何请求；
 * - 多用户 Linux 部署时由配置步骤把令牌放入拥有者可读的位置（0400，
 *   属主为拥有者），控制面目录对拥有者开放连接权限。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_FILE_NAME = "owner.token";

export function ensureOwnerToken(controlDir: string): string {
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o770 });
  const file = path.join(controlDir, TOKEN_FILE_NAME);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 不存在则生成
  }
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function readOwnerToken(controlDir: string): string | null {
  try {
    const token = fs.readFileSync(path.join(controlDir, TOKEN_FILE_NAME), "utf8").trim();
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

/** 常数时间比较，避免时序侧信道。 */
export function tokenMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // 长度不同直接否决；仍执行一次比较以保持时间形态
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
