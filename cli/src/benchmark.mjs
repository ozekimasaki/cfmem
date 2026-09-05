import { estimateCost } from "./cost.mjs";

export const BENCHMARK_VERSION = "ja-memory-v1";

/** §48 category quotas — minimum 100 scenarios before public production. */
export const CATEGORY_QUOTAS = {
  stable_evolving_preference: 20,
  contradictory_fact: 15,
  event_recall: 15,
  instruction: 10,
  task: 10,
  ambiguous_reference: 10,
  person_project_continuity: 10,
  explicit_remember_delete: 5,
  adversarial_injection: 5,
};

export const MIN_SCENARIOS = 100;

const VALID_CATEGORIES = new Set(Object.keys(CATEGORY_QUOTAS));
const MEMORY_TYPES = new Set(["fact", "event", "instruction", "task"]);
const OPS = new Set(["remember", "messages", "forget"]);

export function parseDataset(text, { file = "<stdin>" } = {}) {
  const scenarios = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      scenarios.push(JSON.parse(line));
    } catch (error) {
      errors.push(`${file}:${index + 1}: invalid JSON (${error.message})`);
    }
  });
  return { scenarios, errors };
}

export function validateDataset(scenarios) {
  const errors = [];
  const seen = new Set();
  const counts = {};
  for (const [index, scenario] of scenarios.entries()) {
    const label = scenario?.id ?? `#${index + 1}`;
    if (!scenario?.id) errors.push(`${label}: missing id`);
    if (seen.has(scenario?.id)) errors.push(`${label}: duplicate id`);
    seen.add(scenario?.id);
    if (!VALID_CATEGORIES.has(scenario?.category)) errors.push(`${label}: unknown category "${scenario?.category}"`);
    counts[scenario?.category] = (counts[scenario?.category] ?? 0) + 1;
    if (typeof scenario?.query !== "string" || !scenario.query.trim()) errors.push(`${label}: missing query`);
    if (!Array.isArray(scenario?.setup) || scenario.setup.length === 0) errors.push(`${label}: missing setup`);
    for (const [setupIndex, step] of (scenario?.setup ?? []).entries()) {
      if (!OPS.has(step?.op)) errors.push(`${label}.setup[${setupIndex}]: op must be one of ${[...OPS].join(", ")}`);
      if (step?.op === "remember") {
        if (!step?.content) errors.push(`${label}.setup[${setupIndex}]: remember needs content`);
        if (step?.type !== undefined && !MEMORY_TYPES.has(step.type)) errors.push(`${label}.setup[${setupIndex}]: bad memory type "${step.type}"`);
      }
      if (step?.op === "messages") {
        if (!step?.sessionId) errors.push(`${label}.setup[${setupIndex}]: messages needs sessionId`);
        if (!Array.isArray(step?.messages) || step.messages.length === 0) errors.push(`${label}.setup[${setupIndex}]: messages needs a non-empty messages array`);
      }
      if (step?.op === "forget" && !step?.selector) errors.push(`${label}.setup[${setupIndex}]: forget needs selector (content substring of the memory to delete)`);
      if (step?.profile !== undefined && !["primary", "decoy"].includes(step.profile)) {
        errors.push(`${label}.setup[${setupIndex}]: profile must be "primary" or "decoy"`);
      }
    }
    if (!scenario?.expect && !scenario?.leakProbe) errors.push(`${label}: needs expect or leakProbe`);
    for (const key of ["anyOf", "allOf", "noneOf"]) {
      const value = scenario?.expect?.[key];
      if (value !== undefined && !Array.isArray(value)) errors.push(`${label}.expect.${key}: must be an array`);
    }
    if (scenario?.profile !== undefined && !["primary", "decoy"].includes(scenario.profile)) {
      errors.push(`${label}: profile must be "primary" or "decoy"`);
    }
  }
  const quotaShortfalls = Object.entries(CATEGORY_QUOTAS)
    .filter(([category, want]) => (counts[category] ?? 0) < want)
    .map(([category, want]) => ({ category, have: counts[category] ?? 0, want }));
  return {
    ok: errors.length === 0,
    totals: scenarios.length,
    counts,
    quotaShortfalls,
    belowMinimum: scenarios.length < MIN_SCENARIOS ? { have: scenarios.length, want: MIN_SCENARIOS } : null,
    errors,
  };
}

const candidateText = (candidate) => {
  const record = candidate?.memory ?? candidate;
  return [record?.content, record?.summary, record?.subject_key, record?.subjectKey].filter(Boolean).join("\n");
};

const containsAny = (candidates, needles) =>
  needles.some((needle) => candidates.some((candidate) => candidateText(candidate).includes(needle)));

const firstRank = (candidates, needles) => {
  for (const [index, candidate] of candidates.entries()) {
    if (needles.some((needle) => candidateText(candidate).includes(needle))) return index + 1;
  }
  return null;
};

