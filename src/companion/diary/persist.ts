/**
 * Diary rows on the companion database.
 *
 * Callers own the transaction. Statements are fixed strings. Prose and person
 * ids are bound parameters. A sealed page and its FTS row commit together.
 *
 * @module dsh-companion/diary/persist
 */

import type { DatabaseSync } from "node:sqlite";
import { joinTokens, tokenize } from "../../tokenize.js";
import type { TurnRole } from "../types.js";
import type { DiaryClaim, DiaryEntry, DiaryEvent, DiaryLayer, DiarySource } from "./types.js";

const STALE_MS = 60_000;

export interface DiaryClaimInput {
  personId: string;
  layer: DiaryLayer;
  periodKey: string;
  now: number;
}

export interface DiarySealInput {
  personId: string;
  layer: DiaryLayer;
  periodKey: string;
  text: string;
  source: Exclude<DiarySource, "pending">;
  now: number;
}

export interface DiaryEventInput {
  personId: string;
  turnId: number;
  ts: number;
  periodKey: string;
  role: TurnRole;
  kind: string;
  verbatim: string;
}

export function listDiaryEntries(db: DatabaseSync, personId: string | undefined): DiaryEntry[] {
  const rows = (personId === undefined
    ? db.prepare("SELECT * FROM diary_entry ORDER BY id").all()
    : db.prepare("SELECT * FROM diary_entry WHERE person_id = ? ORDER BY id").all(personId)) as unknown as Row[];
  return rows.map(toEntry);
}

export function readDiaryEntry(
  db: DatabaseSync,
  personId: string,
  layer: DiaryLayer,
  periodKey: string,
): DiaryEntry | undefined {
  const row = db.prepare(
    "SELECT * FROM diary_entry WHERE person_id = ? AND layer = ? AND period_key = ?",
  ).get(personId, layer, periodKey) as Row | undefined;
  return row ? toEntry(row) : undefined;
}

export function readDiaryEntryById(db: DatabaseSync, id: number): DiaryEntry | undefined {
  const row = db.prepare("SELECT * FROM diary_entry WHERE id = ?").get(id) as Row | undefined;
  return row ? toEntry(row) : undefined;
}

export function listDiaryEvents(db: DatabaseSync, personId: string): DiaryEvent[] {
  const rows = db.prepare(
    "SELECT * FROM diary_event WHERE person_id = ? ORDER BY ts, id",
  ).all(personId) as unknown as Row[];
  return rows.map(toEvent);
}

