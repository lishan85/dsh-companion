/**
 * SQLite vector index.
 *
 * Each turn, sealed diary page, and wander experience is embedded once per
 * model. `upsert` writes the current turn immediately when the provider is
 * synchronous. `backfill` fills anything older, including diary pages sealed
 * before this process started. sqlite-vec answers the nearest-neighbor query
 * when the extension loads; otherwise the same blobs are scored in process.
 *
 * HTTP embeddings never run without a key. A 401 or 403 switches this index
 * to the offline hash for the rest of the process and continues. Other HTTP
 * failures leave the missing rows for the next backfill and do not throw into
 * the recall path.
 *
 * @module dsh-companion/vector/index
 */

import {
  EmbeddingAuthError,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  offlineProvider,
  selectEmbeddingProvider,
  textHash,
  type EmbeddingProvider,
} from "../embed.js";
import type { CompanionStore } from "../store.js";
import type { VectorHit, VectorIndex } from "../stubs.js";
import type { CorpusRow, EmbedSource } from "./types.js";

const BATCH = 16;

export interface VectorIndexOptions {
  provider: "offline" | "openai";
  baseUrl?: string;
  model?: string;
  dimensions: number;
  timeoutMs: number;
  apiKey?: string;
  apiKeyEnv?: string;
  minScore: number;
  scanLimit: number;
  fetch?: typeof fetch;
  /** Test switch. `auto` loads sqlite-vec when it can. */
  backend?: "auto" | "blob";
  now?: () => number;
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

export class SqliteVectorIndex implements VectorIndex {
  readonly #store: CompanionStore;
  readonly #options: VectorIndexOptions;
  #provider: EmbeddingProvider;
  #backend: "sqlite-vec" | "blob" | undefined;
  #fallbackNote: string | undefined;
  #query: { text: string; vector: Float32Array } | undefined;
  #chain: Promise<void> = Promise.resolve();
  #httpDisabled = false;

