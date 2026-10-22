/**
 * Extension points that this slice does not implement.
 *
 * Emotion is implemented by `PersistedEmotionModel` in `emotion/engine.ts`.
 * The diary is implemented by `LayeredDiaryWriter` in `diary/writer.ts`.
 * `StubEmotionModel` and `StubDiaryWriter` are the explicit inert doubles.
 * `defaultExtensions()` still returns them, because that helper has no
 * database; the plugin constructs the persisted models once the store is open.
 *
 * Vectors and hybrid reranking live in `vector/` and `rerank.ts`.
 * `NullVectorIndex` and `FtsOrderReranker` stay as the inert doubles.
 * `defaultExtensions()` still returns them, because that helper has no
 * database. The plugin builds `SqliteVectorIndex` and `HybridReranker`
 * once the store is open.
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

export type RetrievalKind = "turn" | "diary" | "experience";

export interface VectorHit {
  id: number;
  score: number;
  /** Absent means a raw turn, which is what the original contract returned. */
  kind?: RetrievalKind;
}

export interface VectorBackfillReport {
  turns: number;
  diaryPages: number;
  experiences: number;
  embedded: number;
  skipped: number;
  failed: number;
  backend: "sqlite-vec" | "blob";
}

export interface VectorIndex {
  upsert(id: number, text: string): void;
  search(query: string, limit: number): VectorHit[];
  /** Embed turns, sealed diary pages, and experiences that do not have a vector yet. */
  backfill?(): VectorBackfillReport | Promise<VectorBackfillReport>;
  /** Cache a query vector before a synchronous search. No-op for the offline hash. */
  prepareQuery?(query: string, signal?: AbortSignal): Promise<void>;
}

export class NullVectorIndex implements VectorIndex {
  upsert(_id: number, _text: string): void {
    // Inert double. The plugin default is SqliteVectorIndex.
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
  kind?: RetrievalKind;
  ts?: number;
  personId?: string;
  topics?: readonly string[];
}

export interface RerankContext {
  now?: number;
  personId?: string;
}

export interface Reranker {
  rerank(query: string, hits: readonly RerankHit[], context?: RerankContext): RerankHit[];
  /** Optional external pass. Failures must leave the deterministic order in place. */
  prepare?(query: string, hits: readonly RerankHit[], context?: RerankContext, signal?: AbortSignal): Promise<void>;
}

/** Keeps the FTS5 order. Vector-only hits sort after every FTS hit. */
export class FtsOrderReranker implements Reranker {
  rerank(_query: string, hits: readonly RerankHit[]): RerankHit[] {
    const ordered = [...hits].sort((a, b) => {
      const left = Number.isFinite(a.ftsRank) ? a.ftsRank : Number.POSITIVE_INFINITY;
      const right = Number.isFinite(b.ftsRank) ? b.ftsRank : Number.POSITIVE_INFINITY;
      const kind = (hit: RerankHit) => hit.kind === "diary" ? 1 : hit.kind === "experience" ? 2 : 0;
      return left - right || b.vectorScore - a.vectorScore || kind(a) - kind(b) || a.id - b.id;
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
