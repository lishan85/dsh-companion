/**
 * Cordis entry for dsh-companion.
 *
 * The persona is a stable system section so a prefix cache can reuse it.
 * `agent/pre-step` prepends recent raw turns and retrieved windows.
 * `session/event` appends raw user and assistant utterances. Emotion scores
 * each turn and queues proactive followups. The diary flags important events
 * immediately and seals a day, week, or month on rollover, on idle, or on
 * the backstop timer. Vector indexes stay on the stub.
 *
 * @module dsh-companion
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { TokenCounter } from "../contracts.js";
import { loadTokenCounter } from "../token-counter.js";
import { channelOf, parseSessionEvent, shouldSkipUserMessage, textOf } from "./channel.js";
import { loadCompanionConfig, type CompanionConfig } from "./config.js";
import { CheapDiaryModel } from "./diary/model.js";
import { LayeredDiaryWriter } from "./diary/writer.js";
import { deliverViaFollowup, type FollowupTarget } from "./emotion/deliver.js";
import { defaultEmotionRuntime, PersistedEmotionModel } from "./emotion/engine.js";
import { CheapModelScorer } from "./emotion/model-scorer.js";
import { isRecallContent, renderCompanionPrompt } from "./render.js";
import { retrieve } from "./retrieve.js";
import { CompanionStore } from "./store.js";
import { defaultExtensions, type CompanionExtensions, type DiaryWriter, type EmotionModel } from "./stubs.js";
import type { ProactiveRow } from "./emotion/types.js";
import type { Snippet, TurnInput } from "./types.js";

export const name = "companion";
export const inject = ["tools", "systemPrompt"];
export { Config } from "./config.js";

const SEARCH_DESCRIPTION =
  "在你们的原始对话和她写过的日记里按当下话题查找更早的内容。眼前这段已经在上下文里，所以只在需要更早的原话或日记时再用。结果是她记得的原话、前后几句，或她自己写过的一页，不是一份交接材料。";

export interface CompanionApplyOptions {
  extensions?: CompanionExtensions;
}

interface Host {
  effect: (callback: () => void | (() => void)) => void;
  on: (event: string, listener: (...args: any[]) => any) => void;
  tools: { register: (tool: unknown) => void };
  systemPrompt: { section: (section: { name: string; order: number; text: () => string }) => void };
}

interface PreStepPayload {
  agent?: unknown;
  messages?: unknown;
  signal?: AbortSignal;
}

interface PreStepDecision {
  kind: string;
  messages?: unknown[];
  startsRequestSeries?: true;
}

export function apply(ctx: Context, rawConfig: unknown, options: CompanionApplyOptions = {}): void {
  const config = loadCompanionConfig(rawConfig);
  let extensions = options.extensions ?? defaultExtensions();
  const tokenCounter = config.promptTokenizerPath === undefined
    ? undefined
    : loadTokenCounter(config.promptTokenizerPath);
  let store: CompanionStore | undefined;
  let emotion: EmotionModel = extensions.emotion;
  let diary: DiaryWriter = extensions.diary;
  const openTurns = new Map<string, number>();
  const agentsBySession = new Map<string, FollowupTarget>();
  const agentsByPerson = new Map<string, FollowupTarget>();
  const host = ctx as unknown as Host;

  host.effect(() => {
    const opened = new CompanionStore(config.path);
    store = opened;
    let timer: ReturnType<typeof setInterval> | undefined;
    let diaryTimer: ReturnType<typeof setInterval> | undefined;
    let owned: PersistedEmotionModel | undefined;
    if (!options.extensions && config.emotionEnabled) {
      const key = process.env.DSH_COMPANION_EMOTION_API_KEY?.trim() ?? "";
      const scorer = config.emotionModelEnabled && key.length > 0 && config.emotionModelBaseUrl !== undefined
        ? new CheapModelScorer({
            baseUrl: config.emotionModelBaseUrl,
            model: config.emotionModelName,
            timeoutMs: config.emotionModelTimeoutMs,
            apiKey: key,
          })
        : undefined;
      owned = new PersistedEmotionModel(opened, {
        runtime: runtimeOf(config),
        ...(scorer ? { scorer } : {}),
        deliver: (item) => deliverToKnownAgent(item, agentsBySession, agentsByPerson),
      });
      emotion = owned;
      extensions = { ...extensions, emotion: owned };
      if (config.proactiveEnabled && config.proactiveIntervalMs > 0) {
        timer = setInterval(() => {
          void owned?.evaluateProactive(Date.now());
        }, config.proactiveIntervalMs);
        if (typeof timer.unref === "function") timer.unref();
      }
    }
    if (!options.extensions && config.diaryEnabled) {
      const key = process.env.DSH_COMPANION_DIARY_API_KEY?.trim() ?? "";
      const model = config.diaryModelEnabled && key.length > 0 && config.diaryModelBaseUrl !== undefined
        ? new CheapDiaryModel({
            baseUrl: config.diaryModelBaseUrl,
            model: config.diaryModelName,
            timeoutMs: config.diaryModelTimeoutMs,
            apiKey: key,
          })
        : undefined;
      const writer = new LayeredDiaryWriter(opened, {
        timeZone: config.diaryTimeZone,
        ...(model ? { model } : {}),
      });
      diary = writer;
      extensions = { ...extensions, diary: writer };
      if (config.diaryIntervalMs > 0) {
        diaryTimer = setInterval(() => {
          void writer.maintain(Date.now()).catch(() => {
            // The next settle() or maintain() surfaces a store failure.
          });
        }, config.diaryIntervalMs);
        if (typeof diaryTimer.unref === "function") diaryTimer.unref();
      }
    }
    return () => {
      if (timer) clearInterval(timer);
      if (diaryTimer) clearInterval(diaryTimer);
      store = undefined;
      opened.close();
    };
  });

  host.systemPrompt.section({
    name: "companion:persona",
    order: config.promptOrder,
    text: () => renderCompanionPrompt({
      persona: config.persona,
      emotionLine: "",
      recent: [],
      snippets: [],
      maxChars: config.promptMaxChars,
      ...(config.promptMaxTokens !== undefined ? { maxTokens: config.promptMaxTokens } : {}),
      ...(tokenCounter ? { tokenCounter } : {}),
    }).stable,
  });

  host.on("session/event", (session: unknown, event: unknown) => {
    const opened = store;
    if (!opened) return;
    const sessionId = sessionIdOf(session);
    const started = turnStarted(event);
    if (started !== undefined) {
      openTurns.set(sessionId, started);
      return;
    }
    const parsed = parseSessionEvent(session, event, Date.now());
    if (!parsed || parsed.skip || isRecallContent(parsed.content)) return;
    const previous = sessionId.length > 0 ? opened.latestTurnForSession(sessionId) : undefined;
    const meta = parsed.role === "assistant"
      ? {
          channel: previous?.channel ?? "",
          userId: previous?.userId ?? "",
          chatId: previous?.chatId ?? "",
          bridge: previous?.bridge ?? "",
        }
      : parsed.meta;
    const personId = personIdFor(opened, config, meta, sessionId);
    let turnNo = parsed.turnNo;
    if (turnNo === null && parsed.role === "user") {
      const tracked = openTurns.get(sessionId);
      if (tracked !== undefined) turnNo = tracked;
    }
    const input: TurnInput = {
      channel: meta.channel,
      userId: meta.userId,
      chatId: meta.chatId,
      sessionId: parsed.meta.sessionId,
      bridge: meta.bridge,
      personId,
      ts: parsed.meta.ts,
      role: parsed.role,
      content: parsed.content,
    };
    if (turnNo !== null) input.turnNo = turnNo;
    const turn = opened.appendTurn(input);
    const agent = agentsBySession.get(turn.sessionId);
    if (agent) agentsByPerson.set(turn.personId, agent);
    const observed = emotion.observe(turn);
    if (observed instanceof Promise) {
      void observed.catch(() => {
        // The model keeps the failure and rethrows it from line() / settle().
      });
    }
    const noted = diary.observe(turn);
    if (noted instanceof Promise) {
      void noted.catch(() => {
        // A diary failure stays off the transcript path. settle() rethrows it.
      });
    }
    extensions.vector.upsert(turn.id, turn.content);
  });

  host.on("agent/pre-step", async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
    const decision = await next();
    if (decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    const opened = store;
    if (!opened) return decision;
    payload.signal?.throwIfAborted();
    rememberAgent(payload.agent, agentsBySession);
    await emotion.settle?.();
    const wire = recallWire(opened, config, extensions, tokenCounter, payload.agent, decision.messages);
    if (wire.length === 0) return decision;
    return {
      ...decision,
      messages: [recallMessage(wire), ...decision.messages],
    };
  });

  host.tools.register(defineTool({
    name: "history_search",
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: { type: "string", required: true, description: "要回想的话题，用现在这句话里的词。" },
      limit: { type: "number", description: `最多几段。默认 ${config.snippetLimit}，不超过 ${config.searchLimitMax}。` },
      around: { type: "number", description: "命中的原话前后各带几句。默认用配置里的 contextRadius。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          snippets: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                focusId: { type: "number", required: true },
                score: { type: "number", required: true },
                text: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { snippets: Array<{ text: string }> }) => [{
        type: "text",
        text: value.snippets.length === 0
          ? "我翻了一下，细节没抓住。"
          : value.snippets.map((snippet) => snippet.text).join("\n\n"),
      }],
    },
    async execute(args: { query?: string; limit?: number; around?: number }, exec?: ToolRunContext) {
      const opened = store;
      if (!opened) throw new Error("dsh-companion: store is not open");
      const query = typeof args.query === "string" ? args.query : "";
      const limit = clampLimit(args.limit, config.snippetLimit, config.searchLimitMax);
      const radius = args.around === undefined ? config.contextRadius : args.around;
      if (!Number.isInteger(radius) || radius < 0 || radius > 8) {
        throw new Error("dsh-companion: around must be an integer from 0 to 8");
      }
      const sessionId = sessionIdOf(exec?.agent);
      const personId = (sessionId.length > 0 ? opened.latestTurnForSession(sessionId)?.personId : undefined)
        ?? config.defaultPersonId;
      const snippets = searchHistory(opened, query, personId, limit, radius, extensions);
      return { snippets: snippets.map(toView) };
    },
    isConcurrencySafe: () => true,
  }));

  host.on("agent/created", (payload: unknown) => {
    rememberAgent(payload, agentsBySession);
    void emotion.settle?.().then(() => {
      const owned = emotion;
      if (owned instanceof PersistedEmotionModel) return owned.evaluateProactive(Date.now());
      return undefined;
    });
  });

  host.on("agent/status", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const status = (payload as { status?: unknown }).status;
    if (status !== "idle") return;
    rememberAgent(payload, agentsBySession);
    if (emotion instanceof PersistedEmotionModel) void emotion.evaluateProactive(Date.now());
    if (diary instanceof LayeredDiaryWriter) {
      void diary.maintain(Date.now()).catch(() => {
        // Idle sealing is idempotent. The next maintain() reports a store failure.
      });
    }
  });
}

export function searchHistory(
  store: CompanionStore,
  query: string,
  personId: string,
  limit: number,
  radius: number,
  extensions: CompanionExtensions = defaultExtensions(),
): Snippet[] {
  return retrieve(store, {
    query,
    personId,
    limit,
    radius,
    vector: extensions.vector,
    reranker: extensions.reranker,
  });
}

function recallWire(
  store: CompanionStore,
  config: CompanionConfig,
  extensions: CompanionExtensions,
  tokenCounter: TokenCounter | undefined,
  agent: unknown,
  messages: readonly unknown[],
): string {
  const current = latestUserMessage(messages);
  const sessionId = sessionIdOf(agent);
  const meta = channelOf(current);
  const personId = personIdFor(store, config, meta, sessionId);
  const query = textOf(current && typeof current === "object" ? (current as { content?: unknown }).content : undefined);
  const snippets = query.length === 0
    ? []
    : searchHistory(store, query, personId, config.snippetLimit, config.contextRadius, extensions);
  const rendered = renderCompanionPrompt({
    persona: config.persona,
    emotionLine: extensions.emotion.line(personId, Date.now()),
    recent: store.recentTurns(personId, config.recentTurns),
    snippets,
    maxChars: config.promptMaxChars,
    ...(config.promptMaxTokens !== undefined ? { maxTokens: config.promptMaxTokens } : {}),
    ...(tokenCounter ? { tokenCounter } : {}),
  });
  return rendered.wire;
}

function latestUserMessage(messages: readonly unknown[]): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (shouldSkipUserMessage(message)) continue;
    const role = message && typeof message === "object" ? (message as { role?: unknown }).role : undefined;
    if (role !== undefined && role !== "user") continue;
    return message;
  }
  return undefined;
}

function personIdFor(
  store: CompanionStore,
  config: CompanionConfig,
  meta: { channel: string; userId: string },
  sessionId: string,
): string {
  if (meta.channel.length > 0 && meta.userId.length > 0) return store.personFor(meta.channel, meta.userId);
  if (sessionId.length > 0) {
    const known = store.latestTurnForSession(sessionId);
    if (known) return known.personId;
  }
  return config.defaultPersonId;
}

function recallMessage(text: string): {
  id: string;
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  source: { kind: "dsh-companion"; form: "recall" };
} {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "dsh-companion", form: "recall" },
  };
}

function toView(snippet: Snippet): { focusId: number; score: number; text: string } {
  return { focusId: snippet.focusId, score: snippet.score, text: snippet.text };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error("dsh-companion: limit must be an integer >= 1");
  return Math.min(value, max);
}

function turnStarted(event: unknown): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  if ((event as { type?: unknown }).type !== "turn/start") return undefined;
  const data = (event as { data?: unknown }).data;
  const turn = data && typeof data === "object" ? (data as { turn?: unknown }).turn : undefined;
  return typeof turn === "number" && Number.isInteger(turn) ? turn : undefined;
}

function runtimeOf(config: CompanionConfig) {
  return defaultEmotionRuntime({
    enabled: config.emotionEnabled,
    proactive: {
      enabled: config.proactiveEnabled,
      dailyCap: config.proactiveDailyCap,
      minGapMs: config.proactiveMinGapMs,
      quiet: {
        timeZone: config.proactiveQuietTimeZone,
        start: config.proactiveQuietStart,
        end: config.proactiveQuietEnd,
      },
      followUpHour: config.proactiveFollowUpHour,
      followUpMinute: config.proactiveFollowUpMinute,
      hysteresis: 0.12,
      thresholds: {
        missing: config.thresholdMissing,
        worried: config.thresholdWorried,
        aggrieved: config.thresholdAggrieved,
        jealous: config.thresholdJealous,
        angry: config.thresholdAngry,
      },
    },
  });
}

function rememberAgent(value: unknown, agents: Map<string, FollowupTarget>): void {
  const agent = followupTarget(value);
  if (!agent) return;
  const sessionId = sessionIdOf(agent);
  if (sessionId.length === 0) return;
  agents.set(sessionId, agent);
}

function followupTarget(value: unknown): FollowupTarget | undefined {
  if (isFollowup(value)) return value;
  if (!value || typeof value !== "object" || !("agent" in value)) return undefined;
  const nested = (value as { agent: unknown }).agent;
  return isFollowup(nested) ? nested : undefined;
}

function isFollowup(value: unknown): value is FollowupTarget {
  return Boolean(value && typeof value === "object" && typeof (value as { followup?: unknown }).followup === "function");
}

function deliverToKnownAgent(
  item: ProactiveRow,
  bySession: Map<string, FollowupTarget>,
  byPerson: Map<string, FollowupTarget>,
): boolean {
  const agent = byPerson.get(item.personId) ?? (item.sessionId.length > 0 ? bySession.get(item.sessionId) : undefined);
  if (!agent) return false;
  try {
    deliverViaFollowup(agent, item.text);
    return true;
  } catch {
    return false;
  }
}

function sessionIdOf(scope: unknown): string {
  if (!scope || typeof scope !== "object") return "";
  const direct = (scope as { id?: unknown }).id;
  if (typeof direct === "string" && direct.length > 0 && !("session" in (scope as object))) return direct;
  const nested = (scope as { session?: { id?: unknown; header?: { id?: unknown } } }).session;
  if (nested && typeof nested.id === "string" && nested.id.length > 0) return nested.id;
  if (typeof nested?.header?.id === "string" && nested.header.id.length > 0) return nested.header.id;
  const header = (scope as { header?: { id?: unknown } }).header;
  if (typeof header?.id === "string") return header.id;
  if (typeof direct === "string") return direct;
  return "";
}
