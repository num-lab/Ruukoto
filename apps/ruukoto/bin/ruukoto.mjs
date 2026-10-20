#!/usr/bin/env node
// Note: 见 .agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md
process.env.RUUKOTO_PRODUCT = "ruukoto";
import { register } from "tsx/esm/api";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";
register();
await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/main.ts")).href);
