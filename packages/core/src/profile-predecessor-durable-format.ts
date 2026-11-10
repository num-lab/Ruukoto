// Frozen admission metadata: archive e7838ea5d1b1; Pi Durable/Chord 1.3.0. Not a runtime registry.
export const DURABLE_SQL = [
  "CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)",
  "CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)",
  "CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)",
  "CREATE INDEX documents_by_address\n\t\t\tON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)",
  "CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)",
  "CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)",
  "CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)",
  "CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL",
  "CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)",
  "CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
  "CREATE INDEX submissions_by_status ON submissions (status, id)",
  "CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
  "CREATE INDEX tasks_by_background ON tasks (background, id)",
  "CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
  "CREATE INDEX tasks_by_kind ON tasks (kind, id)",
  "CREATE INDEX tasks_by_status ON tasks (status, id)",
  "CREATE TABLE conversations (\n\t\t\tid INTEGER PRIMARY KEY,\n\t\t\towner_conversation_id INTEGER,\n\t\t\towner_task_id INTEGER,\n\t\t\trecord TEXT NOT NULL CHECK (json_valid(record))\n\t\t) STRICT",
  "CREATE TABLE document_revisions (\n\t\t\tdocument_id INTEGER NOT NULL,\n\t\t\tseq INTEGER NOT NULL,\n\t\t\tkind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),\n\t\t\tversion INTEGER NOT NULL,\n\t\t\tcontent TEXT NOT NULL CHECK (json_valid(content)),\n\t\t\tPRIMARY KEY (document_id, seq)\n\t\t) STRICT",
  "CREATE TABLE documents (\n\t\t\tid INTEGER PRIMARY KEY,\n\t\t\tkind TEXT NOT NULL,\n\t\t\tfamily INTEGER NOT NULL CHECK (family IN (0, 1)),\n\t\t\tkey_value TEXT NOT NULL,\n\t\t\tscope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),\n\t\t\towner_id INTEGER NOT NULL,\n\t\t\tcreated_at INTEGER NOT NULL,\n\t\t\tretired_at INTEGER,\n\t\t\trecord TEXT NOT NULL CHECK (json_valid(record))\n\t\t) STRICT",
  "CREATE TABLE durable_metadata (\n\t\t\tsingleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n\t\t\tnext_id TEXT NOT NULL,\n\t\t\tnext_seq INTEGER NOT NULL\n\t\t) STRICT",
  "CREATE TABLE durable_schema (\n\t\t\tsingleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n\t\t\tversion INTEGER NOT NULL CHECK (version >= 0)\n\t\t) STRICT",
  "CREATE TABLE entries (\n\t\t\tid INTEGER PRIMARY KEY,\n\t\t\tconversation_id INTEGER NOT NULL,\n\t\t\thead INTEGER,\n\t\t\tcommit_seq INTEGER NOT NULL,\n\t\t\trecord TEXT NOT NULL CHECK (json_valid(record))\n\t\t) STRICT",
  "CREATE TABLE record_ids (\n\t\t\tid INTEGER PRIMARY KEY,\n\t\t\trecord_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))\n\t\t) STRICT",
  "CREATE TABLE submissions (\n\t\t\tid INTEGER PRIMARY KEY,\n\t\t\tconversation_id INTEGER NOT NULL,\n\t\t\trequest_id TEXT,\n\t\t\tstatus TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),\n\t\t\trecord TEXT NOT NULL CHECK (json_valid(record))\n\t\t) STRICT",
  "CREATE TABLE tasks (\n\t\t\tid INTEGER PRIMARY KEY,\n\t\t\tconversation_id INTEGER NOT NULL,\n\t\t\tkind TEXT NOT NULL,\n\t\t\tstatus TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),\n\t\t\tabort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),\n\t\t\tbackground INTEGER NOT NULL CHECK (background IN (0, 1)),\n\t\t\trecord TEXT NOT NULL CHECK (json_valid(record))\n\t\t) STRICT"
] as const;

