import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { loadCompanionConfig } from "../src/companion/config.js";
import { detectImportantEvent } from "../src/companion/diary/events.js";
import { VERBATIM_MARK } from "../src/companion/diary/fallback.js";
import { CheapDiaryModel, parseDiary, type DiaryModel } from "../src/companion/diary/model.js";
import { dayBounds, dayKey, dayKeysOfWeek, weekKeyFromDay } from "../src/companion/diary/periods.js";
import { LayeredDiaryWriter } from "../src/companion/diary/writer.js";
import { zonedTimeToUtc } from "../src/companion/emotion/clock.js";
import { completionsUrl } from "../src/companion/emotion/model-scorer.js";
import { apply } from "../src/companion/plugin.js";
import { RECALL_MARK, renderCompanionPrompt } from "../src/companion/render.js";
import { retrieve } from "../src/companion/retrieve.js";
import { SCHEMA_VERSION } from "../src/companion/schema.js";
import { CompanionStore } from "../src/companion/store.js";
import type { TurnRecord, TurnRole } from "../src/companion/types.js";

const TZ = "Asia/Shanghai";
const MARK = "KEEP-THIS-EXAM-SENTENCE-UNTOUCHED";

function fileDb(): string {
  return join(mkdtempSync(join(tmpdir(), "dsh-diary-")), "companion.db");
}

function at(day: number, hour = 12): number {
  return zonedTimeToUtc(2026, 10, day, hour, 0, TZ);
}

function later(): number {
  return zonedTimeToUtc(2026, 12, 1, 12, 0, TZ);
}

function say(
  store: CompanionStore,
  content: string,
  ts: number,
  role: TurnRole = "user",
  personId = "primary",
): TurnRecord {
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

function writer(
  store: CompanionStore,
  now: number,
  extra: { model?: DiaryModel; maxDaysPerRun?: number } = {},
): LayeredDiaryWriter {
  return new LayeredDiaryWriter(store, {
    timeZone: TZ,
    now: () => now,
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.maxDaysPerRun !== undefined ? { maxDaysPerRun: extra.maxDaysPerRun } : {}),
  });
}

describe("diary periods and events", () => {
  it("keeps a local day inside its own bounds and its ISO week", () => {
    const noon = at(22);
    const key = dayKey(noon, TZ);
    expect(key).toBe("2026-10-22");
    const bounds = dayBounds(key, TZ);
    expect(noon).toBeGreaterThanOrEqual(bounds.start);
    expect(noon).toBeLessThan(bounds.end);
    expect(at(23)).toBeGreaterThanOrEqual(bounds.end);
    const week = weekKeyFromDay(key);
    expect(dayKeysOfWeek(week)).toContain(key);
    expect(dayKeysOfWeek(week)).toHaveLength(7);
  });

  it("flags a life event and keeps the whole utterance", () => {
    const content = `明天有考试，原话${MARK}。`;
    expect(detectImportantEvent({ role: "user", content })).toEqual({ kind: "exam", verbatim: content });
    expect(detectImportantEvent({ role: "user", content: "今天天气不错" })).toBeUndefined();
    expect(detectImportantEvent({ role: "assistant", content: "我答应你" })?.kind).toBe("promise");
  });
});

