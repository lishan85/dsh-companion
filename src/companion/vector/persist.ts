/**
 * Vector rows and the optional sqlite-vec mirror.
 *
 * The blob column is the portable copy. sqlite-vec is a derived index: it is
 * created only after the extension loads, and a database that has never loaded
 * it is still a valid schema 4 store. Callers own the transaction except for
 * the helpers that are documented as running their own statements.
 *
 * @module dsh-companion/vector/persist
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { joinTokens, tokenize } from "../../tokenize.js";
import type {
  CorpusRow,
  EmbeddingState,
  ExperienceInput,
  ExperienceRecord,
  ExperienceWrite,
  StoredVector,
  VectorNeighbor,
} from "./types.js";

const require = createRequire(import.meta.url);

export function tryLoadSqliteVec(db: DatabaseSync): boolean {
  try {
    const sqliteVec = require("sqlite-vec") as { load(database: { loadExtension(file: string): void }): void };
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

export function ensureVecTable(db: DatabaseSync, dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 4096) {
    throw new Error("dsh-companion: vector index dimensions must be an integer from 8 to 4096");
  }
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'embeddings_vec'").get() as { sql: string | null } | undefined;
  const wanted = `float[${dimensions}]`;
  if (row?.sql && row.sql.includes(wanted) && row.sql.toLowerCase().includes("vec0")) return;
  if (row) db.exec("DROP TABLE IF EXISTS embeddings_vec");
  db.exec(`CREATE VIRTUAL TABLE embeddings_vec USING vec0(embedding float[${dimensions}] distance_metric=cosine)`);
}

export function vecStamp(model: string, dimensions: number, count: number, totalTime: number): string {
  return `${model}\t${dimensions}\t${count}\t${totalTime}`;
}

export function readVecStamp(db: DatabaseSync): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'vec_index_stamp'").get() as { value: string } | undefined;
  return row?.value;
}

export function writeVecStamp(db: DatabaseSync, stamp: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('vec_index_stamp', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(stamp);
}

export function embeddingCensus(db: DatabaseSync, model: string, dimensions: number): { count: number; totalTime: number } {
  const row = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(embedded_at), 0) AS s FROM embeddings WHERE model = ? AND dim = ?",
  ).get(model, dimensions) as { n: number; s: number } | undefined;
  return { count: row?.n ?? 0, totalTime: Number(row?.s ?? 0) };
}

export function rebuildVec(db: DatabaseSync, model: string, dimensions: number): void {
  db.exec("DELETE FROM embeddings_vec");
  const rows = db.prepare(
    "SELECT id, vector FROM embeddings WHERE model = ? AND dim = ? ORDER BY id",
  ).all(model, dimensions) as unknown as Array<{ id: number; vector: Buffer }>;
  const insert = db.prepare("INSERT INTO embeddings_vec(rowid, embedding) VALUES (?, ?)");
  for (const row of rows) insert.run(BigInt(row.id), row.vector);
  const census = embeddingCensus(db, model, dimensions);
  writeVecStamp(db, vecStamp(model, dimensions, census.count, census.totalTime));
}

export function corpus(db: DatabaseSync): CorpusRow[] {
  const turns = db.prepare(
    "SELECT id, person_id, ts, content FROM turns ORDER BY id",
  ).all() as unknown as Array<{ id: number; person_id: string; ts: number; content: string }>;
  const pages = db.prepare(
    "SELECT id, person_id, updated_at, text FROM diary_entry WHERE status = 'sealed' AND text != '' ORDER BY id",
  ).all() as unknown as Array<{ id: number; person_id: string; updated_at: number; text: string }>;
  const trips = db.prepare(
    "SELECT id, person_id, ts, content, topics FROM experiences ORDER BY id",
  ).all() as unknown as Array<{ id: number; person_id: string; ts: number; content: string; topics: string }>;
  return [
    ...turns.map((row) => ({ source: "turn" as const, id: row.id, personId: row.person_id, ts: row.ts, text: row.content, topics: [] })),
    ...pages.map((row) => ({ source: "diary" as const, id: row.id, personId: row.person_id, ts: row.updated_at, text: row.text, topics: [] })),
    ...trips.map((row) => ({
      source: "experience" as const,
      id: row.id,
      personId: row.person_id,
      ts: row.ts,
      text: row.content,
      topics: splitTopics(row.topics),
    })),
  ];
}

export function embeddingStates(db: DatabaseSync, model: string): EmbeddingState[] {
  const rows = db.prepare(
    "SELECT source, source_id, text_hash, dim FROM embeddings WHERE model = ?",
  ).all(model) as unknown as Array<{ source: EmbeddingState["source"]; source_id: number; text_hash: string; dim: number }>;
  return rows.map((row) => ({ source: row.source, sourceId: row.source_id, textHash: row.text_hash, dim: row.dim }));
}

export function saveEmbedding(
  db: DatabaseSync,
  input: { source: CorpusRow["source"]; sourceId: number; model: string; dim: number; textHash: string; embeddedAt: number; vector: Buffer },
  mirror: boolean,
): number {
  const row = db.prepare(
    `INSERT INTO embeddings (source, source_id, model, dim, text_hash, embedded_at, vector)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_id, model) DO UPDATE SET
       dim = excluded.dim,
       text_hash = excluded.text_hash,
       embedded_at = excluded.embedded_at,
       vector = excluded.vector
     RETURNING id`,
  ).get(input.source, input.sourceId, input.model, input.dim, input.textHash, input.embeddedAt, input.vector) as { id: number } | undefined;
  if (!row) throw new Error("dsh-companion: embedding row was not stored");
  if (mirror) {
    db.prepare("DELETE FROM embeddings_vec WHERE rowid = ?").run(BigInt(row.id));
    db.prepare("INSERT INTO embeddings_vec(rowid, embedding) VALUES (?, ?)").run(BigInt(row.id), input.vector);
  }
  return row.id;
}

export function listVectors(db: DatabaseSync, model: string, dimensions: number): StoredVector[] {
  const rows = db.prepare(
    "SELECT source, source_id, vector FROM embeddings WHERE model = ? AND dim = ?",
  ).all(model, dimensions) as unknown as Array<{ source: StoredVector["source"]; source_id: number; vector: Buffer }>;
  return rows.map((row) => ({ source: row.source, sourceId: row.source_id, vector: row.vector }));
}

export function knnVectors(db: DatabaseSync, model: string, dimensions: number, vector: Buffer, k: number): VectorNeighbor[] {
  const rows = db.prepare(
    `SELECT e.source AS source, e.source_id AS source_id, v.distance AS distance
     FROM (
       SELECT rowid, distance FROM embeddings_vec WHERE embedding MATCH ? AND k = ?
     ) AS v
     JOIN embeddings e ON e.id = v.rowid
     WHERE e.model = ? AND e.dim = ?`,
  ).all(vector, k, model, dimensions) as unknown as Array<{ source: VectorNeighbor["source"]; source_id: number; distance: number }>;
  return rows.map((row) => ({ source: row.source, sourceId: row.source_id, distance: row.distance }));
}

export function writeExperience(db: DatabaseSync, input: ExperienceInput): ExperienceWrite {
  const topics = input.topics.join(" ");
  const existing = db.prepare("SELECT * FROM experiences WHERE external_id = ?").get(input.externalId) as Row | undefined;
  if (existing) {
    const same = existing.content === input.content
      && existing.topics === topics
      && existing.place_id === input.placeId
      && existing.place_name === input.placeName
      && existing.attribution === input.attribution
      && existing.license === input.license
      && existing.description_mode === input.descriptionMode
      && existing.emotion_hint === input.emotionHint
      && Number(existing.ts) === input.ts;
    if (same) return { status: "unchanged" };
    const id = Number(existing.id);
    db.prepare(
      `UPDATE experiences
       SET ts = ?, content = ?, topics = ?, place_id = ?, place_name = ?,
           attribution = ?, license = ?, description_mode = ?, emotion_hint = ?
       WHERE id = ?`,
    ).run(
      input.ts, input.content, topics, input.placeId, input.placeName,
      input.attribution, input.license, input.descriptionMode, input.emotionHint, id,
    );
    db.prepare("DELETE FROM experiences_fts WHERE rowid = ?").run(id);
    db.prepare("INSERT INTO experiences_fts (rowid, content) VALUES (?, ?)").run(id, joinTokens(tokenize(input.content)));
    const updated = db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Row | undefined;
    if (!updated) throw new Error("dsh-companion: experience row disappeared after update");
    return { status: "updated", record: toExperience(updated) };
  }
  const result = db.prepare(
    `INSERT INTO experiences (
       external_id, person_id, source, kind, ts, content, topics,
       place_id, place_name, attribution, license, description_mode, emotion_hint
     ) VALUES (?, ?, 'dsh-wander', 'travel', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.externalId, input.personId, input.ts, input.content, topics,
    input.placeId, input.placeName, input.attribution, input.license, input.descriptionMode, input.emotionHint,
  );
  const id = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO experiences_fts (rowid, content) VALUES (?, ?)").run(id, joinTokens(tokenize(input.content)));
  const created = db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Row | undefined;
  if (!created) throw new Error("dsh-companion: experience row disappeared after insert");
  return { status: "inserted", record: toExperience(created) };
}

export function readExperience(db: DatabaseSync, id: number): ExperienceRecord | undefined {
  const row = db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Row | undefined;
  return row ? toExperience(row) : undefined;
}

export function experienceFts(db: DatabaseSync, match: string, limit: number): Array<{ id: number; rank: number }> {
  return db.prepare(
    `SELECT experiences.id AS id, experiences_fts.rank AS rank
     FROM experiences_fts JOIN experiences ON experiences.id = experiences_fts.rowid
     WHERE experiences_fts MATCH ?
     ORDER BY experiences_fts.rank, experiences.id
     LIMIT ?`,
  ).all(match, limit) as unknown as Array<{ id: number; rank: number }>;
}

export function rebuildExperienceFts(db: DatabaseSync): void {
  db.exec("DELETE FROM experiences_fts");
  const rows = db.prepare("SELECT id, content FROM experiences ORDER BY id").all() as unknown as Array<{ id: number; content: string }>;
  const insert = db.prepare("INSERT INTO experiences_fts (rowid, content) VALUES (?, ?)");
  for (const row of rows) insert.run(row.id, joinTokens(tokenize(row.content)));
}

type Row = Record<string, unknown>;

function toExperience(row: Row): ExperienceRecord {
  const mode = row.description_mode === "metadata" || row.description_mode === "vision" ? row.description_mode : "";
  return {
    id: Number(row.id),
    externalId: String(row.external_id),
    personId: String(row.person_id),
    source: "dsh-wander",
    kind: "travel",
    ts: Number(row.ts),
    content: String(row.content),
    topics: splitTopics(String(row.topics ?? "")),
    placeId: String(row.place_id ?? ""),
    placeName: String(row.place_name ?? ""),
    attribution: String(row.attribution ?? ""),
    license: String(row.license ?? ""),
    descriptionMode: mode,
    emotionHint: String(row.emotion_hint ?? ""),
  };
}

function splitTopics(value: string): string[] {
  return value.split(/\s+/).map((item) => item.trim()).filter((item) => item.length > 0);
}
