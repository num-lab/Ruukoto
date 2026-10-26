import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { personalCuaLinux } from './apps/ruukoto/src/personal-cua-linux.ts';
import { connectMcpStdio, type McpConnection } from './packages/agent/src/mcp/transport.ts';
const root = '/tmp/ruukoto-pi-mcp.r0wcnE';
const directory = path.join(root, 'native-cua');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const sent = path.join(directory, 'sent.jsonl'), definitions = path.join(directory, 'tools.json');
fs.writeFileSync(sent, '');
fs.writeFileSync(definitions, JSON.stringify([{ name: 'computer_screenshot', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]));
const host = personalCuaLinux();
const prepared = host.prepare({ command: process.execPath, args: [path.resolve('test/helpers/personal-cua-stdio-fixture.mjs'), sent, definitions], env: { PATH: process.env.PATH!, HOME: directory } });
let connection: McpConnection | undefined, execution: Awaited<ReturnType<typeof host.execution>> | undefined, stopped = false;
try {
  connection = await connectMcpStdio({ serviceId: 'linux-scope-probe', ...prepared.program }, { connectTimeoutMs: 10000, callTimeoutMs: 5000 });
  execution = await host.execution(prepared.scope, prepared.description);
  const before = fs.readFileSync(path.join(execution.group, 'cgroup.events'), 'utf8');
  const tool = (await connection.listTools()).find(tool => tool.name === 'computer_screenshot');
  assert.ok(tool);
  const result = await connection.callTool(tool, {});
  assert.equal(result.content?.[0]?.type, 'image');
  const records = fs.readFileSync(sent, 'utf8').trim().split('\n').map(row => JSON.parse(row));
  const business = records.filter(row => row.method === 'tools/call');
  assert.equal(business.length, 1);
  stopped = await host.stopCli(execution);
  assert.equal(stopped, true);
  await connection.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const groupExists = fs.existsSync(execution.group), serverPidExists = fs.existsSync(`/proc/${business[0].pid}`);
  assert.equal(groupExists, false);
  assert.equal(serverPidExists, false);
  const report = { node: process.version, platform: process.platform, actualScope: execution, before, screenshotFixture: true, businessCalls: business.length, serverPid: business[0].pid, stopped, groupExists, serverPidExists, pass: true };
  fs.writeFileSync(path.join(root, 'logs/native-cua-scope-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
} finally {
  if (execution && !stopped) await host.stopCli(execution);
  await connection?.close();
}
