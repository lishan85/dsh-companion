/**
 * Companion schema, version 2.
 *
 * Version 1 is the raw transcript, its FTS index, and the identity map.
 * Version 2 adds the emotion vector, its history, follow-ups, and the
 * proactive outbox. Later slices append a step to {@link MIGRATIONS}
 * (diary, vectors). A newer, foreign, or malformed file is refused on a
 * read-only look and is not opened for write.
 *
 * @module dsh-companion/schema
 */

import type { DatabaseSync } from "node:sqlite";
import { CompanionError } from "./errors.js";

export const PRODUCT = "dsh-companion";
export const SCHEMA_VERSION = 2;
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

const EMOTION_STATE_COLUMNS = [
  "person_id", "pleasure", "arousal", "dominance", "happy", "missing", "aggrieved",
  "worried", "jealous", "shy", "angry", "at_ease", "intimacy", "updated_at", "last_user_at",
] as const;

const EMOTION_HISTORY_COLUMNS = [
  "id", "person_id", "ts", "turn_id", "reason", "scorer",
  "pleasure", "arousal", "dominance", "happy", "missing", "aggrieved",
  "worried", "jealous", "shy", "angry", "at_ease", "intimacy",
] as const;

const FOLLOWUP_COLUMNS = [
  "id", "person_id", "turn_id", "created_at", "due_at", "kind", "note", "status",
] as const;

const LATCH_COLUMNS = ["person_id", "dimension", "armed"] as const;

const OUTBOX_COLUMNS = [
  "id", "person_id", "session_id", "created_at", "due_at", "kind", "dimension",
  "followup_id", "text", "status", "delivered_at",
] as const;

const EMOTION_OBJECTS = [
  "emotion_state", "emotion_history", "emotion_history_person",
  "emotion_followup", "emotion_followup_due", "emotion_followup_turn",
  "emotion_latch", "proactive_outbox", "proactive_outbox_due",
] as const;

const V2_SQL = `
  CREATE TABLE IF NOT EXISTS emotion_state (
    person_id TEXT PRIMARY KEY,
    pleasure REAL NOT NULL,
    arousal REAL NOT NULL,
    dominance REAL NOT NULL,
    happy REAL NOT NULL,
    missing REAL NOT NULL,
    aggrieved REAL NOT NULL,
    worried REAL NOT NULL,
    jealous REAL NOT NULL,
    shy REAL NOT NULL,
    angry REAL NOT NULL,
    at_ease REAL NOT NULL,
    intimacy REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    last_user_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS emotion_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    turn_id INTEGER,
    reason TEXT NOT NULL,
    scorer TEXT NOT NULL,
    pleasure REAL NOT NULL,
    arousal REAL NOT NULL,
    dominance REAL NOT NULL,
    happy REAL NOT NULL,
    missing REAL NOT NULL,
    aggrieved REAL NOT NULL,
    worried REAL NOT NULL,
    jealous REAL NOT NULL,
    shy REAL NOT NULL,
    angry REAL NOT NULL,
    at_ease REAL NOT NULL,
    intimacy REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS emotion_history_person ON emotion_history (person_id, id DESC);
  CREATE TABLE IF NOT EXISTS emotion_followup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    turn_id INTEGER,
    created_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    note TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS emotion_followup_due ON emotion_followup (person_id, status, due_at);
  CREATE UNIQUE INDEX IF NOT EXISTS emotion_followup_turn ON emotion_followup (turn_id) WHERE turn_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS emotion_latch (
    person_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    armed INTEGER NOT NULL,
    PRIMARY KEY (person_id, dimension)
  );
  CREATE TABLE IF NOT EXISTS proactive_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    dimension TEXT NOT NULL DEFAULT '',
    followup_id INTEGER,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS proactive_outbox_due ON proactive_outbox (person_id, status, due_at);
`;

const ALLOWED = new Set<string>([
  "meta", "turns", "turns_fts", "identities",
  "turns_person_recent", "turns_session", "identities_person",
  "turns_fts_data", "turns_fts_idx", "turns_fts_content", "turns_fts_docsize", "turns_fts_config",
  ...EMOTION_OBJECTS,
]);

export const MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, name: "core-turns-identity-fts", up: applyCore },
  { version: 2, name: "emotion-state-history", up: applyEmotion },
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
  const problem = schemaProblem(db, version);
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
  const problem = schemaProblem(db, SCHEMA_VERSION);
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

