/**
 * Deterministic turn scorer.
 *
 * Keyword hits add fixed impulses. There is no randomness and no network.
 * The engine clamps, scales assistant turns, and applies inertia afterwards.
 * Remembered events are detected only from the text; scheduling them is the
 * engine's job.
 *
 * @module dsh-companion/emotion/rules
 */

import type { TurnRecord } from "../types.js";
import { VECTOR_KEYS, zeroDeltas, type EmotionScore, type VectorKey } from "./types.js";

interface Impulse {
  pattern: RegExp;
  deltas: Partial<Record<VectorKey, number>>;
}

interface EventRule {
  kind: string;
  pattern: RegExp;
}

const IMPULSES: readonly Impulse[] = [
  { pattern: /想你|喜欢你|爱你|抱抱|么么|谢谢你|你真好|心疼你/, deltas: { happy: 0.4, pleasure: 0.3, intimacy: 0.08, atEase: 0.2, missing: -0.25, shy: 0.08 } },
  { pattern: /哈哈|嘿嘿|太好了|好开心|好高兴/, deltas: { happy: 0.35, pleasure: 0.25, atEase: 0.1 } },
  { pattern: /滚|讨厌你|烦死了|闭嘴|你有病|神经病/, deltas: { angry: 0.5, pleasure: -0.4, aggrieved: 0.25, atEase: -0.3, happy: -0.2 } },
  { pattern: /不理我|你都不|敷衍|凭什么|委屈|忘了我/, deltas: { aggrieved: 0.45, pleasure: -0.2, angry: 0.1, atEase: -0.15 } },
  { pattern: /我怕|害怕|好担心|担心你|担心我|睡不着|焦虑|紧张/, deltas: { worried: 0.4, arousal: 0.2, pleasure: -0.1, happy: -0.08 } },
  { pattern: /前女友|前男友|喜欢别人|吃醋|跟别人/, deltas: { jealous: 0.45, pleasure: -0.15, angry: 0.05 } },
  { pattern: /害羞|脸红|不好意思|亲我|想亲/, deltas: { shy: 0.4, arousal: 0.1, happy: 0.05 } },
  { pattern: /晚安|好梦|我在呢|别担心|陪着你|没事的/, deltas: { atEase: 0.3, arousal: -0.25, worried: -0.2, pleasure: 0.1 } },
];

const EVENTS: readonly EventRule[] = [
  { kind: "exam", pattern: /考试|测验|考研|高考|答辩/ },
  { kind: "interview", pattern: /面试/ },
  { kind: "health", pattern: /复诊|手术|住院|生病|不舒服|发烧|医院/ },
  { kind: "travel", pattern: /出差|航班|旅行/ },
  { kind: "birthday", pattern: /生日/ },
  { kind: "plan", pattern: /明天见|明早|今晚见|约好|记得提醒/ },
];

export function scoreUtterance(turn: Pick<TurnRecord, "role" | "content">): EmotionScore {
  const deltas = zeroDeltas();
  if (turn.role !== "user" && turn.role !== "assistant") return { deltas };
  for (const impulse of IMPULSES) {
    if (!impulse.pattern.test(turn.content)) continue;
    for (const key of VECTOR_KEYS) {
      const amount = impulse.deltas[key];
      if (amount !== undefined) deltas[key] += amount;
    }
  }
  if (turn.role !== "user") return { deltas };
  for (const event of EVENTS) {
    const match = event.pattern.exec(turn.content);
    if (!match || match.index === undefined) continue;
    return { deltas, event: { kind: event.kind, note: excerpt(turn.content, match.index, match[0].length) } };
  }
  return { deltas };
}

export function excerpt(content: string, index: number, length: number): string {
  const start = Math.max(0, index - 12);
  const end = Math.min(content.length, index + length + 24);
  return sanitizeNote(content.slice(start, end));
}

export function sanitizeNote(value: string): string {
  const cleaned = value
    .replaceAll("\u2060", "")
    .replaceAll("\u200b", "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}
