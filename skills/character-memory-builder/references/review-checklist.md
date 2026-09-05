# Production Review Checklist

## Spec status

- Verify Agent Memory availability and pricing from current official docs.
- Verify any experimental APIs are still experimental before depending on them.
- Verify current Vectorize limits/pricing and selected Workers AI model pricing.

## Isolation

- Profile key is server-derived HMAC.
- No raw user id in Vectorize/R2 keys where avoidable.
- Vectorize query includes namespace and exact profile filter.
- Returned vector metadata is post-verified.
- Cross-profile leakage integration test passes with zero hits.

## Consistency

- SQLite is authoritative.
- Newly remembered item is immediately available from local lexical/recent search.
- Vector status tracks pending/indexed/failed/deleted.
- Delete updates both authoritative state and vector state.

## Memory quality

- Extraction is checkpointed, not per-turn.
- Canonical types only in compatibility layer.
- Confidence threshold prevents weak inference from becoming durable memory.
- Supersession does not destroy history.
- Character SOUL cannot be mutated by learned memory.
- Stored user instructions cannot override system/developer policy.

## Cost

- `cfmem cost` run with project-specific DAU/turn/recall assumptions.
- Workflow steps estimated.
- Main character LLM cost modeled separately.
- AI Gateway/logging policy reviewed.
- Budget alerts/rate limits configured.

## Operations

- profile export exists;
- delete-profile cascade exists;
- R2 archive is batched;
- raw private content is not logged by default;
- retry/idempotency behavior is tested;
- memory benchmark includes Japanese dialogue if Japanese is a target language.
