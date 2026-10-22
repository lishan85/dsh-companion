/**
 * Inner monologue for the volatile recall segment.
 *
 * The top two or three salient dimensions become one first-person sentence.
 * Bands are coarse on purpose: a tiny float change inside a band keeps the
 * same words, so the volatile prefix can stay stable. Numbers, axis names,
 * and the stable persona are never part of this string.
 *
 * @module dsh-companion/emotion/express
 */

import { PAD_KEYS, type EmotionVector, type VectorKey } from "./types.js";

const SPEECH_FLOOR = 0.55;
const PAD_FLOOR = 0.4;
const STRONG = 0.75;

const ORDER: readonly VectorKey[] = [
  "missing", "worried", "aggrieved", "angry", "jealous", "shy", "happy", "atEase",
  "pleasure", "arousal", "dominance",
];

const PAD = new Set<string>(PAD_KEYS);

const PHRASE: Record<string, { mild: string; strong: string }> = {
  happy: { mild: "有点开心", strong: "心里暖暖的" },
  missing: { mild: "有点想你", strong: "这阵子一直在想你" },
  aggrieved: { mild: "有点委屈", strong: "委屈得不想先开口" },
  worried: { mild: "有点放心不下", strong: "一直放心不下" },
  jealous: { mild: "有点在意", strong: "在意得吃味" },
  shy: { mild: "有点不好意思", strong: "想着就不好意思" },
  angry: { mild: "还没消气", strong: "还在气头上" },
  atEase: { mild: "跟你在一起挺自在", strong: "跟你在一起很自在" },
  pleasureHigh: { mild: "心情软软的", strong: "心情亮亮的" },
  pleasureLow: { mild: "心情有点沉", strong: "心里沉沉的" },
  arousalHigh: { mild: "有点静不下来", strong: "静不下来" },
  arousalLow: { mild: "整个人慢下来了", strong: "懒得着急" },
  dominanceHigh: { mild: "想把话说清楚", strong: "想由我把话说清楚" },
  dominanceLow: { mild: "不想跟你争", strong: "想听你的" },
};

export function renderInnerMonologue(vector: EmotionVector): string {
  const ranked: Array<{ phrase: string; salience: number; order: number }> = [];
  for (const key of ORDER) {
    if (key === "intimacy") continue;
    const salience = salienceOf(key, vector[key]);
    if (salience === undefined) continue;
    const phrase = phraseOf(key, vector[key]);
    if (phrase.length === 0) continue;
    ranked.push({ phrase, salience, order: ORDER.indexOf(key) });
  }
  ranked.sort((left, right) => right.salience - left.salience || left.order - right.order);
  const picked = ranked.slice(0, 3);
  if (picked.length === 0) return "";
  return `我${picked.map((item) => item.phrase).join("，")}。`;
}

function salienceOf(key: VectorKey, value: number): number | undefined {
  if (PAD.has(key)) {
    const magnitude = Math.abs(value);
    return magnitude >= PAD_FLOOR ? magnitude : undefined;
  }
  return value >= SPEECH_FLOOR ? value : undefined;
}

function phraseOf(key: VectorKey, value: number): string {
  if (PAD.has(key)) {
    const strong = Math.abs(value) >= STRONG;
    const direction = value >= 0 ? "High" : "Low";
    const row = PHRASE[`${key}${direction}`];
    return row ? (strong ? row.strong : row.mild) : "";
  }
  const row = PHRASE[key];
  if (!row) return "";
  return value >= STRONG ? row.strong : row.mild;
}