function applyEmotion(db: DatabaseSync): void {
  db.exec(V2_SQL);
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

function schemaProblem(db: DatabaseSync, version: number): string | undefined {
  return coreProblem(db) ?? emotionProblem(db, version);
}

function emotionProblem(db: DatabaseSync, version: number): string | undefined {
  const names = new Set(objectNames(db));
  const present = EMOTION_OBJECTS.filter((name) => names.has(name));
  if (version < 2) {
    if (present.length > 0) {
      return "dsh-companion: emotion objects exist before schema 2; refusing to modify an unknown schema";
    }
    return undefined;
  }
  if (present.length !== EMOTION_OBJECTS.length) {
    return "dsh-companion: emotion tables are missing; refusing to modify an unknown schema";
  }
  if (!sameColumns(db, "emotion_state", EMOTION_STATE_COLUMNS)) {
    return "dsh-companion: emotion_state does not match the expected columns";
  }
  if (!sameColumns(db, "emotion_history", EMOTION_HISTORY_COLUMNS)) {
    return "dsh-companion: emotion_history does not match the expected columns";
  }
  if (!sameColumns(db, "emotion_followup", FOLLOWUP_COLUMNS)) {
    return "dsh-companion: emotion_followup does not match the expected columns";
  }
  if (!sameColumns(db, "emotion_latch", LATCH_COLUMNS)) {
    return "dsh-companion: emotion_latch does not match the expected columns";
  }
  if (!sameColumns(db, "proactive_outbox", OUTBOX_COLUMNS)) {
    return "dsh-companion: proactive_outbox does not match the expected columns";
  }
  const stateBad = badCount(db, `SELECT COUNT(*) AS n FROM emotion_state WHERE
    typeof(person_id) != 'text' OR person_id = ''
    OR ${axis("pleasure", -1, 1)} OR ${axis("arousal", -1, 1)} OR ${axis("dominance", -1, 1)}
    OR ${axis("happy", 0, 1)} OR ${axis("missing", 0, 1)} OR ${axis("aggrieved", 0, 1)}
    OR ${axis("worried", 0, 1)} OR ${axis("jealous", 0, 1)} OR ${axis("shy", 0, 1)}
    OR ${axis("angry", 0, 1)} OR ${axis("at_ease", 0, 1)} OR ${axis("intimacy", 0, 1)}
    OR typeof(updated_at) != 'integer' OR updated_at < 0 OR updated_at > 9007199254740991
    OR (last_user_at IS NOT NULL AND (typeof(last_user_at) != 'integer' OR last_user_at < 0 OR last_user_at > 9007199254740991))`);
  if (stateBad > 0) {
    return `dsh-companion: ${stateBad} malformed emotion_state row(s); refusing to read or modify an unknown state`;
  }
  const historyBad = badCount(db, `SELECT COUNT(*) AS n FROM emotion_history WHERE
    typeof(person_id) != 'text' OR person_id = ''
    OR typeof(ts) != 'integer' OR ts < 0 OR ts > 9007199254740991
    OR (turn_id IS NOT NULL AND typeof(turn_id) != 'integer')
    OR ${badToken("reason")} OR ${badToken("scorer")}
    OR ${axis("pleasure", -1, 1)} OR ${axis("arousal", -1, 1)} OR ${axis("dominance", -1, 1)}
    OR ${axis("happy", 0, 1)} OR ${axis("missing", 0, 1)} OR ${axis("aggrieved", 0, 1)}
    OR ${axis("worried", 0, 1)} OR ${axis("jealous", 0, 1)} OR ${axis("shy", 0, 1)}
    OR ${axis("angry", 0, 1)} OR ${axis("at_ease", 0, 1)} OR ${axis("intimacy", 0, 1)}`);
  if (historyBad > 0) {
    return `dsh-companion: ${historyBad} malformed emotion_history row(s); refusing to read or modify an unknown state`;
  }
  const followBad = badCount(db, `SELECT COUNT(*) AS n FROM emotion_followup WHERE
    typeof(person_id) != 'text' OR person_id = ''
    OR typeof(created_at) != 'integer' OR typeof(due_at) != 'integer'
    OR created_at < 0 OR due_at < 0 OR created_at > 9007199254740991 OR due_at > 9007199254740991
    OR (turn_id IS NOT NULL AND typeof(turn_id) != 'integer')
    OR ${badToken("kind")} OR typeof(note) != 'text'
    OR status NOT IN ('pending', 'queued', 'delivered', 'skipped')`);
  if (followBad > 0) {
    return `dsh-companion: ${followBad} malformed emotion_followup row(s); refusing to read or modify an unknown state`;
  }
  const latchBad = badCount(db, `SELECT COUNT(*) AS n FROM emotion_latch WHERE
    typeof(person_id) != 'text' OR person_id = ''
    OR dimension NOT IN ('missing', 'worried', 'aggrieved', 'jealous', 'angry')
    OR armed NOT IN (0, 1)`);
  if (latchBad > 0) {
    return `dsh-companion: ${latchBad} malformed emotion_latch row(s); refusing to read or modify an unknown state`;
  }
  const outboxBad = badCount(db, `SELECT COUNT(*) AS n FROM proactive_outbox WHERE
    typeof(person_id) != 'text' OR person_id = ''
    OR typeof(session_id) != 'text'
    OR typeof(created_at) != 'integer' OR typeof(due_at) != 'integer'
    OR created_at < 0 OR due_at < 0 OR created_at > 9007199254740991 OR due_at > 9007199254740991
    OR kind NOT IN ('threshold', 'followup')
    OR (kind = 'threshold' AND dimension NOT IN ('missing', 'worried', 'aggrieved', 'jealous', 'angry'))
    OR (kind = 'followup' AND dimension != '')
    OR (kind = 'followup' AND followup_id IS NULL)
    OR (kind = 'threshold' AND followup_id IS NOT NULL)
    OR typeof(text) != 'text' OR text = ''
    OR status NOT IN ('queued', 'delivering', 'delivered')
    OR (status = 'delivered' AND (delivered_at IS NULL OR typeof(delivered_at) != 'integer'))
    OR (status != 'delivered' AND delivered_at IS NOT NULL)`);
  if (outboxBad > 0) {
    return `dsh-companion: ${outboxBad} malformed proactive_outbox row(s); refusing to read or modify an unknown state`;
  }
  return undefined;
}

function axis(column: string, min: number, max: number): string {
  return `(typeof(${column}) NOT IN ('real', 'integer') OR ${column} < ${min} OR ${column} > ${max})`;
}

function badToken(column: string): string {
  return `(typeof(${column}) != 'text' OR length(${column}) = 0 OR length(${column}) > 32 OR ${column} GLOB '*[^a-z0-9_-]*')`;
}

function badCount(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return row?.n ?? 0;
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