export async function runBenchmark({
  scenarios,
  remember,
  appendMessages,
  forgetContent,
  search,
  k = 10,
  applySetup = true,
  pause = () => {},
  now = () => Date.now(),
}) {
  const results = [];
  for (const scenario of scenarios) {
    const scenarioProfile = scenario.profile ?? "primary";
    let turns = 0;
    if (applySetup) {
      for (const step of scenario.setup ?? []) {
        const profile = step.profile ?? scenarioProfile;
        if (step.op === "remember") await remember({ profile, content: step.content, type: step.type, subjectKey: step.subjectKey });
        else if (step.op === "messages") {
          const userTurns = step.messages.filter((message) => message?.role === "user").length;
          turns += userTurns || step.messages.length;
          await appendMessages({ profile, sessionId: step.sessionId, messages: step.messages });
        } else if (step.op === "forget") {
          if (!forgetContent) throw new Error(`scenario ${scenario.id}: setup uses "forget" but no forgetContent hook was provided`);
          await forgetContent({ profile, selector: step.selector });
        }
      }
      await pause(scenario);
    }
    const started = now();
    let candidates = [];
    let error = null;
    try {
      const response = await search({ query: scenario.query, limit: Math.max(k, 10), profile: scenarioProfile });
      candidates = extractCandidates(response);
    } catch (caught) {
      error = caught?.message ?? String(caught);
    }
    const latencyMs = now() - started;
    results.push({ ...scoreScenario({ scenario, candidates, k, latencyMs, error }), turns: Math.max(turns, 1) });
  }
  return results;
}

export function extractCandidates(response) {
  if (Array.isArray(response)) return response;
  const source = response?.data ?? response;
  return source?.candidates ?? source?.results ?? source?.memories ?? source?.items ?? [];
}

export function scoreScenario({ scenario, candidates, k = 10, latencyMs = 0, error = null }) {
  const expect = scenario.expect ?? {};
  const positive = [...(expect.allOf ?? []), ...(expect.anyOf ?? [])];
  const anyOf = expect.anyOf ?? [];
  const allOf = expect.allOf ?? [];
  const noneOf = expect.noneOf ?? [];
  const keep = scenario.supersession?.keep ?? [];
  const drop = scenario.supersession?.drop ?? [];
  const top5 = candidates.slice(0, 5);

  const rank = positive.length ? firstRank(candidates, positive) : null;
  const satisfied = positive.length === 0 ? null : rank !== null && rank <= k;
  const relevantInTop5 = allOf.length || anyOf.length ? top5.filter((candidate) =>
    positive.some((needle) => candidateText(candidate).includes(needle)),
  ).length : 0;

  return {
    id: scenario.id,
    category: scenario.category,
    profile: scenario.profile ?? "primary",
    returned: candidates.length,
    rank,
    satisfied,
    relevantInTop5,
    scored: positive.length > 0,
    staleHit: noneOf.length ? containsAny(candidates, noneOf) : null,
    keepMissing: keep.length ? keep.some((needle) => !containsAny(candidates, [needle])) : null,
    dropApplied: drop.length ? drop.every((needle) => !containsAny(candidates, [needle])) : null,
    leakage: (scenario.leakProbe ?? []).length ? containsAny(candidates, scenario.leakProbe) : null,
    messageDriven: (scenario.setup ?? []).some((step) => step.op === "messages"),
    latencyMs,
    error,
  };
}

const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
const count = (values) => values.filter(Boolean).length;
const defined = (values) => values.filter((value) => value !== null && value !== undefined);

