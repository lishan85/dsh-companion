import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@deepseek-ai/cordis";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { compileMatch } from "../src/search.js";
import { RECALL_MARK, renderCompanionPrompt } from "../src/companion/render.js";
import { retrieve } from "../src/companion/retrieve.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/companion/schema.js";
import { CompanionStore } from "../src/companion/store.js";
import { FtsOrderReranker, StubDiaryWriter, StubEmotionModel, type VectorIndex } from "../src/companion/stubs.js";
import type { TurnRecord, TurnRole } from "../src/companion/types.js";
import { apply } from "../src/companion/plugin.js";
import { runSessionSimulation } from "../src/companion/simulate.js";

function fileDb(): string {
  return join(mkdtempSync(join(tmpdir(), "dsh-companion-")), "companion.db");
}

function baseTurn(content: string, role: TurnRole = "user", personId = "primary") {
  return {
    channel: "",
    userId: "",
    chatId: "",
    sessionId: "s",
    bridge: "",
    personId,
    ts: 1,
    role,
    content,
  };
}

function turn(id: number, role: TurnRole, content: string): TurnRecord {
  return {
    id,
    channel: "",
    userId: "",
    chatId: "",
    sessionId: "s",
    bridge: "",
    personId: "primary",
    ts: id,
    role,
    content,
    turnNo: null,
  };
}

function harness(config: Record<string, unknown> = {}, extensions?: {
  emotion?: StubEmotionModel;
  diary?: StubDiaryWriter;
  vector?: VectorIndex;
}) {
  const listeners = new Map<string, (...args: any[]) => any>();
  let dispose = () => {};
  const registered: any[] = [];
  let section: { name: string; text: () => string } | undefined;
  const ctx = {
    effect(callback: () => () => void) { dispose = callback(); },
    on(event: string, listener: (...args: any[]) => any) { listeners.set(event, listener); },
    tools: { register(tool: any) { registered.push(tool); } },
    systemPrompt: { section(value: { name: string; text: () => string }) { section = value; } },
  } as unknown as Context;
  apply(ctx, { path: ":memory:", ...config }, extensions ? { extensions: {
    emotion: extensions.emotion ?? new StubEmotionModel(),
    diary: extensions.diary ?? new StubDiaryWriter(),
    vector: extensions.vector ?? { upsert() {}, search() { return []; } },
    reranker: new FtsOrderReranker(),
  } } : {});
  return {
    dispose: () => dispose(),
    listeners,
    section,
    tool: registered.find((item) => item.name === "history_search"),
    emit(session: unknown, event: unknown) {
      listeners.get("session/event")?.(session, event);
    },
  };
}

