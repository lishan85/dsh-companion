/**
 * Quiet hours and next-day scheduling on an IANA clock.
 *
 * Asia/Shanghai is the default. The conversion iterates a UTC guess against
 * `Intl.DateTimeFormat`, so it does not depend on a timezone database package.
 *
 * @module dsh-companion/emotion/clock
 */

import type { QuietHours } from "./types.js";

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error(`dsh-companion: time zone "${timeZone}" is not a valid IANA name`);
  }
}

export function parseClock(value: string, label: string): { hour: number; minute: number } {
  const match = CLOCK.exec(value);
  if (!match) throw new Error(`dsh-companion: ${label} must be HH:MM in 24-hour form`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`dsh-companion: missing ${type} while reading ${timeZone}`);
    return Number(found.value);
  };
  let hour = pick("hour");
  if (hour === 24) hour = 0;
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour,
    minute: pick("minute"),
    second: pick("second"),
  };
}

export function dayKey(epochMs: number, timeZone: string): string {
  const parts = zonedParts(epochMs, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** UTC epoch for a wall-clock time in `timeZone`. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(utc, timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    const diff = target - asUtc;
    if (diff === 0) return utc;
    utc += diff;
  }
  return utc;
}

export function isQuiet(epochMs: number, quiet: QuietHours): boolean {
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  const parts = zonedParts(epochMs, quiet.timeZone);
  const current = parts.hour * 60 + parts.minute;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

/** The next instant that is outside quiet hours. Returns `epochMs` when already awake. */
export function nextAwake(epochMs: number, quiet: QuietHours): number {
  if (!isQuiet(epochMs, quiet)) return epochMs;
  const end = parseClock(quiet.end, "quiet end");
  const start = minutes(quiet.start);
  const parts = zonedParts(epochMs, quiet.timeZone);
  const current = parts.hour * 60 + parts.minute;
  const wraps = start > minutes(quiet.end);
  const date = wraps && current >= start
    ? addCalendarDays(parts.year, parts.month, parts.day, 1)
    : { year: parts.year, month: parts.month, day: parts.day };
  return zonedTimeToUtc(date.year, date.month, date.day, end.hour, end.minute, quiet.timeZone);
}

/** The next local calendar day at `hour:minute`, relative to `epochMs`. */
export function nextLocalMorning(
  epochMs: number,
  timeZone: string,
  hour: number,
  minute: number,
): number {
  const parts = zonedParts(epochMs, timeZone);
  const next = addCalendarDays(parts.year, parts.month, parts.day, 1);
  return zonedTimeToUtc(next.year, next.month, next.day, hour, minute, timeZone);
}

function minutes(clock: string): number {
  const parsed = parseClock(clock, "quiet hours");
  return parsed.hour * 60 + parsed.minute;
}

function addCalendarDays(year: number, month: number, day: number, amount: number): ZonedParts {
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
