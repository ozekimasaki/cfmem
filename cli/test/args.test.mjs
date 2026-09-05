import test from "node:test";
import assert from "node:assert/strict";
import { boolFlag, flagValue, numberFlag, parseArgs, requireValues } from "../src/args.mjs";
import { identityLabel, requireConfirmation } from "../src/confirm.mjs";
import { formatCostReport, estimateCost, pricingStalenessWarning, PRICING } from "../src/cost.mjs";

test("parseArgs handles spaced, =-joined, boolean and positional forms", () => {
  const args = parseArgs(["search", "--query", "紅茶", "--limit=5", "--json", "-h", "--", "--not-a-flag"]);
  assert.equal(args._[0], "search");
  assert.equal(args.query, "紅茶");
  assert.equal(args.limit, "5");
  assert.equal(args.json, true);
  assert.equal(args.help, true);
  assert.deepEqual(args._.slice(1), ["--not-a-flag"]);
});

test("dashed flags map to camelCase keys", () => {
  const args = parseArgs(["delete-session", "--session-id", "s1", "--created-before", "10"]);
  assert.equal(args.sessionId, "s1");
  assert.equal(args.createdBefore, "10");
  assert.equal(args["session-id"], undefined);
});

test("a flag immediately followed by another flag is boolean", () => {
  const args = parseArgs(["repair", "outbox", "--apply", "--limit", "10"]);
  assert.equal(args.apply, true);
  assert.equal(args.limit, "10");
  assert.deepEqual(args._, ["repair", "outbox"]);
});

test("flagValue/boolFlag ignore boolean placeholders", () => {
  const args = parseArgs(["list", "--limit", "--json"]);
  assert.equal(flagValue(args, "limit"), undefined);
  assert.equal(boolFlag(args, "json"), true);
  assert.equal(boolFlag(args, "nope"), false);
});

test("requireValues reports every missing flag at once", () => {
  assert.throws(
    () => requireValues({}, [[["query"], "--query"], [["sessionId", "session-id"], "--session-id"]], "search"),
    /search: missing required flag\(s\): --query, --session-id/,
  );
  assert.doesNotThrow(() => requireValues({ query: "q" }, [[["query"], "--query"]], "search"));
  assert.doesNotThrow(() => requireValues({ sessionId: "s" }, [[["sessionId", "session-id"], "--session-id"]], "search"));
});

test("numberFlag validates ranges and rejects non-numeric input", () => {
  const args = parseArgs(["cost", "--dau", "200", "--recall-rate", "0.2"]);
  assert.equal(numberFlag(args, "dau"), 200);
  assert.equal(numberFlag(args, "recallRate"), 0.2);
  assert.equal(numberFlag(args, "days", { fallback: 30 }), 30);
  assert.throws(() => numberFlag(args, "dau", { max: 100 }), /--dau must be <= 100/);
  assert.throws(() => numberFlag(parseArgs(["x", "--dau", "abc"]), "dau"), /--dau must be a number/);
});

test("§58.4 destructive gate refuses without a full identity", () => {
  assert.throws(() => requireConfirmation({ action: "delete-profile", identity: { namespace: "prod" }, yes: true }), /Missing: character, subject/);
  assert.throws(() => requireConfirmation({ action: "delete-profile", identity: undefined, yes: true }), /Missing: namespace, character, subject/);
});

test("§58.4 --yes bypasses the prompt, --confirm must echo-match", () => {
  const identity = { namespace: "prod", character: "mei", subject: "user-1" };
  assert.deepEqual(requireConfirmation({ action: "delete-profile", identity, yes: true }), {
    confirmed: true,
    label: "prod/mei/user-1",
    mode: "flag",
  });
  assert.equal(requireConfirmation({ action: "delete-profile", identity, yes: "prod/mei/user-1" }).mode, "echo");
  assert.throws(() => requireConfirmation({ action: "delete-profile", identity, yes: "prod/mei/user-2" }), /does not match the resolved identity/);
});

test("§58.4 non-interactive runs must not proceed silently", () => {
  const identity = { namespace: "prod", character: "mei", subject: "user-1" };
  assert.throws(
    () => requireConfirmation({ action: "delete-session", identity, isTTY: false }),
    /non-interactive\. Re-run with --yes \(or --confirm "prod\/mei\/user-1"\)/,
  );
});

test("§58.4 interactive prompt asks, accepts an exact echo and rejects a mismatch", () => {
  const identity = { namespace: "prod", character: "mei", subject: "user-1" };
  const pending = requireConfirmation({ action: "delete-profile", identity, isTTY: true });
  assert.equal(pending.needsAnswer, true);
  assert.equal(pending.question, "delete-profile will permanently delete prod/mei/user-1. Type the identity to continue: ");
  assert.equal(requireConfirmation({ action: "delete-profile", identity, isTTY: true, answer: " prod/mei/user-1 " }).confirmed, true);
  assert.equal(requireConfirmation({ action: "delete-profile", identity, isTTY: true, answer: "yes" }).confirmed, false);
  assert.equal(identityLabel(identity), "prod/mei/user-1");
});

test("cost estimator keeps A24 staleness visible in the report", () => {
  const result = estimateCost({ dau: 200, turns: 12, recallRate: 0.2 });
  const fresh = formatCostReport(result, new Date(`${PRICING.reviewedAt}T12:00:00Z`));
  assert.match(fresh, new RegExp(`Pricing reviewed: ${PRICING.reviewedAt}`));
  assert.equal(fresh.includes("! Pricing/limits were reviewed"), false);

  const farFuture = new Date(Date.now() + 400 * 86_400_000);
  assert.match(formatCostReport(result, farFuture), /^! Pricing\/limits were reviewed \d+ days ago/m);
  assert.match(pricingStalenessWarning("not-a-date", new Date()), /unparseable/);
});
