/**
 * Raw-turn store. The prose row and its FTS row commit together. `close()` is
 * idempotent. Refused databases are classified on a read-only handle first.
 *
 * @module dsh-companion/store
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { joinTokens, tokenize } from "../tokenize.js";
import { CompanionError } from "./errors.js";
import {
  applyProactiveWrite,
  claimOutbox,
  commitEmotion as writeEmotionCommit,
  finishOutbox,
  latchesFor,
  listDueOutbox,
  listEmotionHistory,
  listEmotionPeople,
  listFollowups,
  listOutbox,
  readEmotion,
  relinkEmotionRows,
  requeueDelivering,
  requeueOutbox,
  type EmotionCommit,
  type ProactiveWrite,
} from "./emotion/persist.js";
import type { EmotionHistoryRow, EmotionStateRow, FollowupRow, ProactiveRow } from "./emotion/types.js";
import { FTS_TOKEN_VERSION, SCHEMA_VERSION, classifySchema, migrateSchema } from "./schema.js";
import type { IdentityRecord, TurnInput, TurnRecord, TurnRole } from "./types.js";

const MAX_FIELD = 200;
const MAX_CONTENT = 200_000;

export interface CompanionStoreOptions {
  now?: () => number;
  maxContentChars?: number;
}

export class CompanionStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #maxContent: number;
  #closed = false;

  constructor(path: string, options: CompanionStoreOptions = {}) {
    if (path.length === 0) throw new CompanionError("config", "dsh-companion: `path` must not be empty");
    this.#now = options.now ?? Date.now;
    this.#maxContent = options.maxContentChars ?? MAX_CONTENT;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    // A zero-byte file is not a database yet. Anything larger is classified on
    // a read-only handle so a refusal cannot checkpoint or rewrite WAL bytes.
    if (path !== ":memory:" && existsSync(path) && statSync(path).size > 0) {
      let probe: DatabaseSync | undefined;
      try {
        probe = new DatabaseSync(path, { readOnly: true });
      } catch (error) {
        throw new CompanionError(
          "schema",
          "dsh-companion: existing file is not a readable SQLite database; refusing to modify it",
          { cause: error },
        );
      }
      try {
        const found = classifySchema(probe);
        if (found.kind === "unsupported") throw new CompanionError("schema", found.reason);
      } catch (error) {
        if (error instanceof CompanionError) throw error;
        throw new CompanionError(
          "schema",
          "dsh-companion: existing file is not a readable SQLite database; refusing to modify it",
          { cause: error },
        );
      } finally {
        probe?.close();
      }
    }

    let db: DatabaseSync | undefined;
    try {
      db = this.#db = new DatabaseSync(path, { timeout: 5000 });
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA busy_timeout = 5000");
      this.#db.exec("PRAGMA foreign_keys = ON");
      this.#transaction(() => {
        const found = classifySchema(this.#db);
        if (found.kind === "unsupported") throw new CompanionError("schema", found.reason);
        if (found.kind === "empty") migrateSchema(this.#db, 0);
        else if (found.kind === "legacy") migrateSchema(this.#db, found.from);
        this.#rebuildFtsIfNeeded();
        requeueDelivering(this.#db);
      });
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Keep the original open error.
      }
      this.#closed = true;
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  schemaVersion(): number {
    this.#alive();
    const value = this.#meta("schema_version");
    const version = Number(value);
    if (value !== String(SCHEMA_VERSION) || !Number.isSafeInteger(version)) {
      throw new CompanionError("schema", "dsh-companion: open store has an unexpected schema version");
    }
    return version;
  }

  appendTurn(input: TurnInput): TurnRecord {
    this.#alive();
    const row = normalizeTurn(input, this.#maxContent);
    return this.#transaction(() => {
      const result = this.#db.prepare(
        `INSERT INTO turns (
           channel, user_id, chat_id, session_id, bridge, person_id, ts, role, content, turn_no
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.channel, row.userId, row.chatId, row.sessionId, row.bridge, row.personId,
        row.ts, row.role, row.content, row.turnNo,
      );
      const id = Number(result.lastInsertRowid);
      this.#db.prepare("INSERT INTO turns_fts (rowid, content) VALUES (?, ?)").run(id, joinTokens(tokenize(row.content)));
      return this.#mustTurn(id);
    });
  }

  getTurn(id: number): TurnRecord | undefined {
    this.#alive();
    const row = this.#db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as Row | undefined;
    return row ? toTurn(row) : undefined;
  }

  countTurns(): number {
    this.#alive();
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
  }

  recentTurns(personId: string, limit: number): TurnRecord[] {
    this.#alive();
    const rows = this.#db.prepare(
      "SELECT * FROM turns WHERE person_id = ? ORDER BY id DESC LIMIT ?",
    ).all(personId, limit) as unknown as Row[];
    return rows.map(toTurn).reverse();
  }

  /** Neighboring turns of the same person, oldest first, including `id`. */
  turnWindow(personId: string, id: number, radius: number): TurnRecord[] {
    this.#alive();
    const before = (this.#db.prepare(
      "SELECT * FROM turns WHERE person_id = ? AND id <= ? ORDER BY id DESC LIMIT ?",
    ).all(personId, id, radius + 1) as unknown as Row[]).map(toTurn).reverse();
    const after = (this.#db.prepare(
      "SELECT * FROM turns WHERE person_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
    ).all(personId, id, radius) as unknown as Row[]).map(toTurn);
    return [...before, ...after];
  }

  ftsTurns(match: string, personId: string | undefined, limit: number): Array<{ id: number; rank: number }> {
    this.#alive();
    try {
      const sql = personId === undefined
        ? `SELECT turns.id AS id, turns_fts.rank AS rank
           FROM turns_fts JOIN turns ON turns.id = turns_fts.rowid
           WHERE turns_fts MATCH ? ORDER BY turns_fts.rank, turns.id LIMIT ?`
        : `SELECT turns.id AS id, turns_fts.rank AS rank
           FROM turns_fts JOIN turns ON turns.id = turns_fts.rowid
           WHERE turns_fts MATCH ? AND turns.person_id = ?
           ORDER BY turns_fts.rank, turns.id LIMIT ?`;
      return (personId === undefined
        ? this.#db.prepare(sql).all(match, limit)
        : this.#db.prepare(sql).all(match, personId, limit)) as unknown as Array<{ id: number; rank: number }>;
    } catch (error) {
      throw new CompanionError("search", "dsh-companion: full-text query failed", { cause: error });
    }
  }

  personFor(platform: string, platformUserId: string, now = this.#now()): string {
    this.#alive();
    const key = cleanId(platform, "platform");
    const user = cleanId(platformUserId, "platform user id");
    return this.#transaction(() => {
      const existing = this.#db.prepare(
        "SELECT person_id FROM identities WHERE platform = ? AND platform_user_id = ?",
      ).get(key, user) as { person_id: string } | undefined;
      if (existing) return existing.person_id;
      const personId = `${key}:${user}`;
      this.#db.prepare(
        "INSERT INTO identities (platform, platform_user_id, person_id, created_at) VALUES (?, ?, ?, ?)",
      ).run(key, user, personId, now);
      return personId;
    });
  }

  /**
   * Point a platform account at a person. Turns that still carry the previous
   * auto id move with it, so one person is not split across two ids.
   */
  linkIdentity(platform: string, platformUserId: string, personId: string, now = this.#now()): void {
    this.#alive();
    const key = cleanId(platform, "platform");
    const user = cleanId(platformUserId, "platform user id");
    const target = cleanId(personId, "person id");
    this.#transaction(() => {
      const existing = this.#db.prepare(
        "SELECT person_id FROM identities WHERE platform = ? AND platform_user_id = ?",
      ).get(key, user) as { person_id: string } | undefined;
      this.#db.prepare(
        `INSERT INTO identities (platform, platform_user_id, person_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(platform, platform_user_id) DO UPDATE SET person_id = excluded.person_id`,
      ).run(key, user, target, now);
      if (existing && existing.person_id !== target) {
        this.#db.prepare("UPDATE turns SET person_id = ? WHERE person_id = ?").run(target, existing.person_id);
        relinkEmotionRows(this.#db, existing.person_id, target);
      }
    });
  }

  listIdentities(): IdentityRecord[] {
    this.#alive();
    return (this.#db.prepare(
      "SELECT * FROM identities ORDER BY platform, platform_user_id",
    ).all() as unknown as Row[]).map((row) => ({
      platform: String(row.platform),
      platformUserId: String(row.platform_user_id),
      personId: String(row.person_id),
      createdAt: Number(row.created_at),
    }));
  }

  getEmotion(personId: string): EmotionStateRow | undefined {
    this.#alive();
    return readEmotion(this.#db, personId);
  }

  emotionPeople(): string[] {
    this.#alive();
    return listEmotionPeople(this.#db);
  }

  emotionHistory(personId: string, limit = 50): EmotionHistoryRow[] {
    this.#alive();
    const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    return listEmotionHistory(this.#db, personId, bounded);
  }

  emotionFollowups(personId: string): FollowupRow[] {
    this.#alive();
    return listFollowups(this.#db, personId);
  }

  emotionLatches(personId: string): Map<string, boolean> {
    this.#alive();
    return latchesFor(this.#db, personId);
  }

  proactiveQueue(personId?: string): ProactiveRow[] {
    this.#alive();
    return listOutbox(this.#db, personId);
  }

  dueProactive(now: number): ProactiveRow[] {
    this.#alive();
    return listDueOutbox(this.#db, now);
  }

  commitEmotion(commit: EmotionCommit): void {
    this.#alive();
    this.#transaction(() => writeEmotionCommit(this.#db, commit));
  }

  applyProactivePlan(write: ProactiveWrite): void {
    this.#alive();
    this.#transaction(() => applyProactiveWrite(this.#db, write));
  }

  claimProactive(id: number, now: number): boolean {
    this.#alive();
    return this.#transaction(() => claimOutbox(this.#db, id, now));
  }

  requeueProactive(id: number): void {
    this.#alive();
    this.#transaction(() => requeueOutbox(this.#db, id));
  }

  finishProactive(id: number, now: number): void {
    this.#alive();
    this.#transaction(() => finishOutbox(this.#db, id, now));
  }

  latestTurnForSession(sessionId: string): TurnRecord | undefined {
    this.#alive();
    const row = this.#db.prepare(
      "SELECT * FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1",
    ).get(sessionId) as Row | undefined;
    return row ? toTurn(row) : undefined;
  }

  #mustTurn(id: number): TurnRecord {
    const row = this.#db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new CompanionError("store", `dsh-companion: turn #${id} disappeared after insert`);
    return toTurn(row);
  }

  #rebuildFtsIfNeeded(): void {
    if (this.#meta("fts_token_version") === String(FTS_TOKEN_VERSION)) return;
    this.#db.exec("DELETE FROM turns_fts");
    const turns = this.#db.prepare("SELECT id, content FROM turns ORDER BY id").all() as unknown as Array<{ id: number; content: string }>;
    const insert = this.#db.prepare("INSERT INTO turns_fts (rowid, content) VALUES (?, ?)");
    for (const turn of turns) insert.run(turn.id, joinTokens(tokenize(turn.content)));
    this.#db.prepare(
      `INSERT INTO meta (key, value) VALUES ('fts_token_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(FTS_TOKEN_VERSION));
  }

  #meta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The original error is the one that matters.
      }
      throw error;
    }
  }

  #alive(): void {
    if (this.#closed) throw new CompanionError("closed", "dsh-companion: store is not open");
  }
}

type Row = Record<string, unknown>;

function toTurn(row: Row): TurnRecord {
  const role: TurnRole = row.role === "assistant" ? "assistant" : "user";
  return {
    id: Number(row.id),
    channel: String(row.channel ?? ""),
    userId: String(row.user_id ?? ""),
    chatId: String(row.chat_id ?? ""),
    sessionId: String(row.session_id ?? ""),
    bridge: String(row.bridge ?? ""),
    personId: String(row.person_id),
    ts: Number(row.ts),
    role,
    content: String(row.content),
    turnNo: row.turn_no == null ? null : Number(row.turn_no),
  };
}

function normalizeTurn(input: TurnInput, maxContent: number): TurnRecord & { turnNo: number | null } {
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new CompanionError("turn", "dsh-companion: a turn needs non-empty content");
  }
  if (input.content.length > maxContent) {
    throw new CompanionError("turn", `dsh-companion: turn content exceeds ${maxContent} characters`);
  }
  if (input.role !== "user" && input.role !== "assistant") {
    throw new CompanionError("turn", "dsh-companion: turn role must be user or assistant");
  }
  if (!Number.isSafeInteger(input.ts) || input.ts < 0) {
    throw new CompanionError("turn", "dsh-companion: turn timestamp must be a non-negative safe integer");
  }
  if (input.turnNo !== undefined && !Number.isSafeInteger(input.turnNo)) {
    throw new CompanionError("turn", "dsh-companion: turn number must be a safe integer");
  }
  return {
    id: 0,
    channel: bound(input.channel, "channel"),
    userId: bound(input.userId, "user id"),
    chatId: bound(input.chatId, "chat id"),
    sessionId: bound(input.sessionId, "session id"),
    bridge: bound(input.bridge, "bridge"),
    personId: cleanId(input.personId, "person id"),
    ts: input.ts,
    role: input.role,
    content: input.content,
    turnNo: input.turnNo ?? null,
  };
}

function bound(value: string, label: string): string {
  if (typeof value !== "string") throw new CompanionError("turn", `dsh-companion: ${label} must be a string`);
  if (value.length > MAX_FIELD) throw new CompanionError("turn", `dsh-companion: ${label} exceeds ${MAX_FIELD} characters`);
  return value;
}

function cleanId(value: string, label: string): string {
  const trimmed = bound(value, label).trim();
  if (trimmed.length === 0) throw new CompanionError("identity", `dsh-companion: ${label} must not be empty`);
  return trimmed;
}
