/**
 * Fail-loud companion configuration.
 *
 * Emotion baselines, decay, and inertia have code defaults. The knobs here
 * are the ones an operator changes: whether mood is on, the proactive cap
 * and quiet hours, the optional cheap-model scorer, and the diary schedule.
 * Model API keys are not config fields. Emotion reads
 * `DSH_COMPANION_EMOTION_API_KEY`, the diary reads
 * `DSH_COMPANION_DIARY_API_KEY`, embeddings read
 * `DSH_COMPANION_EMBEDDING_KEY` (or `embeddingApiKeyEnv`), and the optional
 * reranker reads `DSH_COMPANION_RERANK_KEY` (or `rerankApiKeyEnv`) at call
 * time. A missing key uses the deterministic fallback and does not wait on
 * a credential. Wander's `experiences.jsonl` is read from
 * `wanderExperiencesPath`, or from `DSH_WANDER_EXPERIENCES`, or from
 * `DSH_WANDER_DATA_DIR/experiences.jsonl`.
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
  diaryEnabled: boolean;
  diaryTimeZone: string;
  diaryIntervalMs: number;
  diaryModelEnabled: boolean;
  diaryModelBaseUrl?: string;
  diaryModelName: string;
  diaryModelTimeoutMs: number;
  embeddingProvider: "offline" | "openai";
  embeddingBaseUrl?: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingTimeoutMs: number;
  embeddingApiKeyEnv: string;
  rerankProvider: "deterministic" | "http";
  rerankBaseUrl?: string;
  rerankModel: string;
  rerankTimeoutMs: number;
  rerankApiKeyEnv: string;
  rrfK: number;
  timeBoost: number;
  timeHalfLifeDays: number;
  personBoost: number;
  topicBoost: number;
  vectorMinScore: number;
  vectorScanLimit: number;
  wanderExperiencesPath: string;
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
  diaryEnabled: z.boolean().default(true),
  diaryTimeZone: z.string().default("Asia/Shanghai"),
  diaryIntervalMs: z.number().default(15 * 60 * 1000),
  diaryModelEnabled: z.boolean().default(false),
  diaryModelBaseUrl: z.string(),
  diaryModelName: z.string().default("deepseek-chat"),
  diaryModelTimeoutMs: z.number().default(4_000),
  embeddingProvider: z.string().default("offline"),
  embeddingBaseUrl: z.string(),
  embeddingModel: z.string().default(""),
  embeddingDimensions: z.number().default(128),
  embeddingTimeoutMs: z.number().default(4_000),
  embeddingApiKeyEnv: z.string().default("DSH_COMPANION_EMBEDDING_KEY"),
  rerankProvider: z.string().default("deterministic"),
  rerankBaseUrl: z.string(),
  rerankModel: z.string().default(""),
  rerankTimeoutMs: z.number().default(2_000),
  rerankApiKeyEnv: z.string().default("DSH_COMPANION_RERANK_KEY"),
  rrfK: z.number().default(60),
  timeBoost: z.number().default(0.15),
  timeHalfLifeDays: z.number().default(30),
  personBoost: z.number().default(0.1),
  topicBoost: z.number().default(0.2),
  vectorMinScore: z.number().default(0.2),
  vectorScanLimit: z.number().default(4096),
  wanderExperiencesPath: z.string().default(""),
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
    diaryEnabled: parsed.diaryEnabled,
    diaryTimeZone: parsed.diaryTimeZone.trim(),
    diaryIntervalMs: parsed.diaryIntervalMs,
    diaryModelEnabled: parsed.diaryModelEnabled,
    diaryModelName: parsed.diaryModelName.trim(),
    diaryModelTimeoutMs: parsed.diaryModelTimeoutMs,
    embeddingProvider: parsed.embeddingProvider === "openai" ? "openai" : "offline",
    embeddingModel: parsed.embeddingModel.trim(),
    embeddingDimensions: parsed.embeddingDimensions,
    embeddingTimeoutMs: parsed.embeddingTimeoutMs,
    embeddingApiKeyEnv: parsed.embeddingApiKeyEnv.trim(),
    rerankProvider: parsed.rerankProvider === "http" ? "http" : "deterministic",
    rerankModel: parsed.rerankModel.trim(),
    rerankTimeoutMs: parsed.rerankTimeoutMs,
    rerankApiKeyEnv: parsed.rerankApiKeyEnv.trim(),
    rrfK: parsed.rrfK,
    timeBoost: parsed.timeBoost,
    timeHalfLifeDays: parsed.timeHalfLifeDays,
    personBoost: parsed.personBoost,
    topicBoost: parsed.topicBoost,
    vectorMinScore: parsed.vectorMinScore,
    vectorScanLimit: parsed.vectorScanLimit,
    wanderExperiencesPath: parsed.wanderExperiencesPath.trim(),
  };
  if (parsed.promptMaxTokens !== undefined) config.promptMaxTokens = parsed.promptMaxTokens;
  if (parsed.promptTokenizerPath !== undefined) config.promptTokenizerPath = parsed.promptTokenizerPath;
  if (parsed.emotionModelBaseUrl !== undefined) config.emotionModelBaseUrl = parsed.emotionModelBaseUrl.trim();
  if (parsed.diaryModelBaseUrl !== undefined) config.diaryModelBaseUrl = parsed.diaryModelBaseUrl.trim();
  if (parsed.embeddingBaseUrl !== undefined) config.embeddingBaseUrl = parsed.embeddingBaseUrl.trim();
  if (parsed.rerankBaseUrl !== undefined) config.rerankBaseUrl = parsed.rerankBaseUrl.trim();
  if (parsed.embeddingProvider !== "offline" && parsed.embeddingProvider !== "openai") {
    throw new Error("dsh-companion: embeddingProvider must be offline or openai");
  }
  if (parsed.rerankProvider !== "deterministic" && parsed.rerankProvider !== "http") {
    throw new Error("dsh-companion: rerankProvider must be deterministic or http");
  }
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
  if (typeof config.diaryEnabled !== "boolean") throw new Error("dsh-companion: diaryEnabled must be a boolean");
  if (typeof config.diaryModelEnabled !== "boolean") throw new Error("dsh-companion: diaryModelEnabled must be a boolean");
  assertTimeZone(config.diaryTimeZone);
  assertInteger(config.diaryIntervalMs, "diaryIntervalMs", 0);
  if (config.diaryModelName.length === 0) throw new Error("dsh-companion: diaryModelName must not be empty");
  assertInteger(config.diaryModelTimeoutMs, "diaryModelTimeoutMs", 1);
  if (config.diaryModelEnabled) {
    const baseUrl = config.diaryModelBaseUrl;
    if (baseUrl === undefined || !/^https?:\/\//.test(baseUrl)) {
      throw new Error("dsh-companion: diaryModelEnabled requires an http(s) diaryModelBaseUrl");
    }
  }
  if (config.embeddingProvider === "openai") {
    const baseUrl = config.embeddingBaseUrl;
    if (baseUrl === undefined || !/^https?:\/\//.test(baseUrl)) {
      throw new Error("dsh-companion: embeddingProvider openai requires an http(s) embeddingBaseUrl");
    }
  }
  assertInteger(config.embeddingDimensions, "embeddingDimensions", 8, 4096);
  assertInteger(config.embeddingTimeoutMs, "embeddingTimeoutMs", 100, 60_000);
  assertEnvName(config.embeddingApiKeyEnv, "embeddingApiKeyEnv");
  if (config.rerankProvider === "http") {
    const baseUrl = config.rerankBaseUrl;
    if (baseUrl === undefined || !/^https?:\/\//.test(baseUrl)) {
      throw new Error("dsh-companion: rerankProvider http requires an http(s) rerankBaseUrl");
    }
  }
  assertInteger(config.rerankTimeoutMs, "rerankTimeoutMs", 100, 60_000);
  assertEnvName(config.rerankApiKeyEnv, "rerankApiKeyEnv");
  assertInteger(config.rrfK, "rrfK", 1, 1_000);
  assertUnit(config.timeBoost, "timeBoost", 5);
  if (!Number.isFinite(config.timeHalfLifeDays) || config.timeHalfLifeDays <= 0 || config.timeHalfLifeDays > 3650) {
    throw new Error("dsh-companion: timeHalfLifeDays must be in (0, 3650]");
  }
  assertUnit(config.personBoost, "personBoost", 5);
  assertUnit(config.topicBoost, "topicBoost", 5);
  if (!Number.isFinite(config.vectorMinScore) || config.vectorMinScore < 0 || config.vectorMinScore > 1) {
    throw new Error("dsh-companion: vectorMinScore must be in [0, 1]");
  }
  assertInteger(config.vectorScanLimit, "vectorScanLimit", 1, 100_000);
}

function assertUnit(value: number, field: string, max: number): void {
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`dsh-companion: ${field} must be in [0, ${max}]`);
  }
}

function assertEnvName(value: string, field: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(`dsh-companion: ${field} must be an uppercase environment variable name`);
  }
}

function assertInteger(value: number, field: string, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`dsh-companion: ${field} must be an integer from ${min} to ${max}`);
  }
}

/** Schemastery schema, exported under the Cordis plugin convention. */
export const Config = ConfigSchema;
