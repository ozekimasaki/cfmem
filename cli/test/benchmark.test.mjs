import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CATEGORY_QUOTAS,
  MIN_SCENARIOS,
  computeMetrics,
  evaluateGates,
  extractCandidates,
  formatBenchmarkReport,
  parseDataset,
  percentile,
  runBenchmark,
  scoreScenario,
  summarizeByCategory,
  validateDataset,
} from "../src/benchmark.mjs";
import { DATASET } from "./helpers/cli.mjs";

const memory = (content, extra = {}) => ({ content, summary: content, ...extra });

test("§48: the shipped Japanese dataset satisfies quotas and schema", () => {
  const { scenarios, errors } = parseDataset(fs.readFileSync(DATASET, "utf8"), { file: DATASET });
  assert.deepEqual(errors, []);
  const dataset = validateDataset(scenarios);
  assert.equal(dataset.ok, true, dataset.errors.join("; "));
  assert.equal(dataset.errors.length, 0);
  assert.ok(dataset.totals >= MIN_SCENARIOS, `${dataset.totals} scenarios`);
  assert.deepEqual(dataset.quotaShortfalls, []);
  assert.equal(dataset.belowMinimum, null);
  for (const [category, want] of Object.entries(CATEGORY_QUOTAS)) {
    assert.ok(dataset.counts[category] >= want, `${category}: ${dataset.counts[category]} < ${want}`);
  }
  assert.equal(scenarios.every((scenario) => /[ぁ-んァ-ン一-龥]/.test(scenario.query)), true, "every query is Japanese");
});

test("dataset validation rejects schema violations and quota shortfalls", () => {
  const broken = [
    { category: "nope", query: "q", setup: [{ op: "write", content: "x" }], expect: {} },
    { id: "dup", category: "task", query: "", setup: [], expect: {} },
    { id: "dup", category: "task", query: "q", setup: [{ op: "forget" }], expect: {} },
    { id: "bad-type", category: "task", query: "q", setup: [{ op: "remember", content: "c", type: "wish" }], expect: { anyOf: "c" } },
    { id: "bad-profile", category: "task", query: "q", setup: [{ op: "remember", content: "c", profile: "other" }], expect: {} },
    { id: "no-expect", category: "task", query: "q", setup: [{ op: "messages", messages: [] }] },
  ];
  const result = validateDataset(broken);
  assert.equal(result.ok, false);
  const joined = result.errors.join("\n");
  assert.match(joined, /#1: missing id/);
  assert.match(joined, /unknown category "nope"/);
  assert.match(joined, /op must be one of/);
  assert.match(joined, /dup: duplicate id/);
  assert.match(joined, /missing query/);
  assert.match(joined, /missing setup/);
  assert.match(joined, /forget needs selector/);
  assert.match(joined, /bad memory type "wish"/);
  assert.match(joined, /anyOf: must be an array/);
  assert.match(joined, /profile must be "primary" or "decoy"/);
  assert.match(joined, /needs expect or leakProbe/);
  assert.match(joined, /messages needs sessionId/);
  assert.ok(result.quotaShortfalls.length >= 1);

  const parse = parseDataset('{"id":"a"}\nnot json\n\n{"id":"b"}');
  assert.equal(parse.scenarios.length, 2);
  assert.equal(parse.errors.length, 1);
  assert.match(parse.errors[0], /<stdin>:2: invalid JSON/);
});

test("scoreScenario scores rank, staleness, supersession and leakage", () => {
  const scenario = {
    id: "x-1",
    category: "contradictory_fact",
    query: "今どこ?",
    setup: [{ op: "remember", content: "川崎在住" }],
    expect: { anyOf: ["川崎"], allOf: ["在住"], noneOf: ["横浜"] },
    supersession: { keep: ["川崎"], drop: ["横浜"] },
    leakProbe: ["部外秘"],
  };
  const candidates = [memory("別の話題"), memory("今は川崎在住です")];
  const scored = scoreScenario({ scenario, candidates, k: 10, latencyMs: 12 });
  assert.equal(scored.rank, 2);
  assert.equal(scored.satisfied, true);
  assert.equal(scored.relevantInTop5, 1, "only one candidate matches a positive needle");
  assert.equal(scored.scored, true);
  assert.equal(scored.staleHit, false);
  assert.equal(scored.keepMissing, false);
  assert.equal(scored.dropApplied, true);
  assert.equal(scored.leakage, false);
  assert.equal(scored.returned, 2);
  assert.equal(scored.latencyMs, 12);

  const stale = scoreScenario({ scenario, candidates: [...candidates, memory("横浜のアパート")], k: 10 });
  assert.equal(stale.staleHit, true);
  assert.equal(stale.keepMissing, false);
  const missing = scoreScenario({ scenario, candidates: [memory("別の話題")], k: 1 });
  assert.equal(missing.satisfied, false, "rank 2 exceeds k=1");
  const leak = scoreScenario({ scenario, candidates: [memory("部外秘の記録"), memory("今は川崎在住です")] });
  assert.equal(leak.leakage, true);
  const unscored = scoreScenario({ scenario: { ...scenario, expect: {} }, candidates: [] });
  assert.equal(unscored.scored, false);
  assert.equal(unscored.satisfied, null);
});

test("percentile uses the nearest-rank method", () => {
  const values = [10, 90, 20, 30, 40, 50, 60, 70, 80, 100];
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 100);
  assert.equal(percentile(values, 100), 100);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, Number.NaN], 50), 5);
});

