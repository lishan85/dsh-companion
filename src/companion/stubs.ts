/**
 * Extension points that this slice does not implement.
 *
 * TODO(emotion): PAD base (pleasure, arousal, dominance in [-1, 1]) plus a
 * discrete vector (happy, missing, aggrieved, worried, jealous, shy, angry,
 * at-ease in [0, 1]), each with baseline, decay, and inertia. A cheap model
 * proposes deltas; a deterministic scorer is the offline fallback. Expression
 * is the top two or three dimensions as inner monologue, never raw numbers.
 * Intimacy moves on a slower clock. Proactive messages fire on thresholds,
 * with a daily cap, a minimum gap, and quiet hours, plus next-day follow-ups.
 *
 * TODO(diary): daily, weekly, and monthly layers in her voice. Raw turns stay
 * forever. Important events are stored verbatim and are never compressed.
 *
 * TODO(vector): configurable embedding provider (OpenAI-compatible HTTP) with
 * an offline fallback. TODO(rerank): blend FTS5/BM25 with character n-gram
 * cosine and the vector score. The default reranker keeps FTS order.
 *
 * @module dsh-companion/stubs
 */

import type { TurnRecord } from "./types.js";

export interface EmotionModel {
  /** Short inner-state line. Empty means "say nothing about mood". */
  line(personId: string, now: number): string;
  observe(turn: TurnRecord): void;
}

export class StubEmotionModel implements EmotionModel {
  line(_personId: string, _now: number): string {
    return "";
  }

  observe(_turn: TurnRecord): void {
    // TODO(emotion): score the turn and persist the new vector.
  }
}

export interface DiaryWriter {
  observe(turn: TurnRecord): void;
}

export class StubDiaryWriter implements DiaryWriter {
  observe(_turn: TurnRecord): void {
    // TODO(diary): roll the turn into the daily layer; seal weeks and months.
  }
}

export interface VectorHit {
  id: number;
  score: number;
}

export interface VectorIndex {
  upsert(id: number, text: string): void;
  search(query: string, limit: number): VectorHit[];
}

export class NullVectorIndex implements VectorIndex {
  upsert(_id: number, _text: string): void {
    // TODO(vector): embed and store a vector for this turn.
  }

  search(_query: string, _limit: number): VectorHit[] {
    return [];
  }
}

export interface RerankHit {
  id: number;
  text: string;
  /** FTS5 bm25 rank, lower is better. Missing FTS hits use +Infinity. */
  ftsRank: number;
  vectorScore: number;
  score: number;
}

export interface Reranker {
  rerank(query: string, hits: readonly RerankHit[]): RerankHit[];
}

/** Keeps the FTS5 order. Vector-only hits sort after every FTS hit. */
export class FtsOrderReranker implements Reranker {
  rerank(_query: string, hits: readonly RerankHit[]): RerankHit[] {
    const ordered = [...hits].sort((a, b) => {
      const left = Number.isFinite(a.ftsRank) ? a.ftsRank : Number.POSITIVE_INFINITY;
      const right = Number.isFinite(b.ftsRank) ? b.ftsRank : Number.POSITIVE_INFINITY;
      return left - right || b.vectorScore - a.vectorScore || a.id - b.id;
    });
    return ordered.map((hit, index) => ({ ...hit, score: ordered.length - index }));
  }
}

export interface CompanionExtensions {
  emotion: EmotionModel;
  diary: DiaryWriter;
  vector: VectorIndex;
  reranker: Reranker;
}

export function defaultExtensions(): CompanionExtensions {
  return {
    emotion: new StubEmotionModel(),
    diary: new StubDiaryWriter(),
    vector: new NullVectorIndex(),
    reranker: new FtsOrderReranker(),
  };
}
