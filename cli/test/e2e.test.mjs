import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startMockMemoryServer } from "./helpers/mock-server.mjs";
import { CATEGORY_QUOTAS } from "../src/benchmark.mjs";
import { DATASET, makeTempDir, runCli, TEMPLATE_WRANGLER, writeJson } from "./helpers/cli.mjs";

const SCOPE = ["--namespace", "e2e", "--character", "mei", "--subject", "user-1"];

async function withServer(fn, options) {
  const server = await startMockMemoryServer(options);
  const dir = makeTempDir("cfmem-e2e-");
  const endpointArgs = ["--endpoint", server.url, ...SCOPE];
  try {
    return await fn({ server, dir, endpointArgs });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

const lastJson = (stdout) => JSON.parse(stdout.slice(stdout.indexOf("{")));

test("§58.1 init scaffolds a project without touching Cloudflare", async () => {
  const dir = makeTempDir("cfmem-init-");
  const target = path.join(dir, "kagami");
  try {
    const first = await runCli(["init", target, "--app", "kagami", "--env", "staging"]);
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /app=kagami env=staging -> worker kagami-staging/);

    const config = JSON.parse(fs.readFileSync(path.join(target, "cfmem.config.json"), "utf8"));
    assert.equal(config.app, "kagami");
    assert.equal(config.env, "staging");
    assert.equal(config.benchmarkDataset, "test/benchmark/ja-memory-v1.jsonl");
    assert.ok(config.pricingReviewedAt);

    const plan = fs.readFileSync(path.join(target, "ops", "resources-plan.txt"), "utf8");
    assert.match(plan, /worker\s+kagami-staging/);
    assert.match(plan, /kagami-staging-memory-v1/);
    assert.match(plan, /--property-name=profile_key/);

    const wrangler = fs.readFileSync(path.join(target, "wrangler.jsonc"), "utf8");
    assert.match(wrangler, /"name": "kagami-staging"/);
    assert.match(wrangler, /"index_name": "kagami-staging-memory-v1"/);
    assert.match(wrangler, /"bucket_name": "kagami-staging-archive"/);
    assert.match(wrangler, /"MEMORY_NAMESPACE": "staging"/);
    assert.equal(wrangler.includes("character-memory-dev"), false, "§5.1: a scaffold never points at another environment");
    assert.equal(fs.existsSync(path.join(target, "node_modules")), false, "dependencies are never copied");
    assert.equal(fs.existsSync(path.join(target, "soul.md")), false, "soul.md only arrives with --character-package (§58.1)");
    assert.equal(fs.existsSync(path.join(target, "src", "memory-profile.ts")), true);
    assert.equal(fs.existsSync(path.join(target, "test", "benchmark", "ja-memory-v1.jsonl")), true);

    // §58.1: the generated project is runnable and green on its own, offline.
    // NODE_TEST_CONTEXT makes `node --test` skip every file, so it must not leak in.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const scaffold = spawnSync(process.execPath, ["--test"], {
      cwd: target,
      encoding: "utf8",
      env: childEnv,
    });
    assert.equal(scaffold.status, 0, `${scaffold.stdout}\n${scaffold.stderr}`);
    assert.match(scaffold.stdout, /fail 0/);
    const templateTestFiles = fs.readdirSync(path.join(TEMPLATE_WRANGLER, "..", "test")).filter((f) => f.endsWith(".test.mjs"));
    const declaredTests = Number(/ℹ tests (\d+)/.exec(scaffold.stdout)?.[1] ?? 0);
    assert.ok(
      declaredTests >= templateTestFiles.length,
      `expected the scaffold to run all ${templateTestFiles.length} starter test files, reporter said ${declaredTests}`,
    );

    const refused = await runCli(["init", target]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Destination is not empty/);

    const packaged = await runCli(["init", path.join(dir, "with-soul"), "--character-package"]);
    assert.equal(packaged.code, 0, packaged.stderr);
    assert.match(fs.readFileSync(path.join(dir, "with-soul", "soul.md"), "utf8"), /Immutable identity lives here/);

    const scoped = await runCli(["init", path.join(dir, "scoped"), "--app", "kagami", "--env", "production", "--namespace", "team-a"]);
    assert.equal(scoped.code, 0, scoped.stderr);
    assert.match(fs.readFileSync(path.join(dir, "scoped", "wrangler.jsonc"), "utf8"), /"MEMORY_NAMESPACE": "team-a"/);
    assert.match(fs.readFileSync(path.join(dir, "scoped", "cfmem.config.json"), "utf8"), /"namespace": "team-a"/);
    assert.match(fs.readFileSync(path.join(dir, "scoped", "wrangler.jsonc"), "utf8"), /"name": "kagami-production"/);

    const plain = await runCli(["init", path.join(dir, "plain")]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(fs.readFileSync(path.join(dir, "plain", "wrangler.jsonc"), "utf8"), /character-memory-dev-memory-v1/);

    const longNamespace = await runCli(["init", path.join(dir, "bad-ns"), "--namespace", "n".repeat(33)]);
    assert.equal(longNamespace.code, 1);
    assert.match(longNamespace.stderr, /namespace must be <= 32/);
    assert.equal(fs.existsSync(path.join(dir, "bad-ns")), false, "validation happens before anything is written");

    // Nothing was created remotely: no wrangler state, no credentials needed.
    assert.equal(fs.existsSync(path.join(dir, ".wrangler")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("resources plan is read-only, env-scoped and machine-readable", async () => {
  const plan = await runCli(["resources", "plan", "--env", "production"]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /Planned resources for env=production/);
  assert.match(plan.stdout, /character-memory-production-delete-profile-v1/);
  assert.match(plan.stdout, /No Cloudflare resources were created/);
  assert.equal(plan.stdout.includes("character-memory-dev"), false);

  const json = await runCli(["resources", "plan", "--env", "dev", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.steps.map((step) => step.id), [
    "vectorize-index",
    "vectorize-metadata-indexes",
    "r2-archive",
    "bindings",
    "secrets",
  ]);

  const badEnv = await runCli(["resources", "plan", "--env", "prod"]);
  assert.equal(badEnv.code, 1);
  assert.match(badEnv.stderr, /Unknown --env "prod"/);

  const noSub = await runCli(["resources"]);
  assert.match(noSub.stderr, /resources requires "plan" or "verify"/);
});

test("resources verify without provable remote state must not report success", async () => {
  await withTempProject(async (dir) => {
    const result = await runCli(["resources", "verify", "--env", "dev"], { cwd: dir });
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.ok([1, 2].includes(result.code), `exit ${result.code}`);
    assert.match(result.stdout + result.stderr, /verify|Verification|cfmem:/);
    assert.doesNotMatch(result.stdout, /No configuration drift detected/);
  });
});

async function withTempProject(fn) {
  const dir = makeTempDir("cfmem-verify-");
  fs.copyFileSync(TEMPLATE_WRANGLER, path.join(dir, "wrangler.jsonc"));
  writeJson(path.join(dir, "cfmem.config.json"), { app: "character-memory", env: "dev", namespace: "dev" });
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("memory operations round-trip through the §10 API", async () => {
  await withServer(async ({ server, endpointArgs, dir }) => {
    const remembered = await runCli([...endpointArgs, "remember", "--content", "好きな飲み物は紅茶", "--type", "fact", "--subject-key", "drinks"]);
    assert.equal(remembered.code, 0, remembered.stderr);
    const record = lastJson(remembered.stdout);
    assert.equal(record.content, "好きな飲み物は紅茶");

    const searched = await runCli([...endpointArgs, "search", "--query", "紅茶", "--text"]);
    assert.equal(searched.code, 0, searched.stderr);
    assert.match(searched.stdout, /fact .*mem-\d+\n\s+好きな飲み物は紅茶/);
    assert.match(searched.stdout, /1 candidate\(s\)/);

    const recalled = await runCli([...endpointArgs, "recall", "--query", "紅茶", "--json"]);
    assert.equal(recalled.code, 0, recalled.stderr);
    assert.deepEqual(lastJson(recalled.stdout).data?.synthesized ?? lastJson(recalled.stdout).synthesized, ["好きな飲み物は紅茶"]);

    const listed = await runCli([...endpointArgs, "list", "--type", "fact", "--limit", "5"]);
    assert.equal(listed.code, 0, listed.stderr);
    const page = lastJson(listed.stdout);
    assert.equal(page.result.length, 1);
    assert.equal(page.result[0].subject_key, "drinks");

    const got = await runCli([...endpointArgs, "get", "--id", record.id]);
    assert.equal(got.code, 0, got.stderr);
    assert.equal(lastJson(got.stdout).id, record.id);

    const missing = await runCli([...endpointArgs, "get", "--id", "does-not-exist"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /memory not found/);

    const forgot = await runCli([...endpointArgs, "forget", "--id", record.id]);
    assert.equal(forgot.code, 0, forgot.stderr);
    assert.equal(lastJson(forgot.stdout).tombstone, true);
    const afterForget = await runCli([...endpointArgs, "search", "--query", "紅茶", "--text"]);
    assert.match(afterForget.stdout, /0 candidate\(s\)/);

    // Session deletion is destructive: §58.4 must stop a non-interactive run.
    await runCli([...endpointArgs, "remember", "--content", "セッションの事実", "--session-id", "sess-9"]);
    const unconfirmed = await runCli([...endpointArgs, "delete-session", "--session-id", "sess-9"]);
    assert.equal(unconfirmed.code, 1);
    assert.match(unconfirmed.stderr, /non-interactive/);
    assert.equal(unconfirmed.stderr.includes("--confirm \"e2e/mei/user-1\""), true);

    const confirmed = await runCli([...endpointArgs, "delete-session", "--session-id", "sess-9", "--yes"]);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.equal(lastJson(confirmed.stdout).purged, 1);

    // Namespace/character have documented defaults; the subject never does, because
    // it is what scopes a destructive call to one person's data (§58.4).
    const noIdentity = await runCli(["--endpoint", server.url, "delete-session", "--session-id", "x", "--yes"]);
    assert.equal(noIdentity.code, 1);
    assert.match(noIdentity.stderr, /Missing: subject/);
    assert.equal(
      server.calls.some((call) => call.method === "DELETE" && call.path.endsWith("/sessions/x")),
      false,
      "identity is checked before any request leaves the CLI",
    );

    const repair = await runCli([...endpointArgs, "repair", "outbox"]);
    assert.equal(repair.code, 0, repair.stderr);
    assert.match(repair.stdout, /dry-run by default/);
    const outboxCall = server.calls.find((call) => call.path.endsWith("/repair/outbox"));
    assert.equal(outboxCall.body.dryRun, true);
    const applied = await runCli([...endpointArgs, "repair", "jobs", "--apply", "--older-than", "600"]);
    assert.equal(applied.code, 0, applied.stderr);
    const jobsCall = server.calls.find((call) => call.path.endsWith("/repair/jobs"));
    assert.equal(jobsCall.body.dryRun, false);
    assert.equal(jobsCall.body.olderThanSeconds, 600);

    // Scope is resolved before the request: a subject-less call never leaves the CLI.
    const noSubject = await runCli([...endpointArgs.slice(0, 2), "list"]);
    assert.equal(noSubject.code, 1);
    assert.match(noSubject.stderr, /subject is required/);

    const tooBig = await runCli([...endpointArgs, "list", "--limit", "500"]);
    assert.equal(tooBig.code, 1);
    assert.match(tooBig.stderr, /--limit must be/);
    assert.equal(server.calls.some((call) => call.query?.limit === "500"), false);

    const noEndpoint = await runCli(["list", ...SCOPE], { cwd: dir });
    assert.equal(noEndpoint.code, 1);
    assert.match(noEndpoint.stderr, /--endpoint \(or CFMEM_ENDPOINT\) is required/);

    const paths = new Set(server.calls.map((call) => call.path));
    for (const suffix of ["/remember", "/search", "/recall", "/memories", "/memories/" + record.id, "/repair/outbox", "/repair/jobs"]) {
      assert.ok([...paths].some((path_) => path_.endsWith(suffix)), `missing call to ${suffix}`);
    }
  });
});

test("export writes a §41 artifact and refuses credential-bearing payloads", async () => {
  await withServer(async ({ endpointArgs, dir }) => {
    await runCli([...endpointArgs, "remember", "--content", "持ち出す事実"]);
    const out = path.join(dir, "profile.json");
    const exported = await runCli([...endpointArgs, "export", "--out", out]);
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, new RegExp(`Wrote ${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const payload = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(payload.format, "cf-character-memory-export");
    assert.equal(payload.version, 1);
    assert.equal(payload.memories.length, 1);
    assert.equal(payload.memories[0].content, "持ち出す事実");
    assert.ok(payload.profileKeyFingerprint, "profile key stays a fingerprint");
  });

  await withServer(async ({ endpointArgs, dir }) => {
    const out = path.join(dir, "leaky.json");
    const exported = await runCli([...endpointArgs, "export", "--out", out]);
    assert.equal(exported.code, 1);
    assert.match(exported.stderr, /export refused/);
    assert.equal(fs.existsSync(out), false, "no file is written when credentials would leak");
  }, { exportIncludesSecret: true });
});

test("delete-profile needs an exact echo before erasing", async () => {
  await withServer(async ({ endpointArgs, server }) => {
    await runCli([...endpointArgs, "remember", "--content", "消される事実"]);

    const mismatch = await runCli([...endpointArgs, "delete-profile", "--confirm", "e2e/mei/other"]);
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.stderr, /does not match the resolved identity/);
    assert.equal(server.calls.filter((call) => call.method === "DELETE" && call.path.endsWith("/profile")).length, 0);

    const echo = await runCli([...endpointArgs, "delete-profile", "--confirm", "e2e/mei/user-1", "--reason", "erasure-request"]);
    assert.equal(echo.code, 0, echo.stderr);
    assert.equal(lastJson(echo.stdout).status, "deleting");
    const call = server.calls.find((entry) => entry.method === "DELETE" && entry.path.endsWith("/profile"));
    assert.equal(call.body.reason, "erasure-request");
  });
});

test("benchmark runs the Japanese dataset end to end and reports §48 metrics", async () => {
  await withServer(async ({ endpointArgs, server }) => {
    const result = await runCli([...endpointArgs, "benchmark", "--dataset", DATASET, "--subject", "bench", "--limit-scenarios", "12"]);
    const gateFailure = result.code === 1;
    assert.ok(gateFailure || result.code === 0, `unexpected exit ${result.code}: ${result.stderr}`);
    assert.match(result.stdout, /Benchmark ja-memory-v1 against http/);
    assert.match(result.stdout, /By category:/);
    assert.match(result.stdout, /Gates:/);
    if (gateFailure) assert.match(result.stdout, /gates failed/);

    const json = await runCli([...endpointArgs, "benchmark", "--dataset", DATASET, "--subject", "bench2", "--limit-scenarios", "12", "--skip-setup", "--json"]);
    assert.ok([0, 1].includes(json.code), json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.metrics.scenarios, 12);
    assert.equal(report.metrics.errors, 0, "the CLI must not lose scenarios to transport errors");
    assert.equal(report.metrics.crossProfileLeakage, 0);
    assert.ok(report.metrics.latency.p95 !== null);
    assert.ok(report.metrics.estimatedCostPer1kTurns > 0);
    assert.equal(report.gates.passed, json.code === 0);
    assert.ok(report.byCategory.length >= 1);

    const subjects = [...server.profiles.keys()];
    assert.ok(subjects.includes("e2e/mei/bench"), subjects.join(", "));
    const remembered = server.calls.filter((call) => call.path === "/v1/namespaces/e2e/characters/mei/subjects/bench/remember").length;
    assert.ok(remembered > 0);
  });
});

/**
 * A lexical stand-in backend can only satisfy a lexically-answerable dataset, so
 * this harness dataset (quota-exact, §48) proves the green path: every gate
 * passes and the CLI exits 0. Retrieval quality itself is a backend concern.
 */
function lexicalHarnessDataset() {
  const lines = [];
  let n = 0;
  for (const [category, want] of Object.entries(CATEGORY_QUOTAS)) {
    for (let i = 1; i <= want; i++) {
      n += 1;
      const id = `${category.slice(0, 3)}-${String(i).padStart(3, "0")}`;
      const word = `答${id}`;
      const answer = `${id}の記録では好物は${word}です`;
      const setup = [];
      const expect = { anyOf: [word] };
      if (category === "contradictory_fact") {
        const old = `旧${word}`;
        setup.push({ op: "remember", content: `${id}の古い記録は${old}でした`, type: "fact" }, { op: "forget", selector: old });
        setup.push({ op: "remember", content: answer, type: "fact" });
        expect.noneOf = [old];
      } else if (category === "explicit_remember_delete") {
        setup.push({ op: "remember", content: `${id}の一時メモ${word}x`, type: "fact" }, { op: "forget", selector: `${word}x` });
        setup.push({ op: "remember", content: answer, type: "fact" });
        expect.noneOf = [`${word}x`];
      } else if (category === "event_recall") {
        setup.push({ op: "messages", sessionId: `s-${id}`, messages: [{ role: "user", content: answer }, { role: "assistant", content: "承知しました" }] });
      } else if (category === "adversarial_injection") {
        setup.push({ op: "remember", content: `${id}の部外秘は秘匿語${word}`, type: "fact", profile: "decoy" });
        setup.push({ op: "remember", content: answer, type: "fact", profile: "primary" });
      } else {
        setup.push({ op: "remember", content: answer, type: category === "task" ? "task" : category === "instruction" ? "instruction" : "fact" });
      }
      lines.push(JSON.stringify({ id, category, query: answer, setup, expect, ...(category === "adversarial_injection" ? { leakProbe: [`秘匿語${word}`] } : {}) }));
    }
  }
  return lines.join("\n");
}

test("benchmark exits 0 when every §60 gate is satisfied", async () => {
  await withServer(async ({ server, endpointArgs, dir }) => {
    const datasetPath = path.join(dir, "lexical-harness.jsonl");
    fs.writeFileSync(datasetPath, `${lexicalHarnessDataset()}\n`, "utf8");

    const validated = await runCli(["benchmark", "--dataset", datasetPath, "--validate-dataset"]);
    assert.equal(validated.code, 0, validated.stdout + validated.stderr);
    assert.match(validated.stdout, /TOTAL\s+100 \(minimum 100\)/);

    const run = await runCli([...endpointArgs, "benchmark", "--dataset", datasetPath, "--subject", "harness"]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /All benchmark gates passed\./);
    assert.match(run.stdout, /Recall@5\s+100\.0%/);
    assert.match(run.stdout, /stale-memory rate\s+0\.0%/);
    assert.match(run.stdout, /cross-profile leakage\s+0 \(target 0\)/);
    assert.match(run.stdout, /extraction acceptance\s+100\.0%/);

    const reportPath = path.join(dir, "report.json");
    const withReport = await runCli([...endpointArgs, "benchmark", "--dataset", datasetPath, "--subject", "harness", "--report", reportPath]);
    assert.equal(withReport.code, 0, withReport.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.metrics.scenarios, 100);
    assert.equal(report.gates.passed, true);
    assert.equal(report.metrics.crossProfileLeakage, 0);

    const subjects = [...server.profiles.keys()];
    assert.ok(subjects.includes("e2e/mei/harness"), subjects.join(", "));
    assert.ok(subjects.includes("e2e/mei/harness-decoy"), "decoy steps use a separate subject (§5.1 isolation)");
    const decoyMemories = [...server.profiles.get("e2e/mei/harness-decoy").memories.values()];
    assert.ok(decoyMemories.length >= 5, "adversarial decoy memories were written");
    assert.equal(decoyMemories.every((row) => row.content.includes("秘匿語")), true);
  });
});

test("benchmark and dataset guardrails fail loudly", async () => {
  const dir = makeTempDir("cfmem-bench-");
  try {
    const missing = path.join(dir, "nope.jsonl");
    const noFile = await runCli(["benchmark", "--dataset", missing]);
    assert.equal(noFile.code, 1);
    assert.match(noFile.stderr, /does not exist|ENOENT|not found/);

    const bad = path.join(dir, "bad.jsonl");
    fs.writeFileSync(bad, `${JSON.stringify({ id: "x", category: "made_up", query: "", setup: [], expect: {} })}\n`);
    const invalid = await runCli(["benchmark", "--dataset", bad, "--validate-dataset"]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stdout, /unknown category "made_up"/);
    assert.match(invalid.stdout, /shortfall|Category shortfalls|TOTAL/);

    const noEndpoint = await runCli(["benchmark", "--dataset", DATASET]);
    assert.equal(noEndpoint.code, 1);
    assert.match(noEndpoint.stderr, /benchmark needs --endpoint/);

    const scaffold = await runCli(["benchmark", "--scaffold", "--out", path.join(dir, "starter", "ja-memory-v1.jsonl")]);
    assert.equal(scaffold.code, 0, scaffold.stderr);
    assert.match(scaffold.stdout, /Freeze this version/);
    assert.equal(fs.readFileSync(path.join(dir, "starter", "ja-memory-v1.jsonl"), "utf8"), fs.readFileSync(DATASET, "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("help, unknown commands and §12 rejections are surfaced to the operator", async () => {
  const help = await runCli(["help"]);
  assert.equal(help.code, 0);
  for (const command of ["init", "doctor", "cost", "resources plan", "resources verify", "managed-status", "remember", "search", "recall", "list", "get", "forget", "delete-session", "export", "delete-profile", "repair outbox", "repair jobs", "benchmark"]) {
    assert.ok(help.stdout.includes(command), `help is missing ${command}`);
  }
  assert.match(help.stdout, /spec §12/);

  const short = await runCli(["--help"]);
  assert.equal(short.code, 0);

  const unknown = await runCli(["nope"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command: nope/);

  await withServer(async ({ endpointArgs }) => {
    const tooLong = await runCli([...endpointArgs, "search", "--query", "あ".repeat(400)]);
    assert.equal(tooLong.code, 1);
    assert.match(tooLong.stderr, /exceeds the 1024-byte input limit/);
  });

  const missingFlag = await runCli(["forget", "--endpoint", "https://x.test", ...SCOPE]);
  assert.equal(missingFlag.code, 1);
  assert.match(missingFlag.stderr, /missing required flag\(s\): --id/);

  const cost = await runCli(["cost", "--dau", "200", "--turns", "12", "--recall-rate", "0.2", "--checkpoint-turns", "8"]);
  assert.equal(cost.code, 0, cost.stderr);
  assert.match(cost.stdout, /Pricing reviewed: \d{4}-\d{2}-\d{2}/);
  assert.match(cost.stdout, /Total\s+\$\d+\.\d{2}/);

  for (const spelling of ["--dimensions", "--embedding-dimensions"]) {
    const tuned = await runCli(["cost", spelling, "768", "--json"]);
    assert.equal(tuned.code, 0, tuned.stderr);
    assert.equal(lastJson(tuned.stdout).assumptions.embeddingDimensions, 768, `${spelling} must reach the estimator`);
  }

  const managed = await runCli(["managed-status"]);
  assert.equal(managed.code, 1);
  assert.match(managed.stderr, /CLOUDFLARE_ACCOUNT_ID/);
});

test("doctor reports prerequisites and never mutates the project", async () => {
  await withTempProject(async (dir) => {
    const before = fs.readdirSync(dir).sort();
    const result = await runCli(["doctor", "--env", "dev"], { cwd: dir });
    assert.match(result.stdout, /cfmem doctor — env=dev/);
    assert.match(result.stdout, /Node >= 20/);
    assert.match(result.stdout, /benchmark dataset/);
    assert.match(result.stdout, /PROFILE_KEY_SECRET \(\.dev\.vars\)/);
    assert.match(result.stdout, /prerequisite\(s\) not satisfied|All local prerequisites satisfied/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "doctor must not write files");
    assert.ok([0, 1].includes(result.code), `exit ${result.code}`);
  });
});
