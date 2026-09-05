/**
 * HTTP client for the custom memory backend contract (§10 routes, §11 envelope,
 * §12 input limits). cfmem is an operations tool: it speaks the same public API
 * as the character runtime, it is not a second memory server.
 */

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "PAYLOAD_TOO_LARGE",
  "PROFILE_DELETING",
  "SESSION_NOT_FOUND",
  "MEMORY_NOT_FOUND",
  "MEMORY_CONFLICT",
  "INGEST_ALREADY_RUNNING",
  "VECTOR_TEMPORARILY_UNAVAILABLE",
  "AI_EXTRACTION_FAILED",
  "ARCHIVE_FAILED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
];

/** §12 input limits, applied client-side before a request leaves the machine. */
export const LIMITS = {
  queryBytes: 1024,
  messageContentBytes: 32_768,
  rememberContentBytes: 32_768,
  sessionIdChars: 64,
  characterIdChars: 128,
  subjectIdChars: 256,
  namespaceChars: 64,
  ingestMessages: 500,
  listPageLimit: 100,
  searchLimit: 50,
};

const utf8Bytes = (value) => Buffer.byteLength(String(value), "utf8");

export class MemoryApiError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message);
    this.name = "MemoryApiError";
    this.status = status;
    this.code = code ?? "INTERNAL_ERROR";
    this.requestId = requestId;
  }
}

function assertWithin(limit, value, label) {
  if (value === undefined || value === null) return;
  if (utf8Bytes(value) > limit) {
    throw new MemoryApiError(`${label} exceeds the ${limit}-byte input limit (${utf8Bytes(value)} bytes).`, {
      code: "PAYLOAD_TOO_LARGE",
    });
  }
}

function assertChars(max, value, label) {
  if (value === undefined || value === null) return;
  if (String(value).length > max) {
    throw new MemoryApiError(`${label} exceeds ${max} characters.`, { code: "INVALID_REQUEST" });
  }
}

function join(base, path) {
  return `${base.replace(/\/$/, "")}${path}`;
}

export class MemoryApiClient {
  constructor({ endpoint, token, namespace = "default", character = "character-default", subject, profile, fetchFn } = {}) {
    if (!endpoint) throw new MemoryApiError("endpoint is required (--endpoint or CFMEM_ENDPOINT).", { code: "INVALID_REQUEST" });
    const subjectId = subject ?? profile;
    if (!subjectId) throw new MemoryApiError("subject is required (--subject or CFMEM_SUBJECT).", { code: "INVALID_REQUEST" });
    assertChars(LIMITS.namespaceChars, namespace, "namespace");
    assertChars(LIMITS.characterIdChars, character, "character id");
    assertChars(LIMITS.subjectIdChars, subjectId, "subject id");
    this.endpoint = endpoint;
    this.token = token;
    this.namespace = namespace;
    this.character = character;
    this.subject = subjectId;
    this.fetchFn = fetchFn ?? fetch;
  }

