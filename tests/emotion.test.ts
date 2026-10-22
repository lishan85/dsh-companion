import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { loadCompanionConfig } from "../src/companion/config.js";
import { shouldSkipUserMessage } from "../src/companion/channel.js";
import { dayKey, isQuiet, nextAwake, nextLocalMorning } from "../src/companion/emotion/clock.js";
import { deliverViaFollowup, type FollowupTarget } from "../src/companion/emotion/deliver.js";
import { DEFAULT_DYNAMICS, applyEmotionDeltas, baselineVector, projectEmotion, relax } from "../src/companion/emotion/dynamics.js";
import { defaultEmotionRuntime, PersistedEmotionModel } from "../src/companion/emotion/engine.js";
import { renderInnerMonologue } from "../src/companion/emotion/express.js";
import { CheapModelScorer, completionsUrl, parseScore, type EmotionScorer } from "../src/companion/emotion/model-scorer.js";
import { scoreUtterance } from "../src/companion/emotion/rules.js";
import { zeroDeltas, type EmotionVector, type ProactiveRow, type ProactiveSettings } from "../src/companion/emotion/types.js";
import { apply } from "../src/companion/plugin.js";
import { RECALL_MARK, renderCompanionPrompt } from "../src/companion/render.js";
import { SCHEMA_VERSION } from "../src/companion/schema.js";
import { CompanionStore } from "../src/companion/store.js";
import type { TurnRecord, TurnRole } from "../src/companion/types.js";

const SHANGHAI = { timeZone: "Asia/Shanghai", start: "23:00", end: "08:00" };
/** 2026-01-15 10:00 in Asia/Shanghai. */
const AWAKE = Date.UTC(2026, 0, 15, 2, 0);
/** 2026-01-15 23:30 in Asia/Shanghai. */
const QUIET = Date.UTC(2026, 0, 15, 15, 30);
/** 2026-01-16 08:00 in Asia/Shanghai. */
const MORNING = Date.UTC(2026, 0, 16, 0, 0);
/** 2026-01-16 09:00 in Asia/Shanghai. */
const FOLLOW_AT = Date.UTC(2026, 0, 16, 1, 0);

function fileDb(): string {
  return join(mkdtempSync(join(tmpdir(), "dsh-emotion-")), "companion.db");
}

function settings(patch: Partial<ProactiveSettings> = {}): ProactiveSettings {
  const base = defaultEmotionRuntime().proactive;
  return { ...base, ...patch, quiet: patch.quiet ?? base.quiet, thresholds: patch.thresholds ?? base.thresholds };
}

function model(
  store: CompanionStore,
  options: { clock?: () => number; deliver?: (item: ProactiveRow) => boolean; proactive?: Partial<ProactiveSettings>; scorer?: EmotionScorer; enabled?: boolean } = {},
) {
  const runtime = defaultEmotionRuntime({
    enabled: options.enabled ?? true,
    proactive: settings(options.proactive),
  });
  return new PersistedEmotionModel(store, {
    runtime,
    clock: options.clock ?? (() => AWAKE),
    ...(options.deliver ? { deliver: async (item) => options.deliver?.(item) ?? false } : {}),
    ...(options.scorer ? { scorer: options.scorer } : {}),
  });
}

function utterance(store: CompanionStore, content: string, role: TurnRole = "user", ts = AWAKE, personId = "primary"): TurnRecord {
  return store.appendTurn({
    channel: "",
    userId: "",
    chatId: "",
    sessionId: "s",
    bridge: "",
    personId,
    ts,
    role,
    content,
  });
}

function vector(patch: Partial<EmotionVector> = {}): EmotionVector {
  return { ...baselineVector(), ...patch };
}

