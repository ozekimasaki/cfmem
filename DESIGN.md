# Cloudflare AI Character Memory Engine

**Status:** Implementation-ready design  
**Reviewed:** 2026-09-05  
**Primary target:** Cloudflare Workers / Agents / Durable Objects / Vectorize / Workers AI / Workflows / R2  
**Deliverables:** `cfmem` CLI + ChatGPT Skill (`character-memory-builder`)
**Greenfield implementation contract:** `GREENFIELD_IMPLEMENTATION.md`
**Implementation handoff:** `IMPLEMENTATION_RUNBOOK.md` (normative v1 implementation decisions)

---

## 0. Executive verdict

The overall theory is viable, but the first draft needed several corrections before production implementation.

### Verdict

- **Durable Object per character-user memory profile:** valid and aligned with Cloudflare's own Agent Memory architecture.
- **SQLite + FTS5 inside Durable Objects:** valid; FTS5 is officially supported.
- **Vectorize for semantic retrieval:** valid.
- **Workers AI for extraction / classification / embeddings:** valid and aligned with Agent Memory internals.
- **Batching ingestion instead of per-turn ingestion:** valid and explicitly recommended by Cloudflare.
- **R2 for raw/archive history:** valid, but should not sit on the hot path.
- **Workflows for durable consolidation:** valid, but should only run at checkpoints because Workflows now has step/storage billing.
- **Session API as a hard dependency:** rejected for v1 because it remains experimental.
- **One Vectorize index per character-user profile:** rejected for a customer implementation because account-level index limits make this an unnecessary scaling ceiling.
- **Inventing extra long-term memory types:** rejected for the compatibility layer. Keep Cloudflare's four canonical types and store relationship/emotional state separately.
- **LLM synthesis on every recall:** rejected for the hot path. Return raw candidates to the character model and synthesize only when explicitly requested.

The revised architecture is therefore a **Cloudflare Agent Memory-compatible custom engine**, not a literal clone.

---

## 1. Official specification alignment

### 1.1 Agent Memory status

As of 2026-09-05, Cloudflare Agent Memory is still **Private Beta**. It requires explicit access and is not currently billed during the private beta. Cloudflare states that at least 30 days notice will be given before charging begins.

Official public concepts:

- Namespace -> Profile -> Memory isolation model.
- Profiles are isolated stores for users, agents, teams, tenants, or other application entities.
- `ingest()` extracts memories from conversations.
- `remember()` stores a known memory explicitly.
- `recall()` retrieves relevant memory and returns a synthesized answer plus scored candidates.
- `list()`, `get()`, `delete()`, `deleteSession()`, and `getSummary()` are available.
- Canonical memory types are:
  - `fact`
  - `event`
  - `instruction`
  - `task`
- Facts and instructions support supersession.
- Cloudflare explicitly says not to run `ingest()` after every model turn; use idle time, compaction, or another natural checkpoint.

### 1.2 Agent Memory internals

Cloudflare has publicly described Agent Memory as being built from:

- Durable Objects with SQLite for raw messages and structured memories.
- FTS indexing and supersession chains in the Durable Object.
- Vectorize for semantic vector search.
- Workers AI for extraction, verification/classification, query analysis, embeddings, and synthesis.

This validates the core custom architecture.

### 1.3 Durable Objects

SQLite-backed Durable Objects are the correct storage primitive for this workload.

Relevant current limits/capabilities:

- New Durable Objects should use SQLite storage.
- FTS5 is supported.
- JSON and math SQLite extensions are supported.
- Point-in-time recovery is available for the SQLite-backed object store.
- Agents can scale to tens of millions of concurrent unique agent instances.
- Maximum stored state per unique Agent is currently 1 GB.

### 1.4 Session API

Cloudflare's Session API provides persistent conversation history, context blocks, compaction, FTS, and related memory primitives, but the API is currently under `agents/experimental/memory/session`.

**Decision:** keep a `SessionAdapter` boundary but do not make v1 depend on it. Raw conversation/session persistence is implemented directly in the profile Durable Object.

### 1.5 Vectorize

Current important limits:

