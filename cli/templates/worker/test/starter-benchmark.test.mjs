import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** §48 quality dataset contract, checked offline so a broken dataset never reaches CI gates. */
const here = path.dirname(fileURLToPath(import.meta.url));
const DATASET = path.join(here, "benchmark", "ja-memory-v1.jsonl");

const QUOTAS = {
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

const scenarios = fs
  .readFileSync(DATASET, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${DATASET}:${index + 1} is not valid JSON (${error.message})`);
    }
  });

test("ja-memory-v1 meets the §48 minimum of 100 scenarios with unique ids", () => {
  assert.ok(scenarios.length >= 100, `${scenarios.length} scenarios, need >= 100`);
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  assert.equal(ids.size, scenarios.length, "duplicate scenario id");
});

test("every §48 category quota is satisfied", () => {
  for (const [category, want] of Object.entries(QUOTAS)) {
    const have = scenarios.filter((scenario) => scenario.category === category).length;
    assert.ok(have >= want, `${category}: ${have} < ${want}`);
  }
  const unknown = scenarios.filter((scenario) => !(scenario.category in QUOTAS)).map((scenario) => scenario.id);
  assert.deepEqual(unknown, [], "scenarios outside the frozen category list");
});

test("each scenario is runnable and scored", () => {
  for (const scenario of scenarios) {
    assert.ok(String(scenario.query ?? "").trim().length > 0, `${scenario.id}: empty query`);
    assert.ok(Array.isArray(scenario.setup) && scenario.setup.length > 0, `${scenario.id}: needs setup`);
    for (const step of scenario.setup) {
      assert.ok(["remember", "messages", "forget"].includes(step.op), `${scenario.id}: unknown op ${step.op}`);
      if (step.op === "remember") assert.ok(String(step.content ?? "").trim().length > 0, `${scenario.id}: empty remember`);
      if (step.op === "messages") assert.ok(Array.isArray(step.messages) && step.messages.length > 0, `${scenario.id}: empty messages`);
      if (step.op === "forget") assert.ok(String(step.selector ?? "").length > 0, `${scenario.id}: forget needs a selector`);
    }
    const scored = (scenario.expect?.anyOf?.length ?? 0) + (scenario.expect?.allOf?.length ?? 0) > 0 || (scenario.leakProbe?.length ?? 0) > 0;
    assert.ok(scored, `${scenario.id}: nothing to score`);
  }
});

test("the dataset covers leakage, staleness, supersession and message-driven extraction", () => {
  const has = (predicate) => assert.ok(scenarios.some(predicate), "dataset lost a required scenario shape");
  has((scenario) => scenario.leakProbe?.length);
  has((scenario) => scenario.expect?.noneOf?.length);
  has((scenario) => scenario.supersession?.drop?.length || scenario.setup?.some((step) => step.op === "forget"));
  has((scenario) => scenario.setup?.some((step) => step.op === "messages"));
  has((scenario) => scenario.setup?.some((step) => step.profile === "decoy"));
});

test("the dataset is Japanese (§48 targets a Japanese-language product)", () => {
  const japanese = /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u;
  const share = scenarios.filter((scenario) => japanese.test(`${scenario.query} ${JSON.stringify(scenario.setup)}`)).length;
  assert.ok(share / scenarios.length >= 0.9, `${share}/${scenarios.length} scenarios contain Japanese text`);
});
