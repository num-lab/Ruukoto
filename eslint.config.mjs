import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import workspaces from "./scripts/workspace-boundaries.mjs";

export default [
  { ignores: ["**/node_modules/**", ".agents/**", ".scratch/**", "worker/**", "dist/**", "apps/desktop/out/**", "verification/archive/**", "verification/desktop-demo/**", "verification/desktop-settings/**", "test/fixtures/desktop-baselines/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/src/**/*.{ts,mts,tsx,js,mjs}", "apps/*/src/**/*.{ts,mts,tsx,js,mjs}"],
    plugins: { workspaces },
    rules: { "workspaces/imports": "error" },
  },
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Preserve existing cleanup loops and control-character filtering.
      "no-constant-condition": ["error", { checkLoops: "none" }],
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Error-chain, assignment and formatting cleanup belongs in a separate change.
      "preserve-caught-error": "off",
      "no-useless-assignment": "off",
      "no-useless-catch": "off",
      "prefer-const": "off",
      "no-regex-spaces": "off",
      "no-unused-vars": "off",
    },
  },
  {
    files: ["apps/desktop/src/renderer/**", "apps/desktop/mygo/preload.js"],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*", "electron"] }],
      "no-restricted-globals": ["error", "Buffer", "process", "global", "require", "__dirname", "__filename"],
    },
  },
  {
    files: ["packages/view/src/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "Buffer", "process", "global", "require", "__dirname", "__filename", "setImmediate"],
    },
  },
  {
    files: ["**/*.ts", "**/*.mts", "**/*.tsx"],
    rules: {
      // Existing SDK/protocol boundaries use any; this configuration preserves their API compatibility.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