test("computeMetrics turns scored results into §48 metrics", () => {
  const results = [
    { id: "1", category: "instruction", scored: true, satisfied: true, rank: 1, relevantInTop5: 2, returned: 10, staleHit: null, keepMissing: null, dropApplied: null, leakage: null, messageDriven: true, latencyMs: 10, turns: 2, error: null },
    { id: "2", category: "instruction", scored: true, satisfied: true, rank: 5, relevantInTop5: 1, returned: 10, staleHit: false, keepMissing: false, dropApplied: true, leakage: false, latencyMs: 20, turns: 1, error: null },
    { id: "3", category: "event_recall", scored: true, satisfied: false, rank: 9, relevantInTop5: 0, returned: 10, staleHit: true, keepMissing: true, dropApplied: false, leakage: false, latencyMs: 30, turns: 3, error: null },
    { id: "4", category: "event_recall", scored: true, satisfied: false, rank: null, relevantInTop5: 0, returned: 0, latencyMs: 40, turns: 1, error: null },
    { id: "5", category: "adversarial_injection", scored: false, satisfied: null, rank: null, relevantInTop5: 0, returned: 3, leakage: true, latencyMs: 50, turns: 1, error: "boom" },
  ];
  const metrics = computeMetrics(results);
  assert.equal(metrics.scenarios, 5);
  assert.equal(metrics.errors, 1);
  assert.equal(metrics.recallAt5, 2 / 4);
  assert.equal(metrics.recallAt10, 2 / 4);
  assert.equal(metrics.precisionAt5, 3 / 20);
  assert.equal(metrics.zeroResultRate, 1 / 5);
  assert.equal(metrics.staleMemoryRate, 1 / 2, "only scenarios that probe staleness are counted");
  assert.equal(metrics.falseSupersessionRate, 1 / 2);
  assert.equal(metrics.supersessionAppliedRate, 1 / 2);
  assert.equal(metrics.crossProfileLeakage, 1);
  assert.equal(metrics.leakageProbes, 3);
  assert.equal(metrics.extractionAcceptanceRate, 1, "the only message-driven scored scenario passed");
  assert.equal(metrics.latency.p50, 30);
  assert.equal(metrics.latency.p95, 50);
  assert.equal(metrics.observedTurns, 8);
  assert.ok(metrics.estimatedCostPer1kTurns > 0);
  const empty = computeMetrics([]);
  assert.equal(empty.recallAt5, null);
  assert.equal(empty.precisionAt5, null);
  assert.equal(empty.zeroResultRate, null);
  assert.equal(empty.scenarios, 0);
});

test("§60 gates fail loudly on leakage and weak recall", () => {
  const dataset = { totals: 105, ok: true, quotaShortfalls: [], errors: [] };
  const good = {
    crossProfileLeakage: 0, errors: 0, recallAt5: 0.8, staleMemoryRate: 0, falseSupersessionRate: 0,
  };
  const passed = evaluateGates(good, dataset);
  assert.equal(passed.passed, true);
  assert.ok(passed.gates.length >= 5);

  const leaky = evaluateGates({ ...good, crossProfileLeakage: 1 }, dataset);
  assert.equal(leaky.passed, false);
  assert.equal(leaky.gates.find((gate) => gate.name.startsWith("cross-profile")).pass, false);

  const weak = evaluateGates({ ...good, recallAt5: 0.4 }, dataset);
  assert.equal(weak.gates.find((gate) => gate.name.startsWith("Recall@5")).pass, false);

  const small = evaluateGates(good, { ...dataset, totals: 40, quotaShortfalls: [{ category: "task", have: 2, want: 10 }], ok: false, errors: ["x"] });
  assert.equal(small.passed, false);
  assert.equal(small.gates.filter((gate) => !gate.pass).length, 3);

  const notMeasured = evaluateGates({ crossProfileLeakage: 0, errors: 0, recallAt5: null, staleMemoryRate: null, falseSupersessionRate: null }, dataset);
  assert.equal(notMeasured.passed, true, "unmeasurable metrics do not fabricate a failure");
  assert.equal(notMeasured.gates.some((gate) => gate.name.startsWith("Recall@5")), false);
});

