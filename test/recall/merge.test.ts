/**
 * Ported from nextclaw-cloud's test/merge.test.ts (mergeRoutes/mmrRerank/jaccard
 * cases), retargeted at mergeHits's v2 route names and field names, plus new
 * cases for cross-route overlap, the superseded penalty, and MMR demotion
 * requested for this port.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, jaccard, mergeHits, mmrRerank, SUPERSEDED_PENALTY } from "../../src/recall/merge";
import type { MergedHit, RouteHit } from "../../src/recall/merge";

function hit(id: string, score: number, text = `text ${id}`, extra: Partial<RouteHit> = {}): RouteHit {
  return { id, score, text, ...extra };
}

describe("mergeHits", () => {
  it("single-route hit = weight x normalised score (vector clamps, doesn't rescale)", () => {
    const merged = mergeHits([{ route: "vector", hits: [hit("a", 0.8)] }], { limit: 10 });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.score).toBeCloseTo(DEFAULT_WEIGHTS.vector * 0.8, 10);
  });

  it("same id hit by two routes -> scores add, routes accumulate", () => {
    const merged = mergeHits(
      [
        { route: "vector", hits: [hit("a", 0.5)] },
        { route: "fulltext", hits: [hit("a", 10)] },
        { route: "tag", hits: [hit("a", 3)] },
      ],
      { limit: 10 },
    );
    expect(merged).toHaveLength(1);
    const only = merged[0]!;
    expect(only.routes.sort()).toEqual(["fulltext", "tag", "vector"]);
    // fulltext/tag both normalise by batch max; each is alone in its batch -> normScore 1.
    expect(only.score).toBeCloseTo(
      DEFAULT_WEIGHTS.vector * 0.5 + DEFAULT_WEIGHTS.fulltext * 1 + DEFAULT_WEIGHTS.tag * 1,
      10,
    );
  });

  it("three-route weak overlap can outrank a single-route strong hit", () => {
    const merged = mergeHits(
      [
        { route: "vector", hits: [hit("strong", 0.95), hit("multi", 0.4)] },
        { route: "fulltext", hits: [hit("multi", 9)] },
        { route: "tag", hits: [hit("multi", 4)] },
      ],
      { limit: 10 },
    );
    expect(merged[0]?.id).toBe("multi");
    expect(merged[1]?.id).toBe("strong");
  });

  it("overlapping hits from two routes rank above hits unique to either route", () => {
    // "shared" is hit by both vector and fulltext; "vector-only" and
    // "fulltext-only" each appear in exactly one route with a higher raw score
    // in that route alone, but the combined score for "shared" should still win.
    const merged = mergeHits(
      [
        {
          route: "vector",
          hits: [hit("shared", 0.6, "共享结果 alpha"), hit("vector-only", 0.9, "只在向量路 beta")],
        },
        {
          route: "fulltext",
          hits: [hit("shared", 5, "共享结果 alpha"), hit("fulltext-only", 9, "只在全文路 gamma")],
        },
      ],
      { limit: 10 },
    );
    expect(merged[0]?.id).toBe("shared");
    expect(merged[0]?.routes.sort()).toEqual(["fulltext", "vector"]);
  });

  it("weights can be overridden per call", () => {
    const merged = mergeHits([{ route: "time", hits: [hit("a", 10)] }], {
      limit: 10,
      weights: { time: 0.1 },
    });
    // time's own formula (0.6 + 0.4*ratio) still applies; only the weight changes.
    expect(merged[0]?.score).toBeCloseTo(0.1 * 1, 10);
  });

  it("time route floors the weakest hit's normalised score at 0.6 of batch max", () => {
    // Mirrors nextclaw-cloud's time_bucket formula: even the worst hit in the
    // window keeps most of its weight, since a time-range match alone is a
    // meaningful signal (no ranking function to otherwise separate hits).
    const merged = mergeHits([{ route: "time", hits: [hit("strong", 100), hit("weak", 1)] }], {
      limit: 10,
    });
    const weak = merged.find((m) => m.id === "weak")!;
    expect(weak.score).toBeCloseTo(DEFAULT_WEIGHTS.time * (0.6 + 0.4 * (1 / 100)), 10);
    expect(weak.score).toBeGreaterThan(DEFAULT_WEIGHTS.time * 0.6);
  });

  it("supersededBy applies the 0.2x penalty after combining route scores", () => {
    const merged = mergeHits(
      [
        { route: "vector", hits: [hit("old", 0.9, "旧结果", { supersededBy: "new" })] },
        { route: "vector", hits: [hit("new", 0.5, "新结果")] },
      ],
      { limit: 10 },
    );
    const old = merged.find((m) => m.id === "old")!;
    const fresh = merged.find((m) => m.id === "new")!;
    expect(old.score).toBeCloseTo(0.9 * SUPERSEDED_PENALTY, 10);
    expect(fresh.score).toBeCloseTo(0.5, 10);
    // Superseded ranks below the current fact even though its raw score was higher.
    expect(merged[0]?.id).toBe("new");
    expect(merged[1]?.id).toBe("old");
  });

  it("supersededBy: null / undefined are both treated as not superseded", () => {
    const merged = mergeHits(
      [
        { route: "vector", hits: [hit("a", 0.5, "text a", { supersededBy: null })] },
        { route: "vector", hits: [hit("b", 0.5, "text b")] },
      ],
      { limit: 10 },
    );
    expect(merged.find((m) => m.id === "a")?.score).toBeCloseTo(0.5, 10);
    expect(merged.find((m) => m.id === "b")?.score).toBeCloseTo(0.5, 10);
  });

  it("same route repeating the same id does not duplicate the routes entry", () => {
    const merged = mergeHits(
      [
        { route: "vector", hits: [hit("a", 0.5)] },
        { route: "vector", hits: [hit("a", 0.5)] },
      ],
      { limit: 10 },
    );
    expect(merged[0]?.routes).toEqual(["vector"]);
  });

  it("empty input -> empty result", () => {
    expect(mergeHits([], { limit: 10 })).toEqual([]);
    expect(mergeHits([{ route: "vector", hits: [] }], { limit: 10 })).toEqual([]);
  });

  it("passes occurredAt through untouched", () => {
    const merged = mergeHits([{ route: "vector", hits: [hit("a", 0.5, "t", { occurredAt: 12345 })] }], {
      limit: 10,
    });
    expect(merged[0]?.occurredAt).toBe(12345);
  });

  it("demotes a near-duplicate text via MMR even when its raw score is close to the top hit", () => {
    const dup = "机器学习 模型 训练 数据 流程";
    const merged = mergeHits(
      [
        {
          route: "vector",
          hits: [
            hit("a", 1.0, dup),
            hit("b", 0.98, dup), // near-duplicate of a
            hit("c", 0.9, "完全不同的话题 烤箱 温度 面团 发酵"),
          ],
        },
      ],
      { limit: 2 },
    );
    expect(merged.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("respects limit after MMR re-ranking", () => {
    const merged = mergeHits(
      [
        {
          route: "vector",
          hits: Array.from({ length: 10 }, (_, i) => hit(`c${i}`, 1 - i * 0.05, `独立内容 ${i} unique-${i}`)),
        },
      ],
      { limit: 4 },
    );
    expect(merged).toHaveLength(4);
  });

  it("mmrLambda is configurable and forwarded to the rerank step", () => {
    // Same near-duplicate dataset as above: under the default lambda, "b"
    // (near-dup of "a") loses to "c" on diversity despite a higher raw score.
    const dup = "机器学习 模型 训练 数据 流程";
    const items = [
      {
        route: "vector" as const,
        hits: [hit("a", 1.0, dup), hit("b", 0.98, dup), hit("c", 0.9, "完全不同的话题 烤箱 温度 面团 发酵")],
      },
    ];
    // lambda=1 zeroes out the diversity term -> pure relevance order (a, b), not (a, c).
    const pureRelevance = mergeHits(items, { limit: 2, mmrLambda: 1 });
    expect(pureRelevance.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("mmrRerank", () => {
  const merged = (h: RouteHit, score: number): MergedHit => ({
    id: h.id,
    text: h.text,
    score,
    routes: ["vector"],
    supersededBy: null,
  });

  it("returns items unchanged when count <= k", () => {
    const items = [merged(hit("a", 1), 1), merged(hit("b", 1), 0.5)];
    expect(mmrRerank(items, 5)).toHaveLength(2);
  });

  it("highest score is always selected first", () => {
    const items = [
      merged(hit("top", 1, "完全独一无二的内容 alpha beta"), 2.0),
      merged(hit("b", 1, "另一段文字 gamma delta"), 1.0),
      merged(hit("c", 1, "第三段文字 epsilon zeta"), 0.5),
    ];
    expect(mmrRerank(items, 2)[0]?.id).toBe("top");
  });

  it("returns exactly k items", () => {
    const items = Array.from({ length: 10 }, (_, i) => merged(hit(`c${i}`, 1, `独立内容 ${i} unique-${i}`), 1 - i * 0.05));
    expect(mmrRerank(items, 4)).toHaveLength(4);
  });
});

describe("jaccard", () => {
  it("identical = 1, disjoint = 0", () => {
    expect(jaccard("alpha beta", "alpha beta")).toBe(1);
    expect(jaccard("alpha beta", "gamma delta")).toBe(0);
  });
  it("empty string = 0", () => {
    expect(jaccard("", "alpha beta")).toBe(0);
  });
});
