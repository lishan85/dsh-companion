/**
 * Emotion rows on the companion database.
 *
 * Callers own the transaction. Statements are fixed strings; person ids and
 * notes are bound parameters.
 *
 * @module dsh-companion/emotion/persist
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  EmotionHistoryRow,
  EmotionStateRow,
  EmotionVector,
  FollowupRow,
  ProactiveRow,
} from "./types.js";

export interface HistoryInsert {
  ts: number;
  turnId: number | null;
  reason: string;
  scorer: string;
}

export interface FollowupInsert {
  turnId: number;
  createdAt: number;
  dueAt: number;
  kind: string;
  note: string;
}

export interface EmotionCommit {
  state: EmotionStateRow;
  history: HistoryInsert;
  followup?: FollowupInsert;
}

export interface OutboxInsert {
  sessionId: string;
  createdAt: number;
  dueAt: number;
  kind: "threshold" | "followup";
  dimension: string;
  followupId: number | null;
  text: string;
}

export interface ProactiveWrite {
  personId: string;
  state?: EmotionStateRow;
  history?: HistoryInsert;
  arm: readonly string[];
  reschedule: readonly { id: number; dueAt: number }[];
  enqueue: readonly OutboxInsert[];
  markFollowupsQueued: readonly number[];
}

const UPSERT_STATE = `
  INSERT INTO emotion_state (
    person_id, pleasure, arousal, dominance, happy, missing, aggrieved, worried,
    jealous, shy, angry, at_ease, intimacy, updated_at, last_user_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(person_id) DO UPDATE SET
    pleasure = excluded.pleasure,
    arousal = excluded.arousal,
    dominance = excluded.dominance,
    happy = excluded.happy,
    missing = excluded.missing,
    aggrieved = excluded.aggrieved,
    worried = excluded.worried,
    jealous = excluded.jealous,
    shy = excluded.shy,
    angry = excluded.angry,
    at_ease = excluded.at_ease,
    intimacy = excluded.intimacy,
    updated_at = excluded.updated_at,
    last_user_at = excluded.last_user_at
`;

const INSERT_HISTORY = `
  INSERT INTO emotion_history (
    person_id, ts, turn_id, reason, scorer,
    pleasure, arousal, dominance, happy, missing, aggrieved, worried,
    jealous, shy, angry, at_ease, intimacy
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function readEmotion(db: DatabaseSync, personId: string): EmotionStateRow | undefined {
  const row = db.prepare("SELECT * FROM emotion_state WHERE person_id = ?").get(personId) as Row | undefined;
  return row ? toState(row) : undefined;
}

export function listEmotionPeople(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT person_id FROM emotion_state ORDER BY person_id").all() as unknown as Row[];
  return rows.map((row) => String(row.person_id));
}

export function listEmotionHistory(db: DatabaseSync, personId: string, limit: number): EmotionHistoryRow[] {
  const rows = db.prepare(
    "SELECT * FROM emotion_history WHERE person_id = ? ORDER BY id DESC LIMIT ?",
  ).all(personId, limit) as unknown as Row[];
  return rows.map(toHistory).reverse();
}

export function listFollowups(db: DatabaseSync, personId: string): FollowupRow[] {
  const rows = db.prepare(
    "SELECT * FROM emotion_followup WHERE person_id = ? ORDER BY id",
  ).all(personId) as unknown as Row[];
  return rows.map(toFollowup);
}

export function listOutbox(db: DatabaseSync, personId: string | undefined): ProactiveRow[] {
  const rows = (personId === undefined
    ? db.prepare("SELECT * FROM proactive_outbox ORDER BY id").all()
    : db.prepare("SELECT * FROM proactive_outbox WHERE person_id = ? ORDER BY id").all(personId)) as unknown as Row[];
  return rows.map(toOutbox);
}

export function listDueOutbox(db: DatabaseSync, now: number): ProactiveRow[] {
  const rows = db.prepare(
    "SELECT * FROM proactive_outbox WHERE status = 'queued' AND due_at <= ? ORDER BY due_at, id",
  ).all(now) as unknown as Row[];
  return rows.map(toOutbox);
}

export function latchesFor(db: DatabaseSync, personId: string): Map<string, boolean> {
  const rows = db.prepare(
    "SELECT dimension, armed FROM emotion_latch WHERE person_id = ?",
  ).all(personId) as unknown as Row[];
  const map = new Map<string, boolean>();
  for (const row of rows) map.set(String(row.dimension), Number(row.armed) !== 0);
  return map;
}

export function commitEmotion(db: DatabaseSync, commit: EmotionCommit): void {
  writeState(db, commit.state);
  writeHistory(db, commit.state, commit.history);
  if (commit.followup) insertFollowup(db, commit.state.personId, commit.followup);
}

export function applyProactiveWrite(db: DatabaseSync, write: ProactiveWrite): void {
  if (write.state && write.history) {
    writeState(db, write.state);
    writeHistory(db, write.state, write.history);
  }
  for (const dimension of write.arm) {
    db.prepare(
      `INSERT INTO emotion_latch (person_id, dimension, armed) VALUES (?, ?, 1)
       ON CONFLICT(person_id, dimension) DO UPDATE SET armed = 1`,
    ).run(write.personId, dimension);
  }
  for (const change of write.reschedule) {
    db.prepare("UPDATE proactive_outbox SET due_at = ? WHERE id = ? AND status = 'queued'").run(change.dueAt, change.id);
  }
  for (const item of write.enqueue) {
    db.prepare(
      `INSERT INTO proactive_outbox (
         person_id, session_id, created_at, due_at, kind, dimension, followup_id, text, status, delivered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL)`,
    ).run(
      write.personId,
      item.sessionId,
      item.createdAt,
      item.dueAt,
      item.kind,
      item.dimension,
      item.followupId,
      item.text,
    );
  }
  for (const id of write.markFollowupsQueued) {
    db.prepare(
      "UPDATE emotion_followup SET status = 'queued' WHERE id = ? AND status = 'pending'",
    ).run(id);
  }
}

export function claimOutbox(db: DatabaseSync, id: number, now: number): boolean {
  const result = db.prepare(
    "UPDATE proactive_outbox SET status = 'delivering' WHERE id = ? AND status = 'queued' AND due_at <= ?",
  ).run(id, now);
  return result.changes === 1;
}

export function requeueOutbox(db: DatabaseSync, id: number): void {
  db.prepare(
    "UPDATE proactive_outbox SET status = 'queued', delivered_at = NULL WHERE id = ? AND status = 'delivering'",
  ).run(id);
}

export function finishOutbox(db: DatabaseSync, id: number, now: number): void {
  const row = db.prepare("SELECT * FROM proactive_outbox WHERE id = ?").get(id) as Row | undefined;
  if (!row || row.status !== "delivering") return;
  db.prepare(
    "UPDATE proactive_outbox SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'delivering'",
  ).run(now, id);
  if (row.followup_id != null) {
    db.prepare("UPDATE emotion_followup SET status = 'delivered' WHERE id = ?").run(Number(row.followup_id));
  }
  if (row.kind === "threshold" && typeof row.dimension === "string" && row.dimension.length > 0) {
    db.prepare(
      `INSERT INTO emotion_latch (person_id, dimension, armed) VALUES (?, ?, 0)
       ON CONFLICT(person_id, dimension) DO UPDATE SET armed = 0`,
    ).run(String(row.person_id), String(row.dimension));
  }
}

export function requeueDelivering(db: DatabaseSync): void {
  db.prepare(
    "UPDATE proactive_outbox SET status = 'queued', delivered_at = NULL WHERE status = 'delivering'",
  ).run();
}

export function relinkEmotionRows(db: DatabaseSync, from: string, to: string): void {
  if (from === to) return;
  const target = db.prepare("SELECT person_id FROM emotion_state WHERE person_id = ?").get(to) as Row | undefined;
  if (target) db.prepare("DELETE FROM emotion_state WHERE person_id = ?").run(from);
  else db.prepare("UPDATE emotion_state SET person_id = ? WHERE person_id = ?").run(to, from);
  const dims = db.prepare("SELECT dimension FROM emotion_latch WHERE person_id = ?").all(to) as unknown as Row[];
  for (const row of dims) {
    db.prepare("DELETE FROM emotion_latch WHERE person_id = ? AND dimension = ?").run(from, String(row.dimension));
  }
  db.prepare("UPDATE emotion_latch SET person_id = ? WHERE person_id = ?").run(to, from);
  db.prepare("UPDATE emotion_history SET person_id = ? WHERE person_id = ?").run(to, from);
  db.prepare("UPDATE emotion_followup SET person_id = ? WHERE person_id = ?").run(to, from);
  db.prepare("UPDATE proactive_outbox SET person_id = ? WHERE person_id = ?").run(to, from);
}

function writeState(db: DatabaseSync, state: EmotionStateRow): void {
  const vector = state.vector;
  db.prepare(UPSERT_STATE).run(
    state.personId,
    vector.pleasure, vector.arousal, vector.dominance, vector.happy, vector.missing, vector.aggrieved,
    vector.worried, vector.jealous, vector.shy, vector.angry, vector.atEase, vector.intimacy,
    state.updatedAt, state.lastUserAt,
  );
}

function writeHistory(db: DatabaseSync, state: EmotionStateRow, history: HistoryInsert): void {
  const vector = state.vector;
  db.prepare(INSERT_HISTORY).run(
    state.personId, history.ts, history.turnId, history.reason, history.scorer,
    vector.pleasure, vector.arousal, vector.dominance, vector.happy, vector.missing, vector.aggrieved,
    vector.worried, vector.jealous, vector.shy, vector.angry, vector.atEase, vector.intimacy,
  );
}

function insertFollowup(db: DatabaseSync, personId: string, followup: FollowupInsert): void {
  db.prepare(
    `INSERT OR IGNORE INTO emotion_followup (
       person_id, turn_id, created_at, due_at, kind, note, status
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(personId, followup.turnId, followup.createdAt, followup.dueAt, followup.kind, followup.note);
}

type Row = Record<string, unknown>;

function toState(row: Row): EmotionStateRow {
  return {
    personId: String(row.person_id),
    vector: vectorOf(row),
    updatedAt: Number(row.updated_at),
    lastUserAt: row.last_user_at == null ? null : Number(row.last_user_at),
  };
}

function toHistory(row: Row): EmotionHistoryRow {
  return {
    id: Number(row.id),
    personId: String(row.person_id),
    ts: Number(row.ts),
    turnId: row.turn_id == null ? null : Number(row.turn_id),
    reason: String(row.reason),
    scorer: String(row.scorer),
    vector: vectorOf(row),
  };
}

function toFollowup(row: Row): FollowupRow {
  return {
    id: Number(row.id),
    personId: String(row.person_id),
    turnId: row.turn_id == null ? null : Number(row.turn_id),
    createdAt: Number(row.created_at),
    dueAt: Number(row.due_at),
    kind: String(row.kind),
    note: String(row.note),
    status: String(row.status),
  };
}

function toOutbox(row: Row): ProactiveRow {
  const kind = row.kind === "followup" ? "followup" : "threshold";
  return {
    id: Number(row.id),
    personId: String(row.person_id),
    sessionId: String(row.session_id ?? ""),
    createdAt: Number(row.created_at),
    dueAt: Number(row.due_at),
    kind,
    dimension: String(row.dimension ?? ""),
    followupId: row.followup_id == null ? null : Number(row.followup_id),
    text: String(row.text),
    status: String(row.status),
    deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
  };
}

function vectorOf(row: Row): EmotionVector {
  return {
    pleasure: Number(row.pleasure),
    arousal: Number(row.arousal),
    dominance: Number(row.dominance),
    happy: Number(row.happy),
    missing: Number(row.missing),
    aggrieved: Number(row.aggrieved),
    worried: Number(row.worried),
    jealous: Number(row.jealous),
    shy: Number(row.shy),
    angry: Number(row.angry),
    atEase: Number(row.at_ease),
    intimacy: Number(row.intimacy),
  };
}
