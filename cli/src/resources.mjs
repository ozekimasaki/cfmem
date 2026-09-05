import { BINDINGS, REQUIRED_SECRETS, assertEnv, localBindings, resourceNames } from "./config.mjs";
import { assertSafeName, parseOutput, pick } from "./wrangler.mjs";

export const REQUIRED_METADATA_INDEXES = [
  { propertyName: "profile_key", type: "string" },
  { propertyName: "memory_type", type: "string" },
  { propertyName: "active", type: "boolean" },
];

const wr = (...args) => ["npx", "wrangler", ...args].join(" ");

/** §58.2 — print the intended remote shape without touching Cloudflare. */
export function planResources({ app, envName, dimensions, metric, namespace }) {
  assertEnv(envName);
  const names = resourceNames(assertSafeName(app, "app"), envName);
  assertSafeName(names.vectorizeIndex, "vectorize index name");
  assertSafeName(names.r2Bucket, "r2 bucket name");
  assertSafeName(namespace, "memory namespace");
  if (String(namespace).length > 32) {
    throw new Error(`memory namespace must be <= 32 characters (§12), got ${namespace.length}: ${namespace}`);
  }
  return {
    env: envName,
    namespace,
    dimensions,
    metric,
    names,
    steps: [
      {
        id: "vectorize-index",
        title: `Create Vectorize index ${names.vectorizeIndex}`,
        commands: [wr("vectorize", "create", names.vectorizeIndex, `--dimensions=${dimensions}`, `--metric=${metric}`)],
        note: "Must exist before the first vector write.",
      },
      {
        id: "vectorize-metadata-indexes",
        title: `Create metadata indexes on ${names.vectorizeIndex}`,
        commands: [
          ...REQUIRED_METADATA_INDEXES.map((entry) =>
            wr("vectorize", "create-metadata-index", names.vectorizeIndex, `--property-name=${entry.propertyName}`, `--type=${entry.type}`),
          ),
          wr("vectorize", "list-metadata-index", names.vectorizeIndex),
        ],
        note: "profile_key is a blocking precondition: without it DO NOT ingest vectors (§6 step 2).",
      },
      {
        id: "r2-archive",
        title: `Create private R2 archive bucket ${names.r2Bucket}`,
        commands: [wr("r2", "bucket", "create", names.r2Bucket), wr("r2", "bucket", "list")],
        note: `Archive keys live under ${names.archivePrefix}<profile_key>/... ; SOUL packages use ${names.soulPrefix}<character_key>/... .`,
      },
      {
        id: "bindings",
        title: "Provision Worker, Durable Object and Workflow bindings",
        commands: [wr("deploy", "--env", envName)],
        note:
          `No manual DO namespace step: ${names.bindings.doClass} is provisioned from the exports block ` +
          `(storage: sqlite) on deploy. Workflows ${names.consolidateWorkflow} and ${names.deleteProfileWorkflow} ` +
          "deploy with the Worker class.",
      },
      {
        id: "secrets",
        title: `Configure required secrets for ${names.worker}`,
        commands: REQUIRED_SECRETS.map((secret) => wr("secret", "put", secret, "--env", envName)),
        note: "PROFILE_KEY_SECRET must come from cryptographically secure random bytes; never a memorable phrase.",
      },
    ],
  };
}

export function formatPlan(plan) {
  const row = (label, value) => `  ${label.padEnd(26)}${value}`;
  return [
    `Planned resources for env=${plan.env}`,
    "",
    row("worker", plan.names.worker),
    row("vectorize index", plan.names.vectorizeIndex),
    row("r2 bucket", plan.names.r2Bucket),
    row("consolidate workflow", plan.names.consolidateWorkflow),
    row("delete-profile workflow", plan.names.deleteProfileWorkflow),
    row("DO binding / class", `${plan.names.bindings.durableObject} / ${plan.names.bindings.doClass} (sqlite)`),
    row("memory namespace", plan.namespace),
    row("embedding", `${plan.dimensions} dims, ${plan.metric}`),
    "",
    "Apply in this order (this command does not mutate anything):",
    "",
    ...plan.steps.flatMap((step) => [
      `${step.title}`,
      ...step.commands.map((command) => `  $ ${command}`),
      `  # ${step.note}`,
      "",
    ]),
  ].join("\n");
}

