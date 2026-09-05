# cfmem

Bootstrap, resource-planning and operations CLI for a Cloudflare Workers memory service for AI characters.

`cfmem` is **not** the memory server. The server is the Worker + SQLite-backed `MemoryProfile` Durable Object that `cfmem init` scaffolds; one DO per `namespace × character × subject` profile keeps every user's memories physically separate. `cfmem` is the tooling around it: it generates the project, names and verifies the remote resources, prices the workload, drives the memory API for operations, and runs the versioned Japanese recall benchmark.

In the snippets below `cfmem` means `node cli/src/cfmem.mjs`:

```
cfmem init ../my-memory --app kagami --env dev   # generate a runnable project
cfmem doctor --env dev                           # what still blocks a deploy
cfmem resources plan --env dev                   # exact wrangler commands, in order
cfmem resources verify --env dev                 # read remote config, fail on drift
cfmem benchmark --endpoint ... --subject ...     # score recall against ja-memory-v1
```

## Requirements

- Node.js ≥ 20 (developed and tested on 24.x). No runtime dependencies — `node --test` only for the tests.
- Wrangler is only needed for commands that touch an account. Add `npx`-installed wrangler or install the scaffold's devDependencies.
- `resources verify` and `managed-status` need `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

## Install

```bash
git clone https://github.com/ozekimasaki/cfmem.git
cd cfmem/cli
node src/cfmem.mjs help          # the whole command surface
```

There is nothing to `npm install`: the CLI has zero dependencies. `cfmem` is declared as the package bin, so alias it if you prefer the short name — `alias cfmem='node ~/cfmem/cli/src/cfmem.mjs'`. The package (`cf-character-memory-cli`) is not published to npm.

## Quick start

Generate a project. Nothing is created remotely, and `wrangler.jsonc` is retargeted to the planned names, so a scaffold can never point at another environment:

```
$ node src/cfmem.mjs init ../example-memory --app kagami --env staging
Created ../example-memory
  app=kagami env=staging -> worker kagami-staging, index kagami-staging-memory-v1, bucket kagami-staging-archive
  ops/resources-plan.txt records the exact remote names and command order.
Next: run cfmem doctor, then pass Phase 1 (SQLite + Japanese FTS) before adding AI/Vectorize.
```

The scaffold pins the environment, not the user: `namespace` and `characterId` land in `cfmem.config.json`, while `--subject` is supplied per operation.

The generated project is green immediately, with no `npm install` and no credentials — 15 starter tests pin the frozen schema, the benchmark dataset shape, and the §5/§52 binding contract:

```
cd ../example-memory && node --test      # tests 15 / pass 15 / fail 0
```

Price the workload before building it:

```
$ node src/cfmem.mjs cost --dau 200 --turns 12 --recall-rate 0.2
Pricing reviewed: 2026-09-05
Estimated monthly memory-platform cost:
  Workers Paid base       $5.00
  AI extraction           $1.79
  AI embeddings           $0.04
  Vectorize queries       $0.02
  Vectorize storage       $0.01
  --------------------------------
  Total                   $6.86
```

Then create resources in the printed order. `resources plan` only prints; the `profile_key` metadata index is a blocking precondition, because Vectorize queries must be scoped by `profile_key` (spec A10) — vectors ingested without it cannot be isolated per profile.

```
$ node src/cfmem.mjs resources plan --env dev
...
Create Vectorize index character-memory-dev-memory-v1
  $ npx wrangler vectorize create character-memory-dev-memory-v1 --dimensions=1024 --metric=cosine
  # Must exist before the first vector write.
