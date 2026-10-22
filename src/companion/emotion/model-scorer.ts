/**
 * Optional cheap-model scorer.
 *
 * The API key is read by the caller from the environment and passed in.
 * It is sent only as a bearer header. A missing key, a timeout, an HTTP
 * error, or a body that is not the expected JSON all return `undefined` so
 * the deterministic rules can run. This class never throws for those cases
 * and never logs the turn or the key.
 *
 * @module dsh-companion/emotion/model-scorer
 */

import type { TurnRecord } from "../types.js";
import { sanitizeNote } from "./rules.js";
import {
  VECTOR_KEYS,
  zeroDeltas,
  type EmotionDeltas,
  type EmotionScore,
  type EmotionVector,
  type VectorKey,
} from "./types.js";

const EVENT_KINDS = new Set(["exam", "interview", "health", "travel", "birthday", "plan", "other"]);

const SYSTEM = [
  "你是情绪增量打分器。只输出一个 JSON 对象，不要 Markdown，不要解释。",
  "deltas 的每个值大约在 -0.4 到 0.4。intimacy 只允许 -0.08 到 0.08。",
  "deltas 字段：pleasure, arousal, dominance, happy, missing, aggrieved, worried, jealous, shy, angry, atEase, intimacy。都是数字。",
  "如果这句提到以后值得关心的事，再加 event：{ kind, note }。kind 只能是 exam、interview、health、travel、birthday、plan、other。note 不超过 40 字，摘自原话。没有就不要 event。",
].join("\n");

export interface CheapModelOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey: string;
  fetch?: typeof fetch;
}

export interface EmotionScoreInput {
  turn: TurnRecord;
  state: EmotionVector;
}

export interface EmotionScorer {
  readonly id: string;
  score(input: EmotionScoreInput): EmotionScore | undefined | Promise<EmotionScore | undefined>;
}

export class CheapModelScorer implements EmotionScorer {
  readonly id = "model";
  readonly #options: CheapModelOptions;

  constructor(options: CheapModelOptions) {
    this.#options = options;
  }

  async score(input: EmotionScoreInput): Promise<EmotionScore | undefined> {
    if (this.#options.apiKey.trim().length === 0) return undefined;
    const fetchImpl = this.#options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    try {
      const response = await fetchImpl(completionsUrl(this.#options.baseUrl), {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.#options.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: JSON.stringify({ role: input.turn.role, text: input.turn.content.slice(0, 2000), mood: roundMood(input.state) }) },
          ],
        }),
      });
      if (!response.ok) return undefined;
      const body = await response.json() as unknown;
      return parseScore(body);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function parseScore(body: unknown): EmotionScore | undefined {
  const content = contentOf(body);
  if (content === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(content));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as { deltas?: unknown; event?: unknown };
  const deltas = deltasOf(record.deltas);
  if (!deltas) return undefined;
  const event = eventOf(record.event);
  return event ? { deltas, event } : { deltas };
}

function deltasOf(value: unknown): EmotionDeltas | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const deltas = zeroDeltas();
  for (const key of VECTOR_KEYS) {
    const raw = record[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
    deltas[key] = raw;
  }
  return deltas;
}

function eventOf(value: unknown): { kind: string; note: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as { kind?: unknown; note?: unknown };
  if (typeof record.kind !== "string" || !EVENT_KINDS.has(record.kind)) return undefined;
  const note = typeof record.note === "string" ? sanitizeNote(record.note) : "";
  return { kind: record.kind, note };
}

function contentOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function roundMood(state: EmotionVector): Record<VectorKey, number> {
  const rounded = {} as Record<VectorKey, number>;
  for (const key of VECTOR_KEYS) rounded[key] = Math.round(state[key] * 100) / 100;
  return rounded;
}
