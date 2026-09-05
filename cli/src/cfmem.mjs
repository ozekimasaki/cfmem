#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boolFlag, flagValue, numberFlag, parseArgs, requireValues } from "./args.mjs";
import {
  DEFAULT_APP,
  ENVIRONMENTS,
  RESOURCE_DEFAULTS,
  findProjectRoot,
  loadConfig,
  localBindings,
  pricingStalenessWarning,
  resolveApiSettings,
} from "./config.mjs";
import { MemoryApiClient, LIMITS } from "./client.mjs";
import { estimateCost, formatCostReport, PRICING } from "./cost.mjs";
import { requireConfirmation } from "./confirm.mjs";
import { collectRemoteFacts, detectDrift, formatPlan, formatVerify, planResources } from "./resources.mjs";
import { createWranglerRunner } from "./wrangler.mjs";
import {
  BENCHMARK_VERSION,
  CATEGORY_QUOTAS,
  MIN_SCENARIOS,
  computeMetrics,
  evaluateGates,
  formatBenchmarkReport,
  parseDataset,
  runBenchmark,
  summarizeByCategory,
  validateDataset,
} from "./benchmark.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const COMMANDS = [
  "init",
  "doctor",
  "cost",
  "resources",
  "managed-status",
  "remember",
  "search",
  "recall",
  "list",
  "get",
  "forget",
  "delete-session",
  "export",
  "delete-profile",
  "repair",
  "benchmark",
];

