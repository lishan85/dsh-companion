/**
 * Daily diary in her voice, rolled up into weeks and months.
 *
 * Raw turns are never deleted. Important events are flagged when the turn is
 * seen and copied verbatim onto every layer that covers them. Sealing runs
 * when the local day rolls over, when she is idle, or on the backstop timer.
 * Sealing a period that is already sealed does nothing.
 *
 * @module dsh-companion/diary/writer
 */

import type { CompanionStore } from "../store.js";
import type { DiaryWriter } from "../stubs.js";
import type { TurnRecord } from "../types.js";
import { detectImportantEvent } from "./events.js";
import { acceptableDiary, appendMissing, fallbackNarrative } from "./fallback.js";
import type { DiaryModel } from "./model.js";
import {
  dayBounds,
  dayKey,
  dayKeysOfWeek,
  monthKey,
  monthKeyFromDay,
  weekKey,
  weekKeyFromDay,
} from "./periods.js";
import type { DiaryDraft, DiaryEntry, DiaryEvent, DiaryLayer } from "./types.js";

const DEFAULT_MAX_DAYS = 31;

export interface DiaryRuntime {
  enabled?: boolean;
  timeZone: string;
  maxDaysPerRun?: number;
  model?: DiaryModel;
  now?: () => number;
}

export class LayeredDiaryWriter implements DiaryWriter {
  readonly #store: CompanionStore;
  readonly #timeZone: string;
  readonly #maxDays: number;
  readonly #model: DiaryModel | undefined;
  readonly #now: () => number;
  readonly #enabled: boolean;
  /** Person ids whose past days were sealed for this local date. */
  readonly #settled = new Map<string, string>();
  #inflight: Promise<void> | undefined;
  #queuedNow: number | undefined;
  #running = false;

  constructor(store: CompanionStore, runtime: DiaryRuntime) {
    this.#store = store;
    this.#timeZone = runtime.timeZone;
    this.#maxDays = runtime.maxDaysPerRun ?? DEFAULT_MAX_DAYS;
    this.#model = runtime.model;
    this.#now = runtime.now ?? Date.now;
    this.#enabled = runtime.enabled ?? true;
  }

  observe(turn: TurnRecord): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    this.#flag(turn);
    const today = dayKey(this.#now(), this.#timeZone);
    const turnDay = dayKey(turn.ts, this.#timeZone);
    if (turnDay < today) this.#settled.delete(turn.personId);
    if (turnDay < today || this.#needsSeal(turn.personId, today)) {
      return this.maintain(this.#now()).then(() => {
        this.#noteSettled(turn.personId, today);
      });
    }
    return Promise.resolve();
  }

  settle(): Promise<void> {
    return this.#inflight ?? Promise.resolve();
  }

