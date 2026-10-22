/**
 * Diary rows. A sealed entry is prose in her voice. An event is a raw turn
 * kept verbatim so a weekly or monthly rollup cannot compress it away.
 *
 * @module dsh-companion/diary/types
 */

import type { TurnRecord, TurnRole } from "../types.js";

export type DiaryLayer = "day" | "week" | "month";
export type DiarySource = "pending" | "model" | "fallback";
export type DiaryStatus = "sealing" | "sealed";

export interface DiaryEntry {
  id: number;
  personId: string;
  layer: DiaryLayer;
  periodKey: string;
  text: string;
  source: DiarySource;
  status: DiaryStatus;
  createdAt: number;
  updatedAt: number;
}

export interface DiaryEvent {
  id: number;
  personId: string;
  turnId: number;
  ts: number;
  /** Local day key, `YYYY-MM-DD`. */
  periodKey: string;
  role: TurnRole;
  kind: string;
  verbatim: string;
}

export type DiaryClaim = "owned" | "sealed" | "busy";

/** Source material for one page. Ordinary prose may be shortened; events may not. */
export interface DiaryDraft {
  layer: DiaryLayer;
  periodKey: string;
  turns: readonly TurnRecord[];
  days: readonly DiaryEntry[];
  weeks: readonly DiaryEntry[];
  events: readonly DiaryEvent[];
}