- 50,000 indexes/account on Workers Paid, 100 on Free.
- 20,000,000 vectors/index.
- 1,536 max dimensions/vector.
- 50,000 namespaces/index on Paid, 1,000 on Free.
- 10 metadata indexes per Vectorize index.
- 10 KiB metadata/vector.
- `topK` up to 50 when returning values or full metadata; up to 100 without those payloads.
- Namespace and metadata filtering happen before vector search.

Because Agent Memory's internal deployment can create isolated retrieval infrastructure per profile, it is tempting to copy that literally. A normal customer account should not.

**Decision:**

- One Vectorize index per environment/shard, not per profile.
- Namespace by `character_key` or tenant boundary.
- Metadata-filter by opaque `profile_key`.
- Create the `profile_key` metadata index before inserting any vectors.
- Shard indexes only when capacity or operational boundaries require it.

### 1.6 Vectorize consistency

Vector writes are asynchronous. Cloudflare's July 2026 update reports median end-to-end queryability under 30 seconds and p99 under 2 minutes.

That means a vector-only system can forget something immediately after it was learned.

**Decision: consistency bridge**

Recall always merges:

1. local SQLite exact/current facts,
2. local SQLite FTS5,
3. recent not-yet-indexed memories,
4. Vectorize semantic results.

A newly written memory is therefore immediately retrievable even before Vectorize catches up.

### 1.7 Workers AI embedding model

Default recommendation for Japanese/multilingual character memory:

- `@cf/qwen/qwen3-embedding-0.6b`
- 1,024 dimensions
- cosine Vectorize metric
- currently priced at $0.012 per million input tokens

The embedding model is configurable, but changing dimensions requires a new Vectorize index and re-embedding.

---

## 2. Architecture

```text
Client / Character UI / Voice
            |
            v
      Cloudflare Worker
      API/Auth/Rate limit
            |
            +------------------------------+
            |                              |
            v                              v
 Character runtime                 Memory API
 (optional Agents SDK)             /v1/*
            |                              |
            +---------------+--------------+
                            |
                            v
                   Profile Router
          HMAC(namespace|character|user)
                            |
                            v
                MemoryProfile Durable Object
                one object / relationship
                            |
        +-------------------+------------------+
        |                   |                  |
        v                   v                  v
   SQLite tables        SQLite FTS5      relationship_state
   messages             memories_fts     deterministic state
   memories             messages_fts
   sessions
   outbox
        |
        | checkpoint / idle
        v
  Memory Consolidation Workflow
        |
        +--> Workers AI extraction/classification
        +--> supersession verifier
        +--> Workers AI embeddings
        +--> Vectorize upsert
        +--> R2 archive (optional)

Recall
  |
  +--> exact active facts/instructions
  +--> SQLite FTS5
  +--> recent unindexed memories
  +--> Vectorize semantic search
  +--> RRF + recency + salience
  |
  v
Raw candidates
  |
  +--> character model consumes candidates directly
  `--> optional compatibility synthesis
