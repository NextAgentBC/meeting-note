/**
 * Multi-route hit merging + MMR re-ranking for Meeting Note v2 memory recall.
 *
 * Ported from nextclaw-cloud's src/recall/merge.ts (mergeRoutes / mmrRerank /
 * jaccard / tokens / DEFAULT_WEIGHTS / SUPERSEDED_PENALTY), adapted to v2's
 * storage backends. nextclaw-cloud has 5 routes backed by Postgres
 * (semantic/pgvector, fulltext/tsvector, trgm, concept_tag, time_bucket); v2
 * has 4 routes backed by Cloudflare Vectorize + D1:
 *
 *   v2 route   nextclaw-cloud route   weight   why
 *   ---------  ---------------------  -------  --------------------------------
 *   vector     semantic               1.0      same role: nearest-neighbour search
 *   fulltext   fulltext               0.7      same role: keyword search. Also
 *                                               absorbs nextclaw-cloud's separate
 *                                               `trgm` fuzzy route, because D1's
 *                                               FTS5 table uses the trigram
 *                                               tokenizer, so one route now covers
 *                                               both token and fuzzy substring
 *                                               matching. (trgm's 0.5 weight has
 *                                               no separate v2 target.)
 *   tag        concept_tag            0.8      same role: matched query/index tags
 *   time       time_bucket            0.6      same role: matched time window
 *
 * Per-route score normalisation mirrors nextclaw-cloud's per-route SQL:
 *   - vector: clamp to [0,1] (nextclaw-cloud clamps cosine similarity directly
 *     instead of rescaling by batch max, so a weak top hit stays weak).
 *   - fulltext / tag: divide by the batch max (nextclaw-cloud does this for
 *     ts_rank and concept_tag hit counts, both unbounded scores).
 *   - time: 0.6 + 0.4 * (score / batch max) (nextclaw-cloud's time_bucket
 *     formula — a floor of 0.6 so any time-window match counts meaningfully
 *     even when the route can't otherwise rank hits against each other).
 *
 * The combine step (weight * normScore, summed across routes that hit the same
 * id), the superseded penalty (x0.2), and mmrRerank/jaccard/tokens are ported
 * unchanged in behaviour from merge.ts; only field names moved from
 * chunkId/combinedScore/MergedCandidate to id/score/MergedHit to match this
 * package's naming.
 */

export type RouteName = "vector" | "fulltext" | "time" | "tag";

export interface RouteHit {
  id: string;
  score: number;
  text: string;
  supersededBy?: string | null;
  occurredAt?: number;
}

export interface RouteResult {
  route: RouteName;
  hits: RouteHit[];
}

export interface MergedHit {
  id: string;
  text: string;
  score: number;
  routes: RouteName[];
  supersededBy?: string | null;
  occurredAt?: number;
}

export type MergeWeights = Partial<Record<RouteName, number>>;

export interface MergeOptions {
  limit: number;
  weights?: MergeWeights;
  mmrLambda?: number;
}

/** Same values as nextclaw-cloud's DEFAULT_WEIGHTS, remapped to v2 route names (see mapping above). */
export const DEFAULT_WEIGHTS: Required<MergeWeights> = {
  vector: 1.0,
  fulltext: 0.7,
  tag: 0.8,
  time: 0.6,
};

/** Score multiplier for hits whose fact has been superseded by a later chunk. */
export const SUPERSEDED_PENALTY = 0.2;

const DEFAULT_MMR_LAMBDA = 0.7;

export function mergeHits(
  routes: ReadonlyArray<RouteResult>,
  options: MergeOptions,
): MergedHit[] {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const byId = new Map<string, MergedHit>();

  for (const { route, hits } of routes) {
    const weight = weights[route] ?? 0.5;
    const normScores = normalizeScores(route, hits);
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i];
      if (!hit) {
        continue;
      }
      const contribution = weight * (normScores[i] ?? 0);
      const existing = byId.get(hit.id);
      if (existing) {
        // Multi-route hit = compounded score; this is the core payoff of hybrid recall.
        existing.score += contribution;
        if (!existing.routes.includes(route)) {
          existing.routes.push(route);
        }
      } else {
        byId.set(hit.id, {
          id: hit.id,
          text: hit.text,
          score: contribution,
          routes: [route],
          supersededBy: hit.supersededBy ?? null,
          ...(hit.occurredAt === undefined ? {} : { occurredAt: hit.occurredAt }),
        });
      }
    }
  }

  const merged = [...byId.values()];
  for (const m of merged) {
    if (m.supersededBy) {
      m.score *= SUPERSEDED_PENALTY;
    }
  }
  merged.sort((a, b) => b.score - a.score);

  return mmrRerank(merged, options.limit, options.mmrLambda ?? DEFAULT_MMR_LAMBDA);
}

function normalizeScores(route: RouteName, hits: readonly RouteHit[]): number[] {
  if (route === "vector") {
    return hits.map((h) => clamp01(h.score));
  }
  const max = hits.reduce((m, h) => Math.max(m, h.score), 0);
  if (route === "time") {
    return hits.map((h) => (max === 0 ? 0 : 0.6 + 0.4 * (h.score / max)));
  }
  return hits.map((h) => (max === 0 ? 0 : h.score / max));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) {
    return 0;
  }
  return Math.max(0, Math.min(1, n));
}

/**
 * Maximal Marginal Relevance: greedy de-duplication by relevance vs. diversity.
 * Similarity is text Jaccard (ported as-is from merge.ts — avoids a second
 * embedding round-trip just for re-ranking).
 */
export function mmrRerank(
  items: MergedHit[],
  k: number,
  lambda = DEFAULT_MMR_LAMBDA,
): MergedHit[] {
  if (items.length <= k) {
    return items;
  }
  const selected: MergedHit[] = [];
  // Workers Free allows 10 ms of CPU per request: only the strongest candidates compete for
  // diversity, and each text is tokenised once rather than on every comparison.
  const pool = [...items].sort((a, b) => b.score - a.score).slice(0, Math.max(k * 2, 12));
  const tokenSets = new Map(pool.map((item) => [item.id, tokens(item.text.slice(0, 1000))]));
  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const cand = pool[i];
      if (!cand) {
        continue;
      }
      const relevance = cand.score;
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccardSets(tokenSets.get(cand.id)!, tokenSets.get(s.id)!);
        if (sim > maxSim) {
          maxSim = sim;
        }
      }
      const score = lambda * relevance - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const picked = pool.splice(bestIdx, 1)[0];
    if (!picked) {
      break;
    }
    selected.push(picked);
  }
  return selected;
}

export function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/\s+|[,，.。!?;:、]/u)
      .filter((t) => t.length >= 2),
  );
}

export function jaccard(a: string, b: string): number {
  return jaccardSets(tokens(a), tokens(b));
}

function jaccardSets(A: Set<string>, B: Set<string>): number {
  if (A.size === 0 || B.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) {
      inter += 1;
    }
  }
  return inter / (A.size + B.size - inter);
}
