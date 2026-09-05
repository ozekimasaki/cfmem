# Character Memory Worker — greenfield Phase 1 scaffold

This scaffold is Phase 1 of the memory service: the authoritative core only.

It starts with:

- SQLite-backed `MemoryProfile` Durable Object;
- schema migration;
- explicit `remember`;
- Japanese-friendly FTS5 search + recent fallback;
- list/delete;
- HMAC-derived `namespace × character × subject` profile isolation;
- vector outbox rows prepared for a later phase;
- `src/providers.ts` — the embedding, vector-store, archive and extractor interfaces later phases implement;
- offline starter tests in `test/` that pin the frozen schema, the benchmark dataset shape and the §52 binding contract.

It does **not** pretend the later phases are complete. Workers AI extraction, Workflows orchestration, hybrid Vectorize retrieval, R2 archive/export and full deletion reconciliation are added only after Phase 1 acceptance passes.

## Start

```bash
npm install
cp .dev.vars.example .dev.vars
npm run types
npm run dev
```

Before any remote deployment, create the resources in the order recorded in `ops/resources-plan.txt` (written by `cfmem init`; regenerate with `cfmem resources plan --env <env>`).

## Tests

```bash
npm test
```

The starter tests use only `node:test`, so they run before `npm install` and without Cloudflare credentials: they assert the frozen schema, the shape and quotas of `test/benchmark/ja-memory-v1.jsonl`, and that `wrangler.jsonc` matches the §5 naming and §52 binding contract.

## Important

Do not start by wiring every Cloudflare product together. First prove:

1. profile isolation;
2. SQLite persistence;
3. remember/list/delete;
4. Japanese FTS;
5. immediate local recall.

Then add extraction and Vectorize one boundary at a time.
