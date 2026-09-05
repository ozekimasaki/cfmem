import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * §58.1 starter tests. They run offline with `node --test` and read the scaffold as
 * text, so they hold on any Node >= 20 and fail the moment a frozen decision drifts.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, "..", "src", "schema.ts"), "utf8").split("SCHEMA_V1")[1] ?? "";

const tableNames = (ddl) =>
  [...ddl.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]);

test("frozen schema v1 declares every §16 table exactly once", () => {
  assert.deepEqual(tableNames(schema).sort(), [
    "consolidation_jobs",
    "deletion_state",
    "memories",
    "memories_fts",
    "messages",
    "profile_meta",
    "relationship_state",
    "sessions",
    "vector_outbox",
  ]);
});

test("memory rows keep the deletion, supersession and outbox state §37 needs", () => {
  for (const column of ["deleted_at INTEGER", "superseded_by TEXT", "content_hash TEXT NOT NULL", "valid_from INTEGER", "valid_until INTEGER"]) {
    assert.match(schema, new RegExp(column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing ${column}`);
  }
  assert.match(schema, /vector_status TEXT NOT NULL DEFAULT 'pending' CHECK\(vector_status IN \('pending','indexed','failed','deleted'\)\)/);
  assert.match(schema, /CHECK\(type IN \('fact','event','instruction','task'\)\)/);
  // Ingest is idempotent: the same content from the same window cannot be stored twice.
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_source_unique/);
});

test("FTS keeps tombstoned and superseded rows out of the index (§37.2)", () => {
  // trigram works on Japanese without a dictionary or an external tokenizer.
  assert.match(schema, /USING fts5\([\s\S]*?tokenize='trigram'\s*\)/);
  assert.match(schema, /CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories\s*\nWHEN NEW\.deleted_at IS NULL/);
  assert.match(schema, /CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF summary, content, deleted_at ON memories/);
  assert.match(schema, /DELETE FROM memories_fts WHERE memory_id = OLD\.id/);
});

test("job, outbox and deletion tables are keyed for safe re-driving", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS vector_outbox \(\s*memory_id TEXT PRIMARY KEY/);
  assert.match(schema, /UNIQUE\(session_id, from_seq, to_seq\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS deletion_state \(\s*id INTEGER PRIMARY KEY CHECK\(id = 1\)/);
  assert.match(schema, /status TEXT NOT NULL CHECK\(status IN \('pending','running','completed','failed'\)\)/);
});

test("sessions carry the checkpoint watermark that drives consolidation (§33)", () => {
  assert.match(schema, /consolidation_watermark INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /last_scheduled_to_seq INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /role TEXT NOT NULL CHECK\(role IN \('system','user','assistant','tool'\)\)/);
  assert.match(schema, /archived_at INTEGER/);
});
