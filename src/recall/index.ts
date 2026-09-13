// Finding things again: merge hits from several searches, read time words in a question,
// and prepare text for the index. Ported from nextclaw-cloud, adapted to D1 and Vectorize.
export { mergeHits, mmrRerank, jaccard, tokens, DEFAULT_WEIGHTS, SUPERSEDED_PENALTY } from "./merge";
export type { RouteName, RouteHit, RouteResult, MergedHit, MergeWeights, MergeOptions } from "./merge";
export { querySignals } from "./query-signals";
export type { TimeRange, QuerySignals } from "./query-signals";
export { isJunk } from "./trash";
export { splitForIndex } from "./split";
export { buildFtsQuery } from "./fts";
export type { FtsQuery } from "./fts";
