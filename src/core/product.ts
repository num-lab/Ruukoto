/**
 * 产品身份（agent-direction issue 01，ADR 0017）：ruukoto（个人 Agent，Linux 服务器、
 * IM 入口与个人调度）与 ruukoto-code（Coding Agent，开发机器、TUI 入口）共用一份代码，
 * 以兼容扩展方式区分：
 * - 产品身份只经 RUUKOTO_PRODUCT 注入（对应 bin 入口固定赋值），缺省 ruukoto，
 *   旧部署与旧记录零改动；
 * - 数据目录归属经 meta 键 product.type 首次启动登记（Runtime 启动时核对，跨产品复用
 *   同一数据目录直接拒绝）；
 * - 路径环境变量按产品隔离：ruukoto 读 RUUKOTO_*_DIR，ruukoto-code 只读
 *   RUUKOTO_CODE_*_DIR，同机并存不串用；
 * - 日常档案与开发本项目的档案隔离：npm run dev 使用 ~/.ruukoto-dev，
 *   npm run code 使用 ~/.ruukoto-code-dev。
 */

import * as os from "node:os";
import * as path from "node:path";

export const PRODUCT_TYPES = ["ruukoto", "ruukoto-code"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** 数据目录归属登记的 meta 键（旧库缺省无此键，首次启动按当前产品补记）。 */
export const PRODUCT_META_KEY = "product.type";

/** 解析产品身份：未设置/空串默认 ruukoto；非法取值直接报错，不静默落到错误产品。 */
export function productFromEnv(env: NodeJS.ProcessEnv = process.env): ProductType {
  const raw = env.RUUKOTO_PRODUCT;
  if (raw === undefined || raw === "") return "ruukoto";
  if ((PRODUCT_TYPES as readonly string[]).includes(raw)) return raw as ProductType;
  throw new Error(`RUUKOTO_PRODUCT 取值无效：${raw}（${PRODUCT_TYPES.join(" | ")}）`);
}

/** 产品档案根目录。homeDir 参数供测试注入；生产取 os.homedir()。 */
export function productRootDir(product: ProductType, homeDir: string = os.homedir()): string {
  return path.join(homeDir, product === "ruukoto" ? ".ruukoto" : ".ruukoto-code");
}

/** 路径环境变量名前缀按产品隔离：ruukoto 用 RUUKOTO_*_DIR，ruukoto-code 用 RUUKOTO_CODE_*_DIR。 */
export function dirEnvFor(
  product: ProductType,
  kind: "DATA" | "AGENT" | "CONTROL" | "PENDING",
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[`${product === "ruukoto" ? "RUUKOTO" : "RUUKOTO_CODE"}_${kind}_DIR`];
}