export function percentile(values, p) {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function computeMetrics(results, { costAssumptions = {} } = {}) {
  const scored = results.filter((result) => result.scored);
  const leakageProbes = defined(results.map((result) => result.leakage));
  const staleChecks = defined(results.map((result) => result.staleHit));
  const keepChecks = defined(results.map((result) => result.keepMissing));
  const dropChecks = defined(results.map((result) => result.dropApplied));
  const messageDriven = scored.filter((result) => result.messageDriven);
  const latencies = results.map((result) => result.latencyMs);
  const turns = results.length ? results.reduce((sum, result) => sum + (result.turns ?? 1), 0) || results.length : 0;
  const cost = estimateCost({ dau: 1, days: 30, turns: 1, ...costAssumptions });
  const monthlyTurns = cost.usage.userTurns || 1;

  return {
    scenarios: results.length,
    errors: count(results.map((result) => result.error)),
    recallAt5: rate(count(scored.filter((result) => result.rank !== null && result.rank <= 5)), scored.length),
    recallAt10: rate(count(scored.filter((result) => result.satisfied)), scored.length),
    precisionAt5: rate(
      scored.reduce((sum, result) => sum + Math.min(result.relevantInTop5, 5), 0),
      scored.length * 5,
    ),
    zeroResultRate: rate(count(results.filter((result) => result.returned === 0)), results.length),
    staleMemoryRate: rate(count(staleChecks), staleChecks.length),
    falseSupersessionRate: rate(count(keepChecks), keepChecks.length),
    supersessionAppliedRate: rate(count(dropChecks.filter((value) => value === true)), dropChecks.length),
    crossProfileLeakage: count(leakageProbes.filter((value) => value === true)),
    leakageProbes: leakageProbes.length,
    extractionAcceptanceRate: rate(count(messageDriven.filter((result) => result.satisfied)), messageDriven.length),
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    estimatedCostPer1kTurns: (cost.cost.total / monthlyTurns) * 1000,
    observedTurns: turns,
  };
}

/** §48 + §60 release gates. */
export function evaluateGates(metrics, dataset) {
  const gates = [];
  const push = (name, pass, detail) => gates.push({ name, pass: Boolean(pass), detail });
  push("dataset >= 100 scenarios", dataset.totals >= MIN_SCENARIOS, `${dataset.totals} scenarios`);
  push("category quotas met", dataset.quotaShortfalls.length === 0, dataset.quotaShortfalls.map((s) => `${s.category} ${s.have}/${s.want}`).join(", ") || "all categories satisfied");
  push("dataset schema valid", dataset.ok, dataset.errors.slice(0, 3).join("; ") || "no schema errors");
  push("cross-profile leakage == 0", metrics.crossProfileLeakage === 0, `${metrics.crossProfileLeakage} leakages over ${metrics.leakageProbes} probes`);
  push("no scenario errors", metrics.errors === 0, `${metrics.errors} errored scenarios`);
  if (metrics.recallAt5 !== null) push("Recall@5 >= 0.70", metrics.recallAt5 >= 0.7, metrics.recallAt5.toFixed(3));
  if (metrics.staleMemoryRate !== null) push("stale-memory rate <= 0.05", metrics.staleMemoryRate <= 0.05, metrics.staleMemoryRate.toFixed(3));
  if (metrics.falseSupersessionRate !== null) push("false-supersession rate <= 0.05", metrics.falseSupersessionRate <= 0.05, metrics.falseSupersessionRate.toFixed(3));
  return { gates, passed: gates.every((gate) => gate.pass) };
}

const pct = (value) => (value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);

export function formatBenchmarkReport({ metrics, dataset, gates, byCategory }) {
  const row = (label, value) => `  ${label.padEnd(30)}${value}`;
  return [
    `Benchmark ${BENCHMARK_VERSION} — ${metrics.scenarios} scenarios`,
    "",
    row("Recall@5", pct(metrics.recallAt5)),
    row("Recall@10", pct(metrics.recallAt10)),
    row("Precision@5", pct(metrics.precisionAt5)),
    row("zero-result rate", pct(metrics.zeroResultRate)),
    row("stale-memory rate", pct(metrics.staleMemoryRate)),
    row("false-supersession rate", pct(metrics.falseSupersessionRate)),
    row("supersession applied", pct(metrics.supersessionAppliedRate)),
    row("extraction acceptance", pct(metrics.extractionAcceptanceRate)),
    row("cross-profile leakage", `${metrics.crossProfileLeakage} (target 0)`),
    row("retrieval latency p50/p95", `${metrics.latency.p50 ?? "n/a"}ms / ${metrics.latency.p95 ?? "n/a"}ms`),
    row("est. cost / 1k turns", `$${metrics.estimatedCostPer1kTurns.toFixed(4)}`),
    "",
    "By category:",
    ...byCategory.map((entry) => `  ${entry.category.padEnd(30)}${entry.scenarios} scenarios, Recall@10 ${pct(entry.recallAt10)}`),
    "",
    dataset.quotaShortfalls.length ? `Category shortfalls: ${dataset.quotaShortfalls.map((s) => `${s.category} ${s.have}/${s.want}`).join(", ")}` : "Category quotas: satisfied",
    dataset.errors.length ? `Schema errors: ${dataset.errors.length}` : "Schema: valid",
    "",
    "Gates:",
    ...gates.gates.map((gate) => `  ${gate.pass ? "PASS" : "FAIL"} ${gate.name} — ${gate.detail}`),
    "",
    gates.passed ? "All benchmark gates passed." : "Benchmark gates failed: the backend is not release-ready on quality.",
  ].join("\n");
}

export function summarizeByCategory(results) {
  const groups = new Map();
  for (const result of results) {
    const entry = groups.get(result.category) ?? { category: result.category, scenarios: 0, satisfied: 0, scored: 0 };
    entry.scenarios += 1;
    if (result.scored) {
      entry.scored += 1;
      if (result.satisfied) entry.satisfied += 1;
    }
    groups.set(result.category, entry);
  }
  return [...groups.values()].map((entry) => ({
    category: entry.category,
    scenarios: entry.scenarios,
    recallAt10: rate(entry.satisfied, entry.scored),
  }));
}