test("runBenchmark routes each step to its profile and honours hooks", async () => {
  const calls = [];
  const store = new Map();
  const scenarios = [
    {
      id: "a",
      category: "instruction",
      profile: "primary",
      query: "red",
      setup: [
        { op: "remember", content: "red preference" },
        { op: "remember", content: "decoy secret", profile: "decoy" },
        { op: "messages", sessionId: "s1", messages: [{ role: "user", content: "blue note" }, { role: "assistant", content: "ok" }] },
        { op: "forget", selector: "blue note" },
      ],
      expect: { anyOf: ["red"] },
      leakProbe: ["decoy secret"],
    },
    { id: "b", category: "task", query: "nothing matches", setup: [{ op: "remember", content: "green" }], expect: { anyOf: ["nope"] } },
  ];
  const hooks = {
    remember: async ({ profile, content, type }) => {
      calls.push(`remember:${profile}:${content}:${type ?? "-"}`);
      store.set(`${profile}:${content}`, { profile, content, deleted: false });
    },
    appendMessages: async ({ profile, sessionId, messages }) => {
      calls.push(`messages:${profile}:${sessionId}:${messages.length}`);
      for (const message of messages) store.set(`${profile}:${message.content}`, { profile, content: message.content, deleted: false });
    },
    forgetContent: async ({ profile, selector }) => {
      calls.push(`forget:${profile}:${selector}`);
      store.get(`${profile}:${selector}`).deleted = true;
    },
    search: async ({ query, profile, limit }) => {
      calls.push(`search:${profile}:${query}:${limit}`);
      if (query === "boom") throw new Error("vector index unavailable");
      return {
        candidates: [...store.values()]
          .filter((row) => !row.deleted && row.profile === profile && row.content.includes(query))
          .slice(0, limit),
      };
    },
  };
  let clock = 1000;
  const results = await runBenchmark({
    ...hooks,
    scenarios,
    k: 10,
    pause: () => new Promise((resolve) => setTimeout(resolve, 1)),
    now: () => (clock += 5),
  });

  assert.deepEqual(calls, [
    "remember:primary:red preference:-",
    "remember:decoy:decoy secret:-",
    "messages:primary:s1:2",
    "forget:primary:blue note",
    "search:primary:red:10",
    "remember:primary:green:-",
    "search:primary:nothing matches:10",
  ]);
  assert.equal(results[0].satisfied, true);
  assert.equal(results[0].leakage, false, "decoy memories never reach a primary query");
  assert.equal(results[0].turns, 1, "one user message counts as one turn");
  assert.equal(results[0].messageDriven, true);
  assert.equal(results[1].satisfied, false);
  assert.equal(results[1].latencyMs, 5);

  const errored = await runBenchmark({
    ...hooks,
    scenarios: [{ id: "e", category: "task", query: "boom", setup: [{ op: "remember", content: "x" }], expect: { anyOf: ["x"] } }],
  });
  assert.match(errored[0].error, /vector index unavailable/);
  assert.equal(errored[0].returned, 0);

  await assert.rejects(
    runBenchmark({ ...hooks, forgetContent: undefined, scenarios: [{ id: "f", category: "task", query: "x", setup: [{ op: "forget", selector: "y" }], expect: {} }] }),
    /no forgetContent hook/,
  );

  const noSetup = await runBenchmark({ ...hooks, scenarios, applySetup: false, search: async () => ({ candidates: [] }) });
  assert.equal(noSetup.length, 2);
});

test("extractCandidates accepts enveloped, plain and array payloads", () => {
  const rows = [memory("a")];
  assert.deepEqual(extractCandidates({ ok: true, data: { candidates: rows } }), rows);
  assert.deepEqual(extractCandidates({ results: rows }), rows);
  assert.deepEqual(extractCandidates({ memories: rows }), rows);
  assert.deepEqual(extractCandidates(rows), rows);
  assert.deepEqual(extractCandidates(undefined), []);
});

test("report formatting and per-category summary stay readable", () => {
  const results = [
    { id: "1", category: "task", scored: true, satisfied: true, rank: 1, relevantInTop5: 1, returned: 5, latencyMs: 4, turns: 1 },
    { id: "2", category: "task", scored: true, satisfied: false, rank: null, relevantInTop5: 0, returned: 0, latencyMs: 6, turns: 1 },
    { id: "3", category: "instruction", scored: true, satisfied: true, rank: 2, relevantInTop5: 1, returned: 5, latencyMs: 8, turns: 1 },
  ];
  const byCategory = summarizeByCategory(results);
  assert.deepEqual(byCategory, [
    { category: "task", scenarios: 2, recallAt10: 0.5 },
    { category: "instruction", scenarios: 1, recallAt10: 1 },
  ]);

  const metrics = computeMetrics(results);
  const dataset = validateDataset([
    { id: "1", category: "task", query: "q", setup: [{ op: "remember", content: "c" }], expect: { anyOf: ["c"] } },
  ]);
  const report = formatBenchmarkReport({ metrics, dataset, gates: evaluateGates(metrics, dataset), byCategory });
  assert.match(report, /Recall@5\s+66\.7%/);
  assert.match(report, /cross-profile leakage\s+0 \(target 0\)/);
  assert.match(report, /retrieval latency p50\/p95\s+6ms \/ 8ms/);
  assert.match(report, /By category:\n\s+task\s+2 scenarios, Recall@10 50\.0%/);
  assert.match(report, /FAIL dataset >= 100 scenarios — 1 scenarios/);
  assert.match(report, /Category shortfalls: stable_evolving_preference 0\/20/);
  assert.match(report, /Benchmark gates failed/);
});
