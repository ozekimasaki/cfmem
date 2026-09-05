export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS profile_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  closed_at INTEGER,
  consolidation_watermark INTEGER NOT NULL DEFAULT 0,
  last_scheduled_to_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_unarchived ON messages(session_id, archived_at, seq);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('fact','event','instruction','task')),
  subject_key TEXT,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_session_id TEXT,
  source_start_seq INTEGER,
  source_end_seq INTEGER,
  importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
  valid_from INTEGER,
  valid_until INTEGER,
  task_status TEXT CHECK(task_status IS NULL OR task_status IN ('open','completed','expired','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  superseded_by TEXT,
  deleted_at INTEGER,
  vector_status TEXT NOT NULL DEFAULT 'pending' CHECK(vector_status IN ('pending','indexed','failed','deleted')),
  vector_version INTEGER NOT NULL DEFAULT 1,
  vector_updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_source_unique
  ON memories(content_hash, COALESCE(source_session_id, ''), COALESCE(source_start_seq, -1), COALESCE(source_end_seq, -1));
CREATE INDEX IF NOT EXISTS idx_memories_type_active ON memories(type, deleted_at, superseded_by, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_subject_active ON memories(subject_key, deleted_at, superseded_by, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_vector_status ON memories(vector_status, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(source_session_id, source_start_seq, source_end_seq);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  summary,
  content,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO memories_fts(memory_id, summary, content) VALUES(NEW.id, NEW.summary, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF summary, content, deleted_at ON memories
BEGIN
  DELETE FROM memories_fts WHERE memory_id = OLD.id;
  INSERT INTO memories_fts(memory_id, summary, content)
  SELECT NEW.id, NEW.summary, NEW.content WHERE NEW.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
BEGIN
  DELETE FROM memories_fts WHERE memory_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS relationship_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  interaction_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  familiarity REAL NOT NULL DEFAULT 0 CHECK(familiarity >= 0 AND familiarity <= 1),
  bond REAL NOT NULL DEFAULT 0 CHECK(bond >= 0 AND bond <= 1),
  trust_signals INTEGER NOT NULL DEFAULT 0,
  repair_signals INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS consolidation_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(session_id, from_seq, to_seq)
);

CREATE TABLE IF NOT EXISTS vector_outbox (
  memory_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deletion_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  requested_at INTEGER,
  completed_at INTEGER,
  state TEXT CHECK(state IS NULL OR state IN ('requested','deleting','completed','failed')),
  workflow_id TEXT,
  last_error TEXT
);
`;
