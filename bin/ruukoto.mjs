#!/usr/bin/env node
import { register } from "tsx/esm/api";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";
register();
await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")).href);
