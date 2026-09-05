import http from "node:http";
import { createHash } from "node:crypto";

/**
 * In-memory stand-in for the §10 route contract, used only by the CLI test
 * suite. Retrieval is lexical (exact substring + character-bigram overlap), so
 * it proves wiring, scope isolation, envelope handling and metric math — it is
 * NOT a quality proxy for the real Vectorize-backed backend.
 */

const nowId = (() => {
  let n = 0;
  return () => `mem-${String(++n).padStart(6, "0")}`;
})();

function normalize(text) {
  return String(text ?? "").replace(/[\s、。「」『』・？?！!.:,：;；]/g, "");
}

function bigrams(text) {
  const clean = normalize(text);
  const set = new Set();
  if (clean.length === 1) set.add(clean);
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function lexicalScore(memory, query) {
  const haystack = [memory.content, memory.summary, memory.subject_key].filter(Boolean).join("\n");
  let score = 0;
  if (query && haystack.includes(query)) score += 4;
  const queryGrams = bigrams(query);
  if (queryGrams.size) {
    const targetGrams = bigrams(haystack);
    let hits = 0;
    for (const gram of queryGrams) if (targetGrams.has(gram)) hits += 1;
    score += (hits / queryGrams.size) * 2;
  }
  return Number(score.toFixed(6));
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

function envelope(data, requestId) {
  return { ok: true, data, requestId };
}

function failure(response, status, code, message, requestId) {
  json(response, status, { ok: false, error: { code, message }, requestId });
}

export async function startMockMemoryServer({ token, exportIncludesSecret = false } = {}) {
  const profiles = new Map();
  const calls = [];

  const profileFor = (key) => {
    if (!profiles.has(key)) profiles.set(key, { memories: new Map(), deletedProfiles: false });
    return profiles.get(key);
  };

  const server = http.createServer((request, response) => {
    const requestId = `req-${calls.length + 1}`;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
      const url = new URL(request.url, "http://mock.internal");
      const path = url.pathname;
      calls.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body });

      if (path === "/v1/health") return json(response, 200, envelope({ ok: true }, requestId));
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        return failure(response, 401, "UNAUTHENTICATED", "missing or invalid token", requestId);
      }

      const match = path.match(/^\/v1\/namespaces\/([^/]+)\/characters\/([^/]+)\/subjects\/([^/]+)(\/.*)?$/);
      if (!match) return failure(response, 404, "INVALID_REQUEST", `unhandled path ${path}`, requestId);
      const key = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}/${decodeURIComponent(match[3])}`;
      const suffix = match[4] ?? "";
      const profile = profileFor(key);
      const active = () => [...profile.memories.values()].filter((row) => row.deleted_at === null);

      if (request.method === "POST" && suffix === "/remember") {
        if (!body.content) return failure(response, 400, "INVALID_REQUEST", "content is required", requestId);
        const row = {
          id: nowId(),
          type: body.type ?? "fact",
          subject_key: body.subjectKey ?? null,
          summary: String(body.content).slice(0, 240),
          content: body.content,
          importance: body.importance ?? 0.5,
          confidence: body.confidence ?? 1,
          task_status: body.type === "task" ? "open" : null,
          session_id: body.sessionId ?? null,
          created_at: Date.now(),
          updated_at: Date.now(),
          superseded_by: null,
          deleted_at: null,
        };
        profile.memories.set(row.id, row);
        return json(response, 201, envelope(row, requestId));
      }

      if (request.method === "POST" && suffix === "/messages") {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (!body.sessionId) return failure(response, 400, "INVALID_REQUEST", "sessionId is required", requestId);
        for (const message of messages) {
          if (message?.role !== "user") continue;
          const row = {
            id: nowId(),
            type: "fact",
            subject_key: null,
            summary: String(message.content ?? "").slice(0, 240),
            content: message.content ?? "",
            session_id: body.sessionId,
            created_at: Date.now(),
            updated_at: Date.now(),
            superseded_by: null,
            deleted_at: null,
            extracted: true,
          };
          profile.memories.set(row.id, row);
        }
        return json(response, 202, envelope({ accepted: messages.length, sessionId: body.sessionId }, requestId));
      }

      if (request.method === "POST" && suffix === "/ingest") {
        return json(response, 202, envelope({ jobId: `job-${calls.length}`, sessionId: body.sessionId ?? null }, requestId));
      }

      if (request.method === "POST" && (suffix === "/search" || suffix === "/recall")) {
        if (!body.query) return failure(response, 400, "INVALID_REQUEST", "query is required", requestId);
        const limit = Math.min(Number(body.limit) || 10, 50);
        let rows = active().filter((row) => row.superseded_by === null);
        if (body.type) rows = rows.filter((row) => row.type === body.type);
        if (body.sessionId) rows = rows.filter((row) => row.session_id === body.sessionId);
        if (body.subjectKey) rows = rows.filter((row) => row.subject_key === body.subjectKey);
        const scored = rows
          .map((row) => ({ ...row, score: lexicalScore(row, body.query) }))
          .sort((a, b) => b.score - a.score || b.updated_at - a.updated_at)
          .filter((row) => row.score > 0)
          .slice(0, limit);
        if (suffix === "/recall") {
          return json(response, 200, envelope({ query: body.query, synthesized: scored.map((row) => row.content), candidates: scored }, requestId));
        }
        return json(response, 200, envelope({ query: body.query, count: scored.length, candidates: scored }, requestId));
      }

      if (request.method === "GET" && suffix === "/memories") {
        const q = Object.fromEntries(url.searchParams);
        let rows = active();
        if (q.type) rows = rows.filter((row) => row.type === q.type);
        if (q.sessionId) rows = rows.filter((row) => row.session_id === q.sessionId);
        if (q.subjectKey) rows = rows.filter((row) => row.subject_key === q.subjectKey);
        if (q.active === "true") rows = rows.filter((row) => row.superseded_by === null);
        const limit = Math.min(Number(q.limit) || 50, 100);
        const sorted = rows.sort((a, b) => b.updated_at - a.updated_at);
        return json(response, 200, envelope({ count: sorted.length, result: sorted.slice(0, limit), nextCursor: null }, requestId));
      }

      const memoryMatch = suffix.match(/^\/memories\/([^/]+)$/);
      if (memoryMatch) {
        const id = decodeURIComponent(memoryMatch[1]);
        const row = profile.memories.get(id);
        if (!row || row.deleted_at !== null) return failure(response, 404, "MEMORY_NOT_FOUND", "memory not found", requestId);
        if (request.method === "GET") return json(response, 200, envelope(row, requestId));
        if (request.method === "DELETE") {
          row.deleted_at = Date.now();
          row.updated_at = Date.now();
          return json(response, 200, envelope({ id, deleted: true, tombstone: true, outboxOperation: "delete" }, requestId));
        }
      }

      const sessionMatch = suffix.match(/^\/sessions\/([^/]+)$/);
      if (sessionMatch && request.method === "DELETE") {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        let purged = 0;
        for (const row of profile.memories.values()) {
          if (row.session_id === sessionId && row.deleted_at === null) {
            row.deleted_at = Date.now();
            row.session_id = null;
            purged += 1;
          }
        }
        return json(response, 200, envelope({ sessionId, purged, outboxOperations: purged }, requestId));
      }

      if (request.method === "POST" && suffix === "/export") {
        return json(response, 200, envelope({
          format: "cf-character-memory-export",
          version: 1,
          namespace: decodeURIComponent(match[1]),
          character: decodeURIComponent(match[2]),
          subject: decodeURIComponent(match[3]),
          profileKeyFingerprint: createHash("sha256").update(key).digest("hex").slice(0, 16),
          memories: active(),
          ...(exportIncludesSecret ? { leaked: { PROFILE_KEY_SECRET: "super-secret-value" } } : {}),
        }, requestId));
      }

      if (request.method === "DELETE" && suffix === "/profile") {
        profile.deletedProfiles = true;
        const count = profile.memories.size;
        profile.memories.clear();
        return json(response, 202, envelope({ status: "deleting", memories: count, workflows: ["delete-profile-v1"] }, requestId));
      }

      if (request.method === "POST" && (suffix === "/repair/outbox" || suffix === "/repair/jobs")) {
        const dryRun = body.dryRun !== false;
        return json(response, 200, envelope({
          target: suffix,
          dryRun,
          scanned: active().length,
          wouldRedrive: suffix === "/repair/outbox" ? 0 : 0,
          redriven: dryRun ? 0 : 0,
        }, requestId));
      }

      if (request.method === "GET" && (suffix === "/summary" || suffix === "/relationship")) {
        return json(response, 200, envelope({ subject: key, memories: active().length }, requestId));
      }

      return failure(response, 501, "INVALID_REQUEST", `route not implemented in mock: ${request.method} ${suffix}`, requestId);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    profiles,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