describe("companion store", () => {
  it("stores raw turns, channel fields, and Chinese full text", () => {
    const store = new CompanionStore(":memory:");
    try {
      expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(MIGRATIONS.map((step) => step.name)).toEqual([
        "core-turns-identity-fts",
        "emotion-state-history",
        "diary-layers",
        "hybrid-vectors",
      ]);
      const saved = store.appendTurn({
        channel: "qq",
        userId: "u1",
        chatId: "c1",
        sessionId: "s1",
        bridge: "dsh-qq",
        personId: "qq:u1",
        ts: 10,
        role: "user",
        content: "我养了一只叫年糕的白猫，它怕打雷。",
        turnNo: 3,
      });
      expect(saved.content).toBe("我养了一只叫年糕的白猫，它怕打雷。");
      expect(saved.channel).toBe("qq");
      expect(saved.bridge).toBe("dsh-qq");
      const match = compileMatch("年糕");
      expect(match).toBeDefined();
      expect(store.ftsTurns(match!, "qq:u1", 5).map((row) => row.id)).toEqual([saved.id]);
      expect(store.ftsTurns(match!, "primary", 5)).toEqual([]);
      const window = store.turnWindow("qq:u1", saved.id, 1);
      expect(window.map((item) => item.id)).toEqual([saved.id]);
    } finally {
      store.close();
      store.close();
    }
  });

  it("keeps neighboring turns around a hit and moves them when an identity is linked", () => {
    const store = new CompanionStore(":memory:");
    try {
      const person = store.personFor("qq", "42");
      expect(person).toBe("qq:42");
      expect(store.personFor("qq", "42")).toBe(person);
      for (const content of ["前天的事", "我养了一只叫年糕的白猫", "它怕打雷", "后来去散步", "再后来睡觉"]) {
        store.appendTurn({ ...baseTurn(content, "user", person), ts: store.countTurns() + 1 });
      }
      const hit = store.ftsTurns(compileMatch("年糕")!, person, 1)[0]!;
      const window = store.turnWindow(person, hit.id, 1);
      expect(window.map((item) => item.content)).toEqual(["前天的事", "我养了一只叫年糕的白猫", "它怕打雷"]);
      store.linkIdentity("qq", "42", "primary");
      expect(store.listIdentities()[0]?.personId).toBe("primary");
      expect(store.recentTurns("primary", 10)).toHaveLength(5);
      expect(store.recentTurns(person, 10)).toHaveLength(0);
      expect(store.ftsTurns(compileMatch("打雷")!, "primary", 5)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("quotes full-text operators instead of letting them match everything", () => {
    const store = new CompanionStore(":memory:");
    try {
      store.appendTurn(baseTurn("我养了一只叫年糕的白猫，它怕打雷。"));
      store.appendTurn({ ...baseTurn("今天天气很好。"), ts: 2 });
      const snippets = retrieve(store, {
        query: `* OR NOT "年糕"`,
        personId: "primary",
        limit: 5,
        radius: 0,
      });
      expect(snippets.map((item) => item.focusId)).toEqual([1]);
      expect(retrieve(store, { query: `"`, personId: "primary", limit: 5, radius: 0 })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rebuilds the derived index when the token version changes", () => {
    const path = fileDb();
    const store = new CompanionStore(path);
    store.appendTurn(baseTurn("年糕怕打雷"));
    store.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'fts_token_version'").run();
    db.exec("DELETE FROM turns_fts");
    db.close();
    const again = new CompanionStore(path);
    try {
      expect(again.ftsTurns(compileMatch("年糕")!, "primary", 5)).toHaveLength(1);
    } finally {
      again.close();
    }
  });

  it("migrates an empty file and refuses foreign, newer, and malformed files without rewriting them", () => {
    const empty = fileDb();
    writeFileSync(empty, "");
    const created = new CompanionStore(empty);
    expect(created.schemaVersion()).toBe(SCHEMA_VERSION);
    created.close();
    created.close();

    const garbage = fileDb();
    writeFileSync(garbage, "not a database");
    const garbageBytes = readFileSync(garbage);
    expect(() => new CompanionStore(garbage)).toThrow(/not a readable SQLite database/);
    expect(readFileSync(garbage)).toEqual(garbageBytes);
    expect(existsSync(`${garbage}-wal`)).toBe(false);

    const foreign = fileDb();
    const foreignDb = new DatabaseSync(foreign);
    foreignDb.exec("PRAGMA journal_mode = DELETE");
    foreignDb.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    foreignDb.close();
    const foreignBytes = readFileSync(foreign);
    expect(() => new CompanionStore(foreign)).toThrow(/refusing to modify/);
    expect(readFileSync(foreign)).toEqual(foreignBytes);
    expect(existsSync(`${foreign}-wal`)).toBe(false);

    const newer = fileDb();
    const newerDb = new DatabaseSync(newer);
    newerDb.exec("PRAGMA journal_mode = DELETE");
    newerDb.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    newerDb.prepare("INSERT INTO meta (key, value) VALUES ('product', 'dsh-companion')").run();
    newerDb.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '5')").run();
    newerDb.close();
    const newerBytes = readFileSync(newer);
    expect(() => new CompanionStore(newer)).toThrow(new RegExp(`newer than supported ${SCHEMA_VERSION}`));
    expect(readFileSync(newer)).toEqual(newerBytes);
    expect(existsSync(`${newer}-wal`)).toBe(false);

    const malformed = fileDb();
    const seeded = new CompanionStore(malformed);
    seeded.appendTurn(baseTurn("不要改我"));
    seeded.close();
    const editor = new DatabaseSync(malformed);
    editor.exec("UPDATE turns SET role = 'system'");
    editor.close();
    const before = readFileSync(malformed);
    const wal = existsSync(`${malformed}-wal`) ? readFileSync(`${malformed}-wal`) : undefined;
    expect(() => new CompanionStore(malformed)).toThrow(/malformed/);
    expect(readFileSync(malformed)).toEqual(before);
    if (wal) expect(readFileSync(`${malformed}-wal`)).toEqual(wal);
    else if (existsSync(`${malformed}-wal`)) expect(readFileSync(`${malformed}-wal`).length).toBe(0);
  });
});

describe("budgeted first-person recall", () => {
  it("keeps one stable persona and drops the oldest turns first", () => {
    const persona = "我是同一个人。";
    const first = renderCompanionPrompt({
      persona,
      emotionLine: "",
      recent: [turn(1, "user", "OLD_MARKER"), turn(2, "user", "NEW_MARKER")],
      snippets: [],
      maxChars: 40,
    });
    const second = renderCompanionPrompt({
      persona,
      emotionLine: "",
      recent: [turn(1, "user", "另一段历史")],
      snippets: [],
      maxChars: 40,
    });
    expect(first.chars).toBeLessThanOrEqual(40);
    expect(first.stable).toBe(persona);
    expect(first.stable).toBe(second.stable);
    expect(first.volatile).toContain("NEW_MARKER");
    expect(first.volatile).toContain("我记得");
    expect(first.volatile).toContain("你说");
    expect(first.volatile).not.toContain("OLD_MARKER");
    expect(first.volatile).not.toMatch(/根据记录|检索结果|交接/);
    expect(first.wire.startsWith(RECALL_MARK)).toBe(true);
    expect(first.stable).not.toContain("NEW_MARKER");
  });

  it("does not invent a mood line when the emotion stub is silent", () => {
    const emotion = new StubEmotionModel();
    expect(emotion.line("primary", 1)).toBe("");
    emotion.observe(turn(1, "user", "你好"));
    const rendered = renderCompanionPrompt({
      persona: "我是同一个人。",
      emotionLine: emotion.line("primary", 1),
      recent: [turn(1, "user", "你好")],
      snippets: [],
      maxChars: 200,
    });
    expect(rendered.volatile).not.toContain("心情");
  });
});

describe("retrieval seams", () => {
  it("accepts a vector-only hit after every full-text hit", () => {
    const store = new CompanionStore(":memory:");
    try {
      const fts = store.appendTurn(baseTurn("我养了一只叫年糕的白猫"));
      const missed = store.appendTurn({ ...baseTurn("这份记录只在向量里。"), ts: 2 });
      const vector: VectorIndex = {
        upsert() {},
        search() { return [{ id: missed.id, score: 0.99 }]; },
      };
      const snippets = retrieve(store, {
        query: "年糕",
        personId: "primary",
        limit: 2,
        radius: 0,
        vector,
      });
      expect(snippets.map((item) => item.focusId)).toEqual([fts.id, missed.id]);
      expect(snippets[0]?.text).toContain("你说");
      expect(snippets[1]?.text).toContain("向量");
    } finally {
      store.close();
    }
  });
});

describe("companion plugin", () => {
  it("logs raw turns, skips its own recall, and injects a first-person prefix", async () => {
    const path = fileDb();
    const seen: number[] = [];
    const emotion = new StubEmotionModel();
    const diary = new StubDiaryWriter();
    const originalObserve = emotion.observe.bind(emotion);
    emotion.observe = (record) => {
      seen.push(record.id);
      originalObserve(record);
    };
    const diaryIds: number[] = [];
    diary.observe = (record) => { diaryIds.push(record.id); };
    const host = harness({ path }, { emotion, diary, vector: { upsert() {}, search() { return []; } } });
    try {
      expect(host.section?.name).toBe("companion:persona");
      expect(host.section?.text()).toContain("同一个人");
      expect(host.section?.text()).not.toContain("年糕");
      host.emit({ id: "s1" }, { type: "turn/start", time: 1, data: { turn: 4 } });
      host.emit({ id: "s1" }, {
        type: "user/message",
        time: 2,
        data: {
          role: "user",
          content: [{ type: "text", text: "我养了一只叫年糕的白猫，它怕打雷。" }],
          source: { kind: "user" },
        },
      });
      host.emit({ id: "s1" }, {
        type: "assistant/message",
        time: 3,
        data: { turn: 4, message: { role: "assistant", content: "我记住了，年糕怕打雷。" } },
      });
      expect(seen).toEqual([1, 2]);
      expect(diaryIds).toEqual([1, 2]);

      const decision = await host.listeners.get("agent/pre-step")?.(
        {
          agent: { session: { id: "s2" } },
          messages: [{ role: "user", content: "年糕怕什么", source: { kind: "user" } }],
          signal: new AbortController().signal,
        },
        async () => ({
          kind: "enter",
          messages: [{ role: "user", content: "年糕怕什么", source: { kind: "user" } }],
          startsRequestSeries: true,
        }),
      );
      expect(decision.startsRequestSeries).toBe(true);
      const injected = decision.messages[0];
      expect(injected.source).toEqual({ kind: "dsh-companion", form: "recall" });
      expect(injected.content[0].text.startsWith(RECALL_MARK)).toBe(true);
      expect(injected.content[0].text).toContain("我记得");
      expect(injected.content[0].text).toContain("年糕");
      expect(injected.content[0].text).toContain("打雷");
      expect(injected.content[0].text).not.toMatch(/根据记录|检索结果|交接/);
      host.emit({ id: "s2" }, { type: "user/message", time: 4, data: injected });
      const found = await host.tool.execute(
        { query: "年糕", limit: 1, around: 0 },
        { agent: { session: { id: "s1" } } },
      );
      validateJsonSchemaValue(host.tool.output.schema, found);
      expect(found.snippets).toHaveLength(1);
      expect(found.snippets[0].text).toContain("年糕");
      expect(host.tool.output.render({ query: "年糕" }, found)[0].text).toContain("我说");
      const missed = await host.tool.execute(
        { query: "zzqq" },
        { agent: { session: { id: "s1" } } },
      );
      expect(host.tool.output.render({ query: "zzqq" }, missed)[0].text).toBe("我翻了一下，细节没抓住。");
      const leaked = await host.tool.execute(
        { query: "原话" },
        { agent: { session: { id: "s2" } } },
      );
      expect(leaked.snippets).toHaveLength(0);
      const peek = new CompanionStore(path);
      try {
        expect(peek.countTurns()).toBe(2);
        expect(peek.getTurn(1)?.turnNo).toBe(4);
      } finally {
        peek.close();
      }
    } finally {
      host.dispose();
    }
  });

  it("keeps channel identities apart and copies them onto the reply", async () => {
    const path = fileDb();
    const host = harness({ path });
    try {
      host.emit({ id: "sq" }, { type: "turn/start", time: 1, data: { turn: 4 } });
      host.emit({ id: "sq" }, {
        type: "user/message",
        time: 2,
        data: {
          role: "user",
          content: "秘密口令是青竹",
          source: { kind: "user", channel: "wechat", userId: "wx-9", chatId: "g", bridge: "dsh-wechat" },
        },
      });
      host.emit({ id: "sq" }, {
        type: "assistant/message",
        time: 3,
        data: { turn: 4, message: { role: "assistant", content: "青竹这个口令我记住了。" } },
      });
      host.emit({ id: "sp" }, {
        type: "user/message",
        time: 4,
        data: { role: "user", content: "我养了一只叫年糕的白猫", source: { kind: "user" } },
      });
      const qq = await host.tool.execute({ query: "青竹" }, { agent: { session: { id: "sq" } } });
      const local = await host.tool.execute({ query: "青竹" }, { agent: { session: { id: "sp" } } });
      expect(qq.snippets).toHaveLength(1);
      expect(local.snippets).toHaveLength(0);
      const cat = await host.tool.execute({ query: "年糕" }, { agent: { session: { id: "sp" } } });
      expect(cat.snippets[0].text).toContain("年糕");
      const peek = new CompanionStore(path);
      try {
        const channelTurns = peek.recentTurns("wechat:wx-9", 5);
        expect(channelTurns.map((item) => item.role)).toEqual(["user", "assistant"]);
        expect(channelTurns[0]?.turnNo).toBe(4);
        expect(channelTurns[1]).toMatchObject({ channel: "wechat", userId: "wx-9", chatId: "g", bridge: "dsh-wechat" });
        expect(peek.recentTurns("primary", 5).map((item) => item.sessionId)).toEqual(["sp"]);
      } finally {
        peek.close();
      }
    } finally {
      host.dispose();
    }
  });

  it("fails config before opening a store", () => {
    expect(() => harness({ path: "" })).toThrow(/path/);
    expect(() => harness({ promptMaxTokens: 10 })).toThrow(/together/);
    expect(() => harness({ contextRadius: -1 })).toThrow(/contextRadius/);
  });
});

describe("session simulation", () => {
  it("recalls a raw turn from an earlier session after it leaves the recent window", () => {
    const result = runSessionSimulation();
    expect(result.sessions[0]).not.toBe(result.sessions[1]);
    expect(result.recalled).toBe(true);
    expect(result.stable).not.toContain("年糕");
    expect(result.recall).toContain("年糕");
    expect(result.recall).toContain("打雷");
  });
});