describe("layered diary", () => {
  it("seals a finished day on rollover, leaves today open, and is idempotent", async () => {
    const store = new CompanionStore(":memory:");
    try {
      const first = say(store, "今天天气不错，我们随便聊了聊。", at(22));
      let now = at(22);
      const pages = writer(store, now);
      await pages.observe(first);
      expect(store.diaryEntries("primary").filter((entry) => entry.status === "sealed")).toEqual([]);
      const second = say(store, "第二天了，还是随便聊聊。", at(23));
      now = at(23);
      const next = writer(store, now);
      await next.observe(second);
      const sealed = store.diaryEntries("primary").filter((entry) => entry.status === "sealed");
      expect(sealed.map((entry) => entry.periodKey)).toEqual(["2026-10-22"]);
      expect(sealed[0]?.source).toBe("fallback");
      expect(sealed[0]?.text).toContain("我还记得这一天");
      expect(sealed[0]?.text).toContain("你说");
      expect(sealed[0]?.text).not.toMatch(/根据记录|检索结果|交接/);
      const before = store.diaryEntries("primary").map((entry) => entry.id);
      await next.maintain(at(23));
      expect(store.diaryEntries("primary").map((entry) => entry.id)).toEqual(before);
      expect(store.countTurns()).toBe(2);
    } finally {
      store.close();
    }
  });

  it("rolls days into a week and a month without deleting turns or compressing events", async () => {
    const store = new CompanionStore(":memory:");
    try {
      const filler = "闲".repeat(400);
      const quiet = say(store, filler, at(20));
      say(store, filler, at(21));
      const event = say(store, `明天有考试，原话${MARK}。`, at(22));
      say(store, "我记住了，考试这事我放在心里。", at(22, 13), "assistant");
      const raw = store.countTurns();
      const pages = writer(store, later());
      await pages.maintain(later());
      await pages.maintain(later());
      expect(store.countTurns()).toBe(raw);
      expect(store.getTurn(event.id)?.content).toBe(event.content);
      expect(store.getTurn(quiet.id)?.content).toBe(filler);
      const entries = store.diaryEntries("primary");
      const day = entries.find((entry) => entry.layer === "day" && entry.periodKey === "2026-10-22");
      const week = entries.find((entry) => entry.layer === "week");
      const month = entries.find((entry) => entry.layer === "month" && entry.periodKey === "2026-10");
      expect(day?.text).toContain(MARK);
      expect(week?.text).toContain(MARK);
      expect(week?.text).toContain(VERBATIM_MARK);
      expect(week?.text.includes(filler)).toBe(false);
      expect(month?.text).toContain(MARK);
      const saved = store.diaryEvents("primary").find((item) => item.turnId === event.id);
      expect(saved?.verbatim).toBe(event.content);
      expect(saved?.kind).toBe("exam");
      expect(entries.filter((entry) => entry.layer === "day" && entry.periodKey === "2026-10-22")).toHaveLength(1);
      await pages.observe(event);
      expect(store.diaryEvents("primary").filter((item) => item.turnId === event.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("seals a limited number of days per run and continues on the next run", async () => {
    const store = new CompanionStore(":memory:");
    try {
      say(store, "第一天随便聊。", at(1));
      say(store, "第二天随便聊。", at(2));
      say(store, "第三天随便聊。", at(3));
      const pages = writer(store, at(4), { maxDaysPerRun: 1 });
      await pages.maintain(at(4));
      expect(store.diaryEntries("primary").filter((entry) => entry.layer === "day" && entry.status === "sealed")).toHaveLength(1);
      await pages.maintain(at(4));
      expect(store.diaryEntries("primary").filter((entry) => entry.layer === "day" && entry.status === "sealed")).toHaveLength(2);
      await pages.maintain(at(4));
      expect(store.diaryEntries("primary").filter((entry) => entry.layer === "day")).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("uses the cheap model when it returns prose, and the fallback when it does not", async () => {
    const store = new CompanionStore(":memory:");
    let calls = 0;
    const seen: string[] = [];
    const model: DiaryModel = {
      id: "model",
      async write(draft) {
        calls += 1;
        seen.push(draft.periodKey);
        if (draft.layer !== "day") return "这一段我用自己的话写下来。";
        return "今天他提了一嘴，我记在心里。";
      },
    };
    try {
      const event = say(store, `明天有考试，原话${MARK}。`, at(22));
      const pages = writer(store, at(23), { model });
      await pages.maintain(at(23));
      const day = store.diaryEntry("primary", "day", "2026-10-22");
      expect(day?.source).toBe("model");
      expect(day?.text).toContain("我记在心里");
      expect(day?.text).toContain(MARK);
      expect(day?.text).toContain(event.content);
      const callsAfter = calls;
      await pages.maintain(at(23));
      expect(calls).toBe(callsAfter);
      expect(seen).toContain("2026-10-22");
    } finally {
      store.close();
    }
  });

  it("falls back when the model refuses, times out, or has no key", async () => {
    const store = new CompanionStore(":memory:");
    const refused: DiaryModel = { id: "model", async write() { return "根据记录，他考试。"; } };
    try {
      say(store, `明天有考试，原话${MARK}。`, at(22));
      await writer(store, at(23), { model: refused }).maintain(at(23));
      const day = store.diaryEntry("primary", "day", "2026-10-22");
      expect(day?.source).toBe("fallback");
      expect(day?.text).toContain(MARK);
      expect(day?.text).not.toContain("根据记录");
    } finally {
      store.close();
    }

    const calls: Array<{ url: string; authorization: string }> = [];
    const slow = new CheapDiaryModel({
      baseUrl: "https://example.test/v1",
      model: "deepseek-chat",
      timeoutMs: 30,
      apiKey: "diary-key",
      fetch: (url, init) => new Promise((_resolve, reject) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), authorization: headers.get("authorization") ?? "" });
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    });
    const timed = new CompanionStore(":memory:");
    try {
      say(timed, "今天天气不错，我们随便聊了聊。", at(22));
      await writer(timed, at(23), { model: slow }).maintain(at(23));
      expect(calls[0]?.url).toBe(completionsUrl("https://example.test/v1"));
      expect(calls[0]?.authorization).toBe("Bearer diary-key");
      const day = timed.diaryEntry("primary", "day", "2026-10-22");
      expect(day?.source).toBe("fallback");
      expect(day?.text).not.toContain("diary-key");
    } finally {
      timed.close();
    }

    let fetched = false;
    const silent = new CheapDiaryModel({
      baseUrl: "https://example.test/v1",
      model: "deepseek-chat",
      timeoutMs: 1000,
      apiKey: "  ",
      fetch: () => {
        fetched = true;
        throw new Error("should not be called");
      },
    });
    expect(await silent.write({
      layer: "day",
      periodKey: "2026-10-22",
      turns: [],
      days: [],
      weeks: [],
      events: [],
    })).toBeUndefined();
    expect(fetched).toBe(false);
    expect(parseDiary({ choices: [{ message: { content: "```json\n{\"diary\":\"我还记得。\"}\n```" } }] })).toBe("我还记得。");
    expect(parseDiary({ choices: [{ message: { content: "{\"diary\":\"根据记录\"}" } }] })).toBeUndefined();
  });

  it("retrieves a diary page beside the raw turn, in the first person, inside the same budget", async () => {
    const store = new CompanionStore(":memory:");
    const model: DiaryModel = {
      id: "model",
      async write(draft) {
        return draft.layer === "day" ? "我还留着那块桂花糕。" : "后来的日子我也记着桂花糕。";
      },
    };
    try {
      say(store, "今天只是随便聊聊，没提点心。", at(22));
      await writer(store, at(23), { model }).maintain(at(23));
      const snippets = retrieve(store, { query: "桂花糕", personId: "primary", limit: 3, radius: 0 });
      expect(snippets.map((item) => item.kind)).toEqual(["diary"]);
      expect(snippets[0]?.text).toContain("我翻到自己写过的一篇日记");
      expect(snippets[0]?.text).toContain("桂花糕");
      expect(snippets[0]?.text).not.toMatch(/根据记录|检索结果|交接/);
      const both = retrieve(store, { query: "随便聊聊", personId: "primary", limit: 3, radius: 0 });
      expect(both.some((item) => item.kind === "turn" && item.text.includes("你说"))).toBe(true);
      const other = new CompanionStore(":memory:");
      try {
        say(other, "另一位只说过桂花糕这个词吗，没有。", at(22), "user", "other");
        const missed = retrieve(store, { query: "桂花糕", personId: "other", limit: 3, radius: 0 });
        expect(missed).toEqual([]);
      } finally {
        other.close();
      }
      const noisy = retrieve(store, { query: `* OR NOT "桂花糕"`, personId: "primary", limit: 5, radius: 0 });
      expect(noisy.every((item) => item.text.includes("桂花糕"))).toBe(true);
    } finally {
      store.close();
    }

    const persona = "我是同一个人。";
    const recent = [{
      id: 1,
      channel: "",
      userId: "",
      chatId: "",
      sessionId: "s",
      bridge: "",
      personId: "primary",
      ts: 1,
      role: "user" as const,
      content: "短",
      turnNo: null,
    }];
    const diaryText = `我翻到自己写过的一篇日记。\n${"桂花糕".repeat(80)}`;
    const tight = renderCompanionPrompt({
      persona,
      emotionLine: "",
      recent,
      snippets: [{ focusId: 9, score: 1, text: diaryText, turnIds: [], kind: "diary" }],
      maxChars: 40,
    });
    expect(tight.stable).toBe(persona);
    expect(tight.chars).toBeLessThanOrEqual(40);
    expect(tight.volatile).toContain("短");
    expect(tight.volatile).not.toContain("桂花糕");
    const wide = renderCompanionPrompt({
      persona,
      emotionLine: "",
      recent,
      snippets: [{ focusId: 9, score: 1, text: "我翻到自己写过的一篇日记。\n我还留着桂花糕。", turnIds: [], kind: "diary" }],
      maxChars: 200,
    });
    expect(wide.volatile).toContain("我翻到自己写过的一篇日记");
    expect(wide.volatile).toContain("桂花糕");
    expect(wide.stable).not.toContain("桂花糕");
    expect(wide.wire.startsWith(RECALL_MARK)).toBe(true);
    const counted = renderCompanionPrompt({
      persona,
      emotionLine: "",
      recent,
      snippets: [{ focusId: 9, score: 1, text: diaryText, turnIds: [], kind: "diary" }],
      maxChars: 10_000,
      maxTokens: 30,
      tokenCounter: (text) => text.length,
    });
    expect(counted.tokens).toBeLessThanOrEqual(30);
    expect(counted.volatile).not.toContain("桂花糕");
    expect(counted.stable).toBe(persona);
  });

  it("moves diary pages and events onto the linked person", async () => {
    const store = new CompanionStore(":memory:");
    try {
      const person = store.personFor("qq", "9");
      const event = say(store, `明天有考试，原话${MARK}。`, at(22), "user", person);
      await writer(store, at(23)).observe(event);
      expect(store.diaryEvents(person)).toHaveLength(1);
      store.linkIdentity("qq", "9", "primary");
      expect(store.diaryEvents(person)).toEqual([]);
      expect(store.diaryEvents("primary")[0]?.verbatim).toBe(event.content);
      expect(store.diaryEntries("primary").some((entry) => entry.layer === "day" && entry.text.includes(MARK))).toBe(true);
      expect(store.recentTurns("primary", 5)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("diary schema", () => {
  it("migrates a version 2 database and refuses diary rows that appear too early", () => {
    const path = fileDb();
    const created = new CompanionStore(path);
    const saved = say(created, "不要弄丢这句话", at(22));
    created.close();
    const editor = new DatabaseSync(path);
    editor.exec(`
      DROP TABLE IF EXISTS diary_fts;
      DROP TABLE IF EXISTS diary_event;
      DROP TABLE IF EXISTS diary_entry;
    `);
    editor.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    editor.close();
    const upgraded = new CompanionStore(path);
    try {
      expect(upgraded.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(upgraded.getTurn(saved.id)?.content).toBe("不要弄丢这句话");
      expect(upgraded.diaryEntries()).toEqual([]);
    } finally {
      upgraded.close();
    }

    const early = fileDb();
    const seeded = new CompanionStore(early);
    seeded.close();
    const marker = new DatabaseSync(early);
    marker.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    marker.close();
    const before = readFileSync(early);
    const wal = existsSync(`${early}-wal`) ? readFileSync(`${early}-wal`) : undefined;
    expect(() => new CompanionStore(early)).toThrow(/diary objects exist before schema 3/);
    expect(readFileSync(early)).toEqual(before);
    if (wal) expect(readFileSync(`${early}-wal`)).toEqual(wal);
    else if (existsSync(`${early}-wal`)) expect(readFileSync(`${early}-wal`).length).toBe(0);

    const broken = fileDb();
    const opened = new CompanionStore(broken);
    opened.close();
    const bad = new DatabaseSync(broken);
    bad.prepare(
      `INSERT INTO diary_entry (
         person_id, layer, period_key, text, source, status, created_at, updated_at
       ) VALUES ('primary', 'day', '2026-10-22', '', 'fallback', 'sealed', 1, 1)`,
    ).run();
    bad.close();
    const brokenBytes = readFileSync(broken);
    expect(() => new CompanionStore(broken)).toThrow(/malformed diary_entry/);
    expect(readFileSync(broken)).toEqual(brokenBytes);
  });
});

describe("diary config and scheduling", () => {
  it("rejects a bad diary clock and an enabled model with no endpoint", () => {
    const config = loadCompanionConfig({ path: ":memory:" });
    expect(config.diaryEnabled).toBe(true);
    expect(config.diaryTimeZone).toBe("Asia/Shanghai");
    expect(config.diaryModelEnabled).toBe(false);
    expect(config.diaryIntervalMs).toBe(15 * 60 * 1000);
    expect(() => loadCompanionConfig({ path: ":memory:", diaryTimeZone: "Not/AZone" })).toThrow(/time zone/);
    expect(() => loadCompanionConfig({ path: ":memory:", diaryModelEnabled: true })).toThrow(/diaryModelBaseUrl/);
    expect(() => loadCompanionConfig({ path: ":memory:", diaryIntervalMs: -1 })).toThrow(/diaryIntervalMs/);
  });

  it("seals a finished day when the agent is idle, and stays quiet when diary is off", async () => {
    const path = fileDb();
    const listeners = new Map<string, (...args: any[]) => any>();
    let dispose = () => {};
    const ctx = {
      effect(callback: () => () => void) { dispose = callback(); },
      on(event: string, listener: (...args: any[]) => any) { listeners.set(event, listener); },
      tools: { register() {} },
      systemPrompt: { section() {} },
    } as unknown as Context;
    apply(ctx, {
      path,
      emotionEnabled: false,
      proactiveEnabled: false,
      diaryIntervalMs: 0,
    });
    const side = new CompanionStore(path);
    side.appendTurn({
      channel: "",
      userId: "",
      chatId: "",
      sessionId: "s",
      bridge: "",
      personId: "primary",
      ts: Date.now() - 3 * 24 * 60 * 60 * 1000,
      role: "user",
      content: `明天有考试，原话${MARK}。`,
    });
    side.close();
    listeners.get("agent/status")?.({ status: "idle" });
    try {
      await waitFor(() => {
        const peek = new CompanionStore(path);
        try {
          return peek.diaryEntries("primary").some((entry) => entry.status === "sealed" && entry.text.includes(MARK));
        } finally {
          peek.close();
        }
      });
      const peek = new CompanionStore(path);
      try {
        expect(peek.countTurns()).toBe(1);
        expect(peek.diaryEvents("primary")[0]?.verbatim).toContain(MARK);
      } finally {
        peek.close();
      }
    } finally {
      dispose();
    }

    const off = fileDb();
    const offListeners = new Map<string, (...args: any[]) => any>();
    let offDispose = () => {};
    const offCtx = {
      effect(callback: () => () => void) { offDispose = callback(); },
      on(event: string, listener: (...args: any[]) => any) { offListeners.set(event, listener); },
      tools: { register() {} },
      systemPrompt: { section() {} },
    } as unknown as Context;
    apply(offCtx, { path: off, emotionEnabled: false, diaryEnabled: false, diaryIntervalMs: 0 });
    try {
      offListeners.get("session/event")?.({ id: "s" }, {
        type: "user/message",
        time: Date.now(),
        data: { role: "user", content: `明天有考试，原话${MARK}。`, source: { kind: "user" } },
      });
      offListeners.get("agent/status")?.({ status: "idle" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const peek = new CompanionStore(off);
      try {
        expect(peek.countTurns()).toBe(1);
        expect(peek.diaryEvents("primary")).toEqual([]);
        expect(peek.diaryEntries("primary")).toEqual([]);
      } finally {
        peek.close();
      }
    } finally {
      offDispose();
    }
  });

  it("injects a sealed diary page in the first person under the recall budget", async () => {
    const path = fileDb();
    const listeners = new Map<string, (...args: any[]) => any>();
    const registered: any[] = [];
    let dispose = () => {};
    let section: { text: () => string } | undefined;
    const previous = globalThis.fetch;
    const previousKey = process.env.DSH_COMPANION_DIARY_API_KEY;
    process.env.DSH_COMPANION_DIARY_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ diary: "我还留着那块桂花糕。" }) } }],
    }), { status: 200 })) as typeof fetch;
    const ctx = {
      effect(callback: () => () => void) { dispose = callback(); },
      on(event: string, listener: (...args: any[]) => any) { listeners.set(event, listener); },
      tools: { register(tool: any) { registered.push(tool); } },
      systemPrompt: { section(value: { text: () => string }) { section = value; } },
    } as unknown as Context;
    apply(ctx, {
      path,
      emotionEnabled: false,
      proactiveEnabled: false,
      diaryIntervalMs: 0,
      diaryModelEnabled: true,
      diaryModelBaseUrl: "https://example.test/v1",
    });
    try {
      const past = Date.now() - 4 * 24 * 60 * 60 * 1000;
      listeners.get("session/event")?.({ id: "s1" }, {
        type: "user/message",
        time: past,
        data: { role: "user", content: "今天只是随便聊聊，没提点心。", source: { kind: "user" } },
      });
      await waitFor(() => {
        const peek = new CompanionStore(path);
        try {
          return peek.diaryEntries("primary").some((entry) => entry.text.includes("桂花糕"));
        } finally {
          peek.close();
        }
      });
      const tool = registered.find((item) => item.name === "history_search");
      const found = await tool.execute({ query: "桂花糕", limit: 2, around: 0 }, { agent: { session: { id: "s1" } } });
      expect(found.snippets[0].text).toContain("我翻到自己写过的一篇日记");
      expect(found.snippets[0].text).toContain("桂花糕");
      const decision = await listeners.get("agent/pre-step")?.(
        {
          agent: { session: { id: "s1" } },
          messages: [{ role: "user", content: "桂花糕还在吗", source: { kind: "user" } }],
          signal: new AbortController().signal,
        },
        async () => ({
          kind: "enter",
          messages: [{ role: "user", content: "桂花糕还在吗", source: { kind: "user" } }],
          startsRequestSeries: true,
        }),
      );
      const text = decision.messages[0].content[0].text as string;
      expect(text.startsWith(RECALL_MARK)).toBe(true);
      expect(text).toContain("桂花糕");
      expect(text).toContain("我");
      expect(section?.text()).not.toContain("桂花糕");
      expect(section?.text()).toContain("同一个人");
    } finally {
      dispose();
      globalThis.fetch = previous;
      if (previousKey === undefined) delete process.env.DSH_COMPANION_DIARY_API_KEY;
      else process.env.DSH_COMPANION_DIARY_API_KEY = previousKey;
    }
  });
});

async function waitFor(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("dsh-companion: timed out waiting for the diary");
}