function help() {
  console.log(
    `cfmem — Cloudflare agent memory bootstrap/operations CLI (not the memory server itself)

Usage: cfmem <command> [flags]

Build & diagnose
  init <dir>                Scaffold a greenfield memory project (--app NAME --env NAME --namespace NAME
                            --character ID; --character-package adds soul.md). wrangler.jsonc is retargeted
                            to the planned names, so the scaffold never points at another environment.
  doctor [--env NAME]       Local prerequisites for the target environment; never mutates resources
  cost [assumptions]        Monthly memory-platform cost estimate (pricing reviewed ${PRICING.reviewedAt})
  resources plan [--env]    Print intended remote names + Wrangler commands; makes no changes
  resources verify [--env]  Read remote configuration and fail on drift
  managed-status            Check whether the private Agent Memory API is reachable

Memory operations (custom backend, admin token)
  remember   --content ...  Store an explicit memory [--type fact|event|instruction|task]
                            [--subject-key K] [--session-id S] [--importance 0..1] [--confidence 0..1]
  search     --query ...    Raw authoritative candidates (preferred at runtime)
  recall     --query ...    Synthesized compatibility recall (admin/eval use)
                            search/recall: [--limit N] [--type T] [--subject-key K] [--session-id S] [--text]
  list                      Page through memories with §36 filters
                            [--type T] [--active true|false] [--session-id S] [--subject-key K]
                            [--created-before ISO] [--created-after ISO] [--cursor TOKEN] [--limit N]
  get        --id ...       One memory
  forget     --id ...       Tombstone one memory (vector delete is retried by the outbox)
  delete-session --session-id ...     Session-scoped deletion (destructive)
  export                    Portable §41 export to --out FILE [--include-raw] (destructive-free)
  delete-profile            Full profile erasure across DO/Vectorize/R2 (destructive)
  repair outbox             Re-drive stuck vector outbox rows [--limit N] [--include-errors] [--apply]
  repair jobs               Re-drive stuck consolidation / deletion jobs [--older-than SECONDS] [--apply]
  benchmark                 Run the versioned Japanese quality dataset against an endpoint
                            [--dataset FILE | --scaffold [--out FILE]] [--validate-dataset]
                            [--limit-scenarios N] [--skip-setup] [--k N] [--wait-for-extraction S]
                            [--decoy-subject ID] [--report FILE] [--dau N]

Scope flags
  --endpoint URL --namespace NAME --character ID --subject ID [--token TOKEN]
  (--profile is an accepted alias of --subject)
  (also CFMEM_ENDPOINT / CFMEM_NAMESPACE / CFMEM_CHARACTER / CFMEM_SUBJECT / CFMEM_TOKEN / CFMEM_ENV)
  --env ${ENVIRONMENTS.join("|")}   --json   --yes / --confirm <identity> for destructive commands
  Precedence is flag > environment > cfmem.config.json > default.
  Destructive commands never run without an explicit subject plus --yes or a matching --confirm echo.

Cost assumptions
  --dau N --turns N --days N --recall-rate 0.2 --checkpoint-turns 8
  --memories-per-checkpoint N --dimensions ${RESOURCE_DEFAULTS.dimensions} (alias --embedding-dimensions)
  --extraction-input-tokens N --extraction-output-tokens N

Exit codes: 0 ok · 1 failed or drift/gate miss · 2 remote state could not be verified.

Limits enforced client-side (spec §12): query <= ${LIMITS.queryBytes}B, content <= ${LIMITS.messageContentBytes}B,
session id <= ${LIMITS.sessionIdChars}, search --limit <= ${LIMITS.searchLimit}, list --limit <= ${LIMITS.listPageLimit}.
Values starting with a dash need the --flag=-value form.
`,
  );
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * §5.1 — the scaffold must never point at another environment's resources.
 * The template is written against `character-memory-dev`; rewrite the four
 * environment-scoped values to this project's planned names.
 */
const TEMPLATE_DEV_PREFIX = "character-memory-dev";

function retargetWranglerConfig(dest, plan) {
  const file = path.join(dest, "wrangler.jsonc");
  const text = fs.readFileSync(file, "utf8");
  const replacements = [
    [`"${TEMPLATE_DEV_PREFIX}"`, `"${plan.names.worker}"`],
    [`"${TEMPLATE_DEV_PREFIX}-memory-v1"`, `"${plan.names.vectorizeIndex}"`],
    [`"${TEMPLATE_DEV_PREFIX}-archive"`, `"${plan.names.r2Bucket}"`],
    [`"MEMORY_NAMESPACE": "dev"`, `"MEMORY_NAMESPACE": ${JSON.stringify(plan.namespace)}`],
  ];
  const unfound = replacements.filter(([from, to]) => from !== to && !text.includes(from)).map(([from]) => from);
  const next = replacements.reduce((acc, [from, to]) => acc.split(from).join(to), text);
  fs.writeFileSync(file, next);
  if (unfound.length) console.log(`! wrangler.jsonc no longer contains ${unfound.join(", ")}; check bindings manually.`);
}

function initProject(args) {
  const dest = path.resolve(args._[1] ?? "character-memory");
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error(`Destination is not empty: ${dest}`);
  const app = flagValue(args, "app") ?? DEFAULT_APP;
  const envName = flagValue(args, "env") ?? "dev";
  const namespace = flagValue(args, "namespace") ?? envName;
  const plan = planResources({
    app,
    envName,
    dimensions: RESOURCE_DEFAULTS.dimensions,
    metric: RESOURCE_DEFAULTS.metric,
    namespace,
  });
  fs.mkdirSync(dest, { recursive: true });
  copyDir(path.join(root, "templates", "worker"), dest);
  retargetWranglerConfig(dest, plan);
  fs.writeFileSync(
    path.join(dest, "cfmem.config.json"),
    `${JSON.stringify(
      {
        version: 1,
        app,
        env: envName,
        backend: "custom",
        namespace,
        characterId: args.character ?? "character-default",
        embeddingModel: RESOURCE_DEFAULTS.embeddingModel,
        embeddingDimensions: RESOURCE_DEFAULTS.dimensions,
        vectorMetric: RESOURCE_DEFAULTS.metric,
        checkpointTurns: RESOURCE_DEFAULTS.checkpointTurns,
        idleSeconds: RESOURCE_DEFAULTS.idleSeconds,
        benchmarkDataset: "test/benchmark/ja-memory-v1.jsonl",
        pricingReviewedAt: PRICING.reviewedAt,
      },
      null,
      2,
    )}\n`,
  );
  if (boolFlag(args, "characterPackage", "character-package")) {
    fs.writeFileSync(
      path.join(dest, "soul.md"),
      "# Character SOUL\n\nImmutable identity lives here. Learned user memories belong in the memory store, never in this file.\n",
    );
  }
  fs.mkdirSync(path.join(dest, "ops"), { recursive: true });
  fs.writeFileSync(path.join(dest, "ops", "resources-plan.txt"), `${formatPlan(plan)}\n`);
  console.log(`Created ${dest}`);
  console.log(`  app=${app} env=${envName} -> worker ${plan.names.worker}, index ${plan.names.vectorizeIndex}, bucket ${plan.names.r2Bucket}`);
  console.log("  ops/resources-plan.txt records the exact remote names and command order.");
  console.log("Next: run cfmem doctor, then pass Phase 1 (SQLite + Japanese FTS) before adding AI/Vectorize.");
}

function commandExists(cmd, cmdArgs = ["--version"]) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

async function doctor({ envName, config }) {
  const checks = [];
  const add = (name, detail, ok, hint) => checks.push({ name, detail, ok, hint: ok ? null : hint });

  add("Node >= 20", process.versions.node, Number(process.versions.node.split(".")[0]) >= 20, "Upgrade Node; the CLI uses node:test and WebCrypto globals.");
  const wrangler =
    commandExists(process.platform === "win32" ? "wrangler.cmd" : "wrangler", ["--version"]) ??
    commandExists(path.resolve(config.root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler"), ["--version"]);
  add("Wrangler", wrangler ?? "not found", Boolean(wrangler), "npm i -D wrangler in the project, or run through npx.");
  add("cfmem.config.json", config.hasConfig ? "found" : "not found", config.hasConfig, `Run cfmem init, or add ${"cfmem.config.json"} to this directory.`);
  add("wrangler.jsonc", config.hasWrangler ? "found" : "not found", config.hasWrangler, "Required before deploy: npx wrangler init.");
  add(`CLOUDFLARE_ACCOUNT_ID`, process.env.CLOUDFLARE_ACCOUNT_ID ? "set" : "missing", Boolean(process.env.CLOUDFLARE_ACCOUNT_ID), "Only needed for remote operations.");
  add(`CLOUDFLARE_API_TOKEN`, process.env.CLOUDFLARE_API_TOKEN ? "set" : "missing", Boolean(process.env.CLOUDFLARE_API_TOKEN), "Only needed for remote operations.");
  add("CFMEM_ENDPOINT", process.env.CFMEM_ENDPOINT ? "set" : "missing", Boolean(process.env.CFMEM_ENDPOINT), "Needed for memory operations and benchmark.");

  const local = config.hasWrangler ? localBindings(config.wrangler) : null;
  const intended = config.intended;
  add("memory namespace", intended.namespace, Boolean(intended.namespace), "Set namespace in cfmem.config.json.");
  if (local) {
    for (const [label, actual, expected] of [
      ["DO binding", local.durableObject, intended.bindings.durableObject],
      ["DO storage", local.doStorage, "sqlite"],
      ["AI binding", local.ai, intended.bindings.ai],
      ["Vectorize target", local.vectorizeIndex, intended.vectorizeIndex],
      ["R2 target", local.r2Bucket, intended.r2Bucket],
    ]) {
      add(`config ${label}`, actual ?? "missing", actual === expected, `Expected ${expected} for env=${envName}.`);
    }
  }

  const datasetPath = resolveDatasetPath(args_dataset(config));
  add(`benchmark dataset`, datasetPath ? path.relative(process.cwd(), datasetPath) : "not found", Boolean(datasetPath), "cfmem benchmark --scaffold writes the versioned starter dataset.");
  add("PROFILE_KEY_SECRET (.dev.vars)", devVarsHas("PROFILE_KEY_SECRET") ? "present locally" : "missing", devVarsHas("PROFILE_KEY_SECRET"), "Copy .dev.vars.example to .dev.vars and fill it for local dev.");

  const stale = pricingStalenessWarning(intended.pricingReviewedAt);
  add("pricing review date", intended.pricingReviewedAt, !stale, stale ?? null);

  console.log(`cfmem doctor — env=${envName} (project ${config.root})`);
  console.log("");
  for (const check of checks) console.log(`${check.ok ? "OK  " : "--  "}${check.name}: ${check.detail}${check.hint ? `  ${check.hint}` : ""}`);
  const failed = checks.filter((check) => !check.ok);
  console.log("");
  console.log(
    failed.length
      ? `${failed.length} prerequisite(s) not satisfied. Missing Cloudflare credentials are fine for local design work; they block remote access, verify and deploy.`
      : "All local prerequisites satisfied. Remote drift is checked by: cfmem resources verify",
  );
  return failed.length ? 1 : 0;
}

function devVarsHas(key) {
  const file = path.resolve(".dev.vars");
  if (!fs.existsSync(file)) return false;
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(fs.readFileSync(file, "utf8"));
}

function args_dataset(config) {
  return config?.raw?.benchmarkDataset;
}

function resolveDatasetPath(relative) {
  const candidates = [
    process.env.CFMEM_BENCHMARK_DATASET,
    relative,
    "test/benchmark/ja-memory-v1.jsonl",
    path.join(root, "templates", "worker", "test", "benchmark", "ja-memory-v1.jsonl"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

async function managedStatus() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN first.");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/agent-memory/namespaces`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (response.ok) {
    console.log("Agent Memory API is reachable for this account/token. Private-beta access appears available.");
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (response.status === 403 || response.status === 404) {
    console.log(`Agent Memory is not usable with the current account/token (${response.status}).`);
    console.log("Keep the custom backend enabled and retry after access is granted (§49 Phase 8).");
    return;
  }
  throw new Error(`${response.status}: ${text}`);
}

function print(data) {
  console.log(JSON.stringify(data, null, 2));
}

function apiClient(args, config) {
  return new MemoryApiClient(resolveApiSettings(args, process.env, config));
}

async function runResources(subcommand, args, config) {
  const envName = flagValue(args, "env") ?? config.intended.env;
  if (!subcommand || !["plan", "verify"].includes(subcommand)) {
    throw new Error(`resources requires "plan" or "verify", got: ${subcommand ?? "<none>"}`);
  }
  const plan = planResources({
    app: config.intended.app,
    envName,
    dimensions: numberFlag(args, "dimensions", { min: 1, max: 1536, fallback: config.intended.embeddingDimensions }),
    metric: flagValue(args, "metric") ?? config.intended.vectorMetric,
    namespace: flagValue(args, "namespace") ?? config.intended.namespace,
  });
  const intended = { ...config.intended, ...plan.names, env: envName };
  if (subcommand === "plan") {
    if (boolFlag(args, "json")) return print(plan);
    console.log(formatPlan(plan));
    console.log("No Cloudflare resources were created. This command is read-only by design (§58.2).");
    return 0;
  }
  const run = createWranglerRunner({ cwd: config.root });
  const remote = await collectRemoteFacts({ run, names: plan.names, expectedAccountId: process.env.CLOUDFLARE_ACCOUNT_ID });
  const result = detectDrift({ intended, local: config.hasWrangler ? localBindings(config.wrangler) : null, remote });
  if (boolFlag(args, "json")) print({ intended, ...result });
  else console.log(formatVerify(result, intended));
  if (result.drift) return 1;
  if (result.blocked || result.findings.some((f) => f.status === "unknown")) return 2;
  return 0;
}

async function runRepair(subcommand, args, config) {
  if (!["outbox", "jobs"].includes(subcommand)) throw new Error(`repair requires "outbox" or "jobs", got: ${subcommand ?? "<none>"}`);
  const client = apiClient(args, config);
  const apply = boolFlag(args, "apply");
  const dryRun = !apply;
  if (!apply) console.log("repair is dry-run by default; pass --apply to re-drive rows.");
  const payload =
    subcommand === "outbox"
      ? await client.repairOutbox({ dryRun, limit: numberFlag(args, "limit", { min: 1, max: 1000 }), includeErrors: boolFlag(args, "includeErrors", "include-errors") })
      : await client.repairJobs({ dryRun, olderThanSeconds: numberFlag(args, "olderThan", { min: 0 }) });
  print(payload);
  return 0;
}

async function runBenchmarkCommand(args, config) {
  if (boolFlag(args, "scaffold")) {
    const target = path.resolve(flagValue(args, "out") ?? args._[1] ?? "test/benchmark/ja-memory-v1.jsonl");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, "templates", "worker", "test", "benchmark", `${BENCHMARK_VERSION}.jsonl`), target);
    console.log(`Wrote ${target} (${BENCHMARK_VERSION}). Freeze this version when comparing algorithm changes (§48).`);
    return 0;
  }
  const datasetPath = flagValue(args, "dataset") ? path.resolve(flagValue(args, "dataset")) : resolveDatasetPath(args_dataset(config));
  if (!datasetPath) throw new Error("No benchmark dataset found. Pass --dataset FILE or run: cfmem benchmark --scaffold");
  const { scenarios, errors } = parseDataset(fs.readFileSync(datasetPath, "utf8"), { file: datasetPath });
  const dataset = validateDataset(scenarios);
  const subset = numberFlag(args, "limitScenarios", { min: 1 });
  const selected = subset ? scenarios.slice(0, subset) : scenarios;

  if (boolFlag(args, "validateDataset", "validate-dataset") || boolFlag(args, "dryRun", "dry-run")) {
    if (boolFlag(args, "json")) {
      print({ datasetPath, dataset, quotas: dataset.counts, scenarios: selected.length, ...(errors.length ? { parseErrors: errors } : {}) });
    } else {
      console.log(`${datasetPath}`);
      for (const [category, have] of Object.entries(dataset.counts)) {
        console.log(`  ${category.padEnd(30)}${String(have).padStart(3)} / ${CATEGORY_QUOTAS[category]}`);
      }
      console.log(`  ${"TOTAL".padEnd(30)}${String(dataset.totals).padStart(3)} (minimum ${MIN_SCENARIOS})`);
      for (const line of dataset.errors.slice(0, 10)) console.log(`  ! ${line}`);
      if (dataset.errors.length > 10) console.log(`  ! ...and ${dataset.errors.length - 10} more schema error(s)`);
    }
    if (!dataset.ok) return 1;
    return dataset.quotaShortfalls.length || dataset.belowMinimum ? 1 : 0;
  }

  const settings = resolveApiSettings(args, process.env, config);
  if (!settings.endpoint) throw new Error("benchmark needs --endpoint (or CFMEM_ENDPOINT), plus --subject for a writable profile.");
  const primary = new MemoryApiClient({ ...settings, subject: settings.subject ?? "cfmem-benchmark" });
  const decoySubject = flagValue(args, "decoySubject", "decoy-subject") ?? `${primary.subject}-decoy`;
  const decoy = new MemoryApiClient({ ...settings, subject: decoySubject });
  const forProfile = (profile) => (profile === "decoy" ? decoy : primary);
  const k = numberFlag(args, "k", { min: 1, max: LIMITS.searchLimit, fallback: 10 });
  const waitSeconds = numberFlag(args, "waitForExtraction", { min: 0, fallback: 0 });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const asJson = boolFlag(args, "json");
  if (!asJson) console.log(`Benchmark ${BENCHMARK_VERSION} against ${settings.endpoint} (subject=${primary.subject}, decoy=${decoy.subject})`);
  const results = await runBenchmark({
    scenarios: selected,
    k,
    applySetup: !boolFlag(args, "skipSetup", "skip-setup"),
    search: ({ query, profile, limit }) => forProfile(profile).search(query, { limit }),
    remember: ({ profile, content, type, subjectKey }) => forProfile(profile).remember({ content, type, subjectKey }),
    appendMessages: ({ profile, sessionId, messages }) => forProfile(profile).appendMessages(messages, sessionId),
    forgetContent: async ({ profile, selector }) => {
      const client = forProfile(profile);
      const page = await client.list({ limit: LIMITS.listPageLimit });
      const rows = page?.result ?? page?.memories ?? page?.candidates ?? [];
      const match = rows.find((row) => String(row?.content ?? row?.summary ?? "").includes(selector));
      if (!match?.id) throw new Error(`No memory matching "${selector}" to forget in profile ${profile}.`);
      return client.forget(match.id);
    },
    pause: () => (waitSeconds ? sleep(waitSeconds * 1000) : undefined),
  });
  const metrics = computeMetrics(results, {
    costAssumptions: { dau: numberFlag(args, "dau", { fallback: 1 }), turns: 12, recallRate: 1 },
  });
  const gates = evaluateGates(metrics, dataset);
  const byCategory = summarizeByCategory(results);
  const reportArg = args.report;
  if (reportArg) {
    const reportPath = path.resolve(reportArg === true ? `benchmark-report-${BENCHMARK_VERSION}.json` : String(reportArg));
    fs.writeFileSync(reportPath, `${JSON.stringify({ datasetPath, metrics, gates, byCategory, results }, null, 2)}\n`);
    console.error(`Wrote ${reportPath}`);
  }
  if (asJson) print({ datasetPath, metrics, gates, byCategory, results });
  else console.log(formatBenchmarkReport({ metrics, dataset, gates, byCategory }));
  return gates.passed ? 0 : 1;
}

async function runExport(args, config) {
  const client = apiClient(args, config);
  const out = flagValue(args, "out", "output") ?? `cfmem-export-${client.namespace}-${client.character}-${client.subject}.json`;
  const payload = await client.exportProfile({ includeRaw: boolFlag(args, "includeRaw", "include-raw") || undefined });
  const serialized = JSON.stringify(payload, null, 2);
  const secretPattern = /(PROFILE_KEY_SECRET|ADMIN_API_TOKEN|authorization|bearer\s+[A-Za-z0-9._-]{12,})/i;
  if (secretPattern.test(serialized)) {
    throw new Error(`export refused: the payload appears to contain credentials. §41 forbids secrets in exports — fix the server before writing the file.`);
  }
  fs.writeFileSync(path.resolve(out), `${serialized}\n`);
  console.log(`Wrote ${path.resolve(out)}`);
  const format = payload?.format ?? payload?.data?.format;
  if (format && format !== "cf-character-memory-export") console.log(`! unexpected export format "${format}" (expected cf-character-memory-export, §41)`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || args.help) {
    help();
    return 0;
  }
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}\nRun "cfmem help" for the supported surface.`);
  const config = loadConfig({ dir: findProjectRoot(process.cwd()) });
  const clientCommand = ["remember", "search", "recall", "list", "get", "forget", "delete-session", "export", "delete-profile"];

  if (clientCommand.includes(command) && !flagValue(args, "endpoint") && !process.env.CFMEM_ENDPOINT) {
    throw new Error(`${command}: --endpoint (or CFMEM_ENDPOINT) is required. Run "cfmem doctor" to see what is configured.`);
  }
  const identity = resolveApiSettings(args, process.env, config);

  switch (command) {
    case "init":
      return initProject(args);
    case "doctor":
      return doctor({ envName: flagValue(args, "env") ?? config.intended.env, config, args });
    case "cost": {
      const result = estimateCost({
        days: numberFlag(args, "days"),
        dau: numberFlag(args, "dau"),
        turns: numberFlag(args, "turns"),
        recallRate: numberFlag(args, "recallRate", { min: 0, max: 1 }),
        checkpointTurns: numberFlag(args, "checkpointTurns", { min: 1 }),
        memoriesPerCheckpoint: numberFlag(args, "memoriesPerCheckpoint", { min: 0 }),
        embeddingDimensions: numberFlag(args, "dimensions", { min: 1 }) ?? numberFlag(args, "embeddingDimensions", { min: 1 }),
        extractionInputTokens: numberFlag(args, "extractionInputTokens"),
        extractionOutputTokens: numberFlag(args, "extractionOutputTokens"),
      });
      if (boolFlag(args, "json")) return print(result);
      console.log(formatCostReport(result));
      return 0;
    }
    case "resources":
      return runResources(args._[1], args, config);
    case "managed-status":
      return managedStatus();
    case "remember": {
      requireValues(args, [[["content"], "--content"]], "remember");
      const record = await apiClient(args, config).remember({
        content: flagValue(args, "content"),
        type: flagValue(args, "type"),
        subjectKey: flagValue(args, "subjectKey", "subject-key"),
        sessionId: flagValue(args, "sessionId", "session-id"),
        importance: numberFlag(args, "importance", { min: 0, max: 1 }),
        confidence: numberFlag(args, "confidence", { min: 0, max: 1 }),
      });
      return print(record);
    }
    case "search":
    case "recall": {
      requireValues(args, [[["query"], "--query"]], command);
      const options = {
        limit: numberFlag(args, "limit", { min: 1, max: LIMITS.searchLimit }),
        type: flagValue(args, "type"),
        subjectKey: flagValue(args, "subjectKey", "subject-key"),
        sessionId: flagValue(args, "sessionId", "session-id"),
      };
      const payload = await apiClient(args, config)[command](flagValue(args, "query"), options);
      if (boolFlag(args, "text")) {
        const candidates = payload?.candidates ?? payload?.results ?? payload?.memories ?? [];
        for (const candidate of candidates) {
          const record = candidate?.memory ?? candidate;
          console.log(`[${candidate?.score ?? "-"}] ${record?.type ?? "?"} ${record?.id ?? ""}\n    ${String(record?.content ?? record?.summary ?? "").replaceAll("\n", "\n    ")}`);
        }
        console.log(`${candidates.length} candidate(s)`);
        return 0;
      }
      return print(payload);
    }
    case "list": {
      const payload = await apiClient(args, config).list({
        type: flagValue(args, "type"),
        active: flagValue(args, "active"),
        sessionId: flagValue(args, "sessionId", "session-id"),
        subjectKey: flagValue(args, "subjectKey", "subject-key"),
        createdBefore: flagValue(args, "createdBefore", "created-before"),
        createdAfter: flagValue(args, "createdAfter", "created-after"),
        cursor: flagValue(args, "cursor"),
        limit: numberFlag(args, "limit", { min: 1, max: LIMITS.listPageLimit, fallback: undefined }),
      });
      return print(payload);
    }
    case "get": {
      requireValues(args, [[["id"], "--id"]], "get");
      return print(await apiClient(args, config).get(flagValue(args, "id")));
    }
    case "forget": {
      requireValues(args, [[["id"], "--id"]], "forget");
      return print(await apiClient(args, config).forget(flagValue(args, "id")));
    }
    case "delete-session": {
      requireValues(args, [[["sessionId", "session-id"], "--session-id"]], "delete-session");
      const check = await gate("delete-session", identity, args);
      if (!check.confirmed) {
        console.log(`Aborted: ${check.label} was not confirmed.`);
        return 0;
      }
      return print(await apiClient(args, config).deleteSession(flagValue(args, "sessionId", "session-id")));
    }
    case "export":
      return runExport(args, config);
    case "delete-profile": {
      const check = await gate("delete-profile", identity, args);
      if (!check.confirmed) {
        console.log(`Aborted: ${check.label} was not confirmed.`);
        return 0;
      }
      return print(await apiClient(args, config).deleteProfile({ reason: flagValue(args, "reason") }));
    }
    case "repair":
      return runRepair(args._[1], args, config);
    case "benchmark":
      return runBenchmarkCommand(args, config);
    default:
      throw new Error(`Unhandled command: ${command}`);
  }
}

async function ask(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function gate(action, identity, args) {
  let result = requireConfirmation({
    action,
    identity,
    yes: args.yes === true ? true : flagValue(args, "confirm"),
  });
  if (result.needsAnswer) result = requireConfirmation({ action, identity, answer: await ask(result.question) });
  return result;
}

main()
  .then((code) => {
    if (typeof code === "number" && code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    console.error(`cfmem: ${error.message}`);
    process.exitCode = 1;
  });
