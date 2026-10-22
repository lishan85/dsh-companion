/**
 * Embedding providers.
 *
 * The offline model is a deterministic feature hash. It is not a neural
 * encoder. Quality to expect from `offline-hash-v1`:
 *
 * - A paraphrase is recalled when it shares a built-in synonym cluster, or
 *   when it shares enough character n-grams, even if FTS tokens do not overlap.
 *   The clusters are {@link OFFLINE_SYNONYM_CLUSTERS}. "英短" against
 *   "宠物小猫" is the kind of pair this finds.
 * - Paraphrases outside that list that also share almost no characters are
 *   not recalled. This is not general semantic search.
 * - Unrelated text lands near zero. Callers drop neighbors below
 *   `vectorMinScore`.
 * - Changing the model id or the dimension stores a new vector family. Older
 *   vectors for another model stay on disk and are not mixed into the query.
 *
 * An OpenAI-compatible `POST /embeddings` provider is optional. The key is
 * read from the environment at call time, sent only as a bearer header, and
 * never written into an error, a log line, or the database. A missing key
 * does not call the network. HTTP 401/403 raises {@link EmbeddingAuthError}
 * with the status and nothing else, so the index can switch to the offline
 * model instead of waiting on a credential.
 *
 * @module dsh-companion/embed
 */

import { createHash } from "node:crypto";

export const OFFLINE_EMBEDDING_MODEL = "offline-hash-v1";
export const DEFAULT_EMBEDDING_DIMENSIONS = 128;
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Fixed clusters for the offline hash. Members of one cluster share a feature.
 * Latin members are matched case-insensitively. This list is part of the
 * model: editing it requires a new model id so old vectors are rebuilt.
 */
export const OFFLINE_SYNONYM_CLUSTERS: readonly (readonly string[])[] = [
  ["猫", "猫咪", "小猫", "英短", "宠物"],
  ["狗", "小狗", "狗狗"],
  ["怕", "害怕", "惧怕", "恐惧"],
  ["雷", "打雷", "雷暴", "惊雷", "雷声"],
  ["海", "海边", "海岸", "海滩", "大海"],
  ["雨", "下雨", "雨天"],
  ["妈妈", "母亲"],
  ["爸爸", "父亲"],
  ["汽车", "轿车", "开车"],
  ["吃饭", "用餐"],
  ["家里", "回家"],
  ["旅行", "出游", "旅游"],
  ["冰岛"],
  ["芬兰", "汉科", "hanko", "finland"],
];

const CLUSTER_WEIGHT = 8;
const NGRAM_WEIGHT = 1;

export class EmbeddingAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`dsh-companion: embedding request was refused with status ${status}`);
    this.name = "EmbeddingAuthError";
    this.status = status;
  }
}

export class EmbeddingRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbeddingRequestError";
    if (status !== undefined) this.status = status;
  }
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly synchronous: boolean;
  embedMany(texts: readonly string[], signal?: AbortSignal): Float32Array[] | Promise<Float32Array[]>;
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function offlineEmbed(text: string, dimensions: number): Float32Array {
  if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 4096) {
    throw new EmbeddingRequestError("dsh-companion: embedding dimensions must be an integer from 8 to 4096");
  }
  const out = new Float32Array(dimensions);
  const haystack = text.toLowerCase();
  const chars = Array.from(haystack);
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index + size <= chars.length; index += 1) {
      mix(chars.slice(index, index + size).join(""), dimensions, NGRAM_WEIGHT, out);
    }
  }
  OFFLINE_SYNONYM_CLUSTERS.forEach((cluster, clusterIndex) => {
    if (cluster.some((member) => haystack.includes(member.toLowerCase()))) {
      mix(`syn:${clusterIndex}`, dimensions, CLUSTER_WEIGHT, out);
    }
  });
  return normalize(out);
}

export function offlineProvider(dimensions: number, model = OFFLINE_EMBEDDING_MODEL): EmbeddingProvider {
  return {
    model,
    dimensions,
    synchronous: true,
    embedMany(texts) {
      return texts.map((text) => offlineEmbed(text, dimensions));
    },
  };
}

