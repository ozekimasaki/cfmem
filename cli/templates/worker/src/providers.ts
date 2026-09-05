/**
 * Provider seams for the phases after the SQLite/FTS starter.
 *
 * Phase 1 persists and retrieves text only. These interfaces are the boundary the
 * Durable Object talks to, so Workers AI, Vectorize and R2 attach here instead of
 * spreading binding access through the profile logic:
 *
 *   Phase 3 EmbeddingProvider + MemoryExtractor  (Workers AI)
 *   Phase 4 VectorStore                          (Vectorize, outbox-driven)
 *   Phase 6 ArchiveStore                         (R2, §40 prefixes)
 *
 * Filter keys must stay aligned with the metadata indexes provisioned in §6.
 */

export interface Clock {
  now(): number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Fields Vectorize can filter on because `cfmem resources plan` created the index. */
export interface VectorFilter {
  profile_key?: string;
  memory_type?: string;
  active?: boolean;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  upsert(vectors: readonly { id: string; values: number[]; metadata: Record<string, unknown> }[]): Promise<void>;
  query(vector: number[], topK: number, filter?: VectorFilter): Promise<VectorMatch[]>;
  deleteByIds(ids: readonly string[]): Promise<void>;
}

export type MemoryType = "fact" | "event" | "instruction" | "task";

export interface ExtractedMemory {
  type: MemoryType;
  summary: string;
  content: string;
  subjectKey?: string;
  importance?: number;
  confidence?: number;
  validFrom?: number;
  validUntil?: number;
  supersedes?: string[];
}

export interface MemoryExtractor {
  /** Reads one checkpoint window of messages and returns candidate memories with evidence. */
  extract(input: {
    messages: readonly { role: string; content: string; seq: number }[];
    existingSubjects?: readonly string[];
    sessionId: string;
  }): Promise<ExtractedMemory[]>;
}

/** §40 — archive keys are `<prefix>/<profileKey>/<name>` and never carry raw secrets. */
export interface ArchiveStore {
  put(key: string, body: Uint8Array | string, options?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

export interface Providers {
  clock: Clock;
  embeddings: EmbeddingProvider;
  vectors: VectorStore;
  extractor: MemoryExtractor;
  archive: ArchiveStore;
}
