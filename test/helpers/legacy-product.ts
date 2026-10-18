import type { RuntimeProduct } from "@ruukoto/runtime/runtime.ts";

// 旧格式库与共享 IM/恢复组合的测试装配，不是个人产品入口。
// Note: 见 .agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md
export const product: { runtime: RuntimeProduct } = {
  runtime: { type: "ruukoto", im: true, scheduler: true, serviceEnabled: () => false, toolFamilies: () => [] },
};