export const DOCUMENT_KINDS: Readonly<Record<string, readonly [number, number, string]>> = {
  "pi.agent": [
    1,
    0,
    "conversation"
  ],
  "pi.inbox": [
    1,
    0,
    "conversation"
  ],
  "pi.live": [
    1,
    0,
    "conversation"
  ],
  "pi.provider": [
    1,
    0,
    "conversation"
  ],
  "pi.tool.nested-call": [
    1,
    1,
    "task"
  ],
  "pi.usage": [
    1,
    0,
    "conversation"
  ],
  "ruukoto.analysis-delegation": [
    1,
    1,
    "session"
  ],
  "ruukoto.app-data": [
    1,
    0,
    "session"
  ],
  "ruukoto.app-data-operation": [
    1,
    1,
    "session"
  ],
  "ruukoto.attachment-upload": [
    1,
    1,
    "session"
  ],
  "ruukoto.background-process": [
    1,
    1,
    "session"
  ],
  "ruukoto.background-processes": [
    1,
    0,
    "session"
  ],
  "ruukoto.browser": [
    1,
    0,
    "session"
  ],
  "ruukoto.browser-operation": [
    1,
    1,
    "session"
  ],
  "ruukoto.browser-session": [
    1,
    1,
    "session"
  ],
  "ruukoto.command": [
    1,
    1,
    "session"
  ],
  "ruukoto.commands": [
    1,
    0,
    "session"
  ],
  "ruukoto.configuration-version": [
    1,
    1,
    "session"
  ],
  "ruukoto.coordination": [
    1,
    1,
    "session"
  ],
  "ruukoto.desktop-action": [
    1,
    1,
    "session"
  ],
  "ruukoto.desktop-actions": [
    1,
    0,
    "session"
  ],
  "ruukoto.directory-claims": [
    1,
    0,
    "session"
  ],
  "ruukoto.file-io": [
    1,
    0,
    "session"
  ],
  "ruukoto.file-io-job": [
    1,
    1,
    "session"
  ],
  "ruukoto.format": [
    1,
    0,
    "session"
  ],
  "ruukoto.im-deliveries": [
    1,
    0,
    "session"
  ],
  "ruukoto.im-delivery": [
    1,
    1,
    "session"
  ],
  "ruukoto.im-pairing": [
    1,
    1,
    "session"
  ],
  "ruukoto.image": [
    1,
    1,
    "session"
  ],
  "ruukoto.interactive-resource": [
    1,
    1,
    "session"
  ],
  "ruukoto.interactive-resources": [
    1,
    0,
    "session"
  ],
  "ruukoto.local-input": [
    1,
    1,
    "session"
  ],
  "ruukoto.mcp": [
    1,
    1,
    "session"
  ],
  "ruukoto.mcp-config": [
    1,
    0,
    "session"
  ],
  "ruukoto.media": [
    1,
    0,
    "session"
  ],
  "ruukoto.media-message": [
    1,
    1,
    "session"
  ],
  "ruukoto.memories": [
    1,
    0,
    "session"
  ],
  "ruukoto.memory": [
    1,
    1,
    "session"
  ],
  "ruukoto.memory-operation": [
    1,
    1,
    "session"
  ],
  "ruukoto.outputs": [
    1,
    0,
    "session"
  ],
  "ruukoto.owner-input-display": [
    1,
    1,
    "session"
  ],
  "ruukoto.owner-input-history": [
    1,
    1,
    "session"
  ],
  "ruukoto.owner-input-submission": [
    1,
    1,
    "session"
  ],
  "ruukoto.permissions": [
    1,
    0,
    "session"
  ],
  "ruukoto.question": [
    1,
    1,
    "session"
  ],
  "ruukoto.question-receipt": [
    1,
    1,
    "session"
  ],
  "ruukoto.questions": [
    1,
    0,
    "session"
  ],
  "ruukoto.schedule": [
    1,
    1,
    "session"
  ],
  "ruukoto.schedule-run": [
    1,
    1,
    "session"
  ],
  "ruukoto.scheduled-conversation": [
    1,
    1,
    "session"
  ],
  "ruukoto.schedules": [
    1,
    0,
    "session"
  ],
  "ruukoto.service-config": [
    2,
    0,
    "session"
  ],
  "ruukoto.service-execution": [
    1,
    1,
    "session"
  ],
  "ruukoto.service-executions": [
    1,
    0,
    "session"
  ],
  "ruukoto.service-grants": [
    1,
    0,
    "session"
  ],
  "ruukoto.service-operation": [
    1,
    1,
    "session"
  ],
  "ruukoto.service-operations-config": [
    1,
    0,
    "session"
  ],
  "ruukoto.settings": [
    1,
    0,
    "session"
  ],
  "ruukoto.settings-operation": [
    1,
    1,
    "session"
  ],
  "ruukoto.skill-expansion": [
    1,
    1,
    "session"
  ],
  "ruukoto.skill-load": [
    1,
    1,
    "session"
  ],
  "ruukoto.skills": [
    1,
    0,
    "session"
  ],
  "ruukoto.subagents": [
    1,
    0,
    "session"
  ],
  "ruukoto.telegram": [
    1,
    0,
    "session"
  ],
  "ruukoto.telegram-attachment-group": [
    1,
    1,
    "session"
  ],
  "ruukoto.telegram-attachment-message": [
    1,
    1,
    "session"
  ],
  "ruukoto.telegram-attachments": [
    1,
    0,
    "session"
  ],
  "ruukoto.telegram-callback-ack": [
    1,
    1,
    "session"
  ],
  "ruukoto.telegram-callback-acks": [
    1,
    0,
    "session"
  ],
  "ruukoto.telegram-display": [
    1,
    1,
    "session"
  ],
  "ruukoto.telegram-displays": [
    1,
    0,
    "session"
  ],
  "ruukoto.telegram-receipt": [
    1,
    1,
    "session"
  ],
  "ruukoto.telegram-token": [
    1,
    1,
    "session"
  ],
  "ruukoto.tool-operation": [
    1,
    1,
    "session"
  ],
  "ruukoto.tools": [
    1,
    0,
    "session"
  ],
  "ruukoto.web-search": [
    1,
    0,
    "session"
  ],
  "ruukoto.work": [
    1,
    1,
    "session"
  ]
};

