import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, MemoryApiClient, MemoryApiError } from "../src/client.mjs";

function mockFetch(handler) {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, ...init });
    return handler(url, init, seen.length - 1);
  };
  return { fetchFn, seen };
}

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "status",
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const clientWith = (handler, extra = {}) => {
  const { fetchFn, seen } = mockFetch(handler);
  const client = new MemoryApiClient({
    endpoint: "https://memory.test",
    token: "admin-token",
    namespace: "prod",
    character: "mei",
    subject: "user-123",
    fetchFn,
    ...extra,
  });
  return { client, seen };
};

test("§10 routes: every operation hits its documented method and path", async () => {
  const { client, seen } = clientWith(() => response({ ok: true, data: { echo: true } }));
  await client.health();
  await client.remember({ content: "紅茶が好き", type: "fact" });
  await client.search("好きな飲み物", { limit: 5 });
  await client.recall("好きな飲み物");
  await client.list({ type: "task", limit: 20 });
  await client.get("m1");
  await client.forget("m1");
  await client.appendMessages([{ role: "user", content: "hello" }], "s1");
  await client.ingest({ sessionId: "s1", messages: [{ role: "user", content: "hello" }] });
  await client.deleteSession("s1");
  await client.exportProfile({ includeRaw: true });
  await client.deleteProfile({ reason: "gdpr" });
  await client.repairOutbox({ dryRun: true });
  await client.repairJobs({ dryRun: false, olderThanSeconds: 600 });
  await client.summary();
  await client.relationship();

  const base = "/v1/namespaces/prod/characters/mei/subjects/user-123";
  const actual = seen.map((call) => `${call.method} ${call.url.replace("https://memory.test", "").split("?")[0]}`);
  assert.deepEqual(actual, [
    "GET /v1/health",
    `POST ${base}/remember`,
    `POST ${base}/search`,
    `POST ${base}/recall`,
    `GET ${base}/memories`,
    `GET ${base}/memories/m1`,
    `DELETE ${base}/memories/m1`,
    `POST ${base}/messages`,
    `POST ${base}/ingest`,
    `DELETE ${base}/sessions/s1`,
    `POST ${base}/export`,
    `DELETE ${base}/profile`,
    `POST ${base}/repair/outbox`,
    `POST ${base}/repair/jobs`,
    `GET ${base}/summary`,
    `GET ${base}/relationship`,
  ]);
});

test("identity segments are URL-encoded and bearer token is attached", async () => {
  const { client, seen } = clientWith(() => response({ ok: true, data: {} }));
  await client.list({ sessionId: "s/1 x" });
  assert.equal(seen[0].headers.authorization, "Bearer admin-token");
  assert.ok(
    seen[0].url.startsWith("https://memory.test/v1/namespaces/prod/characters/mei/subjects/user-123/memories?"),
    seen[0].url,
  );
  assert.ok(seen[0].url.includes("sessionId=s%2F1+x"), seen[0].url);

  const tricky = new MemoryApiClient({
    endpoint: "https://memory.test",
    namespace: "ns a",
    character: "char/b",
    subject: "s?c+é",
    fetchFn: async () => response({ ok: true, data: {} }),
  });
  assert.equal(
    tricky.subjectPath("/search"),
    "/v1/namespaces/ns%20a/characters/char%2Fb/subjects/s%3Fc%2B%C3%A9/search",
  );
});

test("list filters become query parameters (§36)", async () => {
  const { client, seen } = clientWith(() => response({ ok: true, data: { result: [] } }));
  await client.list({ type: "event", active: true, subjectKey: "work", createdBefore: 1000, limit: 25 });
  const url = new URL(seen[0].url);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    type: "event",
    active: "true",
    subjectKey: "work",
    createdBefore: "1000",
    limit: "25",
  });
});

test("§11 envelope is unwrapped so callers get data directly", async () => {
  const { client } = clientWith(() => response({ ok: true, data: { count: 2, candidates: [{ id: "a" }, { id: "b" }] }, requestId: "r1" }));
  const result = await client.search("q");
  assert.deepEqual(result, { count: 2, candidates: [{ id: "a" }, { id: "b" }] });
});

