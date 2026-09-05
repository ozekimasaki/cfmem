# cfmem Commands

`cfmem` is bootstrap, diagnostic and operations tooling for the memory backend. It is not the memory server, and it never creates or mutates Cloudflare resources: `resources plan` only prints, and `resources verify` only reads.

Run from `cli/` (`node src/cfmem.mjs …`) or through the `cfmem` bin. `cfmem help` prints the same surface this page documents.

## Scope and precedence

Every memory operation addresses one relationship profile:

```bash
--endpoint URL --namespace NAME --character ID --subject ID --token ADMIN_API_TOKEN
```

Equivalently `CFMEM_ENDPOINT` / `CFMEM_NAMESPACE` / `CFMEM_CHARACTER` / `CFMEM_SUBJECT` / `CFMEM_TOKEN`. `--profile` is an accepted alias of `--subject`.

Precedence is **flag > environment variable > `cfmem.config.json` > default**. Namespace and character have defaults; the subject never does, because it is what scopes a destructive call to one person's data. A values-starting-with-a-dash needs the `--flag=-value` form.

Client-side limits (spec §12) are enforced before any request: query ≤ 1024 B, content ≤ 32768 B, session id ≤ 64 chars, `search --limit` ≤ 50, `list --limit` ≤ 100.

Exit codes: `0` ok · `1` failure, drift, or a missed release gate · `2` remote state could not be verified.

## Build and diagnose

```bash
cfmem init ./character-memory --app kagami --env staging --namespace team-a
cfmem doctor --env staging
cfmem cost --dau 200 --turns 12 --days 30 --recall-rate 0.2 --checkpoint-turns 8
cfmem resources plan   --env staging [--json]
cfmem resources verify --env staging [--json]
cfmem managed-status
```

- `init` copies the Worker scaffold, writes `cfmem.config.json` and `ops/resources-plan.txt`, and retargets `wrangler.jsonc` (worker name, Vectorize index, R2 bucket, `MEMORY_NAMESPACE`) to the planned names. It installs nothing and creates nothing remotely. `soul.md` arrives only with `--character-package`.
- `doctor` checks local prerequisites for one environment and never mutates resources. Missing Cloudflare credentials are reported, not fatal, for design work.
- `cost` estimates the memory platform only (the character response model is excluded) and warns when the pricing review date is more than 90 days old. Extra knobs: `--memories-per-checkpoint`, `--dimensions` (alias `--embedding-dimensions`), `--extraction-input-tokens`, `--extraction-output-tokens`, `--json`.
- `resources plan` prints §5 names and the exact §6 provisioning order, including the `profile_key` metadata index that blocks the first vector write.
- `resources verify` reads remote configuration through Wrangler and fails on drift. Without Wrangler auth it exits `2` rather than guessing.
- `managed-status` reports whether the private Agent Memory API is reachable for the current account/token; keep the custom backend enabled while it returns 403/404.

## Memory operations

```bash
cfmem remember --content "好きな飲み物は紅茶" --type fact --subject-key drinks
cfmem search   --query "紅茶" --limit 10 --text
cfmem recall   --query "紅茶" --json
cfmem list     --type fact --active true --limit 50
cfmem get      --id mem-123
cfmem forget   --id mem-123
```

Prefer `search` at character runtime: it returns authoritative candidates. `recall` returns synthesized context and belongs to admin and evaluation paths. `forget` writes a tombstone; the vector delete is retried by the outbox.

## Destructive operations (§58.4)

`delete-session` and `delete-profile` are confirmation-gated. Non-interactive runs must pass `--yes`, or `--confirm <namespace/character/subject>` echoing the exact profile being destroyed. A mismatch aborts with exit `1` before a request leaves the CLI. Repairs need no confirmation because they are dry-run unless `--apply` is passed.

```bash
cfmem delete-session --session-id sess-9 --yes
cfmem delete-profile --confirm "prod/mei/user-42"
cfmem export --out ./profile.json [--include-raw]
```

`export` writes the portable §41 document and refuses to write a payload that looks like it carries credentials. `delete-profile` erases across DO, Vectorize and R2 through the deletion workflow.

## Repair

Dry-run by default; `--apply` re-drives rows.

```bash
cfmem repair outbox --limit 200 --include-errors
cfmem repair jobs --older-than 600 --apply
```

`repair outbox` re-drives stuck vector upsert/delete rows; `repair jobs` re-drives stuck consolidation and profile-deletion jobs (§39.3 reconciliation).

## Benchmark (§48, §60)

```bash
cfmem benchmark --scaffold --out test/benchmark/ja-memory-v1.jsonl
cfmem benchmark --dataset test/benchmark/ja-memory-v1.jsonl --validate-dataset
cfmem benchmark --endpoint "$CFMEM_ENDPOINT" --subject eval-user --k 10
cfmem benchmark --subject eval-user --json --report ./benchmark.json
```

The shipped dataset is Japanese, versioned (`ja-memory-v1`) and quota-exact at 100 scenarios. Freeze the version when comparing algorithm changes. `--skip-setup` scores retrieval against already-populated profiles; `--limit-scenarios N` is a smoke subset and will not satisfy the ≥100 gate. `--wait-for-extraction S` gives the checkpoint/consolidation path time to run after `messages` setup steps.

Reported metrics: Recall@5, Recall@10, Precision@5, zero-result rate, stale-memory rate, false-supersession rate, supersession applied, extraction acceptance, cross-profile leakage, p50/p95 latency, and estimated cost per 1k turns. Release gates (§60) require ≥100 scenarios, category quotas met, a valid schema, **cross-profile leakage = 0**, no transport errors, Recall@5 ≥ 0.70, stale-memory rate ≤ 0.05 and false-supersession rate ≤ 0.05 — exit `0` only when all pass.

## Implementation contract

Before implementing phases beyond the starter, read `references/greenfield-implementation.md` (the bundle root's `GREENFIELD_IMPLEMENTATION.md` is the authoritative copy; `IMPLEMENTATION_RUNBOOK.md` is a compatibility pointer to it). The specification defines the final CLI command surface, provisioning order, schema migrations, Workflow boundaries, deletion semantics, CI gates, and production acceptance tests.

## Tests

```bash
cd cli && npm test        # unit + spawned-process end-to-end against a §10 mock
npm run test:unit         # offline-only subset
```