export const TASK_KINDS: Readonly<Record<string, readonly number[]>> = {
  "pi.compaction": [
    1
  ],
  "pi.generation": [
    1
  ],
  "pi.tool": [
    1,
    2
  ],
  "ruukoto.app-data-recheck": [
    1
  ],
  "ruukoto.background-start": [
    1
  ],
  "ruukoto.background-stop": [
    1
  ],
  "ruukoto.background-work": [
    1,
    2,
    3,
    4
  ],
  "ruukoto.browser-stop": [
    1
  ],
  "ruukoto.command": [
    1
  ],
  "ruukoto.command-stop": [
    1
  ],
  "ruukoto.delegation-report": [
    1,
    2
  ],
  "ruukoto.desktop-action": [
    1
  ],
  "ruukoto.im-delivery": [
    1
  ],
  "ruukoto.inspection-stop": [
    1
  ],
  "ruukoto.mcp-recheck": [
    1
  ],
  "ruukoto.question-continuation": [
    1
  ],
  "ruukoto.schedule-send": [
    1
  ],
  "ruukoto.schedule-supervisor": [
    1
  ],
  "ruukoto.scheduled-run": [
    1
  ],
  "ruukoto.service-operation": [
    1
  ],
  "ruukoto.service-stop": [
    1
  ],
  "ruukoto.telegram-attachment-display": [
    1
  ],
  "ruukoto.telegram-attachment-input": [
    1
  ],
  "ruukoto.telegram-callback-ack": [
    1
  ],
  "ruukoto.telegram-card-edit": [
    1
  ],
  "ruukoto.telegram-input": [
    1
  ]
};