/** §52 remote facts, read-only through Wrangler. */
export async function collectRemoteFacts({ run, names, expectedAccountId }) {
  const facts = {
    wranglerAvailable: true,
    authenticated: false,
    accountId: null,
    accountName: null,
    accountMismatch: null,
    vectorize: { exists: false, dimensions: null, metric: null, metadataIndexes: [], readError: null },
    r2: { exists: false, readError: null },
    secrets: { configured: [], readError: null },
    deployed: { known: false, readError: null },
  };

  const whoami = await run(["whoami", "--json"]);
  const whoamiParsed = parseOutput(whoami.stdout);
  const accounts = pick(whoamiParsed, ["result.accounts", "accounts", "data.accounts"]) ?? [];
  const textAuth = /logged in|received access to account/i.test(`${whoami.stdout}\n${whoami.stderr}`);
  facts.authenticated =
    whoami.ok &&
    (Boolean(pick(whoamiParsed, ["result.authenticated", "authenticated", "success", "result.email", "email"])) ||
      (Array.isArray(accounts) && accounts.length > 0) ||
      textAuth);
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  facts.accountId =
    pick(first, ["account_id", "id", "Account ID"]) ??
    pick(whoamiParsed, ["result.account.id", "result.account_id", "account_id", "accountId"]) ??
    null;
  facts.accountName = pick(first, ["account_name", "name", "Account Name"]) ?? pick(whoamiParsed, ["result.account.name"]) ?? null;
  if (!facts.authenticated) {
    facts.wranglerAvailable = whoami.ok || !/command not found|ENOENT|not recognized/i.test(whoami.stderr);
    return { ...facts, incomplete: true };
  }
  if (expectedAccountId && facts.accountId && expectedAccountId !== facts.accountId) {
    facts.accountMismatch = `expected ${expectedAccountId}, got ${facts.accountId}`;
  }

  const index = await run(["vectorize", "get", names.vectorizeIndex]);
  if (index.ok) {
    const parsed = parseOutput(index.stdout);
    const kv = kvMap(parsed);
    facts.vectorize.exists = true;
    facts.vectorize.dimensions =
      Number(pick(parsed, ["dimensions", "data.dimensions", "config.dimensions", "index_config.dimensions"]) ?? kv.get("dimensions")) || null;
    facts.vectorize.metric =
      pick(parsed, ["metric", "data.metric", "config.metric", "index_config.metric"]) ?? kv.get("metric") ?? null;
  } else {
    facts.vectorize.readError = firstLine(index.stderr || index.stdout);
  }

  const metadata = await run(["vectorize", "list-metadata-index", names.vectorizeIndex]);
  if (metadata.ok) {
    const parsed = parseOutput(metadata.stdout);
    facts.vectorize.metadataIndexes = normalizeMetadataIndexes(parsed);
  } else {
    facts.vectorize.readError = facts.vectorize.readError ?? firstLine(metadata.stderr || metadata.stdout);
  }

  const buckets = await run(["r2", "bucket", "list", "--json"]);
  if (buckets.ok) {
    const parsed = parseOutput(buckets.stdout);
    const list = Array.isArray(parsed) ? parsed : pick(parsed, ["buckets", "result", "data"]) ?? [];
    const names_ = list.map((entry) => pick(entry, ["bucket_name", "name", "Bucket Name"]) ?? entry);
    facts.r2.exists = names_.includes(names.r2Bucket);
  } else {
    facts.r2.readError = firstLine(buckets.stderr || buckets.stdout);
  }

  const secrets = await run(["secret", "list", "--env", names.env]);
  if (secrets.ok) {
    const parsed = parseOutput(secrets.stdout);
    const list = Array.isArray(parsed) ? parsed : pick(parsed, ["secrets", "result"]) ?? [];
    facts.secrets.configured = list.map((entry) => pick(entry, ["name", "secret"]) ?? entry).filter(Boolean);
  } else {
    facts.secrets.readError = firstLine(secrets.stderr || secrets.stdout);
  }

  const deployments = await run(["deployments", "status", "--env", names.env]);
  facts.deployed.known = deployments.ok;
  if (!deployments.ok) facts.deployed.readError = firstLine(deployments.stderr || deployments.stdout);

  return { ...facts, incomplete: false };
}

/** Wrangler prints key/value tables when `--json` is absent. */
function kvMap(parsed) {
  const map = new Map();
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const label = row.field ?? row.config ?? row.key ?? row.name ?? row.Name;
    const value = row.value ?? row.Value;
    if (typeof label === "string" && value !== undefined && value !== null) map.set(label.toLowerCase(), value);
  }
  return map;
}

