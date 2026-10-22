/**
 * FTS5 retrieval over raw turns, sealed diary pages, and her wander experiences.
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
import {
  FtsOrderReranker,
  NullVectorIndex,
  type RerankContext,
  type RerankHit,
  type Reranker,
  type RetrievalKind,
  type VectorIndex,
} from "./stubs.js";
import type { Snippet, TurnRecord } from "./types.js";
import { renderExperienceSnippet } from "./wander.js";

export interface RetrieveOptions {
  query: string;
  personId?: string;
  limit: number;
  radius: number;
  now?: number;
  vector?: VectorIndex;
  reranker?: Reranker;
  signal?: AbortSignal;
}

export function retrieve(store: CompanionStore, options: RetrieveOptions): Snippet[] {
  const prepared = collect(store, options);
  return materialize(store, options, prepared.reranker.rerank(options.query, prepared.hits, prepared.context));
}

/** Embed the query, let an optional reranker prepare, then rank inside the same budget. */
export async function retrieveReady(store: CompanionStore, options: RetrieveOptions): Promise<Snippet[]> {
  const vector: VectorIndex = options.vector ?? new NullVectorIndex();
  await vector.prepareQuery?.(options.query, options.signal);
  const prepared = collect(store, { ...options, vector });
  await prepared.reranker.prepare?.(options.query, prepared.hits, prepared.context, options.signal);
  return materialize(store, options, prepared.reranker.rerank(options.query, prepared.hits, prepared.context));
}

function collect(store: CompanionStore, options: RetrieveOptions): {
  hits: RerankHit[];
  reranker: Reranker;
  context: RerankContext;
} {
  const vector = options.vector ?? new NullVectorIndex();
  const reranker = options.reranker ?? new FtsOrderReranker();
  const pool = Math.max(options.limit * 8, options.limit);
  const hits = new Map<string, RerankHit>();
  const match = compileMatch(options.query);

  if (match) {
    for (const row of store.ftsTurns(match, options.personId, pool)) {
      const turn = store.getTurn(row.id);
      if (!turn) continue;
      hits.set(key("turn", turn.id), hitFromTurn(turn, row.rank, 0));
    }
    for (const row of store.ftsDiary(match, options.personId, pool)) {
      const entry = store.diaryEntryById(row.id);
      if (!entry || entry.status !== "sealed") continue;
      hits.set(key("diary", entry.id), hitFromDiary(entry, row.rank, 0));
    }
    for (const row of store.ftsExperiences(match, pool)) {
      const experience = store.getExperience(row.id);
      if (!experience) continue;
      hits.set(key("experience", experience.id), hitFromExperience(experience, row.rank, 0));
    }
  }

  for (const found of vector.search(options.query, pool)) {
    const kind = found.kind ?? "turn";
    if (kind === "turn") {
      const turn = store.getTurn(found.id);
      if (!turn) continue;
      if (options.personId !== undefined && turn.personId !== options.personId) continue;
      merge(hits, key("turn", turn.id), hitFromTurn(turn, Number.POSITIVE_INFINITY, found.score));
    } else if (kind === "diary") {
      const entry = store.diaryEntryById(found.id);
      if (!entry || entry.status !== "sealed") continue;
      if (options.personId !== undefined && entry.personId !== options.personId) continue;
      merge(hits, key("diary", entry.id), hitFromDiary(entry, Number.POSITIVE_INFINITY, found.score));
    } else {
      const experience = store.getExperience(found.id);
      if (!experience) continue;
      merge(hits, key("experience", experience.id), hitFromExperience(experience, Number.POSITIVE_INFINITY, found.score));
    }
  }

  const context: RerankContext = { now: options.now ?? Date.now() };
  if (options.personId !== undefined) context.personId = options.personId;
  return { hits: [...hits.values()], reranker, context };
}

function materialize(store: CompanionStore, options: RetrieveOptions, ranked: readonly RerankHit[]): Snippet[] {
  const snippets: Snippet[] = [];
  const used = new Set<number>();
  for (const hit of ranked) {
    if (snippets.length >= options.limit) break;
    const kind = hit.kind ?? "turn";
    if (kind === "diary") {
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
    if (kind === "experience") {
      const experience = store.getExperience(hit.id);
      if (!experience) continue;
      snippets.push({
        focusId: experience.id,
        score: hit.score,
        text: renderExperienceSnippet(experience),
        turnIds: [],
        kind: "experience",
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

function merge(hits: Map<string, RerankHit>, id: string, incoming: RerankHit): void {
  const existing = hits.get(id);
  if (!existing) {
    hits.set(id, incoming);
    return;
  }
  if (Number.isFinite(incoming.ftsRank)) existing.ftsRank = Math.min(existing.ftsRank, incoming.ftsRank);
  existing.vectorScore = Math.max(existing.vectorScore, incoming.vectorScore);
}

function hitFromTurn(turn: TurnRecord, ftsRank: number, vectorScore: number): RerankHit {
  return {
    id: turn.id,
    text: turn.content,
    ftsRank,
    vectorScore,
    score: 0,
    kind: "turn",
    ts: turn.ts,
    personId: turn.personId,
    topics: [],
  };
}

function hitFromDiary(entry: DiaryEntry, ftsRank: number, vectorScore: number): RerankHit {
  return {
    id: entry.id,
    text: entry.text,
    ftsRank,
    vectorScore,
    score: 0,
    kind: "diary",
    ts: entry.updatedAt,
    personId: entry.personId,
    topics: [],
  };
}

function hitFromExperience(record: { id: number; content: string; ts: number; personId: string; topics: readonly string[] }, ftsRank: number, vectorScore: number): RerankHit {
  return {
    id: record.id,
    text: record.content,
    ftsRank,
    vectorScore,
    score: 0,
    kind: "experience",
    ts: record.ts,
    personId: record.personId,
    topics: record.topics,
  };
}

function key(kind: RetrievalKind, id: number): string {
  return `${kind}:${id}`;
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
