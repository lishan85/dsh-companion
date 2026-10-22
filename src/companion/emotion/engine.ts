/**
 * Persisted emotion model.
 *
 * After each turn the engine decays the stored vector to that turn's clock,
 * asks the cheap-model scorer when one is configured, and otherwise uses the
 * deterministic rules. The resulting vector and a history row commit in one
 * transaction. `line` projects decay for display and does not write.
 *
 * @module dsh-companion/emotion/engine
 */

import { CompanionError } from "../errors.js";
import type { CompanionStore } from "../store.js";
import type { TurnRecord } from "../types.js";
import type { EmotionModel } from "../stubs.js";
import { nextLocalMorning, isQuiet, nextAwake } from "./clock.js";
import { DEFAULT_DYNAMICS, addDeltas, applyEmotionDeltas, baselineVector, projectEmotion, scaleDeltas } from "./dynamics.js";
import { renderInnerMonologue } from "./express.js";
import type { EmotionScorer } from "./model-scorer.js";
import { planProactive } from "./proactive.js";
import { sanitizeNote, scoreUtterance } from "./rules.js";
import { drainProactiveQueue, type ProactiveDeliverer } from "./deliver.js";
import {
  zeroDeltas,
  type EmotionDeltas,
  type EmotionRuntime,
  type EmotionScore,
  type EmotionStateRow,
  type ProactiveSettings,
  type RememberedEvent,
} from "./types.js";

export interface EmotionEngineOptions {
  scorer?: EmotionScorer;
  deliver?: ProactiveDeliverer;
  /** Clock for proactive evaluation triggered by `observe`. Tests pass a fixed clock. */
  clock?: () => number;
  /** Overrides the built-in dynamics. Operational knobs live on `runtime`. */
  runtime?: EmotionRuntime;
}

export function defaultEmotionRuntime(overrides: Partial<EmotionRuntime> = {}): EmotionRuntime {
  const proactive: ProactiveSettings = overrides.proactive ?? {
    enabled: true,
    dailyCap: 2,
    minGapMs: 6 * 60 * 60 * 1000,
    quiet: { timeZone: "Asia/Shanghai", start: "23:00", end: "08:00" },
    followUpHour: 9,
    followUpMinute: 0,
    hysteresis: 0.12,
    thresholds: { missing: 0.72, worried: 0.75, aggrieved: 0.7, jealous: 0.68, angry: 0.7 },
  };
  return {
    enabled: overrides.enabled ?? true,
    dynamics: overrides.dynamics ?? DEFAULT_DYNAMICS,
    proactive,
  };
}

export class PersistedEmotionModel implements EmotionModel {
  readonly #store: CompanionStore;
  readonly #runtime: EmotionRuntime;
  readonly #scorer: EmotionScorer | undefined;
  readonly #deliver: ProactiveDeliverer | undefined;
  readonly #clock: () => number;
  #chain: Promise<void> = Promise.resolve();
  #fault: unknown;

  constructor(store: CompanionStore, options: EmotionEngineOptions = {}) {
    this.#store = store;
    this.#runtime = options.runtime ?? defaultEmotionRuntime();
    this.#scorer = options.scorer;
    this.#deliver = options.deliver;
    this.#clock = options.clock ?? Date.now;
  }

