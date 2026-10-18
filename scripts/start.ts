import { productFromEnv } from "@ruukoto/core/product.ts";

if (productFromEnv() === "ruukoto-code") await import("../apps/ruukoto-code/src/main.ts");
else await import("../apps/ruukoto/src/main.ts");
