/**
 * Hybrid ranker.
 *
 * Reciprocal rank fusion mixes three lists: FTS5 (lower bm25 is better),
 * vector cosine (higher is better), and character n-gram cosine. Time,
 * person, and topic multipliers then nudge that score. An optional HTTP
 * reranker can reorder the same pool. If it is not configured, the key is
 * missing, or the call fails, the fused score is the result.
 *
 * Experiences are hers, so the person multiplier does not treat them as a
 * different interlocutor. The token budget still lives in the renderer: this
 * module only orders candidates the retriever already capped.
 *
 * @module dsh-companion/rerank
 */

import { ngramCosine } from "../search.js";
import { tokenize } from "../tokenize.js";
import type { RerankContext, RerankHit, Reranker } from "./stubs.js";

export interface HybridRerankOptions {
  k?: number;
  timeBoost?: number;
  timeHalfLifeDays?: number;
  personBoost?: number;
  topicBoost?: number;
  now?: () => number;
}

const DEFAULTS = {
  k: 60,
  timeBoost: 0.15,
  timeHalfLifeDays: 30,
  personBoost: 0.1,
  topicBoost: 0.2,
};

export class HybridReranker implements Reranker {
  readonly #options: Required<Omit<HybridRerankOptions, "now">> & Pick<HybridRerankOptions, "now">;

  constructor(options: HybridRerankOptions = {}) {
    this.#options = {
      k: options.k ?? DEFAULTS.k,
      timeBoost: options.timeBoost ?? DEFAULTS.timeBoost,
      timeHalfLifeDays: options.timeHalfLifeDays ?? DEFAULTS.timeHalfLifeDays,
      personBoost: options.personBoost ?? DEFAULTS.personBoost,
      topicBoost: options.topicBoost ?? DEFAULTS.topicBoost,
      ...(options.now ? { now: options.now } : {}),
    };
  }

  rerank(query: string, hits: readonly RerankHit[], context?: RerankContext): RerankHit[] {
    if (hits.length === 0) return [];
    const fused = new Map<string, number>();
    const add = (keys: readonly string[]) => {
      keys.forEach((key, index) => {
        fused.set(key, (fused.get(key) ?? 0) + 1 / (this.#options.k + index + 1));
      });
    };
    add(orderBy(hits, (hit) => Number.isFinite(hit.ftsRank), (left, right) => left.ftsRank - right.ftsRank || left.id - right.id));
    add(orderBy(hits, (hit) => hit.vectorScore > 0, (left, right) => right.vectorScore - left.vectorScore || left.id - right.id));
    const lexical = hits
      .map((hit) => ({ hit, cosine: ngramCosine(query, hit.text) }))
      .filter((item) => item.cosine > 0)
      .sort((left, right) => right.cosine - left.cosine || left.hit.id - right.hit.id);
    add(lexical.map((item) => hitKey(item.hit)));

    const now = context?.now ?? this.#options.now?.() ?? Date.now();
    const ranked = hits.map((hit) => {
      const base = fused.get(hitKey(hit)) ?? 0;
      const score = base
        * timeFactor(hit.ts, now, this.#options.timeBoost, this.#options.timeHalfLifeDays)
        * personFactor(hit, context?.personId, this.#options.personBoost)
        * topicFactor(hit.topics, query, this.#options.topicBoost);
      return { ...hit, score };
    });
    ranked.sort((left, right) => right.score - left.score || (right.ts ?? 0) - (left.ts ?? 0) || left.id - right.id);
    return ranked;
  }
}

export interface HttpRerankOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  inner?: HybridReranker;
}

/**
 * Pluggable HTTP reranker. `prepare` caches scores for the current pool.
 * Any failure, including a missing key, leaves the deterministic fusion in place.
 */
export class HttpReranker implements Reranker {
  readonly #options: HttpRerankOptions;
  readonly #inner: HybridReranker;
  #scores: Map<string, number> | undefined;

  constructor(options: HttpRerankOptions) {
    this.#options = options;
    this.#inner = options.inner ?? new HybridReranker();
  }

  async prepare(query: string, hits: readonly RerankHit[], _context?: RerankContext, signal?: AbortSignal): Promise<void> {
    this.#scores = undefined;
    const apiKey = (this.#options.apiKey ?? readKey(this.#options.apiKeyEnv)).trim();
    if (apiKey.length === 0 || hits.length === 0) return;
    try {
      this.#scores = await fetchRerank({ ...this.#options, apiKey }, query, hits, signal);
    } catch {
      this.#scores = undefined;
    }
  }

  rerank(query: string, hits: readonly RerankHit[], context?: RerankContext): RerankHit[] {
    const base = this.#inner.rerank(query, hits, context);
    const scores = this.#scores;
    if (!scores || scores.size === 0) return base;
    const blended = base.map((hit) => {
      const external = scores.get(hitKey(hit));
      if (external === undefined) return hit;
      return { ...hit, score: external };
    });
    blended.sort((left, right) => right.score - left.score || (right.ts ?? 0) - (left.ts ?? 0) || left.id - right.id);
    return blended;
  }
}

export function rerankUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/rerank")) return trimmed;
  return `${trimmed}/rerank`;
}

export async function fetchRerank(
  options: HttpRerankOptions,
  query: string,
  hits: readonly RerankHit[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(rerankUrl(options.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        query,
        documents: hits.map((hit) => hit.text),
      }),
    });
    if (!response.ok) throw new Error(`dsh-companion: rerank request failed with status ${response.status}`);
    const body = await response.json() as unknown;
    return parseRerank(body, hits);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function parseRerank(body: unknown, hits: readonly RerankHit[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (!body || typeof body !== "object") return scores;
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return scores;
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const record = item as { index?: unknown; relevance_score?: unknown; score?: unknown };
    if (typeof record.index !== "number" || !Number.isInteger(record.index)) continue;
    const hit = hits[record.index];
    if (!hit) continue;
    const score = typeof record.relevance_score === "number" ? record.relevance_score : record.score;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    scores.set(hitKey(hit), score);
  }
  return scores;
}

export function hitKey(hit: RerankHit): string {
  return `${hit.kind ?? "turn"}:${hit.id}`;
}

function readKey(name: string | undefined): string {
  if (!name) return "";
  const value = process.env[name];
  return typeof value === "string" ? value : "";
}

function orderBy(
  hits: readonly RerankHit[],
  keep: (hit: RerankHit) => boolean,
  compare: (left: RerankHit, right: RerankHit) => number,
): string[] {
  return hits.filter(keep).sort(compare).map(hitKey);
}

function timeFactor(ts: number | undefined, now: number, weight: number, halfLifeDays: number): number {
  if (ts === undefined || weight === 0) return 1;
  const age = Math.max(0, now - ts);
  const half = halfLifeDays * 86_400_000;
  if (half <= 0) return 1;
  return 1 + weight * Math.pow(0.5, age / half);
}

function personFactor(hit: RerankHit, personId: string | undefined, weight: number): number {
  if (hit.kind === "experience" || weight === 0 || personId === undefined || hit.personId === undefined) return 1;
  return hit.personId === personId ? 1 + weight : 1;
}

function topicFactor(topics: readonly string[] | undefined, query: string, weight: number): number {
  if (!topics || topics.length === 0 || weight === 0) return 1;
  const tokens = new Set(tokenize(query));
  let matched = 0;
  for (const topic of topics) {
    if (tokenize(topic).some((token) => tokens.has(token))) matched += 1;
  }
  if (matched === 0) return 1;
  return 1 + weight * (matched / topics.length);
}