test("non-enveloped responses are tolerated (starter Worker shape)", async () => {
  const okClient = clientWith(() => response({ result: [{ id: "a" }] }));
  assert.deepEqual(await okClient.client.list(), { result: [{ id: "a" }] });

  const starter = clientWith(() => response({ error: "not found" }, 404));
  await assert.rejects(starter.client.get("nope"), (error) => {
    assert.equal(error instanceof MemoryApiError, true);
    assert.equal(error.message, "not found");
    assert.equal(error.status, 404);
    return true;
  });
});

test("§11.1 HTTP status maps to stable error codes", async () => {
  const cases = [
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "MEMORY_NOT_FOUND"],
    [409, "MEMORY_CONFLICT"],
    [413, "PAYLOAD_TOO_LARGE"],
    [429, "RATE_LIMITED"],
    [503, "INTERNAL_ERROR"],
  ];
  for (const [status, code] of cases) {
    const { client } = clientWith(() => response({}, status));
    await assert.rejects(client.get("x"), (error) => {
      assert.equal(error.code, code, `status ${status}`);
      assert.equal(error.status, status);
      return true;
    });
  }
});

test("server-provided error codes and requestIds win over status mapping", async () => {
  const { client } = clientWith(() =>
    response({ ok: false, error: { code: "PROFILE_DELETING", message: "erasing" }, requestId: "req-9" }, 409),
  );
  await assert.rejects(client.list(), (error) => {
    assert.equal(error.code, "PROFILE_DELETING");
    assert.equal(error.message, "erasing");
    assert.equal(error.requestId, "req-9");
    return true;
  });
});

test("ok:false in a 200 envelope still throws", async () => {
  const { client } = clientWith(() => response({ ok: false, error: { code: "VECTOR_TEMPORARILY_UNAVAILABLE", message: "warm up" } }));
  await assert.rejects(client.search("q"), { code: "VECTOR_TEMPORARILY_UNAVAILABLE" });
});

test("§12 limits are enforced before the request leaves the machine", async () => {
  const { client, seen } = clientWith(() => response({ ok: true, data: {} }));

  await assert.rejects(client.search("あ".repeat(600)), { code: "PAYLOAD_TOO_LARGE" });
  await assert.rejects(client.remember({ content: "あ".repeat(20_000) }), { code: "PAYLOAD_TOO_LARGE" });
  await assert.rejects(client.appendMessages([{ role: "user", content: "x".repeat(40_000) }], "s1"), { code: "PAYLOAD_TOO_LARGE" });
  await assert.rejects(client.list({ limit: 500 }), { code: "INVALID_REQUEST" });
  await assert.rejects(client.search("q", { limit: 51 }), { code: "INVALID_REQUEST" });
  await assert.rejects(client.ingest({ sessionId: "s", messages: [] }), { code: "INVALID_REQUEST" });
  await assert.rejects(client.ingest({ sessionId: "s", messages: new Array(501).fill({ role: "user", content: "x" }) }), {
    code: "INVALID_REQUEST",
  });
  await assert.rejects(client.deleteSession(""), { code: "INVALID_REQUEST" });
  await assert.rejects(client.forget(undefined), { code: "INVALID_REQUEST" });
  assert.equal(seen.length, 0, "no request should have been sent");
});

test("multi-byte queries are measured in bytes, not characters", async () => {
  const { client, seen } = clientWith(() => response({ ok: true, data: {} }));
  const fits = "あ".repeat(Math.floor(LIMITS.queryBytes / Buffer.byteLength("あ", "utf8")));
  await client.search(fits);
  assert.equal(seen.length, 1);
  await assert.rejects(client.search(`${fits}あ`), { code: "PAYLOAD_TOO_LARGE" });
});

test("identity validation happens at construction time", () => {
  assert.throws(() => new MemoryApiClient({ subject: "s" }), /endpoint is required/);
  assert.throws(() => new MemoryApiClient({ endpoint: "https://x.test" }), /subject is required/);
  assert.equal(new MemoryApiClient({ endpoint: "https://x.test", profile: "alias" }).subject, "alias");
  assert.throws(
    () => new MemoryApiClient({ endpoint: "https://x.test", subject: "x".repeat(300) }),
    /subject id exceeds 256 characters/,
  );
});

test("search body only carries supported options", async () => {
  const { client, seen } = clientWith(() => response({ ok: true, data: {} }));
  await client.search("q", { limit: 3, type: "task", subjectKey: "k", nonsense: "ignored" });
  assert.deepEqual(JSON.parse(seen[0].body), { query: "q", limit: 3, type: "task", subjectKey: "k" });
});