```

---

## 3. Memory boundaries

### 3.1 Immutable character identity (SOUL)

Do not let conversation memory rewrite identity.

Source of truth:

```text
characters/<character-id>/soul.md
characters/<character-id>/character.json
```

Recommended deployment options, in preference order:

1. bundle with Worker deployment if character identity changes only with releases;
2. R2 if operators need runtime-editable character packages;
3. cache loaded R2 content in Agent/DO state and invalidate by version.

Do not read R2 on every turn if the SOUL is unchanged.

### 3.2 Working/session memory

Stored in the profile DO:

- current session id
- raw recent messages
- compaction watermarks
- unresolved tasks
- current scene pointers

### 3.3 Long-term semantic/episodic memory

Cloudflare-compatible types only:

#### Fact
Stable knowledge.

Examples:

- user preferences
- relationship facts
- user goals
- project properties

#### Event
Time-anchored completed occurrence.

Examples:

- attended an event
- deployed a release
- celebrated a birthday

#### Instruction
Reusable preference, rule, convention, or procedure.

Examples:

- preferred response style
- workflow convention

#### Task
Short-lived follow-up or active work.

### 3.4 Relationship state

Relationship progression is deterministic state and must not be modeled as an uncontrolled LLM-generated memory type.

```ts
type RelationshipState = {
  interactionCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  familiarity: number;     // bounded 0..1
  bond: number;            // bounded 0..1
  trustSignals: number;
  repairSignals: number;
};
```

The model never receives raw scores. A renderer converts state into a short natural-language relationship context.

Example:

```text
You have spoken with this person many times over several months.
Treat them with familiar warmth, but do not invent shared experiences.
```

### 3.5 Emotion

Current emotion is ephemeral character state, not durable personal memory.

Persist only if it becomes an event that matters later, e.g. "the user was nervous before their first talk and later said it went well." Do not retain transient sentiment classifications indefinitely.

---

## 4. Profile identity and privacy

Logical profile identity:

```text
namespace / character_id / user_id
```

Never send the raw user id to Vectorize metadata.

Compute:

```text
profile_key = base64url(
  HMAC-SHA256(PROFILE_KEY_SECRET,
    namespace + "\n" + character_id + "\n" + user_id
  )
)
```

Use the same opaque profile key for:

- Durable Object name
- Vectorize `profile_key` metadata
- archive path prefix

Vectorize namespace:

```text
character_key = opaque hash(character_id)
```

This gives two independent filters:

- Vectorize namespace: character/tenant segment
- metadata equality: exact profile

Every semantic result must also be verified server-side against the expected `profile_key` before returning it.

---

## 5. SQLite schema

```sql
CREATE TABLE IF NOT EXISTS profile_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  closed_at INTEGER,
  consolidation_watermark INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq
  ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('fact','event','instruction','task')),
  subject_key TEXT,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  source_session_id TEXT,
  source_start_seq INTEGER,
  source_end_seq INTEGER,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  valid_from INTEGER,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  superseded_by TEXT,
  vector_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(vector_status IN ('pending','indexed','failed','deleted')),
  vector_updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memories_type_active
  ON memories(type, superseded_by, updated_at);

CREATE INDEX IF NOT EXISTS idx_memories_subject_active
  ON memories(subject_key, superseded_by, updated_at);

CREATE INDEX IF NOT EXISTS idx_memories_vector_status
  ON memories(vector_status, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  summary,
  content,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS relationship_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  interaction_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  familiarity REAL NOT NULL DEFAULT 0,
  bond REAL NOT NULL DEFAULT 0,
  trust_signals INTEGER NOT NULL DEFAULT 0,
  repair_signals INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS consolidation_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  UNIQUE(session_id, from_seq, to_seq)
);
```

### FTS tokenizer note

For Japanese, use FTS5 trigram rather than an English stemming tokenizer. It gives character-level substring matching and avoids depending on whitespace tokenization.

Benchmark this against real Japanese dialogue. If recall quality is poor, retain FTS as lexical fallback and lean more heavily on embeddings.

---

## 6. Extraction pipeline

### 6.1 When to consolidate

Never consolidate on every turn.

Trigger when one or more conditions are true:

- `unprocessed_turns >= 8`
- user idle for 60-180 seconds
- explicit session close
- context compaction boundary
- explicit `remember` command

Recommended default:

```json
{
  "checkpointTurns": 8,
  "idleSeconds": 120,
  "maxBatchMessages": 100
}
```

Cloudflare Agent Memory allows up to 500 messages per ingest call; our custom engine should use a much smaller operational batch for predictable latency and cost.

### 6.2 Durable flow

Production mode:

```text
DO marks range pending
   -> Workflow instance id = profileKey:session:fromSeq:toSeq
      -> load source messages
      -> extract structured candidates
      -> normalize + validate
      -> resolve supersession
      -> transactional memory write + FTS write
      -> embed new/changed active memories
      -> Vectorize upsert
      -> mark vector indexed
      -> advance session watermark
      -> optional R2 archive
