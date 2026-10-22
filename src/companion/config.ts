/**
 * Fail-loud companion configuration.
 *
 * Emotion baselines, decay, and inertia have code defaults. The knobs here
 * are the ones an operator changes: whether mood is on, the proactive cap
 * and quiet hours, and the optional cheap-model scorer. The model API key is
 * not a config field. It is read from `DSH_COMPANION_EMOTION_API_KEY` at
 * call time, and a missing key falls back to the rule scorer.
 *
 * @module dsh-companion/config
 */

import z from "@deepseek-ai/schemastery";
import { assertTimeZone, parseClock } from "./emotion/clock.js";
import { DEFAULT_PERSONA } from "./render.js";

export interface CompanionConfig {
  path: string;
  persona: string;
  recentTurns: number;
  contextRadius: number;
  snippetLimit: number;
  promptMaxChars: number;
  promptMaxTokens?: number;
  promptTokenizerPath?: string;
  promptOrder: number;
  defaultPersonId: string;
  searchLimitMax: number;
  emotionEnabled: boolean;
  proactiveEnabled: boolean;
  proactiveDailyCap: number;
  proactiveMinGapMs: number;
  proactiveQuietTimeZone: string;
  proactiveQuietStart: string;
  proactiveQuietEnd: string;
  proactiveFollowUpHour: number;
  proactiveFollowUpMinute: number;
  proactiveIntervalMs: number;
  thresholdMissing: number;
  thresholdWorried: number;
  thresholdAggrieved: number;
  thresholdJealous: number;
  thresholdAngry: number;
  emotionModelEnabled: boolean;
  emotionModelBaseUrl?: string;
  emotionModelName: string;
  emotionModelTimeoutMs: number;
}

const ConfigSchema = z.object({
  path: z.string().required(),
  persona: z.string().default(DEFAULT_PERSONA),
  recentTurns: z.number().default(12),
  contextRadius: z.number().default(2),
  snippetLimit: z.number().default(3),
  promptMaxChars: z.number().default(6000),
  promptMaxTokens: z.number(),
  promptTokenizerPath: z.string(),
  promptOrder: z.number().default(12),
  defaultPersonId: z.string().default("primary"),
  searchLimitMax: z.number().default(20),
  emotionEnabled: z.boolean().default(true),
  proactiveEnabled: z.boolean().default(true),
  proactiveDailyCap: z.number().default(2),
  proactiveMinGapMs: z.number().default(6 * 60 * 60 * 1000),
  proactiveQuietTimeZone: z.string().default("Asia/Shanghai"),
  proactiveQuietStart: z.string().default("23:00"),
  proactiveQuietEnd: z.string().default("08:00"),
  proactiveFollowUpHour: z.number().default(9),
  proactiveFollowUpMinute: z.number().default(0),
  proactiveIntervalMs: z.number().default(15 * 60 * 1000),
  thresholdMissing: z.number().default(0.72),
  thresholdWorried: z.number().default(0.75),
  thresholdAggrieved: z.number().default(0.7),
  thresholdJealous: z.number().default(0.68),
  thresholdAngry: z.number().default(0.7),
  emotionModelEnabled: z.boolean().default(false),
  emotionModelBaseUrl: z.string(),
  emotionModelName: z.string().default("deepseek-chat"),
  emotionModelTimeoutMs: z.number().default(800),
});

const POSITIVE = ["recentTurns", "promptMaxChars", "searchLimitMax"] as const;

export function loadCompanionConfig(value: unknown): CompanionConfig {
  const parsed = ConfigSchema(value as never) as CompanionConfig;
  const config: CompanionConfig = {
    path: parsed.path,
    persona: parsed.persona,
    recentTurns: parsed.recentTurns,
    contextRadius: parsed.contextRadius,
    snippetLimit: parsed.snippetLimit,
    promptMaxChars: parsed.promptMaxChars,
    promptOrder: parsed.promptOrder,
    defaultPersonId: parsed.defaultPersonId.trim(),
    searchLimitMax: parsed.searchLimitMax,
    emotionEnabled: parsed.emotionEnabled,
    proactiveEnabled: parsed.proactiveEnabled,
    proactiveDailyCap: parsed.proactiveDailyCap,
    proactiveMinGapMs: parsed.proactiveMinGapMs,
    proactiveQuietTimeZone: parsed.proactiveQuietTimeZone.trim(),
    proactiveQuietStart: parsed.proactiveQuietStart.trim(),
    proactiveQuietEnd: parsed.proactiveQuietEnd.trim(),
    proactiveFollowUpHour: parsed.proactiveFollowUpHour,
    proactiveFollowUpMinute: parsed.proactiveFollowUpMinute,
    proactiveIntervalMs: parsed.proactiveIntervalMs,
    thresholdMissing: parsed.thresholdMissing,
    thresholdWorried: parsed.thresholdWorried,
    thresholdAggrieved: parsed.thresholdAggrieved,
    thresholdJealous: parsed.thresholdJealous,
    thresholdAngry: parsed.thresholdAngry,
    emotionModelEnabled: parsed.emotionModelEnabled,
    emotionModelName: parsed.emotionModelName.trim(),
    emotionModelTimeoutMs: parsed.emotionModelTimeoutMs,
  };
  if (parsed.promptMaxTokens !== undefined) config.promptMaxTokens = parsed.promptMaxTokens;
  if (parsed.promptTokenizerPath !== undefined) config.promptTokenizerPath = parsed.promptTokenizerPath;
  if (parsed.emotionModelBaseUrl !== undefined) config.emotionModelBaseUrl = parsed.emotionModelBaseUrl.trim();
  validateCompanionConfig(config);
  return config;
}