  headers() {
    const headers = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  subjectPath(suffix = "") {
    return `/v1/namespaces/${encodeURIComponent(this.namespace)}/characters/${encodeURIComponent(this.character)}/subjects/${encodeURIComponent(this.subject)}${suffix}`;
  }

  profilePath(suffix = "") {
    return this.subjectPath(suffix);
  }

  /**
   * Sends a request and unwraps the §11 envelope. Non-enveloped responses
   * (including the starter Worker's `{ error: "string" }` shape) are tolerated.
   */
  async request(path, { method = "GET", body, query } = {}) {
    let url = join(this.endpoint, path);
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const response = await this.fetchFn(url, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    const envelope = payload && typeof payload === "object" ? payload : {};
    const requestId = envelope.requestId;

    if (!response.ok) {
      const error = envelope.error;
      const code = typeof error === "object" && error?.code ? error.code : httpCode(response.status);
      const message =
        typeof error === "string" ? error : typeof error === "object" && error?.message ? error.message : text || response.statusText;
      throw new MemoryApiError(message, { status: response.status, code, requestId });
    }
    if (envelope.ok === false) {
      const code = typeof error_code(envelope) === "string" ? error_code(envelope) : "INTERNAL_ERROR";
      throw new MemoryApiError(envelope.error?.message ?? "Server reported failure.", { status: response.status, code, requestId });
    }
    return envelope.data !== undefined ? envelope.data : payload;
  }

  health() {
    return this.request("/v1/health");
  }

  async appendMessages(messages, sessionId) {
    for (const message of messages) assertWithin(LIMITS.messageContentBytes, message?.content, "message content");
    assertChars(LIMITS.sessionIdChars, sessionId, "session id");
    return this.request(this.subjectPath("/messages"), { method: "POST", body: { sessionId, messages } });
  }

  async ingest({ sessionId, messages }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new MemoryApiError("ingest requires a non-empty messages array.", { code: "INVALID_REQUEST" });
    }
    if (messages.length > LIMITS.ingestMessages) {
      throw new MemoryApiError(`ingest accepts at most ${LIMITS.ingestMessages} messages per call.`, { code: "INVALID_REQUEST" });
    }
    assertChars(LIMITS.sessionIdChars, sessionId, "session id");
    return this.request(this.subjectPath("/ingest"), { method: "POST", body: { sessionId, messages } });
  }

  async remember(input) {
    const body = typeof input === "string" ? { content: input } : { ...input };
    assertWithin(LIMITS.rememberContentBytes, body.content, "remember content");
    assertChars(LIMITS.sessionIdChars, body.sessionId, "session id");
    return this.request(this.subjectPath("/remember"), { method: "POST", body });
  }

  async search(query, options = {}) {
    return this.request(this.subjectPath("/search"), { method: "POST", body: searchBody(query, options) });
  }

  async recall(query, options = {}) {
    return this.request(this.subjectPath("/recall"), { method: "POST", body: searchBody(query, options) });
  }

  /** §36 list filters. */
  async list(filters = {}) {
    assertChars(LIMITS.sessionIdChars, filters.sessionId, "session id");
    const query = {};
    for (const key of ["type", "active", "sessionId", "subjectKey", "createdBefore", "createdAfter", "cursor", "limit"]) {
      if (filters[key] !== undefined) query[key] = filters[key];
    }
    if (query.limit !== undefined) {
      const limit = Number(query.limit);
      if (!Number.isFinite(limit) || limit < 1 || limit > LIMITS.listPageLimit) {
        throw new MemoryApiError(`--limit must be between 1 and ${LIMITS.listPageLimit}.`, { code: "INVALID_REQUEST" });
      }
    }
    return this.request(this.subjectPath("/memories"), { query });
  }

  async get(id) {
    if (!id) throw new MemoryApiError("memory id is required (--id).", { code: "INVALID_REQUEST" });
    return this.request(this.subjectPath(`/memories/${encodeURIComponent(id)}`));
  }

  async forget(id) {
    if (!id) throw new MemoryApiError("memory id is required (--id).", { code: "INVALID_REQUEST" });
    return this.request(this.subjectPath(`/memories/${encodeURIComponent(id)}`), { method: "DELETE" });
  }

  async deleteMemory(id) {
    return this.forget(id);
  }

  async deleteSession(sessionId) {
    assertChars(LIMITS.sessionIdChars, sessionId, "session id");
    if (!sessionId) throw new MemoryApiError("session id is required (--session-id).", { code: "INVALID_REQUEST" });
    return this.request(this.subjectPath(`/sessions/${encodeURIComponent(sessionId)}`), { method: "DELETE" });
  }

  summary() {
    return this.request(this.subjectPath("/summary"));
  }

  relationship() {
    return this.request(this.subjectPath("/relationship"));
  }

  exportProfile(options = {}) {
    return this.request(this.subjectPath("/export"), { method: "POST", body: options });
  }

  deleteProfile(options = {}) {
    return this.request(this.subjectPath("/profile"), { method: "DELETE", body: options });
  }

  /**
   * Admin reconciliation entry points (§39.3, §28.3). These are the operator
   * surface of the same subject scope; they never mutate without a call.
   */
  repairOutbox({ dryRun = true, limit, includeErrors } = {}) {
    return this.request(this.subjectPath("/repair/outbox"), {
      method: "POST",
      body: { dryRun, limit, includeErrors },
    });
  }

  repairJobs({ dryRun = true, olderThanSeconds, statuses } = {}) {
    return this.request(this.subjectPath("/repair/jobs"), {
      method: "POST",
      body: { dryRun, olderThanSeconds, statuses },
    });
  }
}

function searchBody(query, options) {
  assertWithin(LIMITS.queryBytes, query, "query");
  if (!query || !String(query).trim()) {
    throw new MemoryApiError("query is required (--query).", { code: "INVALID_REQUEST" });
  }
  const body = { query };
  for (const key of ["limit", "type", "subjectKey", "sessionId", "active", "includeSuperseded"]) {
    if (options[key] !== undefined) body[key] = options[key];
  }
  if (body.limit !== undefined) {
    const limit = Number(body.limit);
    if (!Number.isFinite(limit) || limit < 1 || limit > LIMITS.searchLimit) {
      throw new MemoryApiError(`--limit must be between 1 and ${LIMITS.searchLimit}.`, { code: "INVALID_REQUEST" });
    }
  }
  return body;
}

function error_code(envelope) {
  return envelope.error?.code;
}

function httpCode(status) {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "MEMORY_NOT_FOUND";
  if (status === 409) return "MEMORY_CONFLICT";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  return "INTERNAL_ERROR";
}
