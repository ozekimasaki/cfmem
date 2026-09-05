/**
 * §58.4 — destructive commands need explicit identity plus a confirmation flag
 * when running non-interactively.
 */
export function identityLabel({ namespace, character, subject }) {
  return `${namespace}/${character}/${subject}`;
}

export function requireConfirmation({ action, identity, yes, answer, isTTY = process.stdout?.isTTY === true }) {
  const missing = ["namespace", "character", "subject"].filter((key) => !identity?.[key]);
  if (missing.length) {
    throw new Error(
      `${action}: refusing to run without explicit identity. Missing: ${missing.join(", ")}. ` +
        "Pass --namespace, --character and --subject (or the matching CFMEM_* variables).",
    );
  }
  const label = identityLabel(identity);
  if (yes === true) return { confirmed: true, label, mode: "flag" };
  if (yes !== undefined && yes !== true) {
    if (String(yes) !== label) {
      throw new Error(
        `${action}: --confirm="${yes}" does not match the resolved identity "${label}". ` +
          "Re-run with --confirm <namespace>/<character>/<subject>.",
      );
    }
    return { confirmed: true, label, mode: "echo" };
  }
  if (!isTTY) {
    throw new Error(
      `${action}: ${label} is destructive and this session is non-interactive. ` +
        `Re-run with --yes (or --confirm "${label}") to proceed.`,
    );
  }
  if (answer === undefined) {
    return { confirmed: false, needsAnswer: true, label, mode: "prompt", question: `${action} will permanently delete ${label}. Type the identity to continue: ` };
  }
  if (String(answer).trim() === label) return { confirmed: true, label, mode: "prompt" };
  return { confirmed: false, label, mode: "prompt" };
}