export function validateCompanionConfig(config: CompanionConfig): void {
  if (config.path.length === 0) throw new Error("dsh-companion: `path` must not be empty");
  if (config.persona.trim().length === 0) throw new Error("dsh-companion: persona must not be empty");
  if (config.defaultPersonId.length === 0) throw new Error("dsh-companion: defaultPersonId must not be empty");
  if (!Number.isInteger(config.contextRadius) || config.contextRadius < 0) {
    throw new Error("dsh-companion: contextRadius must be an integer >= 0");
  }
  if (!Number.isInteger(config.snippetLimit) || config.snippetLimit < 1) {
    throw new Error("dsh-companion: snippetLimit must be an integer >= 1");
  }
  for (const field of POSITIVE) {
    const number = config[field];
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`dsh-companion: ${field} must be an integer >= 1`);
    }
  }
  if (config.snippetLimit > config.searchLimitMax) {
    throw new Error("dsh-companion: snippetLimit exceeds searchLimitMax");
  }
  if (!Number.isFinite(config.promptOrder)) throw new Error("dsh-companion: promptOrder must be finite");
  if ((config.promptMaxTokens === undefined) !== (config.promptTokenizerPath === undefined)) {
    throw new Error("dsh-companion: promptMaxTokens and promptTokenizerPath must be configured together");
  }
  if (config.promptMaxTokens !== undefined && (!Number.isSafeInteger(config.promptMaxTokens) || config.promptMaxTokens < 1)) {
    throw new Error("dsh-companion: promptMaxTokens must be a safe integer >= 1");
  }
  if (config.promptTokenizerPath !== undefined && config.promptTokenizerPath.trim().length === 0) {
    throw new Error("dsh-companion: promptTokenizerPath must be a nonempty string");
  }
  if (typeof config.emotionEnabled !== "boolean") throw new Error("dsh-companion: emotionEnabled must be a boolean");
  if (typeof config.proactiveEnabled !== "boolean") throw new Error("dsh-companion: proactiveEnabled must be a boolean");
  if (typeof config.emotionModelEnabled !== "boolean") throw new Error("dsh-companion: emotionModelEnabled must be a boolean");
  assertInteger(config.proactiveDailyCap, "proactiveDailyCap", config.proactiveEnabled ? 1 : 0);
  assertInteger(config.proactiveMinGapMs, "proactiveMinGapMs", 0);
  assertInteger(config.proactiveIntervalMs, "proactiveIntervalMs", 0);
  assertInteger(config.proactiveFollowUpHour, "proactiveFollowUpHour", 0, 23);
  assertInteger(config.proactiveFollowUpMinute, "proactiveFollowUpMinute", 0, 59);
  assertTimeZone(config.proactiveQuietTimeZone);
  parseClock(config.proactiveQuietStart, "proactiveQuietStart");
  parseClock(config.proactiveQuietEnd, "proactiveQuietEnd");
  for (const field of ["thresholdMissing", "thresholdWorried", "thresholdAggrieved", "thresholdJealous", "thresholdAngry"] as const) {
    const value = config[field];
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`dsh-companion: ${field} must be in (0, 1]`);
    }
  }
  if (config.emotionModelName.length === 0) throw new Error("dsh-companion: emotionModelName must not be empty");
  assertInteger(config.emotionModelTimeoutMs, "emotionModelTimeoutMs", 1);
  if (config.emotionModelEnabled) {
    const baseUrl = config.emotionModelBaseUrl;
    if (baseUrl === undefined || !/^https?:\/\//.test(baseUrl)) {
      throw new Error("dsh-companion: emotionModelEnabled requires an http(s) emotionModelBaseUrl");
    }
  }
}

function assertInteger(value: number, field: string, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`dsh-companion: ${field} must be an integer from ${min} to ${max}`);
  }
}

/** Schemastery schema, exported under the Cordis plugin convention. */
export const Config = ConfigSchema;