  line(personId: string, now: number): string {
    this.#raise();
    if (!this.#runtime.enabled) return "";
    const row = this.#store.getEmotion(personId);
    if (!row) return "";
    const projected = projectEmotion(row.vector, row.updatedAt, row.lastUserAt, now, this.#runtime.dynamics);
    return renderInnerMonologue(projected);
  }

  observe(turn: TurnRecord): Promise<void> {
    if (!this.#runtime.enabled) return Promise.resolve();
    const job = this.#chain.then(() => this.#evaluate(turn));
    this.#chain = job.then(() => undefined, (error: unknown) => {
      this.#fault = error;
    });
    return job;
  }

  settle(): Promise<void> {
    return this.#chain;
  }

  evaluateProactive(now: number): Promise<void> {
    const job = this.#chain.then(() => this.#runProactive(now));
    this.#chain = job.then(() => undefined, (error: unknown) => {
      this.#fault = error;
    });
    return job;
  }

  async #evaluate(turn: TurnRecord): Promise<void> {
    requireInstant(turn.ts);
    const previous = this.#store.getEmotion(turn.personId);
    const dynamics = this.#runtime.dynamics;
    const base = previous?.vector ?? baselineVector(dynamics);
    const updatedAt = previous?.updatedAt ?? turn.ts;
    const lastUserAt = previous?.lastUserAt ?? null;
    const decayed = projectEmotion(base, updatedAt, lastUserAt, turn.ts, dynamics);
    const scored = await this.#score(turn, decayed);
    const deltas = impulsesFor(turn, scored.deltas, dynamics);
    const vector = applyEmotionDeltas(decayed, deltas, dynamics);
    const state: EmotionStateRow = {
      personId: turn.personId,
      vector,
      updatedAt: turn.ts,
      lastUserAt: turn.role === "user" ? turn.ts : lastUserAt,
    };
    const followup = turn.role === "user" && scored.event
      ? {
          turnId: turn.id,
          createdAt: turn.ts,
          dueAt: followupDue(turn.ts, this.#runtime.proactive),
          kind: scored.event.kind,
          note: scored.event.note,
        }
      : undefined;
    this.#store.commitEmotion({
      state,
      history: { ts: turn.ts, turnId: turn.id, reason: "turn", scorer: scored.scorer },
      ...(followup ? { followup } : {}),
    });
    await this.#runProactive(this.#clock());
  }

  async #runProactive(now: number): Promise<void> {
    this.#raise();
    if (!this.#runtime.enabled || !this.#runtime.proactive.enabled) return;
    requireInstant(now);
    for (const personId of this.#store.emotionPeople()) this.#planPerson(personId, now);
    if (this.#deliver) await drainProactiveQueue(this.#store, now, this.#deliver);
  }

  async #score(turn: TurnRecord, state: EmotionStateRow["vector"]): Promise<EmotionScore & { scorer: string }> {
    if (this.#scorer) {
      try {
        const scored = await this.#scorer.score({ turn, state });
        if (scored) return { ...normalizeScore(scored), scorer: token(this.#scorer.id) };
      } catch {
        // The rule scorer is the offline fallback. The failure itself is not stored.
      }
    }
    return { ...scoreUtterance(turn), scorer: "rules" };
  }

  #planPerson(personId: string, now: number): void {
    const row = this.#store.getEmotion(personId);
    if (!row) return;
    const projected = projectEmotion(row.vector, row.updatedAt, row.lastUserAt, now, this.#runtime.dynamics);
    const sessionId = this.#store.recentTurns(personId, 1)[0]?.sessionId ?? "";
    const plan = planProactive({
      now,
      personId,
      sessionId,
      vector: projected,
      latches: this.#store.emotionLatches(personId),
      followups: this.#store.emotionFollowups(personId),
      outbox: this.#store.proactiveQueue(personId),
      settings: this.#runtime.proactive,
    });
    const crossed = plan.enqueue.some((item) => item.kind === "threshold");
    this.#store.applyProactivePlan({
      personId,
      ...(crossed
        ? {
            state: { personId, vector: projected, updatedAt: now, lastUserAt: row.lastUserAt },
            history: { ts: now, turnId: null, reason: "proactive", scorer: "decay" },
          }
        : {}),
      arm: plan.arm,
      reschedule: plan.reschedule,
      enqueue: plan.enqueue.map((item) => ({
        sessionId,
        createdAt: now,
        dueAt: item.dueAt,
        kind: item.kind,
        dimension: item.dimension,
        followupId: item.followupId,
        text: item.text,
      })),
      markFollowupsQueued: plan.enqueue.flatMap((item) => item.followupId === null ? [] : [item.followupId]),
    });
  }

  #raise(): void {
    if (!this.#fault) return;
    const error = new CompanionError(
      "emotion",
      "dsh-companion: the previous emotion update failed; refusing to invent a mood",
      { cause: this.#fault },
    );
    throw error;
  }
}

function impulsesFor(turn: TurnRecord, deltas: EmotionDeltas, dynamics: EmotionRuntime["dynamics"]): EmotionDeltas {
  const scaled = turn.role === "assistant" ? scaleDeltas(deltas, dynamics.assistantScale) : deltas;
  if (turn.role !== "user") return scaled;
  const pulse = zeroDeltas();
  pulse.missing = dynamics.presenceMissingDelta;
  return addDeltas(scaled, pulse);
}

function normalizeScore(score: EmotionScore): EmotionScore {
  if (!score.event) return score;
  const event: RememberedEvent = { kind: token(score.event.kind), note: sanitizeNote(score.event.note) };
  return { deltas: score.deltas, event };
}

function followupDue(turnTs: number, settings: ProactiveSettings): number {
  let due = nextLocalMorning(turnTs, settings.quiet.timeZone, settings.followUpHour, settings.followUpMinute);
  if (isQuiet(due, settings.quiet)) due = nextAwake(due, settings.quiet);
  return due;
}

function token(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "model";
}

function requireInstant(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CompanionError("emotion", "dsh-companion: emotion timestamps must be non-negative safe integers");
  }
}