function normalizeMetadataIndexes(parsed) {
  const list = Array.isArray(parsed) ? parsed : pick(parsed, ["metadata_indexes", "data", "result"]) ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === "string") {
        const [propertyName, type] = entry.split(/[:\s]+/);
        return { propertyName, type: type?.toLowerCase() ?? null };
      }
      return {
        propertyName: pick(entry, ["propertyName", "property_name", "Property Name", "name"]) ?? null,
        type: (pick(entry, ["type", "Type"]) ?? "").toString().toLowerCase() || null,
      };
    })
    .filter((entry) => entry.propertyName);
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "unknown error";
}

/** Pure drift detector so the rules are testable without a Cloudflare account. */
export function detectDrift({ intended, local, remote }) {
  const findings = [];
  const add = (area, name, status, expected, actual, hint, source) =>
    findings.push({ area, name, status, expected, actual: actual ?? null, hint: hint ?? null, source });

  if (!remote?.authenticated) {
    add("auth", "wrangler whoami", "unknown", "authenticated", remote?.wranglerAvailable === false ? "wrangler not installed" : "not authenticated",
      "Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN, then re-run verify.", "remote");
    return { findings, drift: findings.some((f) => f.status === "drift"), blocked: true };
  }
  add("auth", "wrangler whoami", "ok", "authenticated", "authenticated", null, "remote");
  if (remote.accountMismatch) add("auth", "account", "drift", "expected account", remote.accountMismatch, "Wrong account; §5.1 forbids shared environments across accounts.", "remote");

  const metadataLookup = new Map(remote.vectorize.metadataIndexes.map((entry) => [entry.propertyName, entry.type]));
  const crossEnv = crossEnvironmentNames({ intended, local, remote });
  for (const entry of crossEnv) {
    add("isolation", entry.name, "drift", `no "-dev" resource referenced from ${intended.env}`, entry.detail, "§5.1/§52: production must not point at a dev resource.", "local+remote");
  }

  add("vectorize", "index exists", remote.vectorize.exists ? "ok" : remote.vectorize.readError ? "unknown" : "drift",
    intended.vectorizeIndex, remote.vectorize.exists ? intended.vectorizeIndex : remote.vectorize.readError ?? "missing",
    remote.vectorize.readError ? `Could not read index: ${remote.vectorize.readError}` : `npx wrangler vectorize create ${intended.vectorizeIndex} ...`, "remote");
  if (remote.vectorize.exists) {
    add("vectorize", "dimensions", eq(remote.vectorize.dimensions, intended.embeddingDimensions) ? "ok" : "drift",
      intended.embeddingDimensions, remote.vectorize.dimensions, "Dimensions must match the embedding model output.", "remote");
    add("vectorize", "metric", eq((remote.vectorize.metric ?? "").toString().toLowerCase(), intended.vectorMetric) ? "ok" : "drift",
      intended.vectorMetric, remote.vectorize.metric, null, "remote");
    for (const required of REQUIRED_METADATA_INDEXES) {
      const actualType = metadataLookup.get(required.propertyName);
      add("vectorize", `metadata ${required.propertyName}`, actualType ? (eq(actualType, required.type) ? "ok" : "drift") : "drift",
        required.type, actualType ?? "missing",
        actualType ? null : `profile_key missing is a blocking condition: do not ingest vectors (§6 step 2). npx wrangler vectorize create-metadata-index ${intended.vectorizeIndex} --property-name=${required.propertyName} --type=${required.type}`,
        "remote");
    }
  }

  add("r2", "bucket exists", remote.r2.exists ? "ok" : remote.r2.readError ? "unknown" : "drift", intended.r2Bucket,
    remote.r2.exists ? intended.r2Bucket : remote.r2.readError ?? "missing",
    remote.r2.readError ? `Could not list buckets: ${remote.r2.readError}` : `npx wrangler r2 bucket create ${intended.r2Bucket}`, "remote");

  const localChecks = [
    ["worker name", local?.workerName ?? null, intended.worker, "wrangler name must follow §5 naming"],
    ["DO binding", local?.durableObject ?? null, BINDINGS.durableObject, null],
    ["DO storage", local?.doStorage ?? null, "sqlite", "exports.MemoryProfile.storage must be sqlite"],
    ["AI binding", local?.ai ?? null, BINDINGS.ai, null],
    ["Vectorize binding", local?.vectorizeBinding ?? null, BINDINGS.vectorize, null],
    ["Vectorize target", local?.vectorizeIndex ?? null, intended.vectorizeIndex, "Binding must target this environment's index"],
    ["R2 binding", local?.r2Binding ?? null, BINDINGS.r2, null],
    ["R2 target", local?.r2Bucket ?? null, intended.r2Bucket, "Binding must target this environment's bucket"],
    ["Consolidation workflow", local?.consolidateWorkflow ?? null, intended.consolidateWorkflow, null],
    ["Deletion workflow", local?.deleteWorkflow ?? null, intended.deleteProfileWorkflow, null],
  ];
  for (const [name, actual, expected, hint] of localChecks) {
    if (!local) {
      add("worker-config", name, "unknown", expected, "no wrangler.jsonc found", "Run cfmem init or add wrangler.jsonc.", "local");
      continue;
    }
    if (actual === null && (name === "Consolidation workflow" || name === "Deletion workflow")) {
      add("worker-config", name, "missing", expected, "not declared", `Declare workflows[].binding=${expected === intended.consolidateWorkflow ? BINDINGS.consolidateWorkflow : BINDINGS.deleteWorkflow} before Phase 5.`, "local");
      continue;
    }
    add("worker-config", name, eq(actual, expected) ? "ok" : "drift", expected, actual, hint, "local");
  }

  const declaredSecrets = local?.requiredSecrets ?? [];
  for (const secret of REQUIRED_SECRETS) {
    add("secrets", `${secret} declared`, declaredSecrets.includes(secret) ? "ok" : "drift", "declared in secrets.required", declaredSecrets.includes(secret) ? "declared" : "not declared", "§7 secrets.required drives deploy-time validation.", "local");
    if (!remote.secrets.readError) {
      add("secrets", `${secret} configured`, remote.secrets.configured.includes(secret) ? "ok" : "drift", "present remotely",
        remote.secrets.configured.includes(secret) ? "present" : "missing", `npx wrangler secret put ${secret} --env ${intended.env}`, "remote");
    } else {
      add("secrets", "remote secret list", "unknown", "list readable", remote.secrets.readError, `Could not read secrets for env ${intended.env}.`, "remote");
    }
  }

  if (!remote.deployed.known) {
    add("worker", "deployment status", "unknown", "deployed", remote.deployed.readError ?? "unreadable", "Deploy once, then re-run verify.", "remote");
  } else {
    add("worker", "deployment status", "ok", "deployed", "deployed", null, "remote");
  }

  const drift = findings.filter((f) => f.status === "drift");
  const blocking = findings.filter((f) => f.status === "drift" && f.name.startsWith("metadata profile_key"));
  return { findings, drift: drift.length > 0, blocking: blocking.length > 0, driftCount: drift.length };
}

