export const PRICING = {
  reviewedAt: "2026-09-05",
  workers: {
    baseMonthly: 5,
    includedRequests: 10_000_000,
    extraPerMillionRequests: 0.30,
    includedCpuMs: 30_000_000,
    extraPerMillionCpuMs: 0.02,
  },
  durableObjects: {
    includedRequests: 1_000_000,
    extraPerMillionRequests: 0.15,
    includedRowsRead: 25_000_000_000,
    extraPerMillionRowsRead: 0.001,
    includedRowsWritten: 50_000_000,
    extraPerMillionRowsWritten: 1.00,
    includedStorageGb: 5,
    extraPerGbMonth: 0.20,
  },
  vectorize: {
    includedQueriedDimensions: 50_000_000,
    extraPerMillionQueriedDimensions: 0.01,
    includedStoredDimensions: 10_000_000,
    extraPer100MillionStoredDimensions: 0.05,
  },
  workflows: {
    includedSteps: 500_000,
    extraPer100kSteps: 0.80,
  },
  ai: {
    extractionInputPerMillion: 0.051,
    extractionOutputPerMillion: 0.335,
    embeddingInputPerMillion: 0.012,
  },
};

const positive = (n) => Math.max(0, Number(n) || 0);
const over = (value, included) => Math.max(0, value - included);

/** A24: pricing figures are point-in-time; warn once they go stale. */
export function pricingStalenessWarning(reviewedAt = PRICING.reviewedAt, now = new Date()) {
  const reviewed = new Date(`${reviewedAt}T00:00:00Z`);
  if (Number.isNaN(reviewed.getTime())) {
    return `Pricing review date "${reviewedAt}" is unparseable; re-verify Cloudflare pricing.`;
  }
  const days = Math.floor((now.getTime() - reviewed.getTime()) / 86_400_000);
  if (days <= 90) return null;
  return (
    `Pricing/limits were reviewed ${days} days ago (${reviewedAt}). ` +
    "Re-verify Cloudflare pricing, Vectorize limits, and Workers AI availability before relying on these numbers."
  );
}

