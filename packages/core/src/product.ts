// Note: See .agents/notes/implemented/architecture/2026-11-10-single-product.md
export const PRODUCT = "ruukoto" as const;
export type ProductType = typeof PRODUCT;
export const PRODUCT_META_KEY = "product.type";
