import type { Migration } from "../Migration.js";

const statements = [
  "UPDATE halo_routine_runs SET session_id = NULL",
  "DROP TABLE halo_session_entries",
  "DROP TABLE halo_session_values",
  "DROP TABLE halo_session_lists",
  "DROP TABLE halo_session_usage",
  "DROP TABLE halo_sessions",
  `CREATE TABLE halo_sessions (
		id TEXT PRIMARY KEY NOT NULL,
		metadata TEXT NOT NULL,
		marked_done INTEGER NOT NULL DEFAULT 0 CHECK (marked_done IN (0, 1)),
		read_receipt_cursor_id TEXT
	) STRICT`,
  `CREATE TABLE durable_metadata (
		session_id TEXT PRIMARY KEY NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
		next_id TEXT NOT NULL,
		next_seq INTEGER NOT NULL
	) STRICT`,
  `CREATE TABLE record_ids (
		session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
		id INTEGER NOT NULL,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document')),
		PRIMARY KEY (session_id, id)
	) STRICT`,
  `CREATE TABLE conversations (
		session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
		id INTEGER NOT NULL,
		owner_conversation_id INTEGER,
		owner_task_id INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record)),
		PRIMARY KEY (session_id, id)
	) STRICT`,
  "CREATE INDEX conversations_by_owner_conversation ON conversations (session_id, owner_conversation_id, id)",
  "CREATE INDEX conversations_by_owner_task ON conversations (session_id, owner_task_id, id)",
  `CREATE TABLE entries (
		session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
		id INTEGER NOT NULL,
		conversation_id INTEGER NOT NULL,
		head INTEGER,
		commit_seq INTEGER NOT NULL,
		record TEXT NOT NULL CHECK (json_valid(record)),
		PRIMARY KEY (session_id, id)
	) STRICT`,
  "CREATE INDEX entries_by_conversation ON entries (session_id, conversation_id, id DESC)",
  "CREATE INDEX entry_heads_by_conversation ON entries (session_id, conversation_id, id DESC) WHERE head IS NOT NULL",
  `CREATE TABLE tasks (
		session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
		id INTEGER NOT NULL,
		conversation_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (json_valid(record)),
		PRIMARY KEY (session_id, id)
	) STRICT`,
  "CREATE INDEX tasks_by_status ON tasks (session_id, status, id)",
  "CREATE INDEX tasks_by_conversation ON tasks (session_id, conversation_id, id)",
  "CREATE INDEX tasks_by_kind ON tasks (session_id, kind, id)",
  "CREATE INDEX tasks_by_abort_requested ON tasks (session_id, abort_requested, id)",
  "CREATE INDEX tasks_by_background ON tasks (session_id, background, id)",
  `CREATE TABLE submissions (
		session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
		id INTEGER NOT NULL,
		conversation_id INTEGER NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		settled_seq INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record)),
		PRIMARY KEY (session_id, id)
	) STRICT`,
  "CREATE INDEX submissions_by_request ON submissions (session_id, conversation_id, request_id)",
  "CREATE INDEX submissions_by_conversation ON submissions (session_id, conversation_id, id)",
  "CREATE INDEX submissions_by_status ON submissions (session_id, status, id)",
  "CREATE INDEX submissions_by_settlement ON submissions (session_id, conversation_id, settled_seq)",
  `CREATE TABLE documents (
		session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
		id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		family INTEGER NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		retired_at INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record)),
		PRIMARY KEY (session_id, id)
	) STRICT`,
  `CREATE INDEX documents_by_address
		ON documents (session_id, kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
  "CREATE INDEX documents_by_scope ON documents (session_id, scope_kind, owner_id, id)",
  "CREATE INDEX documents_by_scope_kind ON documents (session_id, scope_kind, owner_id, kind, id)",
  `CREATE TABLE document_revisions (
		session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
		document_id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version INTEGER NOT NULL,
		content TEXT NOT NULL CHECK (json_valid(content)),
		PRIMARY KEY (session_id, document_id, seq)
	) STRICT`,
  "CREATE INDEX document_revisions_by_kind ON document_revisions (session_id, document_id, kind, seq DESC)",
];

export const durableStorageMigration: Migration = {
  id: "20261003100000-durable-storage",
  sql: statements.join(";\n"),
};
