/**
 * Deterministic diary prose.
 *
 * Ordinary turns can be shortened. Important events are appended in full by
 * {@link appendMissing}, so a weekly or monthly page cannot drop them.
 *
 * @module dsh-companion/diary/fallback
 */

import type { TurnRecord, TurnRole } from "../types.js";
import { chineseDay } from "./periods.js";
import type { DiaryDraft, DiaryEntry, DiaryEvent } from "./types.js";

export const VERBATIM_MARK = "这些事我按原话留着，不缩成一句。";

const FORBIDDEN = /根据记录|检索结果|交接/;

export function acceptableDiary(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 8_000) return false;
  if (trimmed.includes("\u2060")) return false;
  if (FORBIDDEN.test(trimmed)) return false;
  return true;
}

export function narrativeHead(text: string): string {
  const index = text.indexOf(VERBATIM_MARK);
  const head = index >= 0 ? text.slice(0, index) : text;
  return head.trim();
}

export function verbatimAppendix(events: readonly DiaryEvent[]): string {
  if (events.length === 0) return "";
  const lines = [VERBATIM_MARK];
  for (const event of events) lines.push(speak(event.role, event.verbatim));
  return lines.join("\n");
}

export function renderDiarySnippet(entry: DiaryEntry, events: readonly DiaryEvent[]): string {
  const lead = entry.layer === "day"
    ? "我翻到自己写过的一篇日记。"
    : entry.layer === "week"
      ? "我翻到自己写过的一周。"
      : "我翻到自己写过的一个月。";
  return `${lead}\n${appendMissing(entry.text, events)}`;
}

export function appendMissing(narrative: string, events: readonly DiaryEvent[]): string {
  const body = narrative.trim();
  const missing = events.filter((event) => !body.includes(event.verbatim));
  const appendix = verbatimAppendix(missing);
  if (appendix.length === 0) return body;
  return `${body}\n${appendix}`;
}

export function fallbackNarrative(draft: DiaryDraft): string {
  if (draft.layer === "day") return fallbackDay(draft);
  if (draft.layer === "week") return fallbackWeek(draft);
  return fallbackMonth(draft);
}

function fallbackDay(draft: DiaryDraft): string {
  const lines = [`${chineseDay(draft.periodKey)}，我还记得这一天。`];
  const covered = new Set(draft.events.map((event) => event.turnId));
  const ordinary = draft.turns.filter((turn) => !covered.has(turn.id));
  const shown = ordinary.slice(0, 24);
  for (const turn of shown) lines.push(speak(turn.role, clip(turn.content, 180)));
  if (ordinary.length > shown.length) lines.push("这一天后面还有一些闲话，我没有逐句写进日记。");
  if (shown.length === 0) lines.push("这一天留下的，是几件我不肯缩写的事。");
  return lines.join("\n");
}

function fallbackWeek(draft: DiaryDraft): string {
  const lines = [`这一周（${draft.periodKey}）我是这样过的。`];
  for (const day of draft.days) {
    lines.push(`${chineseDay(day.periodKey)}：${clip(narrativeHead(day.text), 160)}`);
  }
  if (draft.days.length === 0) lines.push("这几天我还没写成日记。");
  return lines.join("\n");
}

function fallbackMonth(draft: DiaryDraft): string {
  const lines = [`这个月（${draft.periodKey}）我记得这几周。`];
  for (const week of draft.weeks) {
    lines.push(`${week.periodKey}：${clip(narrativeHead(week.text), 120)}`);
  }
  if (draft.weeks.length === 0) lines.push("这几周的日记还没叠好。");
  return lines.join("\n");
}

function speak(role: TurnRole, content: string): string {
  const verb = role === "user" ? "你说" : "我说";
  return `${verb}：「${content}」`;
}

export function clip(text: string, room: number): string {
  if (room <= 0) return "";
  let out = "";
  for (const point of text) {
    if (out.length + point.length > room) break;
    out += point;
  }
  return out.length < text.length ? `${out}…` : out;
}

export function materialOf(draft: DiaryDraft): string {
  if (draft.layer === "day") return turnsMaterial(draft.turns, draft.events);
  if (draft.layer === "week") {
    return draft.days.map((day) => `${day.periodKey}\n${clip(narrativeHead(day.text), 180)}`).join("\n\n");
  }
  return draft.weeks.map((week) => `${week.periodKey}\n${clip(narrativeHead(week.text), 140)}`).join("\n\n");
}

function turnsMaterial(turns: readonly TurnRecord[], events: readonly DiaryEvent[]): string {
  const covered = new Set(events.map((event) => event.turnId));
  const lines: string[] = [];
  for (const turn of turns) {
    if (covered.has(turn.id)) continue;
    lines.push(speak(turn.role, clip(turn.content, 180)));
    if (lines.length >= 24) break;
  }
  return lines.join("\n");
}
