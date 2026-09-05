import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * §52 worker-config checks that need no Cloudflare credentials. `cfmem init` rewrites
 * these names per environment, so this test is also what proves a scaffold never
 * points at another environment's resources (§5.1).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, "..", "wrangler.jsonc"), "utf8");
const config = JSON.parse(raw.split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join("\n"));

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

test("worker name follows the §5 naming rule", () => {
  assert.match(config.name, SAFE_NAME);
  assert.equal(config.main, "src/index.ts");
  assert.ok(config.compatibility_date, "compatibility_date is required for deploys");
});

test("§5.1 every bound resource is namespaced under the worker name", () => {
  assert.equal(config.vectorize.length, 1);
  assert.equal(config.vectorize[0].index_name, `${config.name}-memory-v1`);
  assert.equal(config.vectorize[0].binding, "MEMORY_VECTORS");
  assert.equal(config.r2_buckets.length, 1);
  assert.equal(config.r2_buckets[0].bucket_name, `${config.name}-archive`);
  assert.equal(config.r2_buckets[0].binding, "MEMORY_ARCHIVE");
  assert.equal(config.ai.binding, "AI");
});

test("the SQLite-exported Durable Object is declared the way §17 requires", () => {
  const [binding] = config.durable_objects.bindings;
  assert.equal(binding.name, "MEMORY_PROFILES");
  assert.equal(binding.class_name, "MemoryProfile");
  assert.equal(binding.script_name, undefined, "the starter is not a foreign-script binding");
  assert.deepEqual(config.exports, {
    MemoryProfile: { type: "durable-object", storage: "sqlite" },
  });
});

test("secrets are declared as required and never inlined as vars (§7)", () => {
  assert.deepEqual([...config.secrets.required].sort(), ["ADMIN_API_TOKEN", "PROFILE_KEY_SECRET"]);
  for (const [key, value] of Object.entries(config.vars)) {
    assert.equal(typeof value, "string", `${key} must be a string var`);
    assert.match(key, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(/SECRET|TOKEN|KEY$/i.test(key), false, `${key} belongs in secrets, not vars`);
  }
});

test("memory namespace var respects the §12 identity limits", () => {
  const namespace = config.vars.MEMORY_NAMESPACE;
  assert.ok(namespace, "MEMORY_NAMESPACE must be set or the worker cannot route profiles");
  assert.match(namespace, /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
  assert.equal(Number(config.vars.EMBEDDING_DIMENSIONS) > 0, true);
  assert.equal(Number(config.vars.CHECKPOINT_TURNS) > 0, true);
});
