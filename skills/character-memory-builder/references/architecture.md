# Architecture Reference

## Core layers

- Immutable identity: bundled SOUL/character config or versioned R2 object.
- Session/working memory: SQLite-backed profile Durable Object.
- Long-term memory: canonical facts/events/instructions/tasks in the same DO.
- Lexical retrieval: FTS5, preferably trigram for Japanese substring-oriented fallback.
- Semantic retrieval: Vectorize using a shared/sharded index.
- Extraction/classification: Workers AI at checkpoints.
- Durable consolidation: Workflows in production; direct DO alarm is acceptable for budget/MVP mode.
- Archive/export: R2, never required on every turn.

## Profile key

Logical profile identity is `namespace + character_id + user_id`.

Derive an opaque key with HMAC-SHA256. Use it for DO naming and Vectorize metadata. Never trust a client-supplied profile key.

## Vectorize layout

Prefer:

- index: one per environment/shard;
- namespace: character or tenant boundary;
- metadata equality filter: opaque profile key;
- post-verify returned metadata before reading authoritative rows.

Do not create per-profile indexes unless project scale and account limits are explicitly bounded and documented.

## Recall

Merge:

1. exact active fact/instruction lookup;
2. FTS5;
3. recent pending/unindexed memory;
4. Vectorize semantic results.

Use RRF and modest recency/salience adjustment. Keep relationship state out of retrieval relevance.

## Supersession

Facts and instructions can replace an older memory on the same stable subject key. Preserve the old row and set `superseded_by`. Events normally accumulate. Tasks expire/complete.

## Compatibility boundary

All character code must depend on a MemoryProvider interface. Provide a custom implementation now and a managed Agent Memory implementation when access/GA permits.