describe("emotion dynamics", () => {
  it("grows missing across an absence and leaves intimacy almost still", () => {
    const start = baselineVector();
    const day = 24 * 60 * 60 * 1000;
    const later = projectEmotion(start, 0, 0, day, DEFAULT_DYNAMICS);
    expect(later.missing).toBeCloseTo(relax(start.missing, 1, 0.05, day), 6);
    expect(later.missing).toBeGreaterThan(0.7);
    expect(later.happy).toBeCloseTo(start.happy, 6);
    expect(later.intimacy).toBeCloseTo(start.intimacy, 6);
    expect(later.pleasure).toBeGreaterThanOrEqual(-1);
    expect(later.pleasure).toBeLessThanOrEqual(1);
  });

  it("damps impulses with inertia and moves intimacy more slowly than happiness", () => {
    const deltas = zeroDeltas();
    deltas.happy = 0.2;
    deltas.intimacy = 0.2;
    const next = applyEmotionDeltas(baselineVector(), deltas, DEFAULT_DYNAMICS);
    const happyMove = next.happy - DEFAULT_DYNAMICS.happy.baseline;
    const intimacyMove = next.intimacy - DEFAULT_DYNAMICS.intimacy.baseline;
    expect(happyMove).toBeCloseTo(0.2 * (1 - DEFAULT_DYNAMICS.happy.inertia), 6);
    expect(intimacyMove).toBeCloseTo(DEFAULT_DYNAMICS.maxIntimacyDelta * (1 - DEFAULT_DYNAMICS.intimacy.inertia), 6);
    expect(intimacyMove).toBeLessThan(happyMove);
    const frozen = {
      ...DEFAULT_DYNAMICS,
      happy: { ...DEFAULT_DYNAMICS.happy, inertia: 1 },
    };
    const held = applyEmotionDeltas(baselineVector(), deltas, frozen);
    expect(held.happy).toBeCloseTo(DEFAULT_DYNAMICS.happy.baseline, 6);
  });

  it("does not move when no time has passed", () => {
    const start = vector({ missing: 0.4, angry: 0.5 });
    expect(projectEmotion(start, 50, 50, 50, DEFAULT_DYNAMICS)).toEqual(start);
  });
});

describe("quiet hours", () => {
  it("uses the Asia/Shanghai calendar, including the date ahead of UTC", () => {
    const justAfterMidnight = Date.UTC(2026, 0, 15, 16, 30);
    expect(dayKey(justAfterMidnight, "Asia/Shanghai")).toBe("2026-01-16");
    expect(dayKey(justAfterMidnight, "UTC")).toBe("2026-01-15");
    expect(isQuiet(QUIET, SHANGHAI)).toBe(true);
    expect(isQuiet(AWAKE, SHANGHAI)).toBe(false);
    expect(nextAwake(QUIET, SHANGHAI)).toBe(MORNING);
    expect(nextAwake(AWAKE, SHANGHAI)).toBe(AWAKE);
    expect(nextLocalMorning(AWAKE, "Asia/Shanghai", 9, 0)).toBe(FOLLOW_AT);
    expect(isQuiet(QUIET, { ...SHANGHAI, start: "00:00", end: "00:00" })).toBe(false);
  });
});

describe("rule scorer", () => {
  it("is deterministic and keeps remembered events on user turns", () => {
    const loved = { role: "user" as const, content: "我想你" };
    expect(scoreUtterance(loved)).toEqual(scoreUtterance(loved));
    expect(scoreUtterance(loved).deltas.happy).toBeGreaterThan(0);
    expect(scoreUtterance(loved).deltas.missing).toBeLessThan(0);
    const exam = scoreUtterance({ role: "user", content: "明天要考试，我有点紧张" });
    expect(exam.event?.kind).toBe("exam");
    expect(exam.event?.note).toContain("考试");
    expect(exam.deltas.worried).toBeGreaterThan(0);
    expect(scoreUtterance({ role: "assistant", content: "明天要考试" }).event).toBeUndefined();
    expect(scoreUtterance({ role: "user", content: "今天吃饭了" }).event).toBeUndefined();
  });
});

