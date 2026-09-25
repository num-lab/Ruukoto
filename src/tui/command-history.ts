import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultPendingDir } from "../control/pending-requests.ts";
import type { CommandEntry } from "./event-flow.ts";

/** 客户端命令回显，与后台消息历史、待确认请求分别保存。 */
export class CommandHistoryStore {
  constructor(private readonly file = path.join(path.dirname(defaultPendingDir()), "tui", "commands.sqlite")) {}

  private withDb<T>(run: (db: DatabaseSync) => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(this.file, "a", 0o600));
    fs.chmodSync(this.file, 0o600);
    using db = new DatabaseSync(this.file);
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS commands (
        instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        line TEXT NOT NULL,
        result TEXT,
        is_error INTEGER NOT NULL,
        at TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (instance_id, session_id, key)
      );
    `);
    return run(db);
  }

  save(instanceId: string, sessionId: string, entry: CommandEntry): void {
    this.withDb((db) => {
      db.prepare(`
        INSERT INTO commands (instance_id, session_id, key, line, result, is_error, at, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (instance_id, session_id, key) DO UPDATE SET
          line = excluded.line, result = excluded.result, is_error = excluded.is_error,
          at = excluded.at, seq = excluded.seq
      `).run(instanceId, sessionId, entry.key, entry.line, entry.result, Number(entry.isError), entry.at, entry.seq);
    });
  }

  load(instanceId: string, sessionId: string): CommandEntry[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT key, line, result, is_error, at, seq FROM commands
        WHERE instance_id = ? AND session_id = ? ORDER BY at, seq, key
      `).all(instanceId, sessionId) as Array<{
        key: string; line: string; result: string | null; is_error: number; at: string; seq: number;
      }>;
      return rows.map(({ is_error, ...entry }) => ({ ...entry, kind: "command", isError: is_error === 1 }));
    });
  }
}