  maintain(now: number): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    this.#queuedNow = this.#queuedNow === undefined ? now : Math.max(this.#queuedNow, now);
    if (this.#running) return this.#inflight ?? Promise.resolve();
    this.#running = true;
    const job = this.#drain().finally(() => {
      this.#running = false;
      this.#inflight = undefined;
      if (this.#queuedNow !== undefined) void this.maintain(this.#queuedNow);
    });
    this.#inflight = job;
    return job;
  }

  #needsSeal(personId: string, today: string): boolean {
    if (this.#settled.get(personId) === today) return false;
    return this.#openPast(personId, today);
  }

  #noteSettled(personId: string, today: string): void {
    if (!this.#openPast(personId, today)) this.#settled.set(personId, today);
  }

  #openPast(personId: string, today: string): boolean {
    for (const key of dayKeysOf(this.#store.turnStamps(personId), this.#timeZone)) {
      if (key >= today) continue;
      const entry = this.#store.diaryEntry(personId, "day", key);
      if (entry?.status !== "sealed") return true;
    }
    return false;
  }

  #flag(turn: TurnRecord): void {
    const detected = detectImportantEvent(turn);
    if (!detected) return;
    this.#store.insertDiaryEvent({
      personId: turn.personId,
      turnId: turn.id,
      ts: turn.ts,
      periodKey: dayKey(turn.ts, this.#timeZone),
      role: turn.role,
      kind: detected.kind,
      verbatim: detected.verbatim,
    });
  }

  async #drain(): Promise<void> {
    while (this.#queuedNow !== undefined) {
      const stamp = this.#queuedNow;
      this.#queuedNow = undefined;
      await this.#run(stamp);
    }
  }

  async #run(now: number): Promise<void> {
    const today = dayKey(now, this.#timeZone);
    const thisWeek = weekKey(now, this.#timeZone);
    const thisMonth = monthKey(now, this.#timeZone);
    for (const personId of this.#store.turnPeople()) {
      await this.#sealDays(personId, today, now);
      await this.#sealWeeks(personId, today, thisWeek, now);
      await this.#sealMonths(personId, thisMonth, now);
    }
  }

  async #sealDays(personId: string, today: string, now: number): Promise<void> {
    const keys = dayKeysOf(this.#store.turnStamps(personId), this.#timeZone).filter((key) => key < today);
    let sealed = 0;
    for (const key of keys) {
      if (sealed >= this.#maxDays) return;
      const existing = this.#store.diaryEntry(personId, "day", key);
      if (existing?.status === "sealed") continue;
      const wrote = await this.#sealOne(personId, "day", key, today, now);
      if (wrote) sealed += 1;
    }
  }

  async #sealWeeks(personId: string, today: string, thisWeek: string, now: number): Promise<void> {
    const weeks = new Set<string>();
    for (const key of dayKeysOf(this.#store.turnStamps(personId), this.#timeZone)) {
      if (key >= today) continue;
      const week = weekKeyFromDay(key);
      if (week < thisWeek) weeks.add(week);
    }
    for (const week of [...weeks].sort()) {
      if (!this.#weekReady(personId, week, today)) continue;
      const existing = this.#store.diaryEntry(personId, "week", week);
      if (existing?.status === "sealed") continue;
      await this.#sealOne(personId, "week", week, today, now);
    }
  }

  async #sealMonths(personId: string, thisMonth: string, now: number): Promise<void> {
    const months = new Set<string>();
    for (const day of dayKeysOf(this.#store.turnStamps(personId), this.#timeZone)) {
      const month = monthKeyFromDay(day);
      if (month < thisMonth) months.add(month);
    }
    for (const month of [...months].sort()) {
      if (!this.#monthReady(personId, month)) continue;
      const existing = this.#store.diaryEntry(personId, "month", month);
      if (existing?.status === "sealed") continue;
      await this.#sealOne(personId, "month", month, todayKey(month), now);
    }
  }

  async #sealOne(personId: string, layer: DiaryLayer, periodKey: string, today: string, now: number): Promise<boolean> {
    const draft = this.#draft(personId, layer, periodKey, today);
    if (!draft) return false;
    const claim = this.#store.claimDiary({ personId, layer, periodKey, now });
    if (claim !== "owned") return false;
    try {
      const written = await this.#write(draft);
      const sealed = this.#store.sealDiary({
        personId,
        layer,
        periodKey,
        text: written.text,
        source: written.source,
        now,
      });
      if (!sealed) this.#store.releaseDiary(personId, layer, periodKey);
      return sealed;
    } catch (error) {
      this.#store.releaseDiary(personId, layer, periodKey);
      throw error;
    }
  }

  #draft(personId: string, layer: DiaryLayer, periodKey: string, today: string): DiaryDraft | undefined {
    const events = this.#eventsFor(personId, layer, periodKey);
    if (layer === "day") {
      const bounds = dayBounds(periodKey, this.#timeZone);
      const turns = this.#store.turnsBetween(personId, bounds.start, bounds.end);
      for (const turn of turns) this.#flag(turn);
      const flagged = this.#eventsFor(personId, "day", periodKey);
      if (turns.length === 0 && flagged.length === 0) return undefined;
      return { layer, periodKey, turns, days: [], weeks: [], events: flagged };
    }
    if (layer === "week") {
      const days = this.#sealedDays(personId, periodKey, today);
      if (days.length === 0 && events.length === 0) return undefined;
      return { layer, periodKey, turns: [], days, weeks: [], events };
    }
    const weeks = this.#store.diaryEntries(personId).filter((entry) => (
      entry.layer === "week" && entry.status === "sealed" && weekTouchesMonth(entry.periodKey, periodKey)
    ));
    if (weeks.length === 0 && events.length === 0) return undefined;
    return { layer, periodKey, turns: [], days: [], weeks, events };
  }

  #sealedDays(personId: string, week: string, today: string): DiaryEntry[] {
    const wanted = new Set(dayKeysOfWeek(week).filter((key) => key < today));
    return this.#store.diaryEntries(personId).filter((entry) => (
      entry.layer === "day" && entry.status === "sealed" && wanted.has(entry.periodKey)
    ));
  }

  #weekReady(personId: string, week: string, today: string): boolean {
    const stamps = this.#store.turnStamps(personId);
    for (const key of dayKeysOf(stamps, this.#timeZone)) {
      if (weekKeyFromDay(key) !== week || key >= today) continue;
      const entry = this.#store.diaryEntry(personId, "day", key);
      if (entry?.status !== "sealed") return false;
    }
    return true;
  }

  #monthReady(personId: string, month: string): boolean {
    const stamps = this.#store.turnStamps(personId);
    const weeks = new Set<string>();
    for (const key of dayKeysOf(stamps, this.#timeZone)) {
      if (monthKeyFromDay(key) !== month) continue;
      weeks.add(weekKeyFromDay(key));
    }
    for (const week of weeks) {
      const entry = this.#store.diaryEntry(personId, "week", week);
      if (entry?.status !== "sealed") return false;
    }
    return weeks.size > 0;
  }

  #eventsFor(personId: string, layer: DiaryLayer, periodKey: string): DiaryEvent[] {
    return this.#store.diaryEvents(personId).filter((event) => covers(layer, periodKey, event.periodKey));
  }

  async #write(draft: DiaryDraft): Promise<{ text: string; source: "model" | "fallback" }> {
    let modelText: string | undefined;
    if (this.#model) {
      try {
        modelText = await this.#model.write(draft);
      } catch {
        modelText = undefined;
      }
    }
    if (modelText !== undefined && acceptableDiary(modelText)) {
      return { text: appendMissing(modelText.trim(), draft.events), source: "model" };
    }
    return { text: appendMissing(fallbackNarrative(draft), draft.events), source: "fallback" };
  }
}

function dayKeysOf(stamps: readonly number[], timeZone: string): string[] {
  const keys: string[] = [];
  let previous = "";
  for (const stamp of stamps) {
    const key = dayKey(stamp, timeZone);
    if (key === previous) continue;
    keys.push(key);
    previous = key;
  }
  return keys;
}

function todayKey(month: string): string {
  return `${month}-01`;
}

function covers(layer: DiaryLayer, periodKey: string, day: string): boolean {
  if (layer === "day") return day === periodKey;
  if (layer === "week") return weekKeyFromDay(day) === periodKey;
  return monthKeyFromDay(day) === periodKey;
}

function weekTouchesMonth(week: string, month: string): boolean {
  return dayKeysOfWeek(week).some((day) => monthKeyFromDay(day) === month);
}
