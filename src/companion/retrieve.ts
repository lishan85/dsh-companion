/**
 * FTS5 retrieval over raw turns and sealed diary pages.
 *
 * Tokens are quoted by the inherited CJK compiler, so model text cannot change
 * the MATCH expression. A vector index and a reranker may be passed in; the
 * defaults add no vectors and keep FTS order. Diary pages share the same
 * snippet budget and are phrased in the first person. See `stubs.ts`.
 *
 * @module dsh-companion/retrieve
 */

import { compileMatch } from "../search.js";
import { renderDiarySnippet } from "./diary/fallback.js";
import { monthKeyFromDay, weekKeyFromDay } from "./diary/periods.js";
import type { DiaryEntry, DiaryEvent } from "./diary/types.js";
import type { CompanionStore } from "./store.js";
import { FtsOrderReranker, NullVectorIndex, type Reranker, type VectorIndex } from "./stubs.js";
import type { Snippet, TurnRecord } from "./types.js";

export interface RetrieveOptions {
  query: string;
  personId?: string;
  limit: number;
  radius: number;
  vector?: VectorIndex;
  reranker?: Reranker;
}

export function retrieve(store: CompanionStore, options: RetrieveOptions): Snippet[] {
  const vector = options.vector ?? new NullVectorIndex();
  const reranker = options.reranker ?? new FtsOrderReranker();
  const pool = Math.max(options.limit * 8, options.limit);
  const hits = new Map<number, { id: number; text: string; ftsRank: number; vectorScore: number; score: number }>();

  const match = compileMatch(options.query);
  if (match) {
    for (const row of store.ftsTurns(match, options.personId, pool)) {
      const turn = store.getTurn(row.id);
      if (!turn) continue;
      hits.set(turn.id, { id: turn.id, text: turn.content, ftsRank: row.rank, vectorScore: 0, score: 0 });
    }
  }

  for (const hit of vector.search(options.query, pool)) {
    const turn = store.getTurn(hit.id);
    if (!turn) continue;
    if (options.personId !== undefined && turn.personId !== options.personId) continue;
    const existing = hits.get(turn.id);
    if (existing) existing.vectorScore = Math.max(existing.vectorScore, hit.score);
    else hits.set(turn.id, { id: turn.id, text: turn.content, ftsRank: Number.POSITIVE_INFINITY, vectorScore: hit.score, score: 0 });
  }

  const ranked = reranker.rerank(options.query, [...hits.values()]);
  const diaryHits = match ? store.ftsDiary(match, options.personId, pool) : [];
  const candidates: Array<{ kind: "turn" | "diary"; id: number; ftsRank: number; score: number }> = [
    ...ranked.map((hit) => ({ kind: "turn" as const, id: hit.id, ftsRank: hit.ftsRank, score: hit.score })),
    ...diaryHits.map((hit) => ({ kind: "diary" as const, id: hit.id, ftsRank: hit.rank, score: 0 })),
  ];
  candidates.sort((left, right) => {
    const leftRank = Number.isFinite(left.ftsRank) ? left.ftsRank : Number.POSITIVE_INFINITY;
    const rightRank = Number.isFinite(right.ftsRank) ? right.ftsRank : Number.POSITIVE_INFINITY;
    return leftRank - rightRank || right.score - left.score || left.id - right.id;
  });
  const snippets: Snippet[] = [];
  const used = new Set<number>();
  for (const hit of candidates) {
    if (snippets.length >= options.limit) break;
    if (hit.kind === "diary") {
      const entry = store.diaryEntryById(hit.id);
      if (!entry || entry.status !== "sealed") continue;
      if (options.personId !== undefined && entry.personId !== options.personId) continue;
      const events = store.diaryEvents(entry.personId).filter((event) => eventInEntry(entry, event));
      snippets.push({
        focusId: entry.id,
        score: hit.score,
        text: renderDiarySnippet(entry, events),
        turnIds: [],
        kind: "diary",
      });
      continue;
    }
    if (used.has(hit.id)) continue;
    const turn = store.getTurn(hit.id);
    if (!turn) continue;
    const window = store.turnWindow(turn.personId, turn.id, options.radius);
    for (const item of window) used.add(item.id);
    snippets.push({
      focusId: turn.id,
      score: hit.score,
      text: windowText(window),
      turnIds: window.map((item) => item.id),
      kind: "turn",
    });
  }
  return snippets;
}

function eventInEntry(entry: DiaryEntry, event: DiaryEvent): boolean {
  if (entry.layer === "day") return event.periodKey === entry.periodKey;
  if (entry.layer === "week") return weekKeyFromDay(event.periodKey) === entry.periodKey;
  return monthKeyFromDay(event.periodKey) === entry.periodKey;
}

function windowText(turns: readonly TurnRecord[]): string {
  return ["说到眼下这件事，我还记得更早的一段。", ...turns.map(speak)].join("\n");
}

function speak(turn: TurnRecord): string {
  return `${turn.role === "user" ? "你说" : "我说"}：「${turn.content}」`;
}
