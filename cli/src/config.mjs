import fs from "node:fs";
import path from "node:path";
import { PRICING } from "./cost.mjs";

export const ENVIRONMENTS = ["dev", "staging", "production"];
export const DEFAULT_APP = "character-memory";
export const CONFIG_FILE = "cfmem.config.json";
export const WRANGLER_FILE = "wrangler.jsonc";

export const BINDINGS = {
  durableObject: "MEMORY_PROFILES",
  doClass: "MemoryProfile",
  ai: "AI",
  vectorize: "MEMORY_VECTORS",
  r2: "MEMORY_ARCHIVE",
  consolidateWorkflow: "MEMORY_CONSOLIDATION",
  deleteWorkflow: "PROFILE_DELETION",
};

export const REQUIRED_SECRETS = ["PROFILE_KEY_SECRET", "ADMIN_API_TOKEN"];

/** §7 baseline vars, used by init/plan/doctor so defaults never diverge. */
export const RESOURCE_DEFAULTS = {
  embeddingModel: "@cf/qwen/qwen3-embedding-0.6b",
  dimensions: 1024,
  metric: "cosine",
  checkpointTurns: 8,
  idleSeconds: 120,
  maxBatchMessages: 100,
  extractionMinConfidence: 0.72,
};

/**
 * Strips comments and trailing commas outside of string literals. A regex
 * cannot tell `"https://x"` from a `//` comment, so this walks the text.
 */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === ",") {
      const rest = text.slice(i + 1);
      if (/^\s*[}\]]/.test(rest)) continue;
    }
    out += char;
  }
  return JSON.parse(out);
}

function readJsonFile(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    return parseJsonc(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable (${file}): ${error.message}`);
  }
}

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE)) || fs.existsSync(path.join(dir, WRANGLER_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** §5 resource naming: one place so plan, verify, and drift checks cannot disagree. */
export function resourceNames(app, envName) {
  assertEnv(envName);
  const suffix = `-${envName}`;
  return {
    app,
    env: envName,
    worker: `${app}${suffix}`,
    vectorizeIndex: `${app}${suffix}-memory-v1`,
    r2Bucket: `${app}${suffix}-archive`,
    consolidateWorkflow: `${app}${suffix}-consolidate-v1`,
    deleteProfileWorkflow: `${app}${suffix}-delete-profile-v1`,
    archivePrefix: "profiles/",
    soulPrefix: "characters/",
    bindings: BINDINGS,
  };
}

export function assertEnv(envName) {
  if (!ENVIRONMENTS.includes(envName)) {
    throw new Error(`Unknown --env "${envName}". Expected one of: ${ENVIRONMENTS.join(", ")}`);
  }
  return envName;
}

export function loadConfig({ dir = process.cwd(), env = process.env } = {}) {
  const root = dir;
  const configFile = path.join(root, CONFIG_FILE);
  const fileConfig = readJsonFile(configFile, CONFIG_FILE) ?? {};
  const wrangler = readJsonFile(path.join(root, WRANGLER_FILE), WRANGLER_FILE) ?? null;

  const envName = env.CFMEM_ENV || fileConfig.env || inferEnvFromWrangler(wrangler) || "dev";
  const app = env.CFMEM_APP || fileConfig.app || DEFAULT_APP;
  const names = resourceNames(app, envName);
  const wranglerVars = wrangler?.vars ?? {};

  const intended = {
    ...names,
    embeddingModel: env.CFMEM_EMBEDDING_MODEL || fileConfig.embeddingModel || wranglerVars.EMBEDDING_MODEL || null,
    embeddingDimensions: Number(
      env.CFMEM_EMBEDDING_DIMENSIONS || fileConfig.embeddingDimensions || wranglerVars.EMBEDDING_DIMENSIONS || 1024,
    ),
    vectorMetric: fileConfig.vectorMetric || "cosine",
    namespace: env.CFMEM_NAMESPACE || fileConfig.namespace || wranglerVars.MEMORY_NAMESPACE || "default",
    checkpointTurns: Number(env.CFMEM_CHECKPOINT_TURNS || fileConfig.checkpointTurns || wranglerVars.CHECKPOINT_TURNS || 8),
    idleSeconds: Number(env.CFMEM_IDLE_SECONDS || fileConfig.idleSeconds || wranglerVars.IDLE_SECONDS || 120),
    requiredSecrets: REQUIRED_SECRETS,
    pricingReviewedAt: fileConfig.pricingReviewedAt || PRICING.reviewedAt,
  };

  return {
    root,
    hasConfig: fs.existsSync(configFile),
    hasWrangler: wrangler !== null,
    wrangler,
    raw: fileConfig,
    intended,
    warnings: [],
  };
}

function inferEnvFromWrangler(wrangler) {
  const name = wrangler?.name;
  if (typeof name !== "string") return null;
  for (const candidate of ENVIRONMENTS) {
    if (name === candidate || name.endsWith(`-${candidate}`)) return candidate;
  }
  return null;
}

/** Bindings as declared locally, used as the "intended" side of drift checks. */
export function localBindings(wrangler) {
  const vectorizeIndex = wrangler?.vectorize?.[0]?.index_name ?? null;
  const r2Bucket = wrangler?.r2_buckets?.[0]?.bucket_name ?? null;
  const workflows = Object.fromEntries(
    (wrangler?.workflows ?? []).map((entry) => [entry.binding, entry.name]),
  );
  return {
    workerName: wrangler?.name ?? null,
    ai: wrangler?.ai?.binding ?? null,
    durableObject: wrangler?.durable_objects?.bindings?.[0]?.name ?? null,
    doStorage: wrangler?.exports?.MemoryProfile?.storage ?? null,
    vectorizeBinding: wrangler?.vectorize?.[0]?.binding ?? null,
    vectorizeIndex,
    r2Binding: wrangler?.r2_buckets?.[0]?.binding ?? null,
    r2Bucket,
    consolidateWorkflow: workflows[BINDINGS.consolidateWorkflow] ?? null,
    deleteWorkflow: workflows[BINDINGS.deleteWorkflow] ?? null,
    requiredSecrets: wrangler?.secrets?.required ?? [],
  };
}

export function resolveApiSettings(args, env = process.env, config = null) {
  const pick = (flagValue, names, fallback) => {
    if (flagValue !== undefined && flagValue !== true) return flagValue;
    for (const name of names) if (env[name]) return env[name];
    if (fallback !== undefined && fallback !== null) return fallback;
    return undefined;
  };
  const subject = pick(args.subject ?? args.profile, ["CFMEM_SUBJECT", "CFMEM_PROFILE"], config?.intended?.subject);
  return {
    endpoint: pick(args.endpoint, ["CFMEM_ENDPOINT"], undefined),
    token: pick(args.token, ["CFMEM_TOKEN", "ADMIN_API_TOKEN"], undefined),
    namespace: pick(args.namespace, ["CFMEM_NAMESPACE"], config?.intended?.namespace),
    character: pick(args.character, ["CFMEM_CHARACTER"], config?.intended?.app ?? DEFAULT_APP),
    subject,
    profile: subject,
  };
}

export { pricingStalenessWarning } from "./cost.mjs";
