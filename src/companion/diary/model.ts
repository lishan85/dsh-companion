/**
 * Pluggable cheap model for diary prose.
 *
 * The API key is passed in by the caller. A missing key, a timeout, an HTTP
 * error, or a body that is not the expected JSON returns `undefined`, and the
 * deterministic fallback writes the page. This class never throws for those
 * cases and never logs the diary or the key.
 *
 * @module dsh-companion/diary/model
 */

import { completionsUrl } from "../emotion/model-scorer.js";
import { acceptableDiary, materialOf } from "./fallback.js";
import type { DiaryDraft, DiaryLayer } from "./types.js";

export interface DiaryModel {
  readonly id: string;
  write(draft: DiaryDraft): Promise<string | undefined>;
}

export interface CheapDiaryOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey: string;
  fetch?: typeof fetch;
}

const SYSTEM = [
  "你在写自己的日记，用第一人称中文。你就是活过这些对话的那个人。",
  "不要用「根据记录」「检索结果」「交接」。不要编造材料里没有的细节。不要报分数。",
  "普通的日子写成一小段就好。重要事件的原话会由系统另行附上，你不要改写它们。",
  "只输出一个 JSON 对象：{\"diary\":\"...\"}。不要 Markdown，不要解释。",
].join("\n");

export class CheapDiaryModel implements DiaryModel {
  readonly id = "model";
  readonly #options: CheapDiaryOptions;

  constructor(options: CheapDiaryOptions) {
    this.#options = options;
  }

  async write(draft: DiaryDraft): Promise<string | undefined> {
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
            { role: "user", content: JSON.stringify(promptOf(draft)).slice(0, 8_000) },
          ],
        }),
      });
      if (!response.ok) return undefined;
      const body = await response.json() as unknown;
      return parseDiary(body);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseDiary(body: unknown): string | undefined {
  const content = contentOf(body);
  if (content === undefined) return undefined;
  const trimmed = stripFence(content).trim();
  let diary = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { diary?: unknown };
      if (typeof parsed.diary !== "string") return undefined;
      diary = parsed.diary;
    } catch {
      return undefined;
    }
  }
  const text = diary.replaceAll("\u2060", "").trim();
  return acceptableDiary(text) ? text : undefined;
}

function promptOf(draft: DiaryDraft): { layer: DiaryLayer; periodKey: string; material: string } {
  return {
    layer: draft.layer,
    periodKey: draft.periodKey,
    material: materialOf(draft).slice(0, 6_000),
  };
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