export const ENTRY_KINDS: Readonly<Record<string, true>> = {
  "pi.assistant": true,
  "pi.compaction": true,
  "pi.reset": true,
  "pi.system": true,
  "pi.tool-result": true,
  "pi.user": true,
  "ruukoto.analysis-admission": true,
  "ruukoto.app-data-admission": true,
  "ruukoto.app-data-binding": true,
  "ruukoto.app-data-decision": true,
  "ruukoto.app-data-observation": true,
  "ruukoto.app-data-start": true,
  "ruukoto.app-data-supersession": true,
  "ruukoto.attachment-grant": true,
  "ruukoto.attachment-upload": true,
  "ruukoto.background-admission": true,
  "ruukoto.background-closure": true,
  "ruukoto.background-launch": true,
  "ruukoto.background-observation": true,
  "ruukoto.background-stop": true,
  "ruukoto.background-supersession": true,
  "ruukoto.browser-admission": true,
  "ruukoto.browser-binding-changed": true,
  "ruukoto.browser-configuration": true,
  "ruukoto.browser-observation": true,
  "ruukoto.browser-pause": true,
  "ruukoto.browser-resolution": true,
  "ruukoto.browser-resume-choice": true,
  "ruukoto.browser-resume-consumption": true,
  "ruukoto.browser-resume-observation": true,
  "ruukoto.browser-start": true,
  "ruukoto.browser-supersession": true,
  "ruukoto.command-admission": true,
  "ruukoto.command-observation": true,
  "ruukoto.command-preparation-stop": true,
  "ruukoto.command-resolution": true,
  "ruukoto.command-start": true,
  "ruukoto.command-supersession": true,
  "ruukoto.coordination-cutoff": true,
  "ruukoto.desktop-action-admission": true,
  "ruukoto.desktop-action-result": true,
  "ruukoto.desktop-action-start": true,
  "ruukoto.directory-claim": true,
  "ruukoto.file-io-admission": true,
  "ruukoto.file-io-lifecycle": true,
  "ruukoto.im-config": true,
  "ruukoto.im-delivery-admission": true,
  "ruukoto.im-delivery-cancel": true,
  "ruukoto.im-delivery-claim": true,
  "ruukoto.im-delivery-observation": true,
  "ruukoto.im-effect-action": true,
  "ruukoto.image-reference": true,
  "ruukoto.interactive-admission": true,
  "ruukoto.interactive-ownership": true,
  "ruukoto.local-input-admission": true,
  "ruukoto.mcp-admission": true,
  "ruukoto.mcp-configuration": true,
  "ruukoto.mcp-cua-launch": true,
  "ruukoto.mcp-cua-launch-stopped": true,
  "ruukoto.mcp-cua-pause": true,
  "ruukoto.mcp-cua-recovery": true,
  "ruukoto.mcp-cua-stop-pending": true,
  "ruukoto.mcp-cua-takeover": true,
  "ruukoto.mcp-decision": true,
  "ruukoto.mcp-ended": true,
  "ruukoto.mcp-images": true,
  "ruukoto.mcp-observation": true,
  "ruukoto.mcp-request": true,
  "ruukoto.mcp-resolution": true,
  "ruukoto.mcp-result": true,
  "ruukoto.mcp-start": true,
  "ruukoto.mcp-supersession": true,
  "ruukoto.media-received": true,
  "ruukoto.memory-revision": true,
  "ruukoto.model-request": true,
  "ruukoto.output-intent": true,
  "ruukoto.owner-effect-claim": true,
  "ruukoto.owner-input-display": true,
  "ruukoto.permissions-change": true,
  "ruukoto.qq-connection": true,
  "ruukoto.qq-received": true,
  "ruukoto.question-admission": true,
  "ruukoto.question-answer-admission": true,
  "ruukoto.question-terminal": true,
  "ruukoto.recovery-check": true,
  "ruukoto.report-admission": true,
  "ruukoto.report-coverage": true,
  "ruukoto.report-failure": true,
  "ruukoto.report-host-admission": true,
  "ruukoto.report-pause": true,
  "ruukoto.report-publication": true,
  "ruukoto.report-request": true,
  "ruukoto.report-send-canceled": true,
  "ruukoto.report-supersession": true,
  "ruukoto.schedule-admission": true,
  "ruukoto.schedule-authority": true,
  "ruukoto.schedule-cancellation": true,
  "ruukoto.schedule-result": true,
  "ruukoto.schedule-run-admission": true,
  "ruukoto.schedule-run-cancellation": true,
  "ruukoto.schedule-send-admission": true,
  "ruukoto.schedule-send-claim": true,
  "ruukoto.schedule-send-observation": true,
  "ruukoto.schedule-summary-admission": true,
  "ruukoto.scheduled-work-admission": true,
  "ruukoto.service-grant-revoked": true,
  "ruukoto.service-inspection": true,
  "ruukoto.service-inspection-admission": true,
  "ruukoto.service-inspection-stop": true,
  "ruukoto.service-operation-configuration": true,
  "ruukoto.service-operation-evidence": true,
  "ruukoto.service-supersession": true,
  "ruukoto.service-work-admission": true,
  "ruukoto.settings-model-test": true,
  "ruukoto.settings-saved": true,
  "ruukoto.skill-expansion": true,
  "ruukoto.skill-load": true,
  "ruukoto.skills-snapshot": true,
  "ruukoto.telegram-attachment-choice": true,
  "ruukoto.telegram-attachment-member": true,
  "ruukoto.telegram-attachment-observation": true,
  "ruukoto.telegram-attachment-rejected": true,
  "ruukoto.telegram-callback": true,
  "ruukoto.telegram-callback-ack-admission": true,
  "ruukoto.telegram-callback-ack-claim": true,
  "ruukoto.telegram-callback-ack-observation": true,
  "ruukoto.telegram-callback-rejected": true,
  "ruukoto.telegram-card-edit-admission": true,
  "ruukoto.telegram-card-edit-claim": true,
  "ruukoto.telegram-card-edit-observation": true,
  "ruukoto.telegram-cua-images": true,
  "ruukoto.telegram-display-admission": true,
  "ruukoto.telegram-received": true,
  "ruukoto.tool-admission": true,
  "ruukoto.tool-decision": true,
  "ruukoto.tool-grant": true,
  "ruukoto.tool-observation": true,
  "ruukoto.tool-redisplay": true,
  "ruukoto.tool-resolution": true,
  "ruukoto.tool-review": true,
  "ruukoto.tool-start": true,
  "ruukoto.tool-supersession": true,
  "ruukoto.tools-configuration": true,
  "ruukoto.work-continuation": true,
  "ruukoto.work-control": true,
  "ruukoto.work-note-admission": true,
  "ruukoto.work-question-canceled": true,
  "ruukoto.work-question-return": true,
};