describe("inner monologue", () => {
  it("speaks the top two or three bands in the first person and never as numbers", () => {
    expect(renderInnerMonologue(baselineVector())).toBe("");
    const mild = vector({ happy: 0.8 });
    const stronger = vector({ happy: 0.91 });
    expect(renderInnerMonologue(mild)).toBe(renderInnerMonologue(stronger));
    expect(renderInnerMonologue(mild)).toBe("我心里暖暖的。");
    expect(renderInnerMonologue(vector({ happy: 0.6 }))).toBe("我有点开心。");
    const crowded = vector({ happy: 0.9, missing: 0.8, worried: 0.7, angry: 0.66 });
    const line = renderInnerMonologue(crowded);
    expect(line.split("，")).toHaveLength(3);
    expect(line.startsWith("我")).toBe(true);
    expect(line.endsWith("。")).toBe(true);
    expect(line).not.toMatch(/\d/);
    expect(line).not.toMatch(/happy|missing|worried|angry|pleasure|score/i);
    expect(line).not.toContain("0.");
  });

  it("keeps the stable persona free of the mood line", () => {
    const persona = "我是同一个人。";
    const first = renderCompanionPrompt({
      persona,
      emotionLine: "我有点想你。",
      recent: [],
      snippets: [],
      maxChars: 400,
    });
    const second = renderCompanionPrompt({
      persona,
      emotionLine: "我心里暖暖的。",
      recent: [],
      snippets: [],
      maxChars: 400,
    });
    expect(first.stable).toBe(second.stable);
    expect(first.stable).toBe(persona);
    expect(first.stable).not.toContain("想你");
    expect(first.volatile).toContain("我有点想你。");
    expect(first.wire.startsWith(RECALL_MARK)).toBe(true);
  });
});

