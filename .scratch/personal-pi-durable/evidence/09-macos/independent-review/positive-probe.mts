import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openPersonalHarness } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-harness.ts';
import { personalProvider } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-model.ts';
import { savePersonalServices } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-service-config.ts';
import { MockModelServer } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/mock-provider.ts';
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const root = fs.mkdtempSync('/tmp/rk-service-review-');
const key = 'RK_INDEPENDENT_REVIEW_KEY';
process.env[key] = 'test';
Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
const service = { version: 1, helperPath: '/review/fixed-helper', policyPath: '/review/fixed-policy', sudoPath: '/review/fixed-sudo' };
let current;
const model = new MockModelServer(() => new Promise(() => {}));
try {
  const url = await model.start();
  const config = { api:'openai-completions', baseUrl:url, modelId:'mock-model', apiKeyEnv:key, contextWindow:128000, maxTokens:1024 };
  for (const operations of [false, true]) {
    const directory = path.join(root, operations ? 'full' : 'inspect-only');
    const options = { directory, provider:personalProvider(config), modelId:config.modelId, service: { ...service, useSudo:true }, serviceOperations:operations };
    const count = model.calls.length;
    current = await openPersonalHarness(options);
    await current.submit('挂起用于独立配置反例', 'review-input');
    while (model.calls.length === count) await delay(5);
    await current.close(); current = undefined;
    if (operations) {
      await savePersonalServices(directory, service);
      assert.equal(fs.existsSync(path.join(directory, 'service.json')), true);
    } else {
      await assert.rejects(savePersonalServices(directory, service), error => error.code === 'service_config_pending');
      assert.equal(fs.existsSync(path.join(directory, 'service.json')), false);
      current = await openPersonalHarness(options);
      assert.equal(current.service, undefined);
      await current.close(); current = undefined;
    }
  }
  process.stdout.write('Independent probes 2/2 passed: inspect-only pending refuses file; fully enabled pending permits missing-file restoration. Platform mocked to Linux; no helper invoked.\n');
} finally {
  await current?.close();
  await model.close();
  Object.defineProperty(process, 'platform', platform);
  delete process.env[key];
  fs.rmSync(root, { recursive:true, force:true });
}
