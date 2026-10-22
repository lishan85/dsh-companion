/**
 * Shared types for the multi-dimensional emotion model.
 *
 * PAD lives in [-1, 1]. Discrete emotions and intimacy live in [0, 1].
 * Intimacy is stored beside the mood but moves on a slower clock and is not
 * one of the spoken dimensions.
 *
 * @module dsh-companion/emotion/types
 */

export const PAD_KEYS = ["pleasure", "arousal", "dominance"] as const;
export const DISCRETE_KEYS = [
  "happy", "missing", "aggrieved", "worried", "jealous", "shy", "angry", "atEase",
] as const;
export const VECTOR_KEYS = [...PAD_KEYS, ...DISCRETE_KEYS, "intimacy"] as const;
export const THRESHOLD_KEYS = ["missing", "worried", "aggrieved", "jealous", "angry"] as const;

export type PadKey = (typeof PAD_KEYS)[number];
export type DiscreteKey = (typeof DISCRETE_KEYS)[number];
export type VectorKey = (typeof VECTOR_KEYS)[number];
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

/** One fully-populated mood. Callers never pass a partial vector. */
export interface EmotionVector {
  pleasure: number;
  arousal: number;
  dominance: number;
  happy: number;
  missing: number;
  aggrieved: number;
  worried: number;
  jealous: number;
  shy: number;
  angry: number;
  atEase: number;
  intimacy: number;
}

/** Proposed impulse before inertia. Every field is present; unused axes are 0. */
export interface EmotionDeltas {
  pleasure: number;
  arousal: number;
  dominance: number;
  happy: number;
  missing: number;
  aggrieved: number;
  worried: number;
  jealous: number;
  shy: number;
  angry: number;
  atEase: number;
  intimacy: number;
}

export interface RememberedEvent {
  kind: string;
  note: string;
}

export interface EmotionScore {
  deltas: EmotionDeltas;
  event?: RememberedEvent;
}

export interface DimensionDynamics {
  baseline: number;
  /** Exponential rate toward the baseline, per hour. */
  decayPerHour: number;
  /** 0 applies a delta in full. 1 refuses to move. */
  inertia: number;
}

export interface EmotionDynamics {
  pleasure: DimensionDynamics;
  arousal: DimensionDynamics;
  dominance: DimensionDynamics;
  happy: DimensionDynamics;
  missing: DimensionDynamics;
  aggrieved: DimensionDynamics;
  worried: DimensionDynamics;
  jealous: DimensionDynamics;
  shy: DimensionDynamics;
  angry: DimensionDynamics;
  atEase: DimensionDynamics;
  intimacy: DimensionDynamics;
  /** While the user is outside the presence window, missing relaxes toward this. */
  missingAbsenceTarget: number;
  missingAbsenceDecayPerHour: number;
  /** After a user turn, this long still counts as "here" for missing. */
  presenceWindowMs: number;
  /** Extra missing impulse on a user turn, before inertia. Negative pulls it down. */
  presenceMissingDelta: number;
  /** Assistant utterances move the mood by this fraction of a user utterance. */
  assistantScale: number;
  maxDelta: number;
  maxIntimacyDelta: number;
}

export interface QuietHours {
  timeZone: string;
  /** Inclusive start, `HH:MM` in `timeZone`. Equal to `end` disables quiet hours. */
  start: string;
  /** Exclusive end, `HH:MM`. A start after the end wraps past midnight. */
  end: string;
}

export interface ProactiveSettings {
  enabled: boolean;
  dailyCap: number;
  minGapMs: number;
  quiet: QuietHours;
  followUpHour: number;
  followUpMinute: number;
  hysteresis: number;
  thresholds: Record<ThresholdKey, number>;
}

export interface EmotionRuntime {
  enabled: boolean;
  dynamics: EmotionDynamics;
  proactive: ProactiveSettings;
}

export interface EmotionStateRow {
  personId: string;
  vector: EmotionVector;
  updatedAt: number;
  lastUserAt: number | null;
}

export interface EmotionHistoryRow {
  id: number;
  personId: string;
  ts: number;
  turnId: number | null;
  reason: string;
  scorer: string;
  vector: EmotionVector;
}

export interface FollowupRow {
  id: number;
  personId: string;
  turnId: number | null;
  createdAt: number;
  dueAt: number;
  kind: string;
  note: string;
  status: string;
}

export interface ProactiveRow {
  id: number;
  personId: string;
  sessionId: string;
  createdAt: number;
  dueAt: number;
  kind: "threshold" | "followup";
  dimension: string;
  followupId: number | null;
  text: string;
  status: string;
  deliveredAt: number | null;
}

export function zeroDeltas(): EmotionDeltas {
  return {
    pleasure: 0,
    arousal: 0,
    dominance: 0,
    happy: 0,
    missing: 0,
    aggrieved: 0,
    worried: 0,
    jealous: 0,
    shy: 0,
    angry: 0,
    atEase: 0,
    intimacy: 0,
  };
}

export function isThresholdKey(value: string): value is ThresholdKey {
  return (THRESHOLD_KEYS as readonly string[]).includes(value);
}
