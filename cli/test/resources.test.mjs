import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BINDINGS, REQUIRED_SECRETS, localBindings, parseJsonc, resourceNames } from "../src/config.mjs";
import { REQUIRED_METADATA_INDEXES, collectRemoteFacts, detectDrift, formatPlan, formatVerify, planResources } from "../src/resources.mjs";
import { SAFE_NAME, createWranglerRunner, parseOutput, parseTable, pick, quoteWindowsArg } from "../src/wrangler.mjs";
import { TEMPLATE_WRANGLER } from "./helpers/cli.mjs";

const templateLocal = localBindings(parseJsonc(fs.readFileSync(TEMPLATE_WRANGLER, "utf8")));
const names = resourceNames("character-memory", "dev");
const intended = {
  ...names,
  embeddingDimensions: 1024,
  embeddingModel: "@cf/qwen/qwen3-embedding-0.6b",
  vectorMetric: "cosine",
  namespace: "dev",
  requiredSecrets: REQUIRED_SECRETS,
};

const remoteOk = () => ({
  authenticated: true,
  accountId: "acct-1",
  accountMismatch: null,
  vectorize: {
    exists: true,
    dimensions: 1024,
    metric: "cosine",
    metadataIndexes: REQUIRED_METADATA_INDEXES.map((entry) => ({ ...entry })),
    readError: null,
  },
  r2: { exists: true, readError: null },
  secrets: { configured: [...REQUIRED_SECRETS], readError: null },
  deployed: { known: true, readError: null },
});

function facts(overrides = {}) {
  const { local, ...remote } = overrides;
  return {
    intended,
    local: local === undefined ? templateLocal : local,
    remote: { ...remoteOk(), ...remote },
  };
}

const statusOf = (result, area, name) => result.findings.find((f) => f.area === area && f.name === name)?.status;

test("§58.2 plan is deterministic, §5-named and ordered by §6", () => {
  const plan = planResources({ app: "character-memory", envName: "production", dimensions: 1024, metric: "cosine", namespace: "production" });
  assert.deepEqual(plan, planResources({ app: "character-memory", envName: "production", dimensions: 1024, metric: "cosine", namespace: "production" }));
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    ["vectorize-index", "vectorize-metadata-indexes", "r2-archive", "bindings", "secrets"],
  );
  assert.equal(plan.names.worker, "character-memory-production");
  assert.equal(plan.names.vectorizeIndex, "character-memory-production-memory-v1");
  assert.ok(plan.steps[1].commands.length >= REQUIRED_METADATA_INDEXES.length);
  assert.ok(plan.steps[1].commands.some((command) => command.includes("--property-name=profile_key")));
  assert.ok(plan.steps[4].commands.every((command) => command.includes("--env production")));
  assert.match(formatPlan(plan), /worker\s+character-memory-production/);
  assert.match(formatPlan(plan), /DO binding \/ class\s+MEMORY_PROFILES \/ MemoryProfile \(sqlite\)/);
  assert.match(formatPlan(plan), /character-memory-production-consolidate-v1/);
});

test("plan rejects resource names Cloudflare would refuse", () => {
  assert.throws(() => planResources({ app: "bad; rm -rf /", envName: "dev", dimensions: 1024, metric: "cosine" }), /not a safe Cloudflare resource name/);
  assert.throws(() => planResources({ app: "character-memory", envName: "nope", dimensions: 1024, metric: "cosine" }), /Unknown --env/);
  assert.equal(SAFE_NAME.test("character-memory-dev-memory-v1"), true);
});

test("detectDrift stops at authentication instead of inventing remote facts", () => {
  const result = detectDrift({ intended, local: null, remote: { authenticated: false, wranglerAvailable: true } });
  assert.equal(result.blocked, true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].status, "unknown");
  assert.match(result.findings[0].hint, /wrangler login/);
});