export interface HttpEmbeddingOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export function createHttpEmbeddingProvider(options: HttpEmbeddingOptions): EmbeddingProvider {
  return {
    model: options.model,
    dimensions: options.dimensions,
    synchronous: false,
    embedMany(texts, signal) {
      return embedHttp(options, texts, signal);
    },
  };
}

export function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/embeddings")) return trimmed;
  return `${trimmed}/embeddings`;
}

export async function embedHttp(
  options: HttpEmbeddingOptions,
  texts: readonly string[],
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  if (options.apiKey.trim().length === 0) {
    throw new EmbeddingAuthError(401);
  }
  if (texts.length === 0) return [];
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(embeddingsUrl(options.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        input: [...texts],
        dimensions: options.dimensions,
      }),
    });
    if (response.status === 401 || response.status === 403) throw new EmbeddingAuthError(response.status);
    if (!response.ok) throw new EmbeddingRequestError(`dsh-companion: embedding request failed with status ${response.status}`, response.status);
    const body = await response.json() as unknown;
    return parseEmbeddings(body, texts.length, options.dimensions);
  } catch (error) {
    if (error instanceof EmbeddingAuthError || error instanceof EmbeddingRequestError) throw error;
    if (controller.signal.aborted) {
      throw new EmbeddingRequestError("dsh-companion: embedding request timed out");
    }
    throw new EmbeddingRequestError("dsh-companion: embedding request failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function parseEmbeddings(body: unknown, count: number, dimensions: number): Float32Array[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw new EmbeddingRequestError("dsh-companion: embedding response did not contain a data array");
  }
  const data = (body as { data: unknown[] }).data;
  const ordered: Array<Float32Array | undefined> = Array.from({ length: count }, () => undefined);
  data.forEach((item, fallbackIndex) => {
    if (!item || typeof item !== "object") return;
    const record = item as { index?: unknown; embedding?: unknown };
    const index = typeof record.index === "number" ? record.index : fallbackIndex;
    if (!Number.isInteger(index) || index < 0 || index >= count) return;
    if (!Array.isArray(record.embedding) || record.embedding.length !== dimensions) return;
    const vector = new Float32Array(dimensions);
    for (let cursor = 0; cursor < dimensions; cursor += 1) {
      const value = record.embedding[cursor];
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      vector[cursor] = value;
    }
    ordered[index] = normalize(vector);
  });
  if (ordered.some((item) => item === undefined)) {
    throw new EmbeddingRequestError("dsh-companion: embedding response did not match the requested documents");
  }
  return ordered as Float32Array[];
}

export interface ProviderSelection {
  provider: EmbeddingProvider;
  /** Set when an requested HTTP provider could not be used. */
  fallback?: string;
}

export function selectEmbeddingProvider(options: {
  provider: "offline" | "openai";
  baseUrl?: string;
  model: string;
  dimensions: number;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): ProviderSelection {
  const model = options.model.trim();
  if (options.provider === "offline" || options.apiKey.trim().length === 0 || options.baseUrl === undefined || options.baseUrl.length === 0) {
    const fallback = options.provider === "openai"
      ? "dsh-companion: embedding endpoint or key is missing; using the offline hash"
      : undefined;
    return {
      provider: offlineProvider(options.dimensions, model.length > 0 && options.provider === "offline" ? model : OFFLINE_EMBEDDING_MODEL),
      ...(fallback ? { fallback } : {}),
    };
  }
  return {
    provider: createHttpEmbeddingProvider({
      baseUrl: options.baseUrl,
      model: model.length > 0 ? model : DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: options.dimensions,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  };
}

export function encodeVector(vector: Float32Array): Buffer {
  const copy = new Float32Array(vector);
  return Buffer.from(copy.buffer);
}

export function decodeVector(blob: Buffer, dimensions: number): Float32Array {
  const out = new Float32Array(dimensions);
  Buffer.from(out.buffer).set(blob.subarray(0, dimensions * 4));
  return out;
}

function mix(key: string, dimensions: number, weight: number, out: Float32Array): void {
  const hash = fnv1a(key);
  const index = hash % dimensions;
  const sign = (hash & 1) === 0 ? 1 : -1;
  out[index] = (out[index] ?? 0) + sign * weight;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) * scale;
  return vector;
}
