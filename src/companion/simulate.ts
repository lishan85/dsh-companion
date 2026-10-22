/**
 * Two sessions, one person. The cat fact is pushed out of the recent window
 * so the second session can only say it by retrieving the raw turn.
 *
 * @module dsh-companion/simulate
 */

import { retrieve } from "./retrieve.js";
import { DEFAULT_PERSONA, renderCompanionPrompt } from "./render.js";
import { CompanionStore } from "./store.js";
import type { TurnRecord } from "./types.js";

export interface SessionSimulation {
  sessions: [string, string];
  transcript: TurnRecord[];
  recall: string;
  stable: string;
  recalled: boolean;
}

const PERSON = "primary";
const CAT = "我养了一只叫年糕的白猫，它怕打雷。";

export function runSessionSimulation(): SessionSimulation {
  const store = new CompanionStore(":memory:");
  try {
    const first = "session-lived";
    const second = "session-continued";
    const base = { channel: "", userId: "", chatId: "", bridge: "", personId: PERSON };
    store.appendTurn({ ...base, sessionId: first, ts: 1, role: "user", content: CAT });
    store.appendTurn({
      ...base,
      sessionId: first,
      ts: 2,
      role: "assistant",
      content: "我记住了，年糕是白猫，它怕打雷。",
    });
    for (let index = 0; index < 16; index += 1) {
      store.appendTurn({
        ...base,
        sessionId: first,
        ts: 3 + index,
        role: "user",
        content: `后来我们又聊了第${index}件无关的事，跟猫没有关系。`,
      });
    }
    const query = "年糕怕什么";
    const snippets = retrieve(store, { query, personId: PERSON, limit: 3, radius: 1 });
    const rendered = renderCompanionPrompt({
      persona: DEFAULT_PERSONA,
      emotionLine: "",
      recent: store.recentTurns(PERSON, 4),
      snippets,
      maxChars: 6000,
    });
    const recalled = rendered.volatile.includes("年糕")
      && rendered.volatile.includes("打雷")
      && rendered.volatile.includes("我记得")
      && !rendered.stable.includes("年糕");
    return {
      sessions: [first, second],
      transcript: store.recentTurns(PERSON, 100),
      recall: rendered.volatile,
      stable: rendered.stable,
      recalled,
    };
  } finally {
    store.close();
  }
}