test("a compliant project produces no drift and no unknowns", () => {
  const compliant = {
    ...templateLocal,
    consolidateWorkflow: names.consolidateWorkflow,
    deleteWorkflow: names.deleteProfileWorkflow,
  };
  const result = detectDrift(facts({ local: compliant }));
  const problems = result.findings.filter((f) => f.status !== "ok");
  assert.deepEqual(problems.map((f) => `${f.area}/${f.name}:${f.status}`), []);
  assert.equal(result.drift, false);
  assert.equal(result.blocking, false);
  assert.match(formatVerify(result, intended), /No configuration drift detected/);
});

test("the shipped starter is compliant except for the Phase 5 workflows", () => {
  const result = detectDrift(facts());
  const notOk = result.findings.filter((f) => f.status !== "ok");
  assert.deepEqual(notOk.map((f) => `${f.area}/${f.name}:${f.status}`).sort(), [
    "worker-config/Consolidation workflow:missing",
    "worker-config/Deletion workflow:missing",
  ]);
  assert.match(formatVerify(result, intended), /No drift, but 2 expected resource\(s\) are not provisioned for env=dev yet/);
});

test("§6 missing profile_key metadata index is reported as blocking", () => {
  const remote = remoteOk();
  remote.vectorize.metadataIndexes = remote.vectorize.metadataIndexes.filter((entry) => entry.propertyName !== "profile_key");
  const result = detectDrift(facts(remote));
  assert.equal(statusOf(result, "vectorize", "metadata profile_key"), "drift");
  assert.equal(result.blocking, true);
  const hint = result.findings.find((f) => f.name === "metadata profile_key").hint;
  assert.match(hint, /blocking condition/);
  assert.match(hint, /create-metadata-index character-memory-dev-memory-v1 --property-name=profile_key --type=string/);
});

test("vectorize dimension and metadata-type mismatches are drift", () => {
  const remote = remoteOk();
  remote.vectorize.dimensions = 768;
  remote.vectorize.metadataIndexes = remote.vectorize.metadataIndexes.map((entry) => (entry.propertyName === "active" ? { ...entry, type: "string" } : entry));
  const result = detectDrift(facts(remote));
  assert.equal(statusOf(result, "vectorize", "dimensions"), "drift");
  assert.equal(result.findings.find((f) => f.expected === 1024 && f.actual === 768).hint, "Dimensions must match the embedding model output.");
});

test("unreadable remote resources are unknown, not drift", () => {
  const remote = remoteOk();
  remote.vectorize = { exists: false, dimensions: null, metric: null, metadataIndexes: [], readError: "index not found" };
  remote.r2 = { exists: false, readError: "rate limited" };
  remote.secrets = { configured: [], readError: "no access" };
  const result = detectDrift(facts(remote));
  assert.equal(statusOf(result, "vectorize", "index exists"), "unknown");
  assert.equal(statusOf(result, "r2", "bucket exists"), "unknown");
  assert.ok(result.findings.some((f) => f.name === "remote secret list" && f.status === "unknown"));
});

test("§52 worker-config drift is caught from wrangler.jsonc alone", () => {
  const local = localBindings({
    name: "cf-character-memory-dev",
    ai: { binding: "AI" },
    vectorize: [{ binding: "MEMORY_VECTORS", index_name: "other-index" }],
    r2_buckets: [{ binding: "WRONG", bucket_name: names.r2Bucket }],
    durable_objects: { bindings: [{ name: BINDINGS.durableObject }] },
    exports: { MemoryProfile: { storage: "namespace" } },
    secrets: { required: ["PROFILE_KEY_SECRET"] },
  });
  const result = detectDrift(facts({ local }));
  const drifts = result.findings.filter((f) => f.status === "drift" && f.area === "worker-config").map((f) => f.name);
  assert.deepEqual(drifts.sort(), ["DO storage", "R2 binding", "Vectorize target", "worker name"]);
  assert.equal(statusOf(result, "worker-config", "Consolidation workflow"), "missing");
  assert.ok(result.drift);
});

