#!/usr/bin/env node
// Coding Agent 产品入口：与 ruukoto 同一 CLI，
// 产品身份由入口固定注入——不读取外部环境中的 RUUKOTO_PRODUCT，避免落到错误产品。
// Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
process.env.RUUKOTO_PRODUCT = "ruukoto-code";
import { register } from "tsx/esm/api";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";
register();
await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")).href);