  constructor(store: CompanionStore, options: VectorIndexOptions) {
    this.#store = store;
    this.#options = options;
    const selected = selectEmbeddingProvider({
      provider: options.provider,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      model: options.model ?? "",
      dimensions: options.dimensions,
      apiKey: options.apiKey ?? readEnv(options.apiKeyEnv ?? "DSH_COMPANION_EMBEDDING_KEY"),
      timeoutMs: options.timeoutMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.#provider = selected.provider;
    if (selected.fallback !== undefined) this.#fallbackNote = selected.fallback;
    if (options.provider === "offline" || selected.fallback !== undefined) this.#httpDisabled = true;
  }

  get backend(): "sqlite-vec" | "blob" {
    return this.#ensureBackend();
  }

  get model(): string {
    return this.#provider.model;
  }

  get fallbackNote(): string | undefined {
    return this.#fallbackNote;
  }

  upsert(id: number, text: string): void {
    this.#writeSoon("turn", id, text);
  }

  upsertDiary(id: number, text: string): void {
    this.#writeSoon("diary", id, text);
  }

  upsertExperience(id: number, text: string): void {
    this.#writeSoon("experience", id, text);
  }

  async prepareQuery(query: string, signal?: AbortSignal): Promise<void> {
    if (query.trim().length === 0) {
      this.#query = undefined;
      return;
    }
    try {
      const [vector] = await this.#embed([query], signal);
      if (vector) this.#query = { text: query, vector };
    } catch {
      this.#query = undefined;
    }
  }

  search(query: string, limit: number): VectorHit[] {
    if (limit < 1 || query.trim().length === 0) return [];
    const vector = this.#query?.text === query ? this.#query.vector : this.#syncQuery(query);
    if (!vector) return [];
    const backend = this.#ensureBackend();
    const model = this.#provider.model;
    const dimensions = this.#provider.dimensions;
    try {
      if (backend === "sqlite-vec") {
        const census = this.#store.vectorCensus(model, dimensions);
        if (census.count === 0) return [];
        const k = Math.min(census.count, Math.max(limit, this.#options.scanLimit));
        return this.#store.vectorNeighbors(model, dimensions, encodeVector(vector), k)
          .map((hit) => ({ id: hit.sourceId, score: clampScore(1 - hit.distance), kind: hit.source }))
          .filter((hit) => hit.score >= this.#options.minScore)
          .sort((left, right) => right.score - left.score || left.id - right.id)
          .slice(0, limit);
      }
      return this.#store.vectorBlobs(model, dimensions)
        .map((row) => ({
          id: row.sourceId,
          score: cosineSimilarity(vector, decodeVector(row.vector, dimensions)),
          kind: row.source,
        }))
        .filter((hit) => hit.score >= this.#options.minScore)
        .sort((left, right) => right.score - left.score || left.id - right.id)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  backfill(): Promise<VectorBackfillReport> {
    const report: VectorBackfillReport = {
      turns: 0,
      diaryPages: 0,
      experiences: 0,
      embedded: 0,
      skipped: 0,
      failed: 0,
      backend: "blob",
    };
    const job = this.#chain.then(async () => {
      report.backend = this.#ensureBackend();
      const pending = this.#pending();
      report.turns = pending.filter((row) => row.source === "turn").length;
      report.diaryPages = pending.filter((row) => row.source === "diary").length;
      report.experiences = pending.filter((row) => row.source === "experience").length;
      for (let index = 0; index < pending.length; index += BATCH) {
        const batch = pending.slice(index, index + BATCH);
        let vectors: Float32Array[];
        try {
          vectors = await this.#embed(batch.map((row) => row.text));
        } catch {
          report.failed += batch.length;
          continue;
        }
        batch.forEach((row, offset) => {
          const vector = vectors[offset];
          if (!vector) {
            report.failed += 1;
            return;
          }
          try {
            this.#store.saveVector({
              source: row.source,
              sourceId: row.id,
              model: this.#provider.model,
              dim: this.#provider.dimensions,
              textHash: textHash(row.text),
              embeddedAt: this.#options.now?.() ?? Date.now(),
              vector: encodeVector(vector),
              mirror: report.backend === "sqlite-vec",
            });
            report.embedded += 1;
          } catch {
            report.failed += 1;
          }
        });
      }
      if (report.backend === "sqlite-vec" && report.embedded > 0) {
        this.#store.refreshVectorStamp(this.#provider.model, this.#provider.dimensions);
      }
    });
    this.#chain = job.then(() => undefined, () => undefined);
    return job.then(() => report);
  }

  pendingCount(): number {
    return this.#pending().length;
  }

  #writeSoon(source: EmbedSource, id: number, text: string): void {
    if (this.#provider.synchronous) {
      try {
        const embedded = this.#provider.embedMany([text]);
        if (embedded instanceof Promise) return;
        const vector = embedded[0];
        if (!vector) return;
        const backend = this.#ensureBackend();
        this.#store.saveVector({
          source,
          sourceId: id,
          model: this.#provider.model,
          dim: vector.length,
          textHash: textHash(text),
          embeddedAt: this.#options.now?.() ?? Date.now(),
          vector: encodeVector(vector),
          mirror: backend === "sqlite-vec",
        });
        if (backend === "sqlite-vec") this.#store.refreshVectorStamp(this.#provider.model, this.#provider.dimensions);
      } catch {
        // The transcript is already committed. Recall still has FTS.
      }
      return;
    }
    const job = this.#chain.then(() => this.#writeAsync(source, id, text));
    this.#chain = job.then(() => undefined, () => undefined);
  }

  async #writeAsync(source: EmbedSource, id: number, text: string): Promise<void> {
    try {
      const [vector] = await this.#embed([text]);
      if (!vector) return;
      const backend = this.#ensureBackend();
      this.#store.saveVector({
        source,
        sourceId: id,
        model: this.#provider.model,
        dim: this.#provider.dimensions,
        textHash: textHash(text),
        embeddedAt: this.#options.now?.() ?? Date.now(),
        vector: encodeVector(vector),
        mirror: backend === "sqlite-vec",
      });
      if (backend === "sqlite-vec") this.#store.refreshVectorStamp(this.#provider.model, this.#provider.dimensions);
    } catch {
      // Leave the row for backfill.
    }
  }

  async #embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    try {
      return await this.#provider.embedMany(texts, signal);
    } catch (error) {
      if (error instanceof EmbeddingAuthError && !this.#httpDisabled) {
        this.#switchToOffline();
        return await this.#provider.embedMany(texts, signal);
      }
      throw error;
    }
  }

  #switchToOffline(): void {
    this.#httpDisabled = true;
    this.#provider = offlineProvider(this.#options.dimensions);
    this.#fallbackNote = "dsh-companion: embedding endpoint refused the key; using the offline hash";
    this.#query = undefined;
    this.#backend = undefined;
  }

  #syncQuery(query: string): Float32Array | undefined {
    if (!this.#provider.synchronous) return undefined;
    const result = this.#provider.embedMany([query]);
    if (result instanceof Promise) return undefined;
    return result[0];
  }

  #pending(): CorpusRow[] {
    const states = new Map(
      this.#store.embeddingStates(this.#provider.model).map((row) => [`${row.source}:${row.sourceId}`, row]),
    );
    const pending: CorpusRow[] = [];
    for (const row of this.#store.embeddingCorpus()) {
      if (row.text.trim().length === 0) continue;
      const found = states.get(`${row.source}:${row.id}`);
      if (found && found.textHash === textHash(row.text) && found.dim === this.#provider.dimensions) continue;
      pending.push(row);
    }
    return pending;
  }

  #ensureBackend(): "sqlite-vec" | "blob" {
    if (this.#backend) return this.#backend;
    if (this.#options.backend === "blob") {
      this.#backend = "blob";
      return this.#backend;
    }
    this.#backend = this.#store.activateVectorIndex(this.#provider.dimensions);
    if (this.#backend === "sqlite-vec") this.#store.alignVectorIndex(this.#provider.model, this.#provider.dimensions);
    return this.#backend;
  }
}

export function readEnv(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score > 1) return 1;
  if (score < -1) return -1;
  return score;
}
