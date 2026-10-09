import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["**/node_modules/**", ".agents/**", ".scratch/**", "worker/**", "verification/archive/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // 清理循环和控制字符过滤是既有行为；保留这些检查的明确例外。
      "no-constant-condition": ["error", { checkLoops: "none" }],
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 原因链、弃用赋值和排版整理另成批，首轮不重写既有错误与声明。
      "preserve-caught-error": "off",
      "no-useless-assignment": "off",
      "no-useless-catch": "off",
      "prefer-const": "off",
      "no-regex-spaces": "off",
      "no-unused-vars": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.mts"],
    rules: {
      // 现有 SDK/协议边界广泛使用 any；首轮保留类型与 API 兼容，不做全库类型重写。
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  { files: ["docs/visual/*.js"], languageOptions: { globals: globals.browser } },
];
