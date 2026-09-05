const toKey = (raw) => raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      out._.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      for (const short of arg.slice(1)) {
        if (short === "h") out.help = true;
        else out[toKey(short)] = true;
      }
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      out[toKey(body.slice(0, eq))] = body.slice(eq + 1);
      continue;
    }
    const key = toKey(body);
    const next = argv[i + 1];
    // A following token that looks like a flag means this flag is boolean.
    // Values that start with a dash must use --flag=-value.
    if (next === undefined || (next.startsWith("-") && next.length > 1)) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function flagValue(args, ...names) {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== true) return value;
  }
  return undefined;
}

export function boolFlag(args, ...names) {
  for (const name of names) if (args[name] === true) return true;
  return false;
}

export function requireValues(args, spec, command) {
  const missing = [];
  for (const [names, label] of spec) {
    if (flagValue(args, ...names) === undefined) missing.push(label ?? `--${names[0]}`);
  }
  if (missing.length) throw new Error(`${command}: missing required flag(s): ${missing.join(", ")}`);
}

export function numberFlag(args, name, { min, max, fallback } = {}) {
  const raw = args[name];
  if (raw === undefined || raw === true || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got: ${raw}`);
  if (min !== undefined && value < min) throw new Error(`--${name} must be >= ${min}`);
  if (max !== undefined && value > max) throw new Error(`--${name} must be <= ${max}`);
  return value;
}