export const ENTRY_VERSIONS: Readonly<Record<string, readonly [string, number]>> = {
  "ruukoto.tool-supersession": [
    "version",
    1
  ],
  "ruukoto.tool-redisplay": [
    "version",
    1
  ],
  "ruukoto.work-continuation": [
    "version",
    1
  ],
  "ruukoto.telegram-attachment-rejected": [
    "v",
    1
  ],
  "ruukoto.telegram-attachment-member": [
    "v",
    1
  ],
  "ruukoto.telegram-attachment-choice": [
    "v",
    1
  ],
  "ruukoto.telegram-attachment-observation": [
    "v",
    1
  ],
  "ruukoto.telegram-callback-ack-admission": [
    "v",
    1
  ],
  "ruukoto.service-supersession": [
    "version",
    1
  ],
  "ruukoto.report-request": [
    "version",
    2
  ],
  "ruukoto.report-coverage": [
    "version",
    2
  ],
  "ruukoto.report-supersession": [
    "version",
    2
  ],
  "ruukoto.report-publication": [
    "version",
    2
  ],
  "ruukoto.report-send-canceled": [
    "version",
    2
  ],
  "ruukoto.report-failure": [
    "version",
    2
  ],
  "ruukoto.owner-input-display": [
    "version",
    1
  ],
  "ruukoto.im-effect-action": [
    "v",
    1
  ],
  "ruukoto.interactive-admission": [
    "version",
    1
  ],
  "ruukoto.mcp-supersession": [
    "version",
    1
  ],
  "ruukoto.mcp-cua-takeover": [
    "version",
    1
  ],
  "ruukoto.command-supersession": [
    "version",
    1
  ],
  "ruukoto.desktop-action-admission": [
    "v",
    1
  ],
  "ruukoto.app-data-supersession": [
    "version",
    1
  ]
};
