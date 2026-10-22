/**
 * Time decay, inertia, and the slow intimacy clock.
 *
 * Missing is the one axis whose target flips: inside the presence window it
 * relaxes toward its baseline, and outside it grows toward
 * `missingAbsenceTarget`. Every other axis, including intimacy, relaxes
 * toward its own baseline. Intimacy uses a much smaller decay and a higher
 * inertia, so one warm sentence cannot drag it across the scale.
 *
 * @module dsh-companion/emotion/dynamics
 */

import {
  PAD_KEYS,
  VECTOR_KEYS,
  type DimensionDynamics,
  type EmotionDeltas,
  type EmotionDynamics,
  type EmotionVector,
  type VectorKey,
} from "./types.js";

const PAD = new Set<string>(PAD_KEYS);

export const DEFAULT_DYNAMICS: EmotionDynamics = {
  pleasure: axis(0.15, 0.15, 0.45),
  arousal: axis(-0.1, 0.18, 0.4),
  dominance: axis(-0.05, 0.12, 0.5),
  happy: axis(0.32, 0.22, 0.35),
  missing: axis(0.15, 0.2, 0.25),
  aggrieved: axis(0.05, 0.16, 0.4),
  worried: axis(0.08, 0.18, 0.35),
  jealous: axis(0.02, 0.14, 0.45),
  shy: axis(0.12, 0.25, 0.3),
  angry: axis(0.02, 0.08, 0.55),
  atEase: axis(0.45, 0.2, 0.35),
  intimacy: axis(0.15, 0.001, 0.75),
  missingAbsenceTarget: 1,
  missingAbsenceDecayPerHour: 0.05,
  presenceWindowMs: 30 * 60 * 1000,
  presenceMissingDelta: -0.4,
  assistantScale: 0.25,
  maxDelta: 0.6,
  maxIntimacyDelta: 0.08,
};

export function baselineVector(dynamics: EmotionDynamics = DEFAULT_DYNAMICS): EmotionVector {
  return {
    pleasure: dynamics.pleasure.baseline,
    arousal: dynamics.arousal.baseline,
    dominance: dynamics.dominance.baseline,
    happy: dynamics.happy.baseline,
    missing: dynamics.missing.baseline,
    aggrieved: dynamics.aggrieved.baseline,
    worried: dynamics.worried.baseline,
    jealous: dynamics.jealous.baseline,
    shy: dynamics.shy.baseline,
    angry: dynamics.angry.baseline,
    atEase: dynamics.atEase.baseline,
    intimacy: dynamics.intimacy.baseline,
  };
}

/**
 * Exponential relaxation. `elapsedMs <= 0` or a zero rate returns `value`.
 * A day of missing at the default absence rate is a large, testable step;
 * a day of intimacy at its default rate is not.
 */
export function relax(value: number, target: number, decayPerHour: number, elapsedMs: number): number {
  if (!Number.isFinite(value)) return target;
  if (elapsedMs <= 0 || decayPerHour <= 0) return value;
  const keep = Math.exp(-decayPerHour * (elapsedMs / 3_600_000));
  return target + (value - target) * keep;
}

export function projectEmotion(
  state: EmotionVector,
  updatedAt: number,
  lastUserAt: number | null,
  now: number,
  dynamics: EmotionDynamics,
): EmotionVector {
  const elapsed = now > updatedAt ? now - updatedAt : 0;
  const present = lastUserAt !== null && now >= lastUserAt && (now - lastUserAt) <= dynamics.presenceWindowMs;
  const next = { ...state };
  for (const key of VECTOR_KEYS) {
    next[key] = projectAxis(key, state[key], elapsed, present, dynamics);
  }
  return next;
}

export function applyEmotionDeltas(
  state: EmotionVector,
  deltas: EmotionDeltas,
  dynamics: EmotionDynamics,
): EmotionVector {
  const next = { ...state };
  for (const key of VECTOR_KEYS) {
    const spec = specOf(dynamics, key);
    const limit = key === "intimacy" ? dynamics.maxIntimacyDelta : dynamics.maxDelta;
    const delta = clamp(finite(deltas[key]), -limit, limit);
    const min = PAD.has(key) ? -1 : 0;
    next[key] = clamp(state[key] + delta * (1 - spec.inertia), min, 1);
  }
  return next;
}

export function scaleDeltas(deltas: EmotionDeltas, scale: number): EmotionDeltas {
  const next = { ...deltas };
  for (const key of VECTOR_KEYS) next[key] = finite(deltas[key]) * scale;
  return next;
}

export function addDeltas(left: EmotionDeltas, right: EmotionDeltas): EmotionDeltas {
  const next = { ...left };
  for (const key of VECTOR_KEYS) next[key] = finite(left[key]) + finite(right[key]);
  return next;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function projectAxis(
  key: VectorKey,
  value: number,
  elapsed: number,
  present: boolean,
  dynamics: EmotionDynamics,
): number {
  if (key === "missing" && !present) {
    return clamp(
      relax(value, dynamics.missingAbsenceTarget, dynamics.missingAbsenceDecayPerHour, elapsed),
      0,
      1,
    );
  }
  const spec = specOf(dynamics, key);
  const min = PAD.has(key) ? -1 : 0;
  return clamp(relax(value, spec.baseline, spec.decayPerHour, elapsed), min, 1);
}

function specOf(dynamics: EmotionDynamics, key: VectorKey): DimensionDynamics {
  return dynamics[key];
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function axis(baseline: number, decayPerHour: number, inertia: number): DimensionDynamics {
  return { baseline, decayPerHour, inertia };
}
