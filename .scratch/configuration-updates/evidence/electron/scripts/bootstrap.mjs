import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const root = process.env.RUUKOTO_GUI_REVIEW_ROOT;
if (!root?.startsWith('/tmp/rk-egui-')) throw new Error('review_directory_required');
app.commandLine.appendSwitch('use-mock-keychain');
for (const key of Object.keys(process.env)) if (/^RUUKOTO_|^NODE_|^ELECTRON_/.test(key)) delete process.env[key];
Object.assign(process.env, { RUUKOTO_DESKTOP_MANAGED: '1', RUUKOTO_CODE_DATA_DIR: path.join(root, 'code/data'), RUUKOTO_CODE_AGENT_DIR: path.join(root, 'code/agent'), RUUKOTO_CODE_CONTROL_DIR: path.join(root, 'code/control') });
for (const [key, value] of [['appData', 'app-data'], ['userData', 'bootstrap-data'], ['sessionData', 'session-data'], ['logs', 'logs']]) { const directory = path.join(root, value); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); app.setPath(key, directory); }
const certificate = fs.readFileSync(path.join(root, 'test-ca.pem'), 'utf8');
https.globalAgent.options.ca = certificate;
if (typeof tls.setDefaultCACertificates !== 'function') throw new Error('test_tls_isolation_unavailable');
tls.setDefaultCACertificates([certificate]);
const key = fs.readFileSync(path.join(root, 'fixture-storage.key'));
const counters = { encrypt: 0, decrypt: 0 };
const methods = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => { counters.encrypt++; const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
  decryptStringAsync: async value => { counters.decrypt++; const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return { result: Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'), shouldReEncrypt: false }; },
};
for (const [name, value] of Object.entries(methods)) if (!Reflect.set(safeStorage, name, value) || safeStorage[name] !== value) throw new Error('test_storage_substitution_failed');
app.on('will-quit', () => fs.writeFileSync(path.join(root, 'electron-isolation.json'), JSON.stringify({ appData: app.getPath('appData'), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), logs: app.getPath('logs'), safeStorageSubstitute: true, counters }, null, 2)));
await import('/Users/eitrous/Developer/ruukoto/apps/desktop/out/main/bootstrap.js');
