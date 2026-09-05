import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSafeName(value, label) {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    throw new Error(`${label} is not a safe Cloudflare resource name: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Resolves the project-local Wrangler binary, falling back to `npx`. */
export function wranglerCommand({ cwd = process.cwd() } = {}) {
  const shim = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  const local = path.join(cwd, "node_modules", ".bin", shim);
  if (fs.existsSync(local)) return { cmd: local, prefix: [] };
  return { cmd: "npx", prefix: ["--no-install", "wrangler"] };
}

/** MSVCRT-style quoting: backslashes only matter before a double quote. */
export function quoteWindowsArg(value) {
  const str = String(value);
  if (str && !/[\s"&<>|^()%!]/.test(str)) return str;
  return `"${str.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

/** Builds the single string cmd.exe expects after `/d /s /c`. */
function windowsCommandLine(cmd, args) {
  return [cmd, ...args].map(quoteWindowsArg).join(" ");
}

/**
 * Runs a read-only Wrangler command. Everything here is invoked with execFile
 * and an argument array (no shell string interpolation), and resource names are
 * validated first, so operator-supplied values cannot become shell syntax.
 */
export function createWranglerRunner({ cwd = process.cwd(), exec = execFileAsync } = {}) {
  return async function run(subcommand, { env = process.env } = {}) {
    const { cmd, prefix } = wranglerCommand({ cwd });
    const args = [...prefix, ...subcommand];
    // .cmd shims cannot be CreateProcess'd directly on Windows, and `shell: true`
    // joins arguments without quoting them, so paths with spaces break.
    const isWin = process.platform === "win32";
    const invocation = isWin
      ? ["cmd.exe", ["/d", "/s", "/c", `"${windowsCommandLine(cmd, args)}"`]]
      : [cmd, args];
    try {
      const { stdout, stderr } = await exec(invocation[0], invocation[1], {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        windowsVerbatimArguments: isWin,
      });
      return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (error) {
      return {
        ok: false,
        stdout: error?.stdout ?? "",
        stderr: error?.stderr ?? error?.message ?? String(error),
      };
    }
  };
}

/** Wrangler mixes prose and structured output; try JSON first, then tables. */
export function parseOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  const direct = tryJson(text);
  if (direct !== undefined) return direct;
  const start = text.search(/[[{]/);
  if (start !== -1) {
    for (let end = text.length; end > start; end--) {
      const candidate = tryJson(text.slice(start, end));
      if (candidate !== undefined) return candidate;
    }
  }
  const table = parseTable(text);
  return table ?? text;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parses `| col | col |` / box-drawing tables printed by Wrangler. */
export function parseTable(text) {
  const rows = text.split(/\r?\n/).filter((line) => /[│|]/.test(line));
  if (rows.length < 2) return null;
  const cells = (line) =>
    line
      .replace(/[┌┐└┘├┤┬┴┼─]/g, "|")
      .split(/[│|]/)
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
  const header = cells(rows[0]);
  const body = rows.slice(1).map(cells).filter((row) => row.length && !row.every((cell) => /^[-: ]*$/.test(cell)));
  if (!header.length) return null;
  return body.map((row) => Object.fromEntries(header.map((key, index) => [key.toLowerCase(), row[index] ?? null])));
}

export function pick(object, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), object);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}
