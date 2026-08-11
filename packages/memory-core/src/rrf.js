import { ValidationError } from "./errors.js";

/**
 * Reciprocal Rank Fusion. Inputs are independently ordered result lists. The
 * function deliberately does not inspect scores from those systems, because
 * BM25, vector similarity and exact-match scores are not comparable.
 */
export function reciprocalRankFusion(lists, { limit = 8, k = 60 } = {}) {
  if (!Array.isArray(lists)) throw new ValidationError("lists must be an array");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("limit must be an integer between 1 and 100");
  }
  if (!Number.isFinite(k) || k < 1) throw new ValidationError("k must be positive");

  const combined = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const seenInList = new Set();
    list.forEach((item, offset) => {
      if (!item || typeof item.id !== "string" || item.id.length === 0) return;
      // A buggy or adversarial retriever must not gain extra voting power by
      // returning the same candidate repeatedly in one ranked list.
      if (seenInList.has(item.id)) return;
      seenInList.add(item.id);
      const rank = offset + 1;
      const existing = combined.get(item.id) ?? {
        ...item,
        rrfScore: 0,
        sources: [],
      };
      existing.rrfScore += 1 / (k + rank);
      if (item.source && !existing.sources.includes(item.source)) {
        existing.sources.push(item.source);
      }
      combined.set(item.id, existing);
    });
  }

  return [...combined.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}
