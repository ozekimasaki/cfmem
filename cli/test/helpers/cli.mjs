import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = path.resolve(here, "..", "..");
export const CFMEM = path.join(CLI_ROOT, "src", "cfmem.mjs");
export const DATASET = path.join(CLI_ROOT, "templates", "worker", "test", "benchmark", "ja-memory-v1.jsonl");
export const TEMPLATE_WRANGLER = path.join(CLI_ROOT, "templates", "worker", "wrangler.jsonc");

/** Runs the real CLI in a child process so flags, exit codes and stdout are exercised. */
export async function runCli(args, { cwd = CLI_ROOT, env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  delete childEnv.CFMEM_ENV;
  delete childEnv.CFMEM_ENDPOINT;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CFMEM, ...args], {
      cwd,
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.message) };
  }
}

export function makeTempDir(prefix = "cfmem-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function withTempDir(prefix, fn) {
  const dir = makeTempDir(prefix);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  try {
    return fn(dir);
  } finally {
    cleanup();
  }
}

export async function withTempDirAsync(prefix, fn) {
  const dir = makeTempDir(prefix);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  try {
    return await fn(dir);
  } finally {
    cleanup();
  }
}

export function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}
