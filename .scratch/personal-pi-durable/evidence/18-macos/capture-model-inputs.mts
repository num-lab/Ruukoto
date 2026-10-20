import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const output = process.argv[3];
const { MockModelServer } = await import(pathToFileURL(path.join(root, 'test/helpers/mock-provider.ts')).href);
const { openPersonalHarness } = await import(pathToFileURL(path.join(root, 'apps/ruukoto/src/personal-harness.ts')).href);
const { personalProvider } = await import(pathToFileURL(path.join(root, 'apps/ruukoto/src/personal-model.ts')).href);
const directory = fs.mkdtempSync(path.join(tmpdir(), 'rk-18-model-'));
const server = new MockModelServer(() => ({ kind: 'text', text: '完成' }));
process.env.RUUKOTO_18_CAPTURE_KEY = 'test-only';
const config = { api: 'openai-completions', baseUrl: await server.start(), modelId: 'mock-model', apiKeyEnv: 'RUUKOTO_18_CAPTURE_KEY', contextWindow: 128000, maxTokens: 1024 };
let p;
try {
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, service: { helperPath: '/tmp/rk-18-unused-helper', policyPath: '/tmp/rk-18-unused-policy', sudoPath: '/usr/bin/sudo', useSudo: false } });
  await p.answer('拥有者来源', 'source');
  const ref = await p.work.delegate({ requestId: 'capture', sourceRequestId: 'source', content: '独立分析' });
  while ((await p.work.status(ref)).task.state.status !== 'terminal') await new Promise(resolve => setTimeout(resolve, 5));
  const values = server.calls.map(request => ({ payload: request.raw, estimates: { toolSchemas: Math.ceil(JSON.stringify(request.tools ?? []).length / 4), systemPrompt: Math.ceil((request.system?.length ?? 0) / 4) } }));
  fs.writeFileSync(output, JSON.stringify({ main: values[0], child: values[1] }, null, 2) + '\n');
} finally { await p?.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
