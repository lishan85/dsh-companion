/**
 * Deterministic important-event detector.
 *
 * A hit stores the whole turn. Later layers may quote it, and they may not
 * replace it with a shorter paraphrase. There is no randomness and no network.
 *
 * @module dsh-companion/diary/events
 */

import type { TurnRecord } from "../types.js";

export interface DetectedEvent {
  kind: string;
  verbatim: string;
}

interface EventRule {
  kind: string;
  pattern: RegExp;
}

const RULES: readonly EventRule[] = [
  { kind: "exam", pattern: /考试|测验|考研|高考|答辩/ },
  { kind: "interview", pattern: /面试/ },
  { kind: "health", pattern: /复诊|手术|住院|生病|不舒服|发烧|医院/ },
  { kind: "travel", pattern: /出差|航班|旅行/ },
  { kind: "birthday", pattern: /生日/ },
  { kind: "plan", pattern: /明天见|明早|今晚见|约好|记得提醒/ },
  { kind: "promise", pattern: /答应|发誓|保证|一定要记得/ },
  { kind: "first", pattern: /第一次|初次见面|头一回/ },
  { kind: "secret", pattern: /这是秘密|不要告诉别人|别告诉别人/ },
  { kind: "loss", pattern: /去世|过世|分手了|离婚/ },
  { kind: "named", pattern: /我养了|我叫|名字叫|它叫/ },
];

export function detectImportantEvent(turn: Pick<TurnRecord, "role" | "content">): DetectedEvent | undefined {
  if (turn.role !== "user" && turn.role !== "assistant") return undefined;
  const content = turn.content.replaceAll("\u2060", "").trim();
  if (content.length === 0) return undefined;
  for (const rule of RULES) {
    if (!rule.pattern.test(content)) continue;
    return { kind: rule.kind, verbatim: turn.content };
  }
  return undefined;
}
