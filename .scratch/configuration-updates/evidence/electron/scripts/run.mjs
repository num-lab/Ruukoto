import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron } from '/Users/eitrous/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import { startFixture } from './fixture.mjs';

if (!process.argv.includes('--run')) { process.stdout.write('Prepared isolated Electron review. Add --run only after the reviewed desktop build is ready.\n'); process.exit(0); }
const repository = '/Users/eitrous/Developer/ruukoto', root = fs.mkdtempSync('/tmp/rk-egui-');
const output = path.join(root, 'output/playwright'); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const userData = path.join(root, 'app-data/Ruukoto Development'); fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(root, 'fixture-storage.key'), randomBytes(32), { mode: 0o600 });
const fixture = await startFixture(root);
fs.writeFileSync(path.join(userData, 'personal-remote.json'), JSON.stringify({ v: 1, origin: fixture.origin }) + '\n', { mode: 0o600 });
const require = createRequire(path.join(repository, 'apps/desktop/package.json'));
const checks = [], errors = [];
let app, page;
const wait = async (check, label) => { const deadline = Date.now() + 10000; while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 30)); } };
const capture = async label => { await page.getByRole('heading', { name: '保存更改？', exact: true }).waitFor({ state: 'hidden' }); const text = await page.locator('body').innerText(); fs.writeFileSync(path.join(output, label + '.txt'), text); await page.screenshot({ path: path.join(output, label + '.png'), fullPage: true, animations: 'disabled' }); fs.writeFileSync(path.join(output, label + '.personal.json'), JSON.stringify(await page.evaluate(() => window.__reviewPersonal ?? []), null, 2)); return text; };
const choose = async category => { await page.getByRole('tab', { name: category, exact: true }).click(); const target = page.getByRole('tab', { name: 'PA', exact: true }); if (await target.count() && await target.getAttribute('aria-selected') !== 'true') await target.click(); };
const saveModel = async id => { await page.locator('#pa-modelId').fill(id); await page.getByRole('button', { name: '查看保存影响', exact: true }).click(); await page.getByRole('heading', { name: '保存更改？', exact: true }).waitFor(); await page.getByRole('button', { name: '保存更改', exact: true }).click(); };
try {
  app = await _electron.launch({ executablePath: require('electron'), args: ['/tmp/ruukoto-electron-review/bootstrap.mjs'], cwd: repository, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ELECTRON_|^NODE_/.test(key))), RUUKOTO_GUI_REVIEW_ROOT: root }, timeout: 20000 });
  page = await app.firstWindow({ timeout: 20000 }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluate(() => { window.__reviewPersonal = []; window.ruukoto.subscribe('personal', update => window.__reviewPersonal.push(update)); });
  await page.getByRole('button', { name: '设置', exact: true }).waitFor(); await capture('01-startup');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: 'PA 远程连接', exact: true }).click();
  await page.getByRole('button', { name: '编辑配对', exact: true }).click();
  await page.getByLabel('此桌面的名称', { exact: true }).fill('Isolated GUI Review');
  await page.getByLabel('服务器配对码', { exact: true }).fill('ABCDEFGHIJKL');
  await page.getByRole('button', { name: '配对并连接', exact: true }).click();
  await page.getByText('已配对', { exact: true }).waitFor(); checks.push('real Electron Host/bridge over authenticated HTTPS, with isolated test credential storage');
  await choose('模型'); await page.locator('#pa-modelId').waitFor(); assert.equal(await page.locator('#pa-modelId').inputValue(), 'gui-initial');
  await page.locator('#pa-modelId').fill('gui-unsaved'); await page.getByRole('tab', { name: 'Skills', exact: true }).click();
  await page.getByRole('heading', { name: '保留未保存的更改？', exact: true }).waitFor(); await page.getByRole('button', { name: '继续编辑', exact: true }).click(); assert.equal(await page.locator('#pa-modelId').inputValue(), 'gui-unsaved');
  await page.getByRole('tab', { name: 'Skills', exact: true }).click(); await page.getByRole('button', { name: '放弃更改', exact: true }).click(); await choose('模型');
  assert.equal(await page.locator('#pa-modelId').inputValue(), 'gui-initial'); checks.push('draft retained on continue editing and discarded only by explicit action');
  await saveModel('gui-online'); await wait(() => fixture.state.writes === 1, 'online save'); await page.getByRole('heading', { name: '保存更改？', exact: true }).waitFor({ state: 'hidden' }); await capture('02-online-save');
  assert.equal(fixture.state.model.modelId, 'gui-online'); checks.push('online model save with absent model credential and development lifecycle');
  fixture.state.drop = true; await saveModel('gui-lost-reply'); await wait(() => fixture.state.writes === 2, 'lost reply admission');
  await page.getByRole('button', { name: '核实原配置与服务', exact: true }).waitFor(); await capture('03-lost-reply'); await page.getByRole('button', { name: '核实原配置与服务', exact: true }).click();
  await page.getByRole('button', { name: '重新读取远端配置', exact: true }).waitFor(); assert.equal(fixture.state.writes, 2); assert.equal(await page.locator('#pa-modelId').inputValue(), 'gui-lost-reply'); checks.push('lost save reply reconciles original receipt without second POST');
  if (await page.getByRole('button', { name: '放弃更改', exact: true }).isEnabled()) await page.getByRole('button', { name: '放弃更改', exact: true }).click();
  fixture.state.online = false; await page.getByRole('button', { name: '重新读取远端配置', exact: true }).click(); await wait(async () => (await page.locator('.personal-settings').innerText()).includes('离线'), 'offline settings');
  await saveModel('gui-offline'); await wait(() => fixture.state.writes === 3, 'offline save'); await capture('04-offline-save'); assert.equal([...fixture.receipts.values()].at(-1).status, 'saved'); checks.push('offline model save reports saved without starting backend');
  fixture.state.online = true; for (const receipt of fixture.receipts.values()) { receipt.status = 'active'; receipt.effectiveRevision = receipt.savedRevision; }
  await page.getByRole('button', { name: '重新读取远端配置', exact: true }).click(); fixture.state.next = 'waiting'; await saveModel('gui-waiting'); await wait(() => fixture.state.writes === 4, 'waiting save');
  await page.getByText('模型配置 · 等待生效', { exact: true }).waitFor(); await capture('05-waiting-model');
  await choose('Skills'); await page.getByRole('button', { name: '选择远端技能库', exact: true }).click(); await page.getByRole('button', { name: '使用此技能库', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '查看保存影响', exact: true }).isEnabled(), true); await page.getByRole('button', { name: '查看保存影响', exact: true }).click(); await page.getByRole('button', { name: '保存更改', exact: true }).click(); await wait(() => fixture.state.writes === 5, 'independent skills save'); await capture('06-independent-skills'); checks.push('model waiting preserves a writable independent Skills page and save');
  for (const receipt of fixture.receipts.values()) { receipt.status = 'active'; receipt.effectiveRevision = receipt.savedRevision; } fixture.state.fileIssue = true;
  await choose('模型'); await page.getByText('配置文件与原保存记录不符。请保留档案并核实当前文件，恢复原文件后重新读取；其他配置仍可管理。', { exact: true }).waitFor(); await capture('07-model-file-issue');
  await choose('Skills'); assert.equal(await page.getByRole('button', { name: '选择远端技能库', exact: true }).isEnabled(), true); checks.push('file integrity issue is visible and restricts only its target');
  fixture.state.fileIssue = false; await choose('模型'); assert.equal(await page.locator('#pa-modelId').inputValue(), 'gui-waiting'); assert.equal(await page.locator('#pa-modelId').isEnabled(), true); assert.equal(fixture.state.writes, 5); checks.push('repaired file is unsealed by refresh without a new save');
  await capture('08-repaired-model');
  fixture.state.next = 'failed'; await saveModel('gui-failed'); await wait(() => fixture.state.writes === 6, 'failed publication receipt'); await page.getByText('模型配置 · 生效失败', { exact: true }).waitFor(); await capture('09-publication-failed'); checks.push('saved but failed publication is shown as failed with original receipt action');
  await choose('MCP'); await page.getByRole('button', { name: /坏凭据服务/ }).click(); await page.getByRole('button', { name: '停用', exact: true }).click(); await page.getByRole('heading', { name: '保存更改？', exact: true }).waitFor(); await page.getByRole('button', { name: '保存更改', exact: true }).click(); await wait(() => fixture.state.writes === 7, 'disable bad credential service'); assert.equal(fixture.state.mcp.services[0].enabled, false); assert.equal(fs.existsSync(path.join(root, 'absent-mcp-key')), false); await page.getByText('凭据缺失 · 1 个允许工具', { exact: true }).waitFor(); await capture('10-disabled-bad-mcp'); checks.push('bad credential MCP service can be disabled through the real UI without discovery or model request');
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ root, checks, pageErrors: errors }, null, 2) + '\n');
} catch (error) { errors.push(String(error.stack || error)); if (page) await capture('failure').catch(() => {}); process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; }
finally {
  if (app) await app.close().catch(error => errors.push(String(error)));
  await fixture.close();
  const fingerprints = {}; for (const f of ['apps/desktop/out/main/bootstrap.js', 'apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs']) fingerprints[f] = createHash('sha256').update(fs.readFileSync(path.join(repository, f))).digest('hex');
  fs.writeFileSync(path.join(root, 'review-result.json'), JSON.stringify({ status: process.exitCode || errors.length ? 'failed' : 'passed', checks, errors, fixture: 'mock HTTPS remote; test credential storage; no real Keychain/model/IM/deployment', fingerprints }, null, 2));
  process.stdout.write('Evidence directory: ' + root + '\n');
}
