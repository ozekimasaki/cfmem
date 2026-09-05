---
name: character-memory-builder
description: Design, review, build, operate, or cost-model a Cloudflare-based long-term memory system for AI characters and agents. Use when working with Cloudflare Agent Memory, Agents SDK, Durable Objects SQLite/FTS5, Vectorize, Workers AI, Workflows, R2, profile isolation, memory extraction/recall/supersession, or the cfmem CLI. Use for architecture reviews, implementation planning, migration between custom memory and managed Agent Memory, and production-readiness checks.
---

# Character Memory Builder

Build Cloudflare character memory as a layered memory system, not as a vector database alone.

## Workflow

1. Determine whether the project uses managed Agent Memory, the custom backend, or both behind an adapter.
2. Review the architecture before changing code. Read `references/review-checklist.md`.
3. Treat current Cloudflare status/limits/pricing as time-sensitive. Verify official documentation when the task depends on current availability, limits, models, or cost.
4. Preserve the four managed-memory-compatible long-term types: `fact`, `event`, `instruction`, `task`.
5. Keep relationship state and transient emotion outside the long-term memory type enum.
6. Keep character SOUL/identity separate from learned memory.
7. Use a `MemoryProvider` abstraction so managed Agent Memory can replace the custom provider without changing character logic.
8. For architecture rationale, read `references/architecture.md`.
9. For a new project, read the relevant sections of `references/greenfield-implementation.md`; treat its Frozen v1 decisions and phase order as the implementation contract unless an explicit ADR changes them.
10. When a local `cfmem` project is available, run the CLI checks described in `references/commands.md`.
11. Before recommending production, run the final review checklist and report blockers explicitly.

## Non-negotiable architecture rules

- Use SQLite-backed Durable Objects for per-profile authoritative state. For new 2026 projects prefer declarative Wrangler `exports` with `storage: "sqlite"`; do not introduce legacy KV-backed namespaces.
- Use one Durable Object per character-user relationship profile unless the project has a documented alternative isolation key.
- Never put raw user identifiers into Vectorize metadata. Derive an opaque profile key server-side.
- Do not create one Vectorize index per profile in normal customer accounts. Use shared/sharded indexes with namespace plus metadata filtering.
- Create Vectorize metadata indexes before inserting vectors that depend on those filters.
- Merge SQLite lexical/recent results with Vectorize results; do not rely on vector search alone for newly written memory.
- Treat Vectorize as eventually queryable after writes. Keep SQLite authoritative.
- Do not call memory extraction after every model turn. Batch at idle/compaction/checkpoints.
- Do not run a second synthesis LLM for normal character recall. Prefer raw candidates and let the character model use them.
- Keep experimental Cloudflare APIs behind adapters. Do not make Session API required for v1.
- Preserve superseded facts/instructions for history; mark them superseded rather than physically deleting them.
- Deletion must cascade through Durable Object state, Vectorize, and R2 archives.

## Managed Agent Memory compatibility

When managed Agent Memory is available, map the application contract to:

- `ingest(messages, { sessionId })`
- `remember({ content, sessionId })`
- `recall(query, options)`
- `list(options)`
- `get(memoryId)`
- `delete(memoryId)`
- `deleteSession(sessionId)`
- `getSummary(options)`

Keep `search()` as a custom extension that returns raw candidates for the character hot path.

Do not claim managed Agent Memory is generally available unless current official documentation confirms it.

## Output standard

For architecture/review tasks, produce:

1. **Verdict** — viable / viable with corrections / blocked.
2. **Official-spec alignment** — confirmed facts versus assumptions.
3. **Architecture changes** — concrete changes and why.
4. **Cost impact** — major cost drivers and estimate assumptions.
5. **Implementation steps** — ordered, testable milestones.
6. **Risks/blockers** — especially isolation, eventual consistency, experimental APIs, and deletion.
7. **Acceptance tests** — what proves the system works.

For code changes, include the exact files changed and run the relevant test/doctor/cost commands before declaring success. For greenfield work, build one phase at a time and do not introduce Workers AI, Vectorize, Workflows, and R2 before the authoritative SQLite/FTS milestone passes.
