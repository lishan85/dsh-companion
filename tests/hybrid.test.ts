/**
 * Hybrid retrieval.
 *
 * The offline embedder is a deterministic feature hash, not a neural model.
 * It recalls a paraphrase when the two strings share a synonym cluster from
 * OFFLINE_SYNONYM_CLUSTERS, or enough character n-grams, even if FTS5 shares
 * no token. It misses a paraphrase that is outside that lexicon and shares
 * no characters. Unrelated text stays near cosine 0 and is dropped by the
 * default vectorMinScore of 0.2. A real embedding endpoint is not called.
 */

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { compileMatch } from "../src/search.js";
import { tokenize } from "../src/tokenize.js";
import { loadCompanionConfig } from "../src/companion/config.js";
import {
  OFFLINE_EMBEDDING_MODEL,
  embeddingsUrl,
} from "../src/companion/embed.js";
import { apply } from "../src/companion/plugin.js";
import { DEFAULT_PERSONA, renderCompanionPrompt } from "../src/companion/render.js";
import { retrieve, retrieveReady } from "../src/companion/retrieve.js";
import { SCHEMA_VERSION } from "../src/companion/schema.js";
import { HybridReranker, HttpReranker, rerankUrl } from "../src/companion/rerank.js";
import { CompanionStore } from "../src/companion/store.js";
import type { RerankHit } from "../src/companion/stubs.js";
import type { TurnRole } from "../src/companion/types.js";
import { SqliteVectorIndex } from "../src/companion/vector/index.js";
import { ingestWanderExperience, ingestWanderFile, resolveWanderExperiencesPath } from "../src/companion/wander.js";

const CAT = "年糕是我养的英短";
const CAT_QUERY = "那只宠物小猫";
const UNRELATED = "量子纠缠实验装置";

function fileDb(): string {
  return join(mkdtempSync(join(tmpdir(), "dsh-companion-hybrid-")), "companion.db");
}

function baseTurn(content: string, role: TurnRole = "user", personId = "primary", ts = 1) {
  return {
    channel: "",
    userId: "",
    chatId: "",
    sessionId: "s",
    bridge: "",
    personId,
    ts,
    role,
    content,
  };
}

function indexFor(store: CompanionStore, backend: "auto" | "blob" = "blob"): SqliteVectorIndex {
  return new SqliteVectorIndex(store, {
    provider: "offline",
    dimensions: 128,
    timeoutMs: 1_000,
    minScore: 0.2,
    scanLimit: 32,
    backend,
    now: () => 1_700_000_000_000,
  });
}

function hit(partial: Partial<RerankHit> & Pick<RerankHit, "id" | "text">): RerankHit {
  return {
    ftsRank: 1,
    vectorScore: 0,
    score: 0,
    kind: "turn",
    ts: 1,
    personId: "primary",
    topics: [],
    ...partial,
  };
}

function sharedTokens(left: string, right: string): string[] {
  const tokens = new Set(tokenize(left));
  return tokenize(right).filter((token) => tokens.has(token));
}

