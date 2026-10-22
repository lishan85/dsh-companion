/**
 * Companion schema, version 1.
 *
 * Version 1 is the raw transcript, its FTS index, and the identity map.
 * Later slices append a step to {@link MIGRATIONS} (emotion, diary, vectors).
 * A newer, foreign, or malformed file is refused on a read-only look and is
 * not opened for write.
 *
 * @module dsh-companion/schema
 */

import type { DatabaseSync } from "node:sqlite";
import { CompanionError } from "./errors.js";

export const PRODUCT = "dsh-companion";
export const SCHEMA_VERSION = 1;
export const FTS_TOKEN_VERSION = 1;

export interface MigrationStep {
  version: number;
  /** Stable name so later PRs can point at a step. */
  name: string;
  up: (db: DatabaseSync) => void;
}

const TURN_COLUMNS = [
  "id", "channel", "user_id", "chat_id", "session_id", "bridge", "person_id",
  "ts", "role", "content", "turn_no",
] as const;

const V1_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    chat_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    bridge TEXT NOT NULL DEFAULT '',
    person_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    turn_no INTEGER
  );
  CREATE INDEX IF NOT EXISTS turns_person_recent ON turns (person_id, id DESC);
  CREATE INDEX IF NOT EXISTS turns_session ON turns (session_id, id);
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    content,
    tokenize = 'unicode61'
  );
  CREATE TABLE IF NOT EXISTS identities (
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (platform, platform_user_id)
  );
  CREATE INDEX IF NOT EXISTS identities_person ON identities (person_id);
`;

const ALLOWED = new Set<string>([
  "meta", "turns", "turns_fts", "identities",
  "turns_person_recent", "turns_session", "identities_person",
  "turns_fts_data", "turns_fts_idx", "turns_fts_content", "turns_fts_docsize", "turns_fts_config",
]);

export const MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, name: "core-turns-identity-fts", up: applyCore },
];

export type SchemaClassification =
  | { kind: "empty" }
  | { kind: "current" }
  | { kind: "legacy"; from: number }
  | { kind: "unsupported"; reason: string };

export function classifySchema(db: DatabaseSync): SchemaClassification {
  const names = objectNames(db);
  if (names.length === 0) return { kind: "empty" };
  if (!names.includes("meta")) {
    return { kind: "unsupported", reason: "dsh-companion: existing database has no companion metadata; refusing to modify it" };
  }
  let product: unknown;
  let versionRaw: unknown;
  try {
    product = meta(db, "product");
    versionRaw = meta(db, "schema_version");
  } catch {
    return { kind: "unsupported", reason: "dsh-companion: existing meta table is not readable; refusing to modify it" };
  }
  if (product !== PRODUCT) {
    return { kind: "unsupported", reason: "dsh-companion: existing database is not a companion store; refusing to modify it" };
  }
  if (typeof versionRaw !== "string" || !/^[1-9]\d*$/.test(versionRaw)) {
    return { kind: "unsupported", reason: "dsh-companion: schema_version is missing or not a canonical integer" };
  }
  const version = Number(versionRaw);
  if (!Number.isSafeInteger(version)) {
    return { kind: "unsupported", reason: "dsh-companion: schema_version is outside the safe integer range" };
  }
  if (version > SCHEMA_VERSION) {
    return { kind: "unsupported", reason: `dsh-companion: database schema ${versionRaw} is newer than supported ${SCHEMA_VERSION}` };
  }
  const foreign = names.filter((name) => !ALLOWED.has(name));
  if (foreign.length > 0) {
    return { kind: "unsupported", reason: `dsh-companion: unrecognized object ${foreign[0]}; refusing to modify an unknown schema` };
  }
  const problem = coreProblem(db);
  if (problem) return { kind: "unsupported", reason: problem };
  if (version < SCHEMA_VERSION) return { kind: "legacy", from: version };
  return { kind: "current" };
}

/** Apply every step newer than `from`. `from` 0 means an empty database. */
export function migrateSchema(db: DatabaseSync, from: number): void {
  if (from > SCHEMA_VERSION) {
    throw new CompanionError("schema", `dsh-companion: cannot migrate from newer schema ${from}`);
  }
  for (const step of MIGRATIONS) {
    if (step.version <= from) continue;
    step.up(db);
    stamp(db, step.version);
  }
  const problem = coreProblem(db);
  if (problem) throw new CompanionError("schema", problem);
}

function applyCore(db: DatabaseSync): void {
  db.exec(V1_SQL);
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('product', ?) ON CONFLICT(key) DO NOTHING",
  ).run(PRODUCT);
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('fts_token_version', ?) ON CONFLICT(key) DO NOTHING",
  ).run(String(FTS_TOKEN_VERSION));
}

function stamp(db: DatabaseSync, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(version));
}

function coreProblem(db: DatabaseSync): string | undefined {
  if (!sameColumns(db, "turns", TURN_COLUMNS)) return "dsh-companion: turns table does not match the expected columns";
  if (!hasColumns(db, "identities", ["platform", "platform_user_id", "person_id", "created_at"])) {
    return "dsh-companion: identities table does not match the expected columns";
  }
  if (!ftsOk(db, "turns_fts")) return "dsh-companion: turns_fts is not the expected fts5 content index";
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM turns WHERE
       typeof(content) != 'text' OR typeof(person_id) != 'text' OR person_id = ''
       OR role NOT IN ('user', 'assistant')
       OR typeof(ts) != 'integer' OR ts < 0 OR ts > 9007199254740991`,
  ).get() as { n: number } | undefined;
  if ((row?.n ?? 0) > 0) {
    return `dsh-companion: ${row?.n} malformed turn row(s); refusing to read or modify an unknown state`;
  }
  return undefined;
}

function ftsOk(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name = ?").get(name) as
    | { type: string; sql: string | null }
    | undefined;
  if (!row || row.type !== "table" || !row.sql) return false;
  const columns = columnNames(db, name);
  if (columns.length !== 1 || columns[0] !== "content") return false;
  const sql = row.sql.toLowerCase().replaceAll(/\s+/g, " ");
  return sql.includes("using fts5") && sql.includes("tokenize") && sql.includes("unicode61") &&
    !sql.includes("unindexed") && !sql.includes("content=") && !sql.includes("content_rowid");
}

function sameColumns(db: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const names = columnNames(db, table);
  return names.length === expected.length && expected.every((name, index) => names[index] === name);
}

function hasColumns(db: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const names = new Set(columnNames(db, table));
  return expected.every((name) => names.has(name)) && names.size === expected.length;
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((column) => column.name);
}

function objectNames(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
  ).all() as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function meta(db: DatabaseSync, key: string): unknown {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: unknown } | undefined;
  return row?.value;
}
