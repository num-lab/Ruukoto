/** 当前命名文件与不可变内容版本分开；读写失败不回退到其他版本。
 * Note: 见 .agents/notes/implemented/feature/2026-10-13-workflow-library-and-controls.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "@ruukoto/core/store.ts";
import { getWorkflowDefinition, getWorkflowDefinitionRef, listWorkflowDefinitionVersions, rememberWorkflowDefinition, saveWorkflowDefinition,
  workflowDigest, workflowName, WorkflowError, WORKFLOW_LIMITS, type WorkflowDefinition } from "@ruukoto/core/workflow.ts";
import { validateWorkflowScript } from "@ruukoto/agent/script-worker/validate.ts";

function io<T>(operation: () => T): T {
  try { return operation(); }
  catch (cause) { throw cause instanceof WorkflowError ? cause : new WorkflowError("definition_io_failed", { cause }); }
}

export class WorkflowLibrary {
  constructor(private readonly store: Store, private readonly agentDir: string) {}

  private root(create = false): string | null {
    const parent = io(() => fs.realpathSync(this.agentDir));
    const root = path.join(parent, "workflows");
    let stat = io(() => fs.lstatSync(root, { throwIfNoEntry: false }));
    if (!stat && create) { io(() => fs.mkdirSync(root, { mode: 0o700 })); stat = io(() => fs.lstatSync(root)); }
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory() || io(() => fs.realpathSync(root)) !== root) throw new WorkflowError("definition_path_unsafe");
    return root;
  }
  private read(name: string): string | null {
    workflowName(name);
    const root = this.root();
    if (!root) return null;
    const file = path.join(root, `${name}.js`);
    const stat = io(() => fs.lstatSync(file, { throwIfNoEntry: false }));
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new WorkflowError("definition_path_unsafe");
    if (stat.size === 0 || stat.size > WORKFLOW_LIMITS.scriptBytes) throw new WorkflowError("invalid_script");
    const fd = io(() => fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
    try {
      const opened = io(() => fs.fstatSync(fd));
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new WorkflowError("definition_changed");
      const bytes = Buffer.alloc(WORKFLOW_LIMITS.scriptBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = io(() => fs.readSync(fd, bytes, length, bytes.length - length, null));
        if (!count) break;
        length += count;
      }
      const after = io(() => fs.fstatSync(fd));
      if (length !== stat.size || after.mtimeMs !== stat.mtimeMs || this.root() !== root) throw new WorkflowError("definition_changed");
      let script: string;
      try { script = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
      catch (cause) { throw new WorkflowError("definition_invalid_utf8", { cause }); }
      return script;
    } finally { io(() => fs.closeSync(fd)); }
  }

  async load(name: string): Promise<WorkflowDefinition> {
    const script = this.read(name);
    if (script === null) throw new WorkflowError("definition_missing");
    await validateWorkflowScript(script);
    if (this.read(name) !== script) throw new WorkflowError("definition_changed");
    return this.store.withTx(() => {
      const definition = saveWorkflowDefinition(this.store, script);
      if (!getWorkflowDefinitionRef(this.store, `version:${name}:${definition.digest}`)) rememberWorkflowDefinition(this.store, name, definition);
      return definition;
    });
  }

  async list(offset = 0, limit = 50) {
    const root = this.root();
    const names = root ? io(() => fs.readdirSync(root)).filter(name => name.endsWith(".js")).sort() : [];
    const definitions: { name: string; id?: string; digest?: string; error?: string }[] = [];
    for (const file of names.slice(offset, offset + limit)) {
      const name = file.slice(0, -3);
      try { const definition = await this.load(name); definitions.push({ name, id: definition.id, digest: definition.digest }); }
      catch (error) {
        if (!(error instanceof WorkflowError)) throw error;
        definitions.push({ name, error: error.code });
      }
    }
    return { definitions, total: names.length, offset, nextOffset: offset + definitions.length < names.length ? offset + definitions.length : null };
  }
  versions(name: string, offset = 0, limit = 100) { return listWorkflowDefinitionVersions(this.store, workflowName(name), offset, limit); }
  version(id: string): WorkflowDefinition {
    const definition = getWorkflowDefinition(this.store, id);
    if (!definition || workflowDigest(definition.script) !== definition.digest) throw new WorkflowError("definition_missing");
    return definition;
  }
  saved(key: string) {
    const ref = getWorkflowDefinitionRef(this.store, `save:${key}`);
    return ref ? { name: ref.name, ...this.version(ref.definitionId), requestDigest: ref.requestDigest } : null;
  }

  async save(input: { name: string; script: string; expectedDigest: string | null; requestKey: string }, verify?: () => void) {
    workflowName(input.name);
    if (!input.requestKey || input.requestKey.length > 256 || (input.expectedDigest !== null && !/^[a-f0-9]{64}$/.test(input.expectedDigest))) throw new WorkflowError("invalid_params");
    const digest = workflowDigest({ name: input.name, script: input.script, expectedDigest: input.expectedDigest });
    const replay = () => {
      const old = this.saved(input.requestKey);
      if (old && old.requestDigest !== digest) throw new WorkflowError("request_conflict");
      return old;
    };
    const old = replay();
    if (old) return old;
    await validateWorkflowScript(input.script);
    const current = this.read(input.name);
    if (current !== null) await validateWorkflowScript(current);
    const raced = replay();
    if (raced) return raced;
    if (this.read(input.name) !== current) throw new WorkflowError("definition_changed");
    const currentDigest = current === null ? null : workflowDigest(current);
    if (currentDigest !== input.expectedDigest && current !== input.script) throw new WorkflowError("definition_version_conflict");
    verify?.();
    if (current !== null) this.store.withTx(() => rememberWorkflowDefinition(this.store, input.name, saveWorkflowDefinition(this.store, current)));
    const root = this.root(true)!;
    const temporary = path.join(root, `.${randomUUID()}.tmp`);
    const file = path.join(root, `${input.name}.js`);
    io(() => fs.writeFileSync(temporary, input.script, { flag: "wx", mode: 0o600 }));
    try {
      const fd = io(() => fs.openSync(temporary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW));
      try { io(() => fs.fsyncSync(fd)); }
      finally { io(() => fs.closeSync(fd)); }
      if (this.root() !== root || this.read(input.name) !== current) throw new WorkflowError("definition_changed");
      io(() => fs.renameSync(temporary, file));
      const directory = io(() => fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW));
      try { io(() => fs.fsyncSync(directory)); }
      finally { io(() => fs.closeSync(directory)); }
      if (this.read(input.name) !== input.script) throw new WorkflowError("definition_changed");
      return this.store.withTx(() => {
        const definition = saveWorkflowDefinition(this.store, input.script);
        rememberWorkflowDefinition(this.store, input.name, definition, { key: input.requestKey, digest });
        return { name: input.name, ...definition, requestDigest: digest };
      });
    } finally {
      // rename 成功后临时文件不存在；其他失败只清理本次创建的临时文件。
      io(() => fs.rmSync(temporary, { force: true }));
    }
  }
}
