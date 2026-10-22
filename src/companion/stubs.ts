/**
 * Extension points that this slice does not implement.
 *
 * Emotion is implemented by `PersistedEmotionModel` in `emotion/engine.ts`.
 * The diary is implemented by `LayeredDiaryWriter` in `diary/writer.ts`.
 * `StubEmotionModel` and `StubDiaryWriter` are the explicit inert doubles.
 * `defaultExtensions()` still returns them, because that helper has no
 * database; the plugin constructs the persisted models once the store is open.
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
  observe(turn: TurnRecord): void | Promise<void>;
  /** Resolves when a turn scored asynchronously has been applied. */
  settle?(): Promise<void>;
}

export class StubEmotionModel implements EmotionModel {
  line(_personId: string, _now: number): string {
    return "";
  }

  observe(_turn: TurnRecord): void {
    // Explicit off switch. The plugin default is PersistedEmotionModel.
  }
}

export interface DiaryWriter {
  observe(turn: TurnRecord): void | Promise<void>;
  /** Resolves when a diary seal started asynchronously has finished. */
  settle?(): Promise<void>;
}

export class StubDiaryWriter implements DiaryWriter {
  observe(_turn: TurnRecord): void {
    // Explicit off switch. The plugin default is LayeredDiaryWriter.
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