```

## Scope model

Every memory operation resolves one profile from three values: `--namespace`, `--character`, `--subject`. `--profile` is an accepted alias of `--subject`. Resolution precedence is **flag > environment > `cfmem.config.json` > default**, and these environment variables are read: `CFMEM_ENDPOINT`, `CFMEM_NAMESPACE`, `CFMEM_CHARACTER`, `CFMEM_SUBJECT` / `CFMEM_PROFILE`, `CFMEM_TOKEN` (fallback `ADMIN_API_TOKEN`), `CFMEM_ENV`, `CFMEM_APP`, `CFMEM_BENCHMARK_DATASET`, `CFMEM_EMBEDDING_MODEL`, `CFMEM_EMBEDDING_DIMENSIONS`.

## Commands

| Command | What it does | Reaches remote |
| --- | --- | --- |
| `init <dir>` | Scaffold a project (`--app --env --namespace --character`, `--character-package` adds `soul.md`) | no |
| `doctor` | Prerequisites for one environment, with reasons | no |
| `cost` | Monthly estimate from workload assumptions, plus the pricing review date | no |
| `resources plan` | Intended remote names and the exact `wrangler` commands, ordered | no, prints only |
| `resources verify` | Compare live configuration against the plan, exit `1` on drift | yes, read-only |
| `managed-status` | Whether the private Agent Memory API is reachable | yes, read-only |
| `remember` | Store an explicit memory (`--type fact\|event\|instruction\|task`, `--importance`, `--confidence`, `--session-id`) | yes, write |
| `search` | Raw authoritative candidates — use this at runtime | yes, read |
| `recall` | Synthesized compatibility recall, for admin/eval use | yes, read |
| `list` | Page through memories with §36 filters and a cursor | yes, read |
| `get` | One memory by `--id` | yes, read |
| `forget` | Tombstone one memory; the outbox retries the vector delete | yes, write |
| `delete-session` | Session-scoped deletion | yes, gated |
| `export` | Portable §41 export to `--out FILE` (`--include-raw`) | yes, read |
| `delete-profile` | Full erasure across DO / Vectorize / R2 | yes, gated |
| `repair outbox` / `repair jobs` | Re-drive stuck vector rows or consolidation/deletion jobs | only with `--apply` |
| `benchmark` | Score the versioned Japanese dataset against an endpoint | yes, writes scenarios |

`--json` gives machine-readable output; `--env dev|staging|production` selects which named resources to target.

## Safety model

- `resources plan` prints. `resources verify`, `doctor`, `export` and `managed-status` read. `init` never creates remote resources.
- **`delete-session` and `delete-profile` are gated**: they refuse without an explicit `--namespace`, `--character` and `--subject`, plus `--yes` or a `--confirm` value that exactly echoes the resolved `namespace/character/subject` identity. In a non-interactive session they refuse unless one of those flags is present, so a mistyped scope cannot delete the wrong profile.
- `repair` is dry-run by default and only mutates with `--apply`.
- Client-side limits (§12) are enforced before any request: query ≤ 1024 B, content ≤ 32768 B, session id ≤ 64, `search --limit` ≤ 50, `list --limit` ≤ 100. Values that start with a dash need the `--flag=-value` form.
- Exit codes: `0` ok · `1` failed, drift, or a missed release gate · `2` remote state could not be verified.

## Quality gates

`benchmark` runs `test/benchmark/ja-memory-v1.jsonl` — 105 Japanese scenarios across nine categories: evolving preference (20), contradictory fact (15), event recall (15), person/project continuity (12), instruction (10), task (10), ambiguous reference (10), adversarial injection (8) and explicit remember+delete (5). Isolation scenarios route setup and queries to a `primary` or `decoy` profile (`--decoy-subject`), which is what makes cross-profile leakage measurable. The §60 release gate requires ≥100 scenarios, category quotas met, **cross-profile leakage = 0**, no transport errors, Recall@5 ≥ 0.70, stale-memory rate ≤ 0.05 and false-supersession rate ≤ 0.05, and exits `1` when any of them miss. `benchmark --validate-dataset` checks a dataset offline.

## Layout

| Path | What it is |
| --- | --- |
| `cli/` | The `cfmem` CLI. |
| `cli/templates/worker/` | Worker + Durable Object skeleton that `init` copies, plus its starter tests and benchmark dataset. |
| `skills/character-memory-builder/` | Build/operate skill. `references/greenfield-implementation.md` is the authoritative build spec (naming, provisioning order, frozen schema, the §58 command surface, CI gates); `references/commands.md` documents every flag. |
| `dist/skill.zip` | The skill packaged for upload. |

## Development

```bash
cd cli && npm test     # 72 tests, offline
```

The suite never needs a Cloudflare account: the HTTP client takes an injected `fetch`, so end-to-end tests run against a §10 mock server, and the Wrangler runner is injected, so `resources verify` and `managed-status` are tested against fake remote facts. The `init` test builds a real project in a temp directory and runs its starter tests inside it.

Verification status: everything above is exercised offline. Deploying the scaffold and running `resources verify` / `benchmark` against a live Cloudflare account has not been done, so treat the remote paths as contract-tested rather than field-proven.