export function estimateCost(input = {}) {
  const days = positive(input.days ?? 30) || 30;
  const dau = positive(input.dau ?? 20);
  const turns = positive(input.turns ?? 12);
  const recallRate = Math.min(1, positive(input.recallRate ?? 0.20));
  const checkpointTurns = positive(input.checkpointTurns ?? 8) || 8;
  const memoriesPerCheckpoint = positive(input.memoriesPerCheckpoint ?? 4);
  const embeddingDimensions = positive(input.embeddingDimensions ?? 1024) || 1024;
  const extractionInputTokens = positive(input.extractionInputTokens ?? 1600);
  const extractionOutputTokens = positive(input.extractionOutputTokens ?? 350);
  const memoryEmbeddingTokens = positive(input.memoryEmbeddingTokens ?? 80);
  const queryEmbeddingTokens = positive(input.queryEmbeddingTokens ?? 32);
  const workflowStepsPerCheckpoint = positive(input.workflowStepsPerCheckpoint ?? 4);

  const userTurns = dau * turns * days;
  const checkpoints = Math.ceil(userTurns / checkpointTurns);
  const recalls = Math.ceil(userTurns * recallRate);
  const memories = Math.ceil(checkpoints * memoriesPerCheckpoint);

  const extractionInputTotal = checkpoints * extractionInputTokens;
  const extractionOutputTotal = checkpoints * extractionOutputTokens;
  const embeddingTokens = memories * memoryEmbeddingTokens + recalls * queryEmbeddingTokens;

  const aiExtraction = extractionInputTotal / 1_000_000 * PRICING.ai.extractionInputPerMillion
    + extractionOutputTotal / 1_000_000 * PRICING.ai.extractionOutputPerMillion;
  const aiEmbedding = embeddingTokens / 1_000_000 * PRICING.ai.embeddingInputPerMillion;

  // Cloudflare's Vectorize pricing examples calculate queried dimensions using
  // (queries + stored vectors) * dimensions. This estimator follows that public example.
  const queriedDimensions = (recalls + memories) * embeddingDimensions;
  const storedDimensions = memories * embeddingDimensions;
  const vectorQueryCost = over(queriedDimensions, PRICING.vectorize.includedQueriedDimensions)
    / 1_000_000 * PRICING.vectorize.extraPerMillionQueriedDimensions;
  const vectorStorageCost = over(storedDimensions, PRICING.vectorize.includedStoredDimensions)
    / 100_000_000 * PRICING.vectorize.extraPer100MillionStoredDimensions;

  const workflowSteps = checkpoints * workflowStepsPerCheckpoint;
  const workflowStepCost = over(workflowSteps, PRICING.workflows.includedSteps)
    / 100_000 * PRICING.workflows.extraPer100kSteps;

  // Conservative rough request model: one public Worker call per turn,
  // one DO RPC per turn, plus one DO RPC per memory checkpoint.
  const workerRequests = userTurns;
  const doRequests = userTurns + checkpoints;
  const workerRequestCost = over(workerRequests, PRICING.workers.includedRequests)
    / 1_000_000 * PRICING.workers.extraPerMillionRequests;
  const doRequestCost = over(doRequests, PRICING.durableObjects.includedRequests)
    / 1_000_000 * PRICING.durableObjects.extraPerMillionRequests;

  const variable = aiExtraction + aiEmbedding + vectorQueryCost + vectorStorageCost
    + workflowStepCost + workerRequestCost + doRequestCost;
  const total = PRICING.workers.baseMonthly + variable;

  return {
    assumptions: {
      days, dau, turns, recallRate, checkpointTurns, memoriesPerCheckpoint,
      embeddingDimensions, extractionInputTokens, extractionOutputTokens,
      memoryEmbeddingTokens, queryEmbeddingTokens, workflowStepsPerCheckpoint,
    },
    usage: {
      userTurns, checkpoints, recalls, memories, queriedDimensions, storedDimensions,
      workflowSteps, workerRequests, doRequests,
    },
    cost: {
      workersBase: PRICING.workers.baseMonthly,
      workerRequestCost,
      durableObjectRequestCost: doRequestCost,
      aiExtraction,
      aiEmbedding,
      vectorQueryCost,
      vectorStorageCost,
      workflowStepCost,
      total,
    },
    notes: [
      "Character-response model cost is intentionally excluded.",
      "Workers AI daily free-neuron allocation is not deducted; this is conservative.",
      "DO duration, rows/storage, R2 and log costs are not estimated without workload-specific byte/CPU data.",
      "Pricing is a point-in-time estimate; verify Cloudflare pricing before production budgeting.",
    ],
  };
}

export function formatCostReport(result, now = new Date()) {
  const money = (n) => `$${n.toFixed(2)}`;
  const c = result.cost;
  const u = result.usage;
  const stale = pricingStalenessWarning(PRICING.reviewedAt, now);
  return [
    `Pricing reviewed: ${PRICING.reviewedAt}`,
    "",
    `User turns/month: ${u.userTurns.toLocaleString()}`,
    `Memory checkpoints/month: ${u.checkpoints.toLocaleString()}`,
    `Semantic recalls/month: ${u.recalls.toLocaleString()}`,
    `New memories/month: ${u.memories.toLocaleString()}`,
    "",
    "Estimated monthly memory-platform cost:",
    `  Workers Paid base       ${money(c.workersBase)}`,
    `  Worker requests         ${money(c.workerRequestCost)}`,
    `  Durable Object requests ${money(c.durableObjectRequestCost)}`,
    `  AI extraction           ${money(c.aiExtraction)}`,
    `  AI embeddings           ${money(c.aiEmbedding)}`,
    `  Vectorize queries       ${money(c.vectorQueryCost)}`,
    `  Vectorize storage       ${money(c.vectorStorageCost)}`,
    `  Workflow steps          ${money(c.workflowStepCost)}`,
    `  --------------------------------`,
    `  Total                   ${money(c.total)}`,
    "",
    ...(stale ? [`! ${stale}`] : []),
    ...result.notes.map((n) => `- ${n}`),
  ].join("\n");
}