test("§5.1 production configuration pointing at dev names is flagged", () => {
  const prod = resourceNames("character-memory", "production");
  const remote = remoteOk();
  remote.vectorize.indexName = "character-memory-dev-memory-v1";
  const result = detectDrift({
    intended: { ...intended, ...prod, env: "production" },
    local: localBindings({
      name: prod.worker,
      ai: { binding: "AI" },
      durable_objects: { bindings: [{ name: "MEMORY_PROFILES" }] },
      exports: { MemoryProfile: { storage: "sqlite" } },
      vectorize: [{ binding: "MEMORY_VECTORS", index_name: "character-memory-dev-memory-v1" }],
      r2_buckets: [{ binding: "MEMORY_ARCHIVE", bucket_name: prod.r2Bucket }],
      workflows: [
        { binding: "MEMORY_CONSOLIDATION", name: prod.consolidateWorkflow },
        { binding: "PROFILE_DELETION", name: prod.deleteProfileWorkflow },
      ],
      secrets: { required: [...REQUIRED_SECRETS] },
    }),
    remote: { ...remote, r2: { exists: true, readError: null } },
  });
  const isolation = result.findings.filter((f) => f.area === "isolation");
  assert.equal(isolation.length, 1);
  assert.equal(isolation[0].status, "drift");
  assert.match(isolation[0].actual, /character-memory-dev-memory-v1/);
  assert.match(isolation[0].hint, /must not point at a dev resource/);
});

test("missing wrangler.jsonc yields unknown worker-config findings", () => {
  const result = detectDrift(facts({ local: null }));
  assert.ok(result.findings.every((f) => f.area !== "worker-config" || f.status === "unknown"));
  assert.match(formatVerify(result, intended), /Run cfmem init/);
});

test("account mismatch across environments is drift", () => {
  const remote = remoteOk();
  remote.accountMismatch = "expected acct-2, got acct-1";
  const result = detectDrift(facts(remote));
  assert.equal(statusOf(result, "auth", "account"), "drift");
});

test("collectRemoteFacts reads JSON and table output through the injected runner", async () => {
  const commands = [];
  const run = async (argv) => {
    commands.push(argv.join(" "));
    if (argv[0] === "whoami") {
      return { ok: true, stdout: JSON.stringify({ result: { authenticated: true, accounts: [{ account_id: "acct-1", account_name: "Main" }] } }), stderr: "" };
    }
    if (argv[0] === "vectorize" && argv[1] === "get") {
      return {
        ok: true,
        stdout: [
          "⎔ Getting index",
          "┌────────────┬──────────────────────────────────┐",
          "│ Config     │ Value                            │",
          "├────────────┼──────────────────────────────────┤",
          "│ Name       │ character-memory-dev-memory-v1   │",
          "│ Dimensions │ 1024                             │",
          "│ Metric     │ cosine                           │",
          "└────────────┴──────────────────────────────────┘",
        ].join("\n"),
        stderr: "",
      };
    }
    if (argv[1] === "list-metadata-index") {
      return { ok: true, stdout: JSON.stringify({ result: [{ propertyName: "profile_key", type: "string" }, { propertyName: "memory_type", type: "string" }, { propertyName: "active", type: "boolean" }] }), stderr: "" };
    }
    if (argv[1] === "bucket") return { ok: true, stdout: JSON.stringify({ result: [{ bucket_name: names.r2Bucket }] }), stderr: "" };
    if (argv[0] === "secret") return { ok: true, stdout: JSON.stringify({ result: [{ name: "PROFILE_KEY_SECRET" }, { name: "ADMIN_API_TOKEN" }] }), stderr: "" };
    return { ok: true, stdout: "{}", stderr: "" };
  };

  const factsCollected = await collectRemoteFacts({ run, names, expectedAccountId: "acct-1" });
  assert.equal(factsCollected.authenticated, true);
  assert.equal(factsCollected.accountId, "acct-1");
  assert.equal(factsCollected.vectorize.exists, true);
  assert.equal(factsCollected.vectorize.dimensions, 1024);
  assert.equal(factsCollected.vectorize.metric, "cosine");
  assert.equal(factsCollected.r2.exists, true);
  assert.deepEqual(factsCollected.secrets.configured, [...REQUIRED_SECRETS]);
  assert.equal(factsCollected.incomplete, false);
  assert.deepEqual(factsCollected.vectorize.metadataIndexes, REQUIRED_METADATA_INDEXES.map((entry) => ({ ...entry })));
  assert.ok(commands.some((command) => command.includes(`vectorize get ${names.vectorizeIndex}`)));

  const drift = detectDrift(facts({ ...factsCollected, local: null }));
  assert.equal(drift.findings.filter((f) => f.source === "remote" && f.status === "drift").length, 0);

  const wrongAccount = await collectRemoteFacts({ run, names, expectedAccountId: "acct-9" });
  assert.match(wrongAccount.accountMismatch, /expected acct-9, got acct-1/);
});

