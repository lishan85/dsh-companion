/**
 * Local day, ISO week, and month keys.
 *
 * The week key is computed from the local calendar date, so a retrieval path
 * can group stored day keys without knowing the timezone again.
 *
 * @module dsh-companion/diary/periods
 */

import { CompanionError } from "../errors.js";
import { dayKey, zonedParts, zonedTimeToUtc } from "../emotion/clock.js";

export { dayKey };

export function weekKey(epochMs: number, timeZone: string): string {
  const parts = zonedParts(epochMs, timeZone);
  return isoWeek(parts.year, parts.month, parts.day);
}

export function monthKey(epochMs: number, timeZone: string): string {
  const parts = zonedParts(epochMs, timeZone);
  return `${parts.year}-${pad(parts.month)}`;
}

export function weekKeyFromDay(periodKey: string): string {
  const parts = parseDay(periodKey);
  return isoWeek(parts.year, parts.month, parts.day);
}

export function monthKeyFromDay(periodKey: string): string {
  parseDay(periodKey);
  return periodKey.slice(0, 7);
}

export function dayBounds(periodKey: string, timeZone: string): { start: number; end: number } {
  const parts = parseDay(periodKey);
  const next = addDays(parts.year, parts.month, parts.day, 1);
  return {
    start: zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, timeZone),
    end: zonedTimeToUtc(next.year, next.month, next.day, 0, 0, timeZone),
  };
}

/** Monday through Sunday, as day keys, for an ISO week key `YYYY-Www`. */
export function dayKeysOfWeek(week: string): string[] {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return [];
  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (weekNumber < 1 || weekNumber > 53) return [];
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Weekday - 1) + (weekNumber - 1) * 7);
  const keys: string[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + offset);
    keys.push(formatDay(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()));
  }
  return keys;
}

export function chineseDay(periodKey: string): string {
  const parts = parseDay(periodKey);
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

function parseDay(periodKey: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodKey);
  if (!match) throw new CompanionError("diary", "dsh-companion: diary day key is not YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new CompanionError("diary", "dsh-companion: diary day key is not a calendar date");
  }
  return { year, month, day };
}

function isoWeek(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

function addDays(year: number, month: number, day: number, amount: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function formatDay(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