function crossEnvironmentNames({ intended, local, remote }) {
  const out = [];
  const devOnly = [local?.vectorizeIndex, local?.r2Bucket, local?.workerName, local?.consolidateWorkflow, remote?.vectorize?.indexName]
    .filter((value) => typeof value === "string" && /(^|-)dev($|-)/.test(value));
  if (intended.env !== "dev" && devOnly.length) {
    out.push({ name: `${intended.env} configuration`, detail: `dev-named resource(s): ${[...new Set(devOnly)].join(", ")}` });
  }
  return out;
}

const eq = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

export function formatVerify(result, intended) {
  const icon = { ok: "OK ", drift: "!! ", missing: ".. ", unknown: "?  " };
  const missingCount = result.findings.filter((f) => f.status === "missing").length;
  const lines = [
    `cfmem resources verify — env=${intended.env} (app=${intended.app})`,
    "",
    ...result.findings.map((f) => {
      const detail = f.actual === null || f.actual === undefined ? "" : ` -> ${f.actual}`;
      return `${icon[f.status] ?? "?? "}[${f.area}] ${f.name}: expected ${f.expected}${detail} (${f.source})`;
    }),
    "",
  ];
  if (result.blocked) lines.push("Verification stopped: not authenticated. Re-run after `npx wrangler login`.");
  else if (result.drift) lines.push(`Drift detected in ${result.driftCount} check(s). Resolve before deploying or trusting retrieval quality results.`);
  else if (missingCount) lines.push(`No drift, but ${missingCount} expected resource(s) are not provisioned for env=${intended.env} yet.`);
  else lines.push("No configuration drift detected.");
  const hints = result.findings.filter((f) => f.hint && f.status !== "ok");
  if (hints.length) lines.push("", ...hints.map((f) => `  - [${f.area}] ${f.name}: ${f.hint}`));
  return lines.join("\n");
}
