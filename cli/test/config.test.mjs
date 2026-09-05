import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_APP,
  RESOURCE_DEFAULTS,
  localBindings,
  loadConfig,
  parseJsonc,
  pricingStalenessWarning,
  resolveApiSettings,
  resourceNames,
} from "../src/config.mjs";
import { assertSafeName } from "../src/wrangler.mjs";
import { TEMPLATE_WRANGLER, withTempDir, writeJson } from "./helpers/cli.mjs";

test("§5 resource names carry the environment suffix in every environment", () => {
  for (const envName of ["dev", "staging", "production"]) {
    const names = resourceNames(DEFAULT_APP, envName);
    assert.equal(names.worker, `character-memory-${envName}`);
    assert.equal(names.vectorizeIndex, `character-memory-${envName}-memory-v1`);
    assert.equal(names.r2Bucket, `character-memory-${envName}-archive`);
    assert.equal(names.consolidateWorkflow, `character-memory-${envName}-consolidate-v1`);
    assert.equal(names.deleteProfileWorkflow, `character-memory-${envName}-delete-profile-v1`);
  }
  // §5.1: production never shares a name with a dev resource.
  assert.notEqual(resourceNames(DEFAULT_APP, "production").vectorizeIndex, resourceNames(DEFAULT_APP, "dev").vectorizeIndex);
  assert.ok(assertSafeName(resourceNames(DEFAULT_APP, "production").deleteProfileWorkflow));
});

test("unknown environments are rejected instead of silently naming resources", () => {
  assert.throws(() => resourceNames(DEFAULT_APP, "prod"), /Unknown --env "prod"/);
  assert.throws(() => resourceNames(DEFAULT_APP, ""), /Unknown --env/);
});

test("parseJsonc tolerates comments and trailing commas", () => {
  const parsed = parseJsonc(`{
    // line comment
    "name": "x", /* block */
    "list": [1, 2,],
    "url": "https://example.test//path",
    "//": "note key, not a comment",
    "quoted": "a \\"//\\" inside",
  }`);
  assert.equal(parsed.name, "x");
  assert.deepEqual(parsed.list, [1, 2]);
  assert.equal(parsed.url, "https://example.test//path");
  assert.equal(parsed["//"], "note key, not a comment");
  assert.equal(parsed.quoted, 'a "//" inside');
});

test("localBindings reads the shipped template into the §52 shape", () => {
  const wrangler = parseJsonc(fs.readFileSync(TEMPLATE_WRANGLER, "utf8"));
  const local = localBindings(wrangler);
  assert.equal(local.workerName, "character-memory-dev");
  assert.equal(local.durableObject, "MEMORY_PROFILES");
  assert.equal(local.doStorage, "sqlite");
  assert.equal(local.vectorizeIndex, "character-memory-dev-memory-v1");
  assert.equal(local.r2Bucket, "character-memory-dev-archive");
  assert.deepEqual(local.requiredSecrets, ["PROFILE_KEY_SECRET", "ADMIN_API_TOKEN"]);
  // Phase 5 workflows are intentionally absent from the starter; verify reports them missing.
  assert.equal(local.consolidateWorkflow, null);
  assert.equal(local.deleteWorkflow, null);
});

test("loadConfig resolves env/app and §7 defaults from a project directory", () => {
  withTempDir("cfmem-config-", (dir) => {
    writeJson(path.join(dir, "cfmem.config.json"), { app: "kagami", env: "staging", namespace: "kagami-prod" });
    fs.copyFileSync(TEMPLATE_WRANGLER, path.join(dir, "wrangler.jsonc"));
    const config = loadConfig({ dir, env: {} });
    assert.equal(config.hasConfig, true);
    assert.equal(config.intended.app, "kagami");
    assert.equal(config.intended.env, "staging");
    assert.equal(config.intended.worker, "kagami-staging");
    assert.equal(config.intended.namespace, "kagami-prod");
    assert.equal(config.intended.embeddingModel, RESOURCE_DEFAULTS.embeddingModel);
    assert.equal(config.intended.embeddingDimensions, 1024);
    assert.equal(config.intended.vectorMetric, "cosine");
  });
});

test("environment variables outrank cfmem.config.json (§58 scoping)", () => {
  withTempDir("cfmem-config-", (dir) => {
    writeJson(path.join(dir, "cfmem.config.json"), { app: "kagami", env: "staging", checkpointTurns: 4 });
    const fromFile = loadConfig({ dir, env: {} });
    assert.equal(fromFile.intended.env, "staging");
    assert.equal(fromFile.intended.checkpointTurns, 4);
    const fromEnv = loadConfig({ dir, env: { CFMEM_ENV: "production", CFMEM_CHECKPOINT_TURNS: "12" } });
    assert.equal(fromEnv.intended.env, "production");
    assert.equal(fromEnv.intended.worker, "kagami-production");
    assert.equal(fromEnv.intended.checkpointTurns, 12);
  });
});

test("env is inferred from the wrangler worker name when no config file exists", () => {
  withTempDir("cfmem-config-", (dir) => {
    fs.copyFileSync(TEMPLATE_WRANGLER, path.join(dir, "wrangler.jsonc"));
    const config = loadConfig({ dir, env: {} });
    assert.equal(config.hasConfig, false);
    assert.equal(config.intended.env, "dev");
    assert.equal(config.intended.worker, "character-memory-dev");
  });
});

test("resolveApiSettings precedence is flag > env > config > default", () => {
  const config = { intended: { namespace: "from-config", app: "character-memory", subject: undefined } };
  const flags = resolveApiSettings({ endpoint: "https://flag.test", namespace: "from-flag", subject: "from-flag" }, {}, config);
  assert.equal(flags.endpoint, "https://flag.test");
  assert.equal(flags.namespace, "from-flag");
  assert.equal(flags.subject, "from-flag");
  assert.equal(flags.profile, "from-flag");

  const envOnly = resolveApiSettings({}, { CFMEM_ENDPOINT: "https://env.test", CFMEM_NAMESPACE: "from-env", CFMEM_SUBJECT: "env-subject" }, config);
  assert.equal(envOnly.endpoint, "https://env.test");
  assert.equal(envOnly.namespace, "from-env");
  assert.equal(envOnly.subject, "env-subject");

  const fromConfig = resolveApiSettings({}, {}, config);
  assert.equal(fromConfig.namespace, "from-config");
  assert.equal(fromConfig.character, "character-memory");
  assert.equal(fromConfig.endpoint, undefined);
  assert.equal(fromConfig.subject, undefined);
});

test("A24: pricing older than 90 days is flagged as stale", () => {
  const now = new Date("2026-09-05T00:00:00Z");
  assert.equal(pricingStalenessWarning("2026-07-01", now), null);
  const stale = pricingStalenessWarning("2026-01-01", now);
  assert.match(stale, /stale|review/i);
  assert.match(stale, /2026-01-01/);
});
