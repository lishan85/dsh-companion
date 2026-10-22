/**
 * Fail-loud companion configuration.
 *
 * This slice has no API keys, embedding endpoint, or proactive schedule.
 * Those belong to the stubbed emotion and vector slices.
 *
 * @module dsh-companion/config
 */

import z from "@deepseek-ai/schemastery";
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
  };
  if (parsed.promptMaxTokens !== undefined) config.promptMaxTokens = parsed.promptMaxTokens;
  if (parsed.promptTokenizerPath !== undefined) config.promptTokenizerPath = parsed.promptTokenizerPath;
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
}

/** Schemastery schema, exported under the Cordis plugin convention. */
export const Config = ConfigSchema;