```

The workflow id and unique range constraint make the process idempotent.

Budget/MVP mode may execute consolidation directly from the DO alarm, but production should use Workflows for retryable multi-step execution.

### 6.3 Extraction JSON schema

```json
{
  "memories": [
    {
      "type": "fact | event | instruction | task",
      "subjectKey": "stable.dotted.key.or.null",
      "summary": "short normalized summary",
      "content": "self-contained memory",
      "importance": 0.0,
      "confidence": 0.0,
      "validFrom": "ISO-8601 or null",
      "validUntil": "ISO-8601 or null",
      "supersedesSubjectKey": "optional"
    }
  ]
}
```

Rules:

- Do not save small talk unless it becomes a meaningful event.
- Do not save information the assistant invented.
- Prefer a small number of self-contained memories.
- Store stable preferences as facts or instructions.
- Store dated completed occurrences as events.
- Store short-lived follow-ups as tasks.
- Do not infer sensitive traits from weak evidence.
- If confidence is below threshold, do not promote to long-term memory.

Recommended confidence threshold: `0.72`.

---

## 7. Supersession

Facts and instructions must evolve without destroying history.

Example:

```text
fact:user.favorite_drink
v1: coffee
    superseded_by -> v2
v2: black tea
```

Algorithm:

1. extractor emits `subjectKey`;
2. load active fact/instruction with same key;
3. if no prior item, insert;
4. if equivalent, update source evidence / timestamp but avoid duplicate;
5. if conflicting and confidence >= threshold, run a lightweight verifier;
6. verifier returns `same | refine | replace | coexist`;
7. only `replace` sets `superseded_by` on the older memory;
8. keep both for audit/history.

Events do not supersede each other by default.

Tasks transition to completed/expired state rather than becoming a new memory type.

---

## 8. Vectorization

Default:

```text
model: @cf/qwen/qwen3-embedding-0.6b
dimensions: 1024
metric: cosine
```

Vector content:

```text
[type]
subject_key
summary
content
```

Vector id:

```text
<profile-prefix>:<memory-ulid>
```

Keep <= 64 bytes.

Metadata:

```json
{
  "profile_key": "opaque-hmac",
  "type": "fact",
  "active": true,
  "importance_bucket": 4,
  "updated_day": 20260905
}
```

Do not put full memory text in Vectorize metadata. SQLite is authoritative.

Create metadata indexes **before any vector insertion** for fields used in filters.

---

## 9. Recall pipeline

### 9.1 Recall gating

Do not perform semantic recall on every character turn.

Recall is useful when the new message:

- refers to previous experience: "前に", "覚えてる", "この前"
- asks for a preference or known fact
- depends on prior project/user state
- references a person/place/event not present in current context
- would materially change response quality if remembered

The character runtime can use a cheap rule-based gate first, then optionally a small query classifier.

### 9.2 Search fan-out

```text
query
  |
  +--> exact subject key lookup when query planner identifies one
  +--> active recent fact/instruction lookup
  +--> SQLite FTS5 top 20
  +--> pending/unindexed recent memories top 20
  +--> Vectorize top 30 scoped by character namespace + profile_key
  |
  v
normalize ranks
  |
  v
RRF merge
  |
  v
recency + importance + active-state adjustment
  |
  v
top 6-12 candidates
```

### 9.3 Ranking

Base Reciprocal Rank Fusion:

```text
rrf(d) = SUM(1 / (60 + rank_i(d)))
```

Final score:

```text
score =
  0.70 * normalized_rrf
