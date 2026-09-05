import test from "node:test";
import assert from "node:assert/strict";
import { estimateCost } from "./src/cost.mjs";

test("cost estimator is deterministic and includes base fee", () => {
  const a = estimateCost({ dau: 200, turns: 12, recallRate: 0.2 });
  const b = estimateCost({ dau: 200, turns: 12, recallRate: 0.2 });
  assert.deepEqual(a, b);
  assert.ok(a.cost.total >= 5);
  assert.equal(a.usage.userTurns, 72_000);
});

test("recall rate is capped at 1", () => {
  const result = estimateCost({ dau: 1, turns: 10, days: 1, recallRate: 5 });
  assert.equal(result.usage.recalls, 10);
});

import { MemoryApiClient } from "./src/client.mjs";

test("client subject path includes namespace, character, and subject", () => {
  const client = new MemoryApiClient({
    endpoint: "https://example.test",
    namespace: "prod",
    character: "mei",
    subject: "user-123",
  });
  assert.equal(
    client.subjectPath("/search"),
    "/v1/namespaces/prod/characters/mei/subjects/user-123/search",
  );
});
