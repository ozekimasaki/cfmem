import { DurableObject } from "cloudflare:workers";
import { migrate } from "./migrations";

export interface Env {
  AI: Ai;
  MEMORY_VECTORS: VectorizeIndex;
  MEMORY_ARCHIVE: R2Bucket;
  EMBEDDING_MODEL: string;
}

type MemoryType = "fact" | "event" | "instruction" | "task";

type MemoryRow = {
  id: string;
  type: MemoryType;
  subject_key: string | null;
  summary: string;
  content: string;
  content_hash: string;
  importance: number;
  confidence: number;
  task_status: string | null;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
  deleted_at: number | null;
  vector_status: string;
  vector_version: number;
};

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, init);
}

function id() {
  return crypto.randomUUID().replaceAll("-", "");
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ftsPhrase(value: string) {
  const clean = value.replaceAll('"', '""').trim();
  return `"${clean}"`;
}

export class MemoryProfile extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await migrate(ctx);
      ctx.storage.sql.exec("INSERT OR IGNORE INTO relationship_state(id) VALUES (1)");
      ctx.storage.sql.exec("INSERT OR IGNORE INTO deletion_state(id) VALUES (1)");
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/remember") {
      const body = await request.json<{ content?: string; type?: MemoryType; subjectKey?: string; importance?: number; confidence?: number }>();
      if (!body.content?.trim()) return json({ error: "content is required" }, { status: 400 });
      const now = Date.now();
      const content = body.content.trim();
      const type = body.type ?? "fact";
      const memory: MemoryRow = {
        id: id(),
        type,
        subject_key: body.subjectKey ?? null,
        summary: content.slice(0, 240),
        content,
        content_hash: await sha256Hex(content),
        importance: Math.min(1, Math.max(0, body.importance ?? 0.5)),
        confidence: Math.min(1, Math.max(0, body.confidence ?? 1)),
        task_status: type === "task" ? "open" : null,
        created_at: now,
        updated_at: now,
        superseded_by: null,
        deleted_at: null,
        vector_status: "pending",
        vector_version: 1,
      };

      this.ctx.storage.sql.exec(
        `INSERT INTO memories(
          id,type,subject_key,summary,content,content_hash,importance,confidence,task_status,
          created_at,updated_at,superseded_by,deleted_at,vector_status,vector_version
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        memory.id, memory.type, memory.subject_key, memory.summary, memory.content, memory.content_hash,
        memory.importance, memory.confidence, memory.task_status, memory.created_at, memory.updated_at,
        memory.superseded_by, memory.deleted_at, memory.vector_status, memory.vector_version,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO vector_outbox(memory_id,operation,attempts,next_attempt_at,created_at,updated_at)
         VALUES(?, 'upsert', 0, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET operation='upsert', next_attempt_at=excluded.next_attempt_at, updated_at=excluded.updated_at`,
        memory.id, now, now, now,
      );
      return json(memory, { status: 201 });
    }

    if (request.method === "POST" && url.pathname === "/search") {
      const body = await request.json<{ query?: string; limit?: number }>();
      const query = body.query?.trim();
      if (!query) return json({ error: "query is required" }, { status: 400 });
      const limit = Math.min(20, Math.max(1, body.limit ?? 10));
      let rows: MemoryRow[] = [];
      if (query.length >= 3) {
        try {
          rows = [...this.ctx.storage.sql.exec<MemoryRow>(
            `SELECT m.* FROM memories_fts f
             JOIN memories m ON m.id = f.memory_id
             WHERE memories_fts MATCH ?
               AND m.deleted_at IS NULL
               AND m.superseded_by IS NULL
               AND (m.type != 'task' OR m.task_status = 'open')
             ORDER BY bm25(memories_fts) LIMIT ?`,
            ftsPhrase(query), limit,
          )];
        } catch {
          rows = [];
        }
      }
      if (rows.length < limit) {
        const recent = [...this.ctx.storage.sql.exec<MemoryRow>(
          `SELECT * FROM memories
           WHERE deleted_at IS NULL
             AND superseded_by IS NULL
             AND (type != 'task' OR task_status = 'open')
           ORDER BY updated_at DESC LIMIT ?`, limit,
        )];
        const seen = new Set(rows.map((r) => r.id));
        for (const row of recent) if (!seen.has(row.id) && rows.length < limit) rows.push(row);
      }
      return json({ count: rows.length, candidates: rows });
    }

    if (request.method === "GET" && url.pathname === "/memories") {
      const rows = [...this.ctx.storage.sql.exec<MemoryRow>(
        "SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100",
      )];
      return json({ count: rows.length, result: rows });
    }

    const memoryMatch = url.pathname.match(/^\/memories\/([^/]+)$/);
    if (memoryMatch) {
      const memoryId = decodeURIComponent(memoryMatch[1]);
      const selectMemory = () =>
        this.ctx.storage.sql.exec<MemoryRow>(
          "SELECT * FROM memories WHERE id=? AND deleted_at IS NULL",
          memoryId,
        ).toArray()[0];

      if (request.method === "GET") {
        const row = selectMemory();
        if (!row) return json({ error: "memory not found" }, { status: 404 });
        return json(row);
      }

      if (request.method === "DELETE") {
        const previous = selectMemory();
        if (!previous) return json({ error: "memory not found" }, { status: 404 });
        const now = Date.now();
        this.ctx.storage.sql.exec("UPDATE memories SET deleted_at=?, vector_status='pending', updated_at=? WHERE id=?", now, now, memoryId);
        this.ctx.storage.sql.exec(
          `INSERT INTO vector_outbox(memory_id,operation,attempts,next_attempt_at,created_at,updated_at)
           VALUES(?, 'delete', 0, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET operation='delete', next_attempt_at=excluded.next_attempt_at, updated_at=excluded.updated_at`,
          memoryId, now, now, now,
        );
        return json(previous);
      }
    }

    return json({ error: "not found" }, { status: 404 });
  }
}