describe("offline recall quality", () => {
  it("finds a synonym the full-text index cannot, and drops an unrelated query", async () => {
    expect(sharedTokens(CAT, CAT_QUERY)).toEqual([]);
    const store = new CompanionStore(":memory:");
    try {
      store.appendTurn(baseTurn(UNRELATED, "user", "primary", 1));
      const saved = store.appendTurn(baseTurn(CAT, "user", "primary", 2));
      const match = compileMatch(CAT_QUERY);
      expect(match).toBeDefined();
      expect(store.ftsTurns(match!, "primary", 5)).toEqual([]);
      const ftsOnly = retrieve(store, { query: CAT_QUERY, personId: "primary", limit: 5, radius: 0 });
      expect(ftsOnly).toEqual([]);

      const index = indexFor(store, "blob");
      const filled = await index.backfill();
      expect(filled.embedded).toBe(2);
      expect(filled.backend).toBe("blob");
      const again = await index.backfill();
      expect(again.embedded).toBe(0);
      expect(index.pendingCount()).toBe(0);

      const found = retrieve(store, {
        query: CAT_QUERY,
        personId: "primary",
        limit: 5,
        radius: 0,
        vector: index,
        reranker: new HybridReranker({ now: () => 1_700_000_000_000 }),
      });
      expect(found.some((item) => item.text.includes("英短"))).toBe(true);
      expect(found.some((item) => item.focusId === saved.id)).toBe(true);
      expect(found.every((item) => item.text.includes("我") || item.text.includes("你说"))).toBe(true);

      const negative = retrieve(store, {
        query: UNRELATED,
        personId: "primary",
        limit: 5,
        radius: 0,
        vector: index,
        reranker: new HybridReranker(),
      });
      expect(negative.some((item) => item.text.includes(UNRELATED))).toBe(true);
      expect(negative.every((item) => !item.text.includes("英短"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("keeps a hybrid hit inside the existing budget and drops it before the persona", async () => {
    const store = new CompanionStore(":memory:");
    try {
      store.appendTurn(baseTurn(CAT));
      const index = indexFor(store);
      await index.backfill();
      const snippets = retrieve(store, {
        query: CAT_QUERY,
        personId: "primary",
        limit: 1,
        radius: 0,
        vector: index,
        reranker: new HybridReranker(),
      });
      expect(snippets[0]?.text).toContain("英短");
      const persona = DEFAULT_PERSONA;
      const tight = renderCompanionPrompt({
        persona,
        emotionLine: "",
        recent: [],
        snippets,
        maxChars: persona.length,
      });
      expect(tight.stable).toBe(persona);
      expect(tight.volatile).not.toContain("英短");
      const wide = renderCompanionPrompt({
        persona,
        emotionLine: "",
        recent: [],
        snippets,
        maxChars: 6000,
      });
      expect(wide.stable).toBe(persona);
      expect(wide.volatile).toContain("英短");
    } finally {
      store.close();
    }
  });
});

describe("vector index", () => {
  it("embeds old turns and sealed diary pages, and writes a new turn immediately", async () => {
    const store = new CompanionStore(":memory:");
    try {
      const old = store.appendTurn(baseTurn("汉科街灯还亮着", "user", "primary", 10));
      expect(store.claimDiary({ personId: "primary", layer: "day", periodKey: "2026-10-01", now: 10 })).toBe("owned");
      expect(store.sealDiary({
        personId: "primary",
        layer: "day",
        periodKey: "2026-10-01",
        text: "窗边那只英短没出门",
        source: "fallback",
        now: 11,
      })).toBe(true);
      expect(store.claimDiary({ personId: "primary", layer: "day", periodKey: "2026-10-02", now: 12 })).toBe("owned");

      const index = indexFor(store);
      expect(index.pendingCount()).toBe(2);
      const filled = await index.backfill();
      expect(filled.turns).toBe(1);
      expect(filled.diaryPages).toBe(1);
      expect(filled.embedded).toBe(2);
      expect(filled.failed).toBe(0);

      const fresh = store.appendTurn(baseTurn("后来又提了一次英短", "user", "primary", 20));
      index.upsert(fresh.id, fresh.content);
      expect(index.pendingCount()).toBe(0);
      const second = await index.backfill();
      expect(second.embedded).toBe(0);

      const diary = retrieve(store, {
        query: CAT_QUERY,
        personId: "primary",
        limit: 5,
        radius: 0,
        vector: index,
        reranker: new HybridReranker(),
      });
      expect(diary.some((item) => item.kind === "diary" && item.text.includes("英短"))).toBe(true);
      expect(store.getTurn(old.id)?.content).toBe("汉科街灯还亮着");
    } finally {
      store.close();
    }
  });

  it("answers from sqlite-vec when the extension loads, and from blobs when it does not", async () => {
    let vecAvailable = false;
    try {
      createRequire(import.meta.url)("sqlite-vec");
      vecAvailable = true;
    } catch {
      vecAvailable = false;
    }
    const store = new CompanionStore(":memory:");
    try {
      store.appendTurn(baseTurn(CAT));
      const index = indexFor(store, "auto");
      await index.backfill();
      expect(index.backend).toBe(vecAvailable ? "sqlite-vec" : "blob");
      const found = index.search(CAT_QUERY, 5);
      expect(found.some((item) => item.kind === "turn" && item.id === 1)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("uses a mocked OpenAI-compatible endpoint, and falls back without logging the key", async () => {
    expect(embeddingsUrl("https://example.test/v1")).toBe("https://example.test/v1/embeddings");
    expect(embeddingsUrl("https://example.test/v1/embeddings/")).toBe("https://example.test/v1/embeddings");
    const secret = "sk-test-secret-value";
    const logs: string[] = [];
    const write = (args: unknown[]) => logs.push(args.map((item) => String(item)).join(" "));
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...args: unknown[]) => write(args);
    console.info = (...args: unknown[]) => write(args);
    console.warn = (...args: unknown[]) => write(args);
    console.error = (...args: unknown[]) => write(args);
    const store = new CompanionStore(":memory:");
    try {
      store.appendTurn(baseTurn(CAT));
      const calls: Array<{ url: string; authorization: string; body: string }> = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? init.body : "";
        calls.push({ url, authorization: headers.get("authorization") ?? "", body });
        return new Response("refused", { status: 401 });
      };
      const index = new SqliteVectorIndex(store, {
        provider: "openai",
        baseUrl: "https://example.test/v1",
        model: "text-embedding-3-small",
        dimensions: 8,
        timeoutMs: 1_000,
        apiKey: secret,
        minScore: 0.2,
        scanLimit: 8,
        backend: "blob",
        fetch: fetchImpl,
      });
      const filled = await index.backfill();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://example.test/v1/embeddings");
      expect(calls[0]?.authorization).toBe(`Bearer ${secret}`);
      expect(calls[0]?.body).toContain(CAT);
      expect(filled.embedded).toBe(1);
      expect(filled.failed).toBe(0);
      expect(index.model).toBe(OFFLINE_EMBEDDING_MODEL);
      expect(index.fallbackNote).toMatch(/refused the key/);
      expect(logs.join("\n")).not.toContain(secret);
      const found = retrieve(store, {
        query: CAT_QUERY,
        personId: "primary",
        limit: 3,
        radius: 0,
        vector: index,
        reranker: new HybridReranker(),
      });
      expect(found.some((item) => item.text.includes("英短"))).toBe(true);
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      store.close();
    }
  });

  it("does not call the network when the key is missing, and retries a non-auth failure", async () => {
    const quiet = new CompanionStore(":memory:");
    try {
      quiet.appendTurn(baseTurn(CAT));
      let called = 0;
      const index = new SqliteVectorIndex(quiet, {
        provider: "openai",
        baseUrl: "https://example.test/v1",
        dimensions: 8,
        timeoutMs: 1_000,
        apiKey: "",
        minScore: 0.2,
        scanLimit: 8,
        backend: "blob",
        fetch: async () => {
          called += 1;
          throw new Error("should not be called");
        },
      });
      const filled = await index.backfill();
      expect(called).toBe(0);
      expect(filled.embedded).toBe(1);
      expect(index.model).toBe(OFFLINE_EMBEDDING_MODEL);
      expect(index.fallbackNote).toMatch(/key is missing/);
    } finally {
      quiet.close();
    }

    const store = new CompanionStore(":memory:");
    try {
      store.appendTurn(baseTurn("alpha-marker"));
      let attempt = 0;
      const vector = [1, 0, 0, 0, 0, 0, 0, 0];
      const index = new SqliteVectorIndex(store, {
        provider: "openai",
        baseUrl: "https://example.test/v1",
        model: "embed-test",
        dimensions: 8,
        timeoutMs: 1_000,
        apiKey: "present",
        minScore: 0.2,
        scanLimit: 8,
        backend: "blob",
        fetch: async () => {
          attempt += 1;
          if (attempt === 1) return new Response("busy", { status: 500 });
          return new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }] }), { status: 200 });
        },
      });
      const failed = await index.backfill();
      expect(failed.failed).toBe(1);
      expect(failed.embedded).toBe(0);
      expect(index.model).toBe("embed-test");
      const recovered = await index.backfill();
      expect(recovered.embedded).toBe(1);
      const snippets = await retrieveReady(store, {
        query: "alpha-marker",
        personId: "primary",
        limit: 2,
        radius: 0,
        vector: index,
        reranker: new HybridReranker(),
      });
      expect(snippets.some((item) => item.text.includes("alpha-marker"))).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("hybrid rerank", () => {
  const now = 1_700_000_000_000;

  it("prefers a recent hit when the time boost is large", () => {
    const reranker = new HybridReranker({ k: 60, timeBoost: 5, timeHalfLifeDays: 1, now: () => now });
    const ranked = reranker.rerank("same words here", [
      hit({ id: 1, text: "same words here", ts: now - 30 * 86_400_000 }),
      hit({ id: 2, text: "same words here", ts: now }),
    ], { now });
    expect(ranked[0]?.id).toBe(2);
  });

  it("boosts the current person and a matching topic, and does not penalize her experiences", () => {
    const people = new HybridReranker({ personBoost: 5, timeBoost: 0, topicBoost: 0 });
    const score = (kind: "turn" | "experience", personId: string) => people.rerank("话题", [
      hit({ id: 1, text: "话题", kind, personId }),
    ], { personId: "primary", now })[0]?.score ?? 0;
    expect(score("experience", "other")).toBeCloseTo(score("turn", "other"));
    expect(score("turn", "primary")).toBeGreaterThan(score("experience", "other"));

    const topics = new HybridReranker({ topicBoost: 5, timeBoost: 0, personBoost: 0 });
    const ranked = topics.rerank("我想去海边", [
      hit({ id: 1, text: "我想去海边", ftsRank: 1, topics: ["城市"] }),
      hit({ id: 2, text: "我想去海边", ftsRank: 4, topics: ["海边"] }),
    ], { now });
    expect(ranked[0]?.id).toBe(2);
  });

  it("applies an HTTP reranker and keeps the fused order when that call fails", async () => {
    expect(rerankUrl("https://example.test/v1")).toBe("https://example.test/v1/rerank");
    const secret = "rk-test-secret-value";
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
    };
    const hits = [
      hit({ id: 1, text: "first document", ftsRank: 1 }),
      hit({ id: 2, text: "second document", ftsRank: 5 }),
    ];
    try {
      let called = 0;
      const failing = new HttpReranker({
        baseUrl: "https://example.test/v1",
        model: "rerank-test",
        apiKey: secret,
        timeoutMs: 1_000,
        fetch: async () => {
          called += 1;
          throw new Error(`down ${secret}`);
        },
      });
      await failing.prepare("query", hits);
      expect(called).toBe(1);
      expect(failing.rerank("query", hits)[0]?.id).toBe(1);
      expect(logs.join("\n")).not.toContain(secret);

      const working = new HttpReranker({
        baseUrl: "https://example.test/v1/rerank",
        model: "rerank-test",
        apiKey: secret,
        timeoutMs: 1_000,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { documents: string[] };
          expect(body.documents).toEqual(["first document", "second document"]);
          return new Response(JSON.stringify({
            results: [
              { index: 1, relevance_score: 0.95 },
              { index: 0, score: 0.1 },
            ],
          }), { status: 200 });
        },
      });
      await working.prepare("query", hits);
      expect(working.rerank("query", hits)[0]?.id).toBe(2);

      let blocked = 0;
      const missing = new HttpReranker({
        baseUrl: "https://example.test/v1",
        model: "rerank-test",
        apiKey: "",
        apiKeyEnv: "DSH_COMPANION_RERANK_KEY_UNSET_FOR_TEST",
        timeoutMs: 1_000,
        fetch: async () => {
          blocked += 1;
          throw new Error("should not be called");
        },
      });
      await missing.prepare("query", hits);
      expect(blocked).toBe(0);
      expect(missing.rerank("query", hits)[0]?.id).toBe(1);
    } finally {
      console.error = original;
    }
  });
});

describe("wander experiences", () => {
  const trip = {
    schemaVersion: 1,
    source: "dsh-wander",
    kind: "travel",
    id: "trip-hanko-1",
    at: "2026-10-20T12:00:00.000Z",
    text: "汉科街灯还亮着",
    emotionHint: "quiet",
    tags: ["travel"],
    place: { id: "hanko", name: "Hanko", region: "Uusimaa", country: "Finland", timezone: "Europe/Helsinki" },
    attribution: "Photo by Someone",
    license: "CC BY 4.0",
    descriptionMode: "metadata",
    trip: { id: "trip-hanko-1" },
  };

  it("ingests experiences.jsonl idempotently and recalls a paraphrase for any person", async () => {
    expect(sharedTokens(trip.text, "芬兰那一趟")).toEqual([]);
    const path = join(mkdtempSync(join(tmpdir(), "dsh-wander-")), "experiences.jsonl");
    writeFileSync(path, `${JSON.stringify(trip)}\n{not json\n{"schemaVersion":2}\n`);
    const store = new CompanionStore(":memory:");
    try {
      store.personFor("qq", "9");
      const first = ingestWanderFile(store, path, "qq:9");
      expect(first).toEqual({ inserted: 1, updated: 0, skipped: 2 });
      const second = ingestWanderFile(store, path, "primary");
      expect(second.inserted).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.skipped).toBe(3);
      expect(ingestWanderFile(store, join(path, "missing-dir"), "primary")).toEqual({ inserted: 0, updated: 0, skipped: 0 });

      const changed = { ...trip, text: "汉科街灯还亮着，风很大" };
      expect(ingestWanderExperience(store, changed, "qq:9")).toBe("updated");
      expect(ingestWanderExperience(store, changed, "qq:9")).toBe("skipped");
      const match = compileMatch("芬兰那一趟");
      expect(store.ftsExperiences(match!, 5)).toEqual([]);

      const index = indexFor(store);
      await index.backfill();
      const found = retrieve(store, {
        query: "芬兰那一趟",
        personId: "other",
        limit: 3,
        radius: 0,
        vector: index,
        reranker: new HybridReranker(),
      });
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe("experience");
      expect(found[0]?.text).toContain("汉科");
      expect(found[0]?.text).toContain("没有把画面交给别人看");
      expect(found[0]?.text).toContain("Photo by Someone");
      expect(found[0]?.text).not.toMatch(/根据记录|检索结果|交接/);
      store.linkIdentity("qq", "9", "primary");
      expect(store.getExperience(found[0]!.focusId)?.personId).toBe("qq:9");
    } finally {
      store.close();
    }
  });

  it("ingests a wander/trip event and a configured jsonl through the plugin", async () => {
    const path = fileDb();
    const experiences = join(mkdtempSync(join(tmpdir(), "dsh-wander-plugin-")), "experiences.jsonl");
    writeFileSync(experiences, `${JSON.stringify(trip)}\n`);
    const listeners = new Map<string, (...args: any[]) => any>();
    const registered: any[] = [];
    let dispose = () => {};
    const ctx = {
      effect(callback: () => () => void) { dispose = callback(); },
      on(event: string, listener: (...args: any[]) => any) { listeners.set(event, listener); },
      tools: { register(tool: any) { registered.push(tool); } },
      systemPrompt: { section() {} },
    } as unknown as Context;
    apply(ctx, {
      path,
      emotionEnabled: false,
      proactiveEnabled: false,
      diaryEnabled: false,
      wanderExperiencesPath: experiences,
    });
    try {
      listeners.get("wander/trip")?.(trip);
      const tool = registered.find((item) => item.name === "history_search");
      const found = await tool.execute({ query: "芬兰那一趟", limit: 3, around: 0 }, { agent: { session: { id: "s1" } } });
      expect(found.snippets.some((item: { text: string }) => item.text.includes("汉科"))).toBe(true);
      const peek = new CompanionStore(path);
      try {
        expect(peek.ftsExperiences(compileMatch("汉科")!, 5)).toHaveLength(1);
      } finally {
        peek.close();
      }
    } finally {
      dispose();
    }
  });

  it("resolves the wander path from config, then the file env, then the data dir", () => {
    expect(resolveWanderExperiencesPath({ wanderExperiencesPath: "  configured.jsonl  " }, {})).toBe("configured.jsonl");
    expect(resolveWanderExperiencesPath({ wanderExperiencesPath: "" }, { DSH_WANDER_EXPERIENCES: " from-env.jsonl " })).toBe("from-env.jsonl");
    expect(resolveWanderExperiencesPath({ wanderExperiencesPath: "" }, { DSH_WANDER_DATA_DIR: "/tmp/wander" })).toBe(join("/tmp/wander", "experiences.jsonl"));
    expect(resolveWanderExperiencesPath({ wanderExperiencesPath: "" }, {})).toBe("");
  });
});

describe("hybrid schema and config", () => {
  it("migrates version 3 in place and refuses a newer or malformed vector shape without rewriting bytes", () => {
    const path = fileDb();
    const created = new CompanionStore(path);
    const saved = created.appendTurn(baseTurn("不要弄丢这句话"));
    created.close();
    const editor = new DatabaseSync(path);
    editor.exec(`
      DROP TABLE IF EXISTS experiences_fts;
      DROP TABLE IF EXISTS experiences;
      DROP TABLE IF EXISTS embeddings;
    `);
    editor.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    editor.close();
    const upgraded = new CompanionStore(path);
    try {
      expect(upgraded.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(upgraded.getTurn(saved.id)?.content).toBe("不要弄丢这句话");
      expect(upgraded.ftsExperiences(compileMatch("不要")!, 5)).toEqual([]);
    } finally {
      upgraded.close();
    }

    const early = fileDb();
    const seeded = new CompanionStore(early);
    seeded.close();
    const marker = new DatabaseSync(early);
    marker.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    marker.close();
    const before = readFileSync(early);
    expect(() => new CompanionStore(early)).toThrow(/vector objects exist before schema 4/);
    expect(readFileSync(early)).toEqual(before);

    const broken = fileDb();
    const opened = new CompanionStore(broken);
    opened.appendTurn(baseTurn("不要改我"));
    opened.close();
    const bad = new DatabaseSync(broken);
    bad.prepare(
      `INSERT INTO embeddings (source, source_id, model, dim, text_hash, embedded_at, vector)
       VALUES ('turn', 1, 'offline-hash-v1', 8, ?, 1, x'0000')`,
    ).run("ab".repeat(32));
    bad.close();
    const brokenBytes = readFileSync(broken);
    expect(() => new CompanionStore(broken)).toThrow(/malformed embedding/);
    expect(readFileSync(broken)).toEqual(brokenBytes);
  });

  it("rejects an unknown provider and an incomplete HTTP endpoint", () => {
    expect(loadCompanionConfig({ path: ":memory:" }).embeddingProvider).toBe("offline");
    expect(loadCompanionConfig({ path: ":memory:" }).rrfK).toBe(60);
    expect(loadCompanionConfig({ path: ":memory:" }).vectorMinScore).toBe(0.2);
    expect(loadCompanionConfig({ path: ":memory:" }).embeddingApiKeyEnv).toBe("DSH_COMPANION_EMBEDDING_KEY");
    expect(loadCompanionConfig({ path: ":memory:" }).rerankApiKeyEnv).toBe("DSH_COMPANION_RERANK_KEY");
    expect(() => loadCompanionConfig({ path: ":memory:", embeddingProvider: "huggingface" })).toThrow(/embeddingProvider/);
    expect(() => loadCompanionConfig({ path: ":memory:", embeddingProvider: "openai" })).toThrow(/embeddingBaseUrl/);
    expect(() => loadCompanionConfig({ path: ":memory:", embeddingDimensions: 7 })).toThrow(/embeddingDimensions/);
    expect(() => loadCompanionConfig({ path: ":memory:", rerankProvider: "http" })).toThrow(/rerankBaseUrl/);
    expect(() => loadCompanionConfig({ path: ":memory:", embeddingApiKeyEnv: "not_upper" })).toThrow(/embeddingApiKeyEnv/);
    expect(() => loadCompanionConfig({ path: ":memory:", vectorMinScore: 1.2 })).toThrow(/vectorMinScore/);
    const http = loadCompanionConfig({
      path: ":memory:",
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://example.test/v1",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 256,
    });
    expect(http.embeddingProvider).toBe("openai");
    expect(http.embeddingDimensions).toBe(256);
  });
});
