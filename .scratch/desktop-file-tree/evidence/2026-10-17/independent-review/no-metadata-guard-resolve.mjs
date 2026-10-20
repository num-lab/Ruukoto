import { pathToFileURL } from 'node:url';
const original = pathToFileURL('/Users/eitrous/.codex/worktrees/6f13/ruukoto/packages/agent/src/execution/approved-ops.ts').href;
const replacement = new URL('./approved-ops-no-metadata-guard.mts', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  return result.url.split('?')[0] === original ? { ...result, url: replacement } : result;
}