export function claimDiary(db: DatabaseSync, input: DiaryClaimInput): DiaryClaim {
  const existing = db.prepare(
    "SELECT status, updated_at FROM diary_entry WHERE person_id = ? AND layer = ? AND period_key = ?",
  ).get(input.personId, input.layer, input.periodKey) as Row | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO diary_entry (
         person_id, layer, period_key, text, source, status, created_at, updated_at
       ) VALUES (?, ?, ?, '', 'pending', 'sealing', ?, ?)`,
    ).run(input.personId, input.layer, input.periodKey, input.now, input.now);
    return "owned";
  }
  if (existing.status === "sealed") return "sealed";
  const updatedAt = Number(existing.updated_at);
  if (existing.status === "sealing" && input.now >= updatedAt && input.now - updatedAt < STALE_MS) return "busy";
  db.prepare(
    `UPDATE diary_entry SET updated_at = ?
     WHERE person_id = ? AND layer = ? AND period_key = ? AND status = 'sealing'`,
  ).run(input.now, input.personId, input.layer, input.periodKey);
  return "owned";
}

export function sealDiary(db: DatabaseSync, input: DiarySealInput): boolean {
  const result = db.prepare(
    `UPDATE diary_entry
     SET text = ?, source = ?, status = 'sealed', updated_at = ?
     WHERE person_id = ? AND layer = ? AND period_key = ? AND status = 'sealing'`,
  ).run(input.text, input.source, input.now, input.personId, input.layer, input.periodKey);
  if (result.changes !== 1) return false;
  const row = db.prepare(
    "SELECT id FROM diary_entry WHERE person_id = ? AND layer = ? AND period_key = ?",
  ).get(input.personId, input.layer, input.periodKey) as { id: number } | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM diary_fts WHERE rowid = ?").run(row.id);
  db.prepare("INSERT INTO diary_fts (rowid, content) VALUES (?, ?)").run(row.id, joinTokens(tokenize(input.text)));
  return true;
}

export function releaseDiary(db: DatabaseSync, personId: string, layer: DiaryLayer, periodKey: string): void {
  db.prepare(
    "DELETE FROM diary_entry WHERE person_id = ? AND layer = ? AND period_key = ? AND status = 'sealing'",
  ).run(personId, layer, periodKey);
}

export function insertDiaryEvent(db: DatabaseSync, input: DiaryEventInput): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO diary_event (
       person_id, turn_id, ts, period_key, role, kind, verbatim
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.personId, input.turnId, input.ts, input.periodKey, input.role, input.kind, input.verbatim);
  return result.changes === 1;
}

export function diaryFts(
  db: DatabaseSync,
  match: string,
  personId: string | undefined,
  limit: number,
): Array<{ id: number; rank: number }> {
  const sql = personId === undefined
    ? `SELECT diary_entry.id AS id, diary_fts.rank AS rank
       FROM diary_fts JOIN diary_entry ON diary_entry.id = diary_fts.rowid
       WHERE diary_fts MATCH ? AND diary_entry.status = 'sealed'
       ORDER BY diary_fts.rank, diary_entry.id LIMIT ?`
    : `SELECT diary_entry.id AS id, diary_fts.rank AS rank
       FROM diary_fts JOIN diary_entry ON diary_entry.id = diary_fts.rowid
       WHERE diary_fts MATCH ? AND diary_entry.person_id = ? AND diary_entry.status = 'sealed'
       ORDER BY diary_fts.rank, diary_entry.id LIMIT ?`;
  return (personId === undefined
    ? db.prepare(sql).all(match, limit)
    : db.prepare(sql).all(match, personId, limit)) as unknown as Array<{ id: number; rank: number }>;
}

export function relinkDiaryRows(db: DatabaseSync, from: string, to: string): void {
  if (from === to) return;
  const sources = db.prepare(
    "SELECT id, layer, period_key, status FROM diary_entry WHERE person_id = ?",
  ).all(from) as unknown as Row[];
  for (const source of sources) {
    const target = db.prepare(
      "SELECT id, status FROM diary_entry WHERE person_id = ? AND layer = ? AND period_key = ?",
    ).get(to, String(source.layer), String(source.period_key)) as Row | undefined;
    if (!target) {
      db.prepare("UPDATE diary_entry SET person_id = ? WHERE id = ?").run(to, Number(source.id));
      continue;
    }
    const sourceSealed = source.status === "sealed";
    const targetSealed = target.status === "sealed";
    if (sourceSealed && !targetSealed) {
      db.prepare("DELETE FROM diary_fts WHERE rowid = ?").run(Number(target.id));
      db.prepare("DELETE FROM diary_entry WHERE id = ?").run(Number(target.id));
      db.prepare("UPDATE diary_entry SET person_id = ? WHERE id = ?").run(to, Number(source.id));
      continue;
    }
    db.prepare("DELETE FROM diary_fts WHERE rowid = ?").run(Number(source.id));
    db.prepare("DELETE FROM diary_entry WHERE id = ?").run(Number(source.id));
  }
  db.prepare("UPDATE diary_event SET person_id = ? WHERE person_id = ?").run(to, from);
}

type Row = Record<string, unknown>;

function toEntry(row: Row): DiaryEntry {
  const layer: DiaryLayer = row.layer === "week" || row.layer === "month" ? row.layer : "day";
  const source: DiarySource = row.source === "model" || row.source === "fallback" ? row.source : "pending";
  const status = row.status === "sealed" ? "sealed" : "sealing";
  return {
    id: Number(row.id),
    personId: String(row.person_id),
    layer,
    periodKey: String(row.period_key),
    text: String(row.text ?? ""),
    source,
    status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toEvent(row: Row): DiaryEvent {
  const role: TurnRole = row.role === "assistant" ? "assistant" : "user";
  return {
    id: Number(row.id),
    personId: String(row.person_id),
    turnId: Number(row.turn_id),
    ts: Number(row.ts),
    periodKey: String(row.period_key),
    role,
    kind: String(row.kind),
    verbatim: String(row.verbatim),
  };
}
