/**
 * Ingest dsh-wander trips as her own experiences.
 *
 * The wander plugin does not import this package. It appends `experiences.jsonl`
 * and emits `wander/trip` with the same version-1 object. This module accepts
 * either source. A metadata diary is still her trip, and the snippet says she
 * did not hand the picture to a vision model. Corrupt lines are skipped.
 * Nothing here calls a network.
 *
 * @module dsh-companion/wander
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CompanionStore } from "./store.js";
import type { ExperienceInput, ExperienceRecord } from "./vector/types.js";

export interface WanderIngestReport {
  inserted: number;
  updated: number;
  skipped: number;
}

export interface WanderPathConfig {
  wanderExperiencesPath: string;
}

export function resolveWanderExperiencesPath(config: WanderPathConfig, env: NodeJS.ProcessEnv = process.env): string {
  const configured = config.wanderExperiencesPath.trim();
  if (configured.length > 0) return configured;
  const file = env.DSH_WANDER_EXPERIENCES?.trim() ?? "";
  if (file.length > 0) return file;
  const dir = env.DSH_WANDER_DATA_DIR?.trim() ?? "";
  if (dir.length > 0) return join(dir, "experiences.jsonl");
  return "";
}

export function ingestWanderFile(store: CompanionStore, path: string, personId: string): WanderIngestReport {
  if (path.length === 0 || !existsSync(path) || !statSync(path).isFile()) {
    return { inserted: 0, updated: 0, skipped: 0 };
  }
  const report: WanderIngestReport = { inserted: 0, updated: 0, skipped: 0 };
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      report.skipped += 1;
      continue;
    }
    const outcome = ingestWanderExperience(store, parsed, personId);
    report[outcome] += 1;
  }
  return report;
}

export function ingestWanderExperience(
  store: CompanionStore,
  value: unknown,
  personId: string,
): "inserted" | "updated" | "skipped" {
  const input = parseExperience(value, personId);
  if (!input) return "skipped";
  const written = store.saveExperience(input);
  return written.status === "unchanged" ? "skipped" : written.status;
}

export function renderExperienceSnippet(record: ExperienceRecord): string {
  const lines = ["我记得自己出去看过的一处。", `我说：「${record.content}」`];
  if (record.descriptionMode === "metadata") {
    lines.push("那次我没有把画面交给别人看，是按地点和时间记的。");
  }
  if (record.attribution.length > 0 && !record.content.includes(record.attribution)) {
    lines.push(`署名是「${record.attribution}」。`);
  }
  return lines.join("\n");
}

function parseExperience(value: unknown, personId: string): ExperienceInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.source !== "dsh-wander" || record.kind !== "travel") return undefined;
  if (typeof record.id !== "string" || record.id.trim().length === 0 || record.id.length > 200) return undefined;
  if (typeof record.text !== "string" || record.text.trim().length === 0 || record.text.length > 200_000) return undefined;
  const ts = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
  if (!Number.isSafeInteger(ts) || ts < 0) return undefined;
  const place = record.place && typeof record.place === "object" ? record.place as Record<string, unknown> : {};
  const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const placeId = typeof place.id === "string" ? place.id.slice(0, 200) : "";
  const placeName = typeof place.name === "string" ? place.name.slice(0, 200) : "";
  const country = typeof place.country === "string" ? place.country.slice(0, 200) : "";
  const topics = [...tags, placeName, country].map((item) => item.trim()).filter((item) => item.length > 0);
  const mode = record.descriptionMode === "metadata" || record.descriptionMode === "vision" ? record.descriptionMode : "";
  return {
    externalId: record.id.trim(),
    personId,
    ts,
    content: record.text,
    topics,
    placeId,
    placeName,
    attribution: typeof record.attribution === "string" ? record.attribution.slice(0, 500) : "",
    license: typeof record.license === "string" ? record.license.slice(0, 200) : "",
    descriptionMode: mode,
    emotionHint: typeof record.emotionHint === "string" ? record.emotionHint.slice(0, 200) : "",
  };
}
