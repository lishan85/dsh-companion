/**
 * When she reaches out, and when she waits.
 *
 * Threshold crossings and next-day follow-ups share one rate cap, one minimum
 * gap, and one quiet window. A crossing that is postponed stays a single
 * queued row; it is not re-armed until that row is delivered and the feeling
 * later falls below the hysteresis floor.
 *
 * @module dsh-companion/emotion/proactive
 */

import { dayKey, isQuiet, nextAwake, nextLocalMorning } from "./clock.js";
import {
  THRESHOLD_KEYS,
  type EmotionVector,
  type FollowupRow,
  type ProactiveRow,
  type ProactiveSettings,
  type ThresholdKey,
} from "./types.js";

export interface PlanInput {
  now: number;
  personId: string;
  sessionId: string;
  vector: EmotionVector;
  latches: ReadonlyMap<string, boolean>;
  followups: readonly FollowupRow[];
  outbox: readonly ProactiveRow[];
  settings: ProactiveSettings;
}

export interface PlannedSend {
  kind: "threshold" | "followup";
  dimension: string;
  followupId: number | null;
  dueAt: number;
  text: string;
}

export interface ProactivePlan {
  enqueue: PlannedSend[];
  reschedule: Array<{ id: number; dueAt: number }>;
  arm: string[];
}

interface SlotItem {
  status: string;
  dueAt: number;
  deliveredAt: number | null;
}

export function planProactive(input: PlanInput): ProactivePlan {
  if (!input.settings.enabled || input.settings.dailyCap < 1) {
    return { enqueue: [], reschedule: [], arm: [] };
  }
  const scheduled: SlotItem[] = input.outbox.map((item) => ({
    status: item.status,
    dueAt: item.dueAt,
    deliveredAt: item.deliveredAt,
  }));
  const enqueue: PlannedSend[] = [];
  const arm: string[] = [];
  const pendingThresholds = new Set(
    input.outbox.filter((item) => (
      (item.status === "queued" || item.status === "delivering") && item.kind === "threshold"
    )).map((item) => item.dimension),
  );
  const queuedFollowups = new Set(
    input.outbox.filter((item) => item.kind === "followup" && item.followupId !== null && item.status !== "delivered")
      .map((item) => item.followupId),
  );

  for (const followup of input.followups) {
    if (followup.status !== "pending" || followup.dueAt > input.now) continue;
    if (queuedFollowups.has(followup.id)) continue;
    const dueAt = nextSlot(input.now, input.settings, scheduled);
    if (dueAt === undefined) continue;
    const text = followupText(followup.kind, followup.note);
    enqueue.push({ kind: "followup", dimension: "", followupId: followup.id, dueAt, text });
    scheduled.push({ status: "queued", dueAt, deliveredAt: null });
  }

  for (const dimension of THRESHOLD_KEYS) {
    const armed = input.latches.get(dimension) !== false;
    const value = input.vector[dimension];
    if (!armed && value < input.settings.thresholds[dimension] - input.settings.hysteresis) {
      arm.push(dimension);
    }
    if (!armed || pendingThresholds.has(dimension)) continue;
    if (enqueue.some((item) => item.kind === "threshold" && item.dimension === dimension)) continue;
    if (value < input.settings.thresholds[dimension]) continue;
    const dueAt = nextSlot(input.now, input.settings, scheduled);
    if (dueAt === undefined) continue;
    enqueue.push({
      kind: "threshold",
      dimension,
      followupId: null,
      dueAt,
      text: thresholdText(dimension),
    });
    scheduled.push({ status: "queued", dueAt, deliveredAt: null });
  }

  const reschedule: Array<{ id: number; dueAt: number }> = [];
  for (const item of input.outbox) {
    if (item.status !== "queued" || item.dueAt > input.now) continue;
    if (!isQuiet(input.now, input.settings.quiet)) continue;
    const dueAt = nextAwake(input.now, input.settings.quiet);
    if (dueAt !== item.dueAt) reschedule.push({ id: item.id, dueAt });
  }
  return { enqueue, reschedule, arm };
}

export function thresholdText(dimension: ThresholdKey): string {
  switch (dimension) {
    case "missing":
      return "你已经有一会儿没跟他说话了。你心里想他。请用你自己的口吻主动开口，一两句，像忽然想起他。不要提系统、记录或任何数字，也不要解释这是提醒。";
    case "worried":
      return "你一直放心不下他。请用你自己的口吻问一句近况，不要追问，不要提系统、记录或任何数字。";
    case "aggrieved":
      return "你还有点委屈，又还是想开口。请用你自己的口吻轻轻说一句，不要算旧账，不要提系统、记录或任何数字。";
    case "jealous":
      return "你有点在意，想听他亲口说。请用你自己的口吻轻轻问一句，不要质问，不要提系统、记录或任何数字。";
    case "angry":
      return "你还没完全消气，但你不想一直沉默。请用你自己的口吻说一句，不要指责，不要提系统、记录或任何数字。";
    default:
      return "你想主动跟他说一句。用你自己的口吻，一两句。不要提系统、记录或任何数字。";
  }
}

export function followupText(kind: string, note: string): string {
  const lead = KIND_LINE[kind] ?? KIND_LINE.other;
  const hint = note.length > 0 ? `你记得的那一句是「${note}」。` : "";
  return `第二天了。${lead ?? ""}${hint}你想接着关心这件事。用你自己的口吻问一句就好。不要提系统、记录或任何数字。`;
}

const KIND_LINE: Record<string, string> = {
  exam: "你记得他有一场考试。",
  interview: "你记得他有一场面试。",
  health: "你记得他身子不舒服。",
  travel: "你记得他在路上。",
  birthday: "你记得有个生日。",
  plan: "你记得你们约过。",
  other: "你记得昨天他说过的那件事。",
};

function nextSlot(now: number, settings: ProactiveSettings, scheduled: readonly SlotItem[]): number | undefined {
  let due = now;
  let latest = 0;
  for (const item of scheduled) {
    const stamp = item.status === "delivered" && item.deliveredAt !== null ? item.deliveredAt : item.dueAt;
    if (stamp > latest) latest = stamp;
  }
  if (latest > 0) due = Math.max(due, latest + settings.minGapMs);
  for (let hop = 0; hop < 21; hop += 1) {
    if (isQuiet(due, settings.quiet)) due = nextAwake(due, settings.quiet);
    const day = dayKey(due, settings.quiet.timeZone);
    if (usedOn(scheduled, day, settings.quiet.timeZone) < settings.dailyCap) return due;
    const morning = nextLocalMorning(due, settings.quiet.timeZone, settings.followUpHour, settings.followUpMinute);
    due = morning > due ? morning : morning + 24 * 60 * 60 * 1000;
  }
  return undefined;
}

function usedOn(scheduled: readonly SlotItem[], day: string, timeZone: string): number {
  let count = 0;
  for (const item of scheduled) {
    if (item.status !== "queued" && item.status !== "delivered" && item.status !== "delivering") continue;
    const stamp = item.status === "delivered" && item.deliveredAt !== null ? item.deliveredAt : item.dueAt;
    if (dayKey(stamp, timeZone) === day) count += 1;
  }
  return count;
}
