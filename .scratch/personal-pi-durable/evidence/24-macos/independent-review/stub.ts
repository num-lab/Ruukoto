import { PassThrough, Writable } from "node:stream"; import * as fs from "node:fs"; import * as path from "node:path";
let failStop = false; export function failStops(value: boolean) { failStop = value; }
export class ExecutionError extends Error {}
export type LinuxExecutionRef = { executionId: string; machineId: string };
export type LaunchedUnit = any;
export type LaunchSpec = any;
export async function stopLinuxExecution(directory: string, ref: LinuxExecutionRef) { fs.mkdirSync(path.join(directory,ref.executionId,"stop-requested"),{recursive:true,mode:0o700}); return { ref, exited: !failStop }; }
export async function launchLinuxExecution(directory: string, ref: LinuxExecutionRef) { fs.mkdirSync(path.join(directory,ref.executionId),{mode:0o700});
 const stdout = new PassThrough(), stderr = new PassThrough(); let resolveExit: (v: object) => void;
 const exit = new Promise(resolve => { resolveExit = resolve; }); let data = "";
 const stdin = new Writable({ write(chunk, _encoding, done) { data += chunk; done(); }, final(done) {
   const command = JSON.parse(data).command; done();
   setTimeout(() => { stdout.end(command); stderr.end(); resolveExit({code:0,signal:null}); }, command === "slow" ? 200 : 5);
 }});
 return { stdin, stdout, stderr, exit };
}