describe("persisted emotion", () => {
  it("appends history, keeps the earlier row, and reloads it", async () => {
    const path = fileDb();
    const store = new CompanionStore(path);
    const mood = model(store, { proactive: { enabled: false } });
    try {
      const first = utterance(store, "我想你");
      await mood.observe(first);
      const saved = store.getEmotion("primary");
      expect(saved?.vector.happy).toBeCloseTo(
        DEFAULT_DYNAMICS.happy.baseline + 0.4 * (1 - DEFAULT_DYNAMICS.happy.inertia),
        5,
      );
      expect(saved?.vector.intimacy).toBeGreaterThan(DEFAULT_DYNAMICS.intimacy.baseline);
      expect(saved?.vector.intimacy).toBeLessThan(saved?.vector.happy ?? 1);
      const history = store.emotionHistory("primary", 10);
      expect(history).toHaveLength(1);
      expect(history[0]?.scorer).toBe("rules");
      const second = utterance(store, "哈哈，太好了", "user", AWAKE + 1000);
      await mood.observe(second);
      const both = store.emotionHistory("primary", 10);
      expect(both).toHaveLength(2);
      expect(both[0]).toEqual(history[0]);
      expect(mood.line("primary", AWAKE + 1000)).toContain("我");
      expect(mood.line("primary", AWAKE + 1000)).not.toMatch(/\d/);
    } finally {
      store.close();
    }
    const again = new CompanionStore(path);
    try {
      expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(again.emotionHistory("primary", 10)).toHaveLength(2);
      expect(again.getEmotion("primary")?.vector.happy).toBeGreaterThan(DEFAULT_DYNAMICS.happy.baseline);
    } finally {
      again.close();
    }
  });

  it("migrates a version 1 database without dropping turns", () => {
    const path = fileDb();
    const created = new CompanionStore(path);
    const saved = created.appendTurn({
      channel: "",
      userId: "",
      chatId: "",
      sessionId: "s",
      bridge: "",
      personId: "primary",
      ts: AWAKE,
      role: "user",
      content: "不要弄丢这句话",
    });
    created.close();
    const editor = new DatabaseSync(path);
    editor.exec(`
      DROP TABLE IF EXISTS proactive_outbox;
      DROP TABLE IF EXISTS emotion_followup;
      DROP TABLE IF EXISTS emotion_latch;
      DROP TABLE IF EXISTS emotion_history;
      DROP TABLE IF EXISTS emotion_state;
    `);
    editor.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    editor.close();
    const upgraded = new CompanionStore(path);
    try {
      expect(upgraded.schemaVersion()).toBe(2);
      expect(upgraded.getTurn(saved.id)?.content).toBe("不要弄丢这句话");
      expect(upgraded.getEmotion("primary")).toBeUndefined();
      expect(upgraded.emotionHistory("primary", 10)).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("refuses a mood value outside its range without rewriting the file", () => {
    const path = fileDb();
    const store = new CompanionStore(path);
    store.close();
    const editor = new DatabaseSync(path);
    editor.prepare(
      `INSERT INTO emotion_state (
         person_id, pleasure, arousal, dominance, happy, missing, aggrieved, worried,
         jealous, shy, angry, at_ease, intimacy, updated_at, last_user_at
       ) VALUES ('primary', 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, NULL)`,
    ).run();
    editor.close();
    const before = readFileSync(path);
    const wal = existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : undefined;
    expect(() => new CompanionStore(path)).toThrow(/malformed emotion_state/);
    expect(readFileSync(path)).toEqual(before);
    if (wal) expect(readFileSync(`${path}-wal`)).toEqual(wal);
    else if (existsSync(`${path}-wal`)) expect(readFileSync(`${path}-wal`).length).toBe(0);
  });

  it("moves emotion history onto the linked person", async () => {
    const store = new CompanionStore(":memory:");
    try {
      const person = store.personFor("qq", "42");
      const mood = model(store, { proactive: { enabled: false } });
      await mood.observe(utterance(store, "我想你", "user", AWAKE, person));
      expect(store.getEmotion(person)?.vector.happy).toBeGreaterThan(0.5);
      store.linkIdentity("qq", "42", "primary");
      expect(store.getEmotion(person)).toBeUndefined();
      expect(store.getEmotion("primary")?.vector.happy).toBeGreaterThan(0.5);
      expect(store.emotionHistory("primary", 10)).toHaveLength(1);
      expect(store.recentTurns("primary", 5)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("scales an assistant turn and does not schedule a follow-up from it", async () => {
    const store = new CompanionStore(":memory:");
    try {
      const mood = model(store, { proactive: { enabled: false } });
      await mood.observe(utterance(store, "明天要考试", "assistant"));
      expect(store.emotionFollowups("primary")).toEqual([]);
      await mood.observe(utterance(store, "我想你", "assistant", AWAKE + 1, "assistant-person"));
      await mood.observe(utterance(store, "我想你", "user", AWAKE + 2, "user-person"));
      const assistantHappy = store.getEmotion("assistant-person")?.vector.happy ?? 0;
      const userHappy = store.getEmotion("user-person")?.vector.happy ?? 0;
      expect(userHappy).toBeGreaterThan(assistantHappy);
      expect(assistantHappy).toBeGreaterThan(DEFAULT_DYNAMICS.happy.baseline);
      await mood.observe(utterance(store, "明天要考试", "user", AWAKE + 3));
      expect(store.emotionFollowups("primary")).toHaveLength(1);
      expect(store.emotionFollowups("assistant-person")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("cheap model scorer", () => {
  it("does not call the network without a key", async () => {
    let called = false;
    const scorer = new CheapModelScorer({
      baseUrl: "https://example.test/v1",
      model: "cheap",
      timeoutMs: 50,
      apiKey: "  ",
      fetch: async () => {
        called = true;
        throw new Error("should not run");
      },
    });
    const store = new CompanionStore(":memory:");
    try {
      const turn = utterance(store, "我想你");
      expect(await scorer.score({ turn, state: baselineVector() })).toBeUndefined();
      expect(called).toBe(false);
    } finally {
      store.close();
    }
  });

  it("falls back when the model fails and never stores the key", async () => {
    const secret = "sk-test-secret";
    const store = new CompanionStore(":memory:");
    try {
      const scorer: EmotionScorer = {
        id: "model",
        score: async () => {
          throw new Error(`denied ${secret}`);
        },
      };
      const mood = model(store, { scorer, proactive: { enabled: false } });
      await mood.observe(utterance(store, "我想你"));
      const history = store.emotionHistory("primary", 5);
      expect(history[0]?.scorer).toBe("rules");
      expect(JSON.stringify(history)).not.toContain(secret);
      expect(mood.line("primary", AWAKE)).not.toContain(secret);
    } finally {
      store.close();
    }
  });

  it("uses a mock completion and ignores a bad body", async () => {
    const captured: { url?: string; authorization?: string } = {};
    const scorer = new CheapModelScorer({
      baseUrl: "https://example.test/v1",
      model: "cheap",
      timeoutMs: 200,
      apiKey: "local-test-key",
      fetch: async (url, init) => {
        captured.url = String(url);
        const headers = new Headers(init?.headers);
        const authorization = headers.get("authorization");
        if (authorization !== null) captured.authorization = authorization;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "```json\n{\"deltas\":{\"pleasure\":0,\"arousal\":0,\"dominance\":0,\"happy\":0.4,\"missing\":0,\"aggrieved\":0,\"worried\":0,\"jealous\":0,\"shy\":0,\"angry\":0,\"atEase\":0,\"intimacy\":0.02},\"event\":{\"kind\":\"exam\",\"note\":\"明天考试\"}}\n```" } }],
        }));
      },
    });
    const store = new CompanionStore(":memory:");
    try {
      const turn = utterance(store, "随便一句");
      const scored = await scorer.score({ turn, state: baselineVector() });
      expect(captured.url).toBe("https://example.test/v1/chat/completions");
      expect(captured.authorization).toBe("Bearer local-test-key");
      expect(captured.url).not.toContain("local-test-key");
      expect(scored?.deltas.happy).toBe(0.4);
      expect(scored?.event).toEqual({ kind: "exam", note: "明天考试" });
      expect(parseScore({ choices: [{ message: { content: "nope" } }] })).toBeUndefined();
      expect(completionsUrl("https://example.test/v1/chat/completions")).toBe("https://example.test/v1/chat/completions");
    } finally {
      store.close();
    }
  });

  it("times out a hanging request and lets the rules stand", async () => {
    const store = new CompanionStore(":memory:");
    try {
      const hanging = new CheapModelScorer({
        baseUrl: "https://example.test/v1",
        model: "cheap",
        timeoutMs: 20,
        apiKey: "local-test-key",
        fetch: (_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      });
      const turn = utterance(store, "我想你");
      expect(await hanging.score({ turn, state: baselineVector() })).toBeUndefined();
      const mood = model(store, {
        proactive: { enabled: false },
        scorer: {
          id: "model",
          score: async () => undefined,
        },
      });
      await mood.observe(turn);
      expect(store.emotionHistory("primary", 1)[0]?.scorer).toBe("rules");
    } finally {
      store.close();
    }
  });
});

describe("proactive queue", () => {
  it("sends one missing note while awake and holds it through quiet hours", async () => {
    const store = new CompanionStore(":memory:");
    const sent: string[] = [];
    try {
      store.commitEmotion({
        state: { personId: "primary", vector: vector({ missing: 0.9 }), updatedAt: AWAKE, lastUserAt: AWAKE - 48 * 60 * 60 * 1000 },
        history: { ts: AWAKE, turnId: null, reason: "turn", scorer: "rules" },
      });
      const quiet = model(store, {
        clock: () => QUIET,
        deliver: (item) => {
          sent.push(item.text);
          return true;
        },
      });
      await quiet.evaluateProactive(QUIET);
      expect(sent).toEqual([]);
      const held = store.proactiveQueue("primary");
      expect(held).toHaveLength(1);
      expect(held[0]?.kind).toBe("threshold");
      expect(held[0]?.dimension).toBe("missing");
      expect(held[0]?.dueAt).toBe(MORNING);
      expect(held[0]?.text).not.toMatch(/\d/);
      const awake = model(store, {
        deliver: (item) => {
          sent.push(item.text);
          return true;
        },
      });
      await awake.evaluateProactive(MORNING);
      expect(sent).toHaveLength(1);
      expect(store.proactiveQueue("primary")[0]?.status).toBe("delivered");
      await awake.evaluateProactive(MORNING);
      expect(sent).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("caps the day and keeps a minimum gap between threshold notes", async () => {
    const store = new CompanionStore(":memory:");
    const sent: string[] = [];
    try {
      store.commitEmotion({
        state: {
          personId: "primary",
          vector: vector({ missing: 0.95, worried: 0.95 }),
          updatedAt: AWAKE,
          lastUserAt: AWAKE,
        },
        history: { ts: AWAKE, turnId: null, reason: "turn", scorer: "rules" },
      });
      const mood = model(store, {
        proactive: { dailyCap: 1, minGapMs: 2 * 60 * 60 * 1000 },
        deliver: (item) => {
          sent.push(item.dimension);
          return true;
        },
      });
      await mood.evaluateProactive(AWAKE);
      expect(sent).toEqual(["missing"]);
      const waiting = store.proactiveQueue("primary").find((item) => item.status === "queued");
      expect(waiting?.dimension).toBe("worried");
      expect(waiting?.dueAt).toBeGreaterThan(AWAKE);
      await mood.evaluateProactive(waiting?.dueAt ?? AWAKE);
      expect(sent).toEqual(["missing", "worried"]);
      await mood.evaluateProactive((waiting?.dueAt ?? AWAKE) + 60_000);
      expect(sent).toEqual(["missing", "worried"]);
    } finally {
      store.close();
    }
  });

  it("follows an exam on the next local morning and not the same day", async () => {
    const store = new CompanionStore(":memory:");
    const sent: string[] = [];
    try {
      const mood = model(store, {
        deliver: (item) => {
          sent.push(item.kind);
          return true;
        },
      });
      await mood.observe(utterance(store, "明天要考试，我有点紧张"));
      const follow = store.emotionFollowups("primary");
      expect(follow[0]?.kind).toBe("exam");
      expect(follow[0]?.status).toBe("pending");
      expect(follow[0]?.dueAt).toBe(FOLLOW_AT);
      expect(follow[0]?.note).toContain("考试");
      expect(store.proactiveQueue("primary").some((item) => item.kind === "followup")).toBe(false);
      await mood.evaluateProactive(AWAKE + 60_000);
      expect(sent).not.toContain("followup");
      await mood.evaluateProactive(FOLLOW_AT);
      expect(sent).toContain("followup");
      expect(store.emotionFollowups("primary")[0]?.status).toBe("delivered");
      const text = store.proactiveQueue("primary").find((item) => item.kind === "followup")?.text ?? "";
      expect(text).toContain("考试");
      expect(text).not.toMatch(/情绪分数|0\.\d/);
    } finally {
      store.close();
    }
  });

  it("keeps a failed delivery queued and retries it", async () => {
    const store = new CompanionStore(":memory:");
    let fail = true;
    let calls = 0;
    try {
      store.commitEmotion({
        state: { personId: "primary", vector: vector({ missing: 0.9 }), updatedAt: AWAKE, lastUserAt: AWAKE },
        history: { ts: AWAKE, turnId: null, reason: "turn", scorer: "rules" },
      });
      const mood = model(store, {
        deliver: () => {
          calls += 1;
          if (fail) throw new Error("agent went away");
          return true;
        },
      });
      await mood.evaluateProactive(AWAKE);
      expect(calls).toBe(1);
      expect(store.proactiveQueue("primary")[0]?.status).toBe("queued");
      fail = false;
      await mood.evaluateProactive(AWAKE);
      expect(calls).toBe(2);
      expect(store.proactiveQueue("primary")[0]?.status).toBe("delivered");
    } finally {
      store.close();
    }
  });

  it("requeues a delivery that was claimed and then interrupted", () => {
    const path = fileDb();
    const store = new CompanionStore(path);
    store.commitEmotion({
      state: { personId: "primary", vector: vector({ missing: 0.9 }), updatedAt: AWAKE, lastUserAt: AWAKE },
      history: { ts: AWAKE, turnId: null, reason: "turn", scorer: "rules" },
    });
    store.applyProactivePlan({
      personId: "primary",
      arm: [],
      reschedule: [],
      enqueue: [{
        sessionId: "s",
        createdAt: AWAKE,
        dueAt: AWAKE,
        kind: "threshold",
        dimension: "missing",
        followupId: null,
        text: "你想开口。",
      }],
      markFollowupsQueued: [],
    });
    expect(store.claimProactive(1, AWAKE)).toBe(true);
    store.close();
    const again = new CompanionStore(path);
    try {
      expect(again.proactiveQueue("primary")[0]?.status).toBe("queued");
    } finally {
      again.close();
    }
  });

  it("leaves the row queued when nothing can deliver it", async () => {
    const store = new CompanionStore(":memory:");
    try {
      store.commitEmotion({
        state: { personId: "primary", vector: vector({ worried: 0.9 }), updatedAt: AWAKE, lastUserAt: AWAKE },
        history: { ts: AWAKE, turnId: null, reason: "turn", scorer: "rules" },
      });
      const mood = model(store);
      await mood.evaluateProactive(AWAKE);
      expect(store.proactiveQueue("primary")[0]?.status).toBe("queued");
      expect(store.dueProactive(AWAKE)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("marks a followup message so the transcript logger skips the instruction", () => {
    let captured: { content: Array<{ text: string }>; source: { kind: string; form?: string } } | undefined;
    const agent: FollowupTarget = {
      followup(message) {
        captured = message;
      },
    };
    deliverViaFollowup(agent, "你想问一句。");
    expect(captured?.source).toEqual({ kind: "dsh-companion", form: "proactive" });
    expect(captured?.content[0]?.text.startsWith(RECALL_MARK)).toBe(true);
    expect(shouldSkipUserMessage({ role: "user", content: captured?.content, source: captured?.source })).toBe(true);
    expect(() => deliverViaFollowup({} as FollowupTarget, "这句不该出现在错误里")).toThrow(/followup method/);
    try {
      deliverViaFollowup({} as FollowupTarget, "这句不该出现在错误里");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("这句不该出现在错误里");
    }
  });
});

describe("emotion config and plugin injection", () => {
  it("rejects a bad clock and an enabled model with no endpoint, and defaults to Shanghai", () => {
    expect(loadCompanionConfig({ path: ":memory:" }).proactiveQuietTimeZone).toBe("Asia/Shanghai");
    expect(loadCompanionConfig({ path: ":memory:" }).emotionModelEnabled).toBe(false);
    expect(() => loadCompanionConfig({ path: ":memory:", proactiveQuietTimeZone: "Not/AZone" })).toThrow(/time zone/);
    expect(() => loadCompanionConfig({ path: ":memory:", proactiveQuietStart: "25:00" })).toThrow(/proactiveQuietStart/);
    expect(() => loadCompanionConfig({ path: ":memory:", proactiveDailyCap: 0 })).toThrow(/proactiveDailyCap/);
    expect(() => loadCompanionConfig({ path: ":memory:", thresholdMissing: 1.2 })).toThrow(/thresholdMissing/);
    expect(() => loadCompanionConfig({ path: ":memory:", emotionModelEnabled: true })).toThrow(/emotionModelBaseUrl/);
    const enabled = loadCompanionConfig({
      path: ":memory:",
      emotionModelEnabled: true,
      emotionModelBaseUrl: "https://example.test/v1",
    });
    expect(enabled.emotionModelBaseUrl).toBe("https://example.test/v1");
    expect(enabled.emotionModelName).toBe("deepseek-chat");
  });

  it("puts the mood in the volatile recall and leaves the persona unchanged", async () => {
    const path = fileDb();
    const listeners = new Map<string, (...args: any[]) => any>();
    let dispose = () => {};
    let section: { name: string; text: () => string } | undefined;
    const ctx = {
      effect(callback: () => () => void) { dispose = callback(); },
      on(event: string, listener: (...args: any[]) => any) { listeners.set(event, listener); },
      tools: { register() {} },
      systemPrompt: { section(value: { name: string; text: () => string }) { section = value; } },
    } as unknown as Context;
    const now = Date.now();
    apply(ctx, { path, proactiveEnabled: false });
    try {
      listeners.get("session/event")?.({ id: "s1" }, {
        type: "user/message",
        time: now,
        data: { role: "user", content: "我想你", source: { kind: "user" } },
      });
      const decision = await listeners.get("agent/pre-step")?.(
        {
          agent: { session: { id: "s1" } },
          messages: [{ role: "user", content: "在吗", source: { kind: "user" } }],
          signal: new AbortController().signal,
        },
        async () => ({
          kind: "enter",
          messages: [{ role: "user", content: "在吗", source: { kind: "user" } }],
          startsRequestSeries: true,
        }),
      );
      const text = decision.messages[0].content[0].text as string;
      expect(text.startsWith(RECALL_MARK)).toBe(true);
      expect(text).toContain("有点开心");
      expect(section?.text()).not.toContain("有点开心");
      expect(section?.text()).toContain("同一个人");
      expect(text).not.toMatch(/\d/);
    } finally {
      dispose();
    }
  });

  it("does nothing when emotion is disabled", async () => {
    const store = new CompanionStore(":memory:");
    try {
      const mood = model(store, { enabled: false });
      await mood.observe(utterance(store, "我想你"));
      expect(store.getEmotion("primary")).toBeUndefined();
      expect(mood.line("primary", AWAKE)).toBe("");
    } finally {
      store.close();
    }
  });
});