+ 0.10 * recency
+ 0.15 * importance
+ 0.05 * source_confidence
```

Do not allow relationship score to overpower relevance. Relationship state belongs in prompt context, not retrieval rank.

### 9.4 No double synthesis

Cloudflare Agent Memory's `recall()` synthesizes an answer. A character application then usually sends that answer to another LLM, which creates:

- extra inference cost;
- latency;
- potential loss of nuance;
- possible hallucinated compression.

Custom runtime API therefore exposes two calls:

```ts
search(query): Promise<MemoryCandidate[]>
recall(query): Promise<{ answer: string; candidates: MemoryCandidate[] }>
```

Use `search()` in the character hot path.

Keep `recall()` only for API compatibility, admin tools, and direct non-character clients.

---

## 10. HTTP API

Custom service mirrors Agent Memory concepts without pretending to be a Cloudflare binding.

```text
POST   /v1/namespaces/:ns/profiles/:profile/messages
POST   /v1/namespaces/:ns/profiles/:profile/ingest
POST   /v1/namespaces/:ns/profiles/:profile/remember
POST   /v1/namespaces/:ns/profiles/:profile/search
POST   /v1/namespaces/:ns/profiles/:profile/recall
GET    /v1/namespaces/:ns/profiles/:profile/memories
GET    /v1/namespaces/:ns/profiles/:profile/memories/:id
DELETE /v1/namespaces/:ns/profiles/:profile/memories/:id
DELETE /v1/namespaces/:ns/profiles/:profile/sessions/:session
DELETE /v1/namespaces/:ns/profiles/:profile
GET    /v1/namespaces/:ns/profiles/:profile/summary
GET    /v1/health
```

### API compatibility adapter

Application code depends on:

```ts
interface MemoryProvider {
  ingest(messages: MemoryMessage[], options?: { sessionId?: string }): Promise<void>;
  remember(memory: { content: string; sessionId?: string }): Promise<Memory>;
  search(query: string, options?: SearchOptions): Promise<MemoryCandidate[]>;
  recall(query: string, options?: RecallOptions): Promise<RecallResult>;
  list(options?: ListOptions): Promise<Memory[]>;
  get(id: string): Promise<Memory | null>;
  delete(id: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getSummary(options?: SummaryOptions): Promise<{ summary: string }>;
}
```

Implementations:

```text
CustomCloudflareMemoryProvider   <- v1 default
ManagedAgentMemoryProvider      <- switch when access/GA is available
```

No character code is allowed to depend directly on either backend.

---

## 11. R2 archival

R2 is not the primary memory store.

Use it for:

- compacted raw conversation archives;
- profile export files;
- deletion audit manifests without deleted content;
- optional memory snapshots;
- character SOUL packages if runtime-editable.

Suggested key layout:

```text
profiles/<profile_key>/sessions/<session_id>/<yyyy-mm-dd>.jsonl.gz
profiles/<profile_key>/exports/<timestamp>.json.gz
characters/<character_key>/soul/<version>.md
```

Deletion must cascade:

1. Durable Object profile data
2. Vectorize ids associated with profile
3. R2 profile prefix
4. scheduled/workflow jobs that have not run

Keep a tombstone with only opaque profile key + deletion timestamp if operationally required.

---

## 12. Cost review

All prices below are current public list prices reviewed on 2026-09-05 and can change.

### 12.1 Workers Paid

Base Workers Paid subscription: **$5/month**.

Included / overage on Standard:

- 10M Worker requests/month, then $0.30/M.
- 30M CPU ms/month, then $0.02/M CPU ms.

### 12.2 Durable Objects

Paid plan:

- 1M DO requests/month included, then $0.15/M.
- 400,000 GB-s/month included, then $12.50/M GB-s.
- SQLite row reads: first 25B/month included, then $0.001/M rows.
- SQLite rows written: first 50M/month included, then $1.00/M rows.
- SQL storage: first 5 GB-month included, then $0.20/GB-month.

**Cost implication:** FTS indexes increase write rows. This is still unlikely to dominate at small/medium character scale, but measure rows written.

### 12.3 Vectorize

Workers Paid:

- first 50M queried vector dimensions/month included, then $0.01/M;
- first 10M stored vector dimensions included, then $0.05 per 100M.

At 1,024 dimensions, vector storage is very cheap; query volume matters more.

### 12.4 Workers AI

Workers AI has 10,000 free Neurons/day. Paid usage beyond that is billed per-model.

Defaults used in this design:

- Qwen3 Embedding 0.6B: $0.012/M input tokens.
- Qwen3 30B A3B FP8: currently $0.051/M input and $0.335/M output.
- Llama 4 Scout: $0.270/M input and $0.850/M output.
- Nemotron 3 120B A12B: $0.50/M input and $1.50/M output.

The cost estimator intentionally ignores the daily free-neuron allowance and therefore gives a conservative list-price estimate.

### 12.5 Workflows

Billing for Workflows steps/storage started 2026-08-10.

Workers Paid includes:

- 10M workflow invocations/month;
- 30M CPU ms/month;
- 1 GB workflow storage;
- 500,000 steps/month;
- extra steps: $0.80 per 100,000.

This is why consolidation is checkpoint-based rather than per-turn.

### 12.6 R2

Standard R2 free tier:

- 10 GB-month storage;
- 1M Class A operations/month;
- 10M Class B operations/month;
- egress free.

Paid Standard list price:

- $0.015/GB-month;
- $4.50/M Class A;
- $0.36/M Class B.

Archive at session/checkpoint granularity, not one object per chat message.

### 12.7 AI Gateway

Core AI Gateway features such as analytics, caching, and rate limiting are currently free. Persistent log quotas depend on plan. Unified Billing adds a 5% fee to credits purchased through Unified Billing; provider inference itself is passed through without markup.

### 12.8 Agent Memory

Private beta is currently not billed. Future pricing is unknown.

Do not use "Agent Memory is free" as a production business assumption.

---

## 13. Cost scenarios

The `cfmem cost` command implements these assumptions so they can be changed per project.

Default assumptions:

```text
12 user turns / DAU / day
checkpoint every 8 turns
20% of turns trigger semantic recall
4 memories extracted per checkpoint
1,600 extraction input tokens/checkpoint
350 extraction output tokens/checkpoint
80 embedding tokens/memory
32 embedding tokens/recall query
4 Workflow steps/checkpoint
```

### Reference scenarios

The current CLI estimator produces the following conservative list-price results under the defaults above. It does **not** subtract the Workers AI daily free-neuron allowance, and it excludes the character-response model itself.

| Example scale | DAU | User turns/month | Estimated memory-platform total |
|---|---:|---:|---:|
| Prototype/community | 20 | 7,200 | **$5.18/mo** |
| Small production | 200 | 72,000 | **$6.86/mo** |
| Medium production | 2,000 | 720,000 | **$28.14/mo** |
| Large production | 20,000 | 7,200,000 | **$266.79/mo** |

These are engineering estimates, not Cloudflare quotes. They intentionally omit DO duration/row/storage cost, R2 byte-level cost, logs, and the main character LLM because those depend on runtime behavior and payload size. The CLI reports these omissions explicitly.

At low scale, the $5 Workers Paid base fee dominates. At medium/large scale, extraction inference and Vectorize queried dimensions become more visible. Workflow step overage appears only after 500,000 included steps/month.

### The main cost lever

The most expensive architectural mistake is not storage. It is **calling an LLM too often**.

Cost controls in order of impact:

1. no memory synthesis on ordinary recall;
2. gate recall;
3. batch extraction;
4. keep extraction prompts compact;
5. use a cheap structured-output model for extraction;
6. archive in batches;
7. only run premium synthesis for explicit admin/API calls.

---

## 14. Failure modes and mitigations

### Vectorize delay

**Risk:** newly written memory missing from semantic results.  
**Mitigation:** SQLite recent/pending recall bridge.

### Duplicate ingestion

**Risk:** repeated workflow creates duplicate memories.  
**Mitigation:** source range unique key + content fingerprint + idempotent workflow id.

### Bad supersession

**Risk:** new memory incorrectly erases an older preference.  
**Mitigation:** never delete old memory; use verifier and supersession chain.

### Cross-user leakage

**Risk:** semantic query returns another user's vector.  
**Mitigation:** HMAC profile key, Vectorize namespace, metadata pre-filter, server-side post-verification, DO-level isolation.

### Character drift

**Risk:** remembered user statements alter the character's identity.  
**Mitigation:** immutable SOUL separated from learned memory; memory prompt cannot write SOUL.

### Over-remembering

**Risk:** noisy long-term profile and privacy concerns.  
**Mitigation:** confidence threshold, importance threshold, durable-memory policy, explicit delete/export APIs.

### Memory poisoning

**Risk:** user text attempts to write instructions that override system behavior.  
**Mitigation:** memories are data, never executable system instructions. Instruction memories are user preferences only and are placed in a delimited, lower-priority context block.

### Cost runaway

**Risk:** every turn triggers recall + workflow + synthesis.  
**Mitigation:** hard gates, usage budgets, Workflow checkpoint thresholds, Workers CPU limits, AI Gateway rate limits, account budget alerts.

### Experimental API churn

**Risk:** Session/Fibers APIs evolve.  
**Mitigation:** adapters and optional integration; v1 core uses stable Worker/DO/Vectorize APIs.

---

## 15. Security rules

- authenticate every public Memory API request;
- never accept `profile_key` directly from an untrusted client;
- derive it server-side from authenticated user id + character id;
- use HMAC rather than raw IDs in Vectorize/R2;
- no secret or raw token in memory text;
- redact secrets before extraction;
- set per-profile and per-user write/recall rate limits;
- cap message content size;
- cap recall query size to the managed Agent Memory limit of 1 KiB for compatibility;
- cap individual message content to 32 KiB for compatibility;
- keep session ids <= 64 chars;
- make delete-profile a two-phase operation with tombstone + retryable cleanup;
- export only after re-authentication/authorization.

---

## 16. Observability

Record metrics, not raw private content wherever possible.

Metrics:

```text
memory_ingest_batches_total
memory_candidates_extracted_total
memory_candidates_rejected_total
memory_supersessions_total
memory_vector_pending_total
memory_vector_lag_seconds
memory_search_total
memory_search_fts_hits
memory_search_vector_hits
memory_search_zero_results
memory_workflow_failures_total
memory_delete_jobs_total
memory_cost_estimated_usd
```

Structured logs should contain:

- request id
- opaque profile key prefix
- session id hash
- command
- candidate counts
- latencies
- model name
- token usage
- Workflow id

Do not log raw memory content by default.

---

## 17. Test strategy

### Unit

- profile key deterministic HMAC
- extraction schema validation
- supersession state machine
- RRF ranking
- recency decay
- FTS query escaping
- API validation/limits
- cost estimator

### Durable Object integration

- concurrent message append order
- transaction rollback
- FTS indexing
- delete cascade inside DO
- alarm/checkpoint idempotency

### Vectorize integration

- profile filter isolation
- namespace isolation
- vector update/delete
- pending-to-indexed transition
- immediate recall before vector availability

### Memory quality benchmark

Build a Japanese evaluation set with at least:

- stable preference updates
- contradictory facts
- recurring people/projects
- dated events
- tasks that expire
- "覚えてる？" queries
- ambiguous references
- instruction changes
- adversarial prompt-in-memory attempts

Metrics:

- Recall@K
- precision@K
- stale-memory rate
- false-supersession rate
- cross-profile leakage = 0
- extraction acceptance rate
- median/p95 added recall latency

Do not call the system production-ready until cross-profile leakage is zero in tests and supersession has a manual audit path.

---

## 18. Repository layout

```text
character-memory/
├── DESIGN.md
├── cli/
│   ├── package.json
│   ├── src/
│   │   ├── cfmem.mjs
│   │   ├── cost.mjs
│   │   └── client.mjs
│   └── templates/
│       └── worker/
│           ├── wrangler.jsonc
│           ├── package.json
│           └── src/
│               ├── index.ts
│               ├── memory-profile.ts
│               └── schema.ts
└── skills/
    └── character-memory-builder/
        ├── SKILL.md
        ├── agents/openai.yaml
        └── references/
            ├── architecture.md
            ├── commands.md
            └── review-checklist.md
```

---

## 19. CLI specification

Binary: `cfmem`

### `cfmem init <directory>`

Creates:

- `cfmem.config.json`
- `ops/resources-plan.txt` (planned remote names and provisioning order)
- Worker starter template, retargeted to the chosen `--app`/`--env`/`--namespace`
- `soul.md` only with `--character-package`

GREENFIELD_IMPLEMENTATION.md §58 is the complete, authoritative command surface; this section is a summary.

### `cfmem doctor`

Checks:

- Node version
- Wrangler availability
- Cloudflare credentials env vars
- local config
- Agent Memory access when credentials are present

### `cfmem cost`

Estimates memory-subsystem monthly cost.

Example:

```bash
cfmem cost --dau 200 --turns 12 --days 30 --recall-rate 0.2
```

### `cfmem managed-status`

Calls Cloudflare's Agent Memory API and reports whether the account appears to have private-beta access.

### `cfmem remember`

```bash
cfmem remember \
  --endpoint https://memory.example.com \
  --namespace prod \
  --profile user-123 \
  --content "The user prefers concise answers"
```

### `cfmem search`

Returns raw candidates, which is the recommended character-runtime mode.

### `cfmem recall`

Requests compatibility synthesis.

### `cfmem list`

Lists memories for inspection.

### `cfmem forget`

Deletes one memory.

---

## 20. Skill specification

Skill name: `character-memory-builder`

Triggers:

- design/build/review an AI character memory system on Cloudflare;
- operate the `cfmem` CLI;
- compare custom memory with managed Agent Memory;
- estimate cost;
- validate profile isolation, recall, supersession, and archival design.

The skill must always:

1. run an architecture review before recommending deployment;
2. distinguish current official specification from project assumptions;
3. avoid hard-depending on Private Beta Agent Memory;
4. preserve the `MemoryProvider` abstraction;
5. run `cfmem doctor` and `cfmem cost` when a local project is available;
6. validate Vectorize metadata index creation before vector writes;
7. verify deletion and cross-profile isolation;
8. clearly label experimental Cloudflare APIs.

---

## 21. Build phases

### Phase 0 - reviewed design

Acceptance:

- official-spec mismatches resolved;
- cost model available;
- storage/search boundaries fixed.

### Phase 1 - CLI + scaffold

Acceptance:

- `cfmem init` creates a project;
- `cfmem doctor` works without credentials and gives actionable diagnostics;
- `cfmem cost` produces deterministic output;
- API client commands accept config/env overrides.

### Phase 2 - MemoryProfile DO

Acceptance:

- messages and memories persist;
- FTS5 search works with Japanese fixture data;
- `remember/list/get/delete` work;
- relationship state stays outside memory types.

### Phase 3 - extraction workflow

Acceptance:

- conversation ranges are processed idempotently;
- duplicate workflow execution creates no duplicate long-term memories;
- supersession audit trail is preserved.

### Phase 4 - Vectorize hybrid recall

Acceptance:

- Qwen embedding index is 1,024/cosine;
- metadata indexes exist before data ingestion;
- semantic + FTS results merge by RRF;
- recent memory appears before Vectorize consistency catches up.

### Phase 5 - archive/delete/export

Acceptance:

- R2 session archives created in batches;
- delete profile removes DO/Vectorize/R2 content;
- export contains portable JSON.

### Phase 6 - managed Agent Memory adapter

Only implement when the Cloudflare account has access or Agent Memory becomes public.

Acceptance:

- application switches backend by configuration;
- character layer code does not change;
- managed and custom contract tests pass against the same interface.

### Phase 7 - quality benchmark

Acceptance:

- Japanese memory benchmark tracked in CI;
- no cross-profile retrieval;
- false supersession below project threshold;
- latency/cost dashboard established.

---

## 22. Go/no-go checklist

Go to production only when all are true:

- [ ] SOUL and learned memory are separated.
- [ ] Profile key is generated server-side with HMAC.
- [ ] Durable Object storage backend is SQLite.
- [ ] FTS5 search passes Japanese fixtures.
- [ ] Vectorize metadata indexes were created before writes.
- [ ] Vector queries include both namespace and profile filter.
- [ ] Every vector result is post-verified for profile key.
- [ ] Recent-memory fallback covers Vectorize indexing lag.
- [ ] No per-turn ingestion.
- [ ] Recall gating is enabled.
- [ ] Default recall returns candidates without second LLM synthesis.
- [ ] Supersession never physically deletes history.
- [ ] Delete-profile cascade is tested.
- [ ] Raw logs are not enabled by default.
- [ ] Cost estimate is inside budget.
- [ ] Experimental Cloudflare APIs are behind adapters.
- [ ] Agent Memory private-beta access is optional.

---

## 23. Official references reviewed

- Cloudflare Agent Memory overview, Workers API, HTTP API, concepts, limits, pricing and get-started documentation.
- Cloudflare blog: "Agents that remember: introducing Agent Memory".
- Durable Objects SQLite API, pricing, limits and Agents limits.
- Vectorize API, metadata filtering, limits, pricing and changelog.
- Workers AI model/pricing documentation.
- Workers Standard pricing.
- Workflows pricing.
- R2 pricing.
- AI Gateway pricing.

Review date matters: Cloudflare Developer Platform evolves quickly. The CLI pricing table should therefore carry a `pricingReviewedAt` field and warn when it becomes stale.