test("collectRemoteFacts stops early when wrangler is not authenticated", async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { ok: false, stdout: "", stderr: "Error parsing remote script: not logged in" };
  };
  const result = await collectRemoteFacts({ run, names, expectedAccountId: undefined });
  assert.equal(result.authenticated, false);
  assert.equal(result.incomplete, true);
  assert.equal(calls, 1, "no further remote reads after a failed whoami");
});

test("wrangler output parsing falls back from JSON to box tables", () => {
  assert.deepEqual(parseOutput('prefix\n{"a":1}\nsuffix'), { a: 1 });
  assert.equal(parseOutput("plain text"), "plain text");
  assert.equal(parseOutput(""), null);
  const table = parseTable(["┌────┬───────┐", "│ Name │ Buckets │", "├────┼───────┤", "│ a    │ x       │", "└────┴───────┘"].join("\n"));
  assert.deepEqual(table, [{ name: "a", buckets: "x" }]);
  assert.equal(parseTable("no table here"), null);
  assert.equal(pick({ a: { b: 1 } }, ["a.b", "c"]), 1);
  assert.equal(pick({}, ["missing", "other"]), undefined);
});

test("plan validates the memory namespace (§12 scope hygiene)", () => {
  assert.equal(planResources({ app: "kagami", envName: "dev", dimensions: 1024, metric: "cosine", namespace: "team-a" }).namespace, "team-a");
  assert.throws(() => planResources({ app: "kagami", envName: "dev", dimensions: 1024, metric: "cosine", namespace: "team/a" }), /not a safe Cloudflare resource name/);
  assert.throws(() => planResources({ app: "kagami", envName: "dev", dimensions: 1024, metric: "cosine", namespace: "n".repeat(33) }), /namespace must be <= 32/);
});

test("wrangler runner quotes arguments instead of shell-concatenating them", async () => {
  const calls = [];
  const run = createWranglerRunner({
    cwd: process.cwd(),
    exec: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: "{}", stderr: "" };
    },
  });
  const result = await run(["vectorize", "get", "kagami-staging-memory-v1"]);
  assert.equal(result.ok, true);
  const [call] = calls;
  assert.equal(call.options.shell, undefined, "shell:true concatenates arguments and warns (DEP0190)");
  if (process.platform === "win32") {
    assert.equal(call.cmd, "cmd.exe");
    assert.deepEqual(call.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(call.args[3], /kagami-staging-memory-v1"$/);
    assert.equal(call.options.windowsVerbatimArguments, true);
  } else {
    assert.deepEqual(call.args, ["--no-install", "wrangler", "vectorize", "get", "kagami-staging-memory-v1"]);
  }
  assert.equal(quoteWindowsArg("plain-name"), "plain-name");
  assert.equal(quoteWindowsArg("C:\\a b\\wrangler.cmd"), '"C:\\a b\\wrangler.cmd"');
  assert.equal(quoteWindowsArg('a"b'), '"a\\\"b"');
});
