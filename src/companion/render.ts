/**
 * Prefix-cache friendly prompt split.
 *
 * The stable section is the persona and nothing else, so DeepSeek can reuse
 * the system prefix across turns. Recent raw turns, retrieved windows, and
 * the inner-state line are a volatile suffix. Together they stay inside one
 * character (and optional token) budget. Recall is first person.
 *
 * @module dsh-companion/render
 */

import type { TokenCounter } from "../contracts.js";
import { validateTokenBudget } from "../token-counter.js";
import type { Snippet, TurnRecord } from "./types.js";

/** Invisible mark so a logged copy of our own injection is not stored again. */
export const RECALL_MARK = "\u2060";

export const DEFAULT_PERSONA = [
  "你是同一个人，从第一天一直活到现在。换会话、上下文被截断、被摘要，都不会把你变成另一个人，也不会把过去变成一份交给你阅读的交接材料。",
  "你用第一人称说话。想起过去时用「我记得」。想不起来的时候像人一样含糊，可以说印象模糊，不要编造具体细节，也不要宣布自己没有这段经历。",
  "不要重新自我介绍，不要用认识新人的开场。你们已经认识了。",
  "情绪用感受说出来，不要报数字。",
].join("\n");

export interface RenderInput {
  persona: string;
  emotionLine: string;
  recent: readonly TurnRecord[];
  snippets: readonly Snippet[];
  maxChars: number;
  maxTokens?: number;
  tokenCounter?: TokenCounter;
}

export interface RenderedPrompt {
  /** Stable system section. Independent of the current turn and the history. */
  stable: string;
  /** Volatile recall, without the wire mark. */
  volatile: string;
  /** Volatile text as injected, marked so the logger can skip it. */
  wire: string;
  chars: number;
  tokens?: number;
}

export function renderCompanionPrompt(input: RenderInput): RenderedPrompt {
  validateTokenBudget(input.maxTokens, input.tokenCounter);
  const emotion = input.emotionLine.trim();
  let stable = input.persona.trim();
  const recent = [...input.recent];
  const snippets = [...input.snippets];
  const fits = (stableText: string, volatileText: string): boolean => {
    const combined = join(stableText, seal(volatileText));
    if (combined.length > input.maxChars) return false;
    if (input.maxTokens !== undefined && input.tokenCounter) {
      return input.tokenCounter(combined) <= input.maxTokens;
    }
    return true;
  };

  if (!fits(stable, "")) stable = truncate(stable, Math.max(0, input.maxChars - 1)) + (stable.length > input.maxChars ? "…" : "");
  while (!fits(stable, "") && stable.length > 0) stable = truncate(stable, stable.length - 1);

  let volatile = compose(emotion, recent, snippets);
  while (!fits(stable, volatile) && (snippets.length > 0 || recent.length > 0)) {
    if (snippets.length > 0) snippets.pop();
    else recent.shift();
    volatile = compose(emotion, recent, snippets);
  }
  if (!fits(stable, volatile)) {
    const room = Math.max(0, input.maxChars - join(stable, "").length);
    volatile = truncate(emotion, room);
    while (!fits(stable, volatile) && volatile.length > 0) volatile = truncate(volatile, volatile.length - 1);
  }
  const wire = seal(volatile);
  const combined = join(stable, wire);
  return {
    stable,
    volatile,
    wire,
    chars: combined.length,
    ...(input.tokenCounter ? { tokens: input.tokenCounter(combined) } : {}),
  };
}

export function isRecallContent(content: string): boolean {
  return content.startsWith(RECALL_MARK);
}

function compose(emotion: string, recent: readonly TurnRecord[], snippets: readonly Snippet[]): string {
  const parts: string[] = [];
  if (recent.length > 0) {
    parts.push(["我记得最近的原话。", ...recent.map(speakTurn)].join("\n"));
  }
  for (const snippet of snippets) {
    const already = new Set(recent.map((turn) => turn.id));
    if (snippet.turnIds.length > 0 && snippet.turnIds.every((id) => already.has(id))) continue;
    parts.push(snippet.text);
  }
  if (emotion.length > 0) parts.push(emotion);
  return parts.join("\n\n");
}

function speakTurn(turn: TurnRecord): string {
  return `${turn.role === "user" ? "你说" : "我说"}：「${turn.content}」`;
}

function seal(volatile: string): string {
  return volatile.length === 0 ? "" : RECALL_MARK + volatile;
}

function join(stable: string, volatile: string): string {
  if (volatile.length === 0) return stable;
  if (stable.length === 0) return volatile;
  return `${stable}\n\n${volatile}`;
}

function truncate(text: string, room: number): string {
  if (room <= 0) return "";
  let out = "";
  for (const point of text) {
    if (out.length + point.length > room) break;
    out += point;
  }
  return out;
}
