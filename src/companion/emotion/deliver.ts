/**
 * Delivery of a queued proactive message.
 *
 * DeepSeek Harness exposes `Agent.followup`: it enqueues a user-role message
 * and wakes the driver. It does not steer the current turn, and it only
 * exists on a live agent. This module is the integration point. When no
 * agent is available the SQLite row stays `queued`; a host can call
 * {@link drainProactiveQueue} later with its own sender.
 *
 * The followup body is an instruction to speak, not a line we pretend the
 * user typed. `source.kind = "dsh-companion"` and a leading U+2060 make the
 * companion logger skip it. The assistant's later reply is an ordinary turn.
 *
 * @module dsh-companion/emotion/deliver
 */

import { CompanionError } from "../errors.js";
import { RECALL_MARK } from "../render.js";
import type { CompanionStore } from "../store.js";
import type { ProactiveRow } from "./types.js";

export interface FollowupMessage {
  content: Array<{ type: "text"; text: string }>;
  source: { kind: string; form?: string };
}

export interface FollowupTarget {
  followup: (message: FollowupMessage) => void;
}

export type ProactiveDeliverer = (message: ProactiveRow) => boolean | Promise<boolean>;

export function deliverViaFollowup(agent: FollowupTarget, text: string): void {
  if (typeof agent.followup !== "function") {
    throw new CompanionError(
      "proactive",
      "dsh-companion: this agent has no followup method; leave the outbox row queued",
    );
  }
  const body = text.startsWith(RECALL_MARK) ? text : RECALL_MARK + text;
  agent.followup({
    content: [{ type: "text", text: body }],
    source: { kind: "dsh-companion", form: "proactive" },
  });
}

/**
 * Claim each due row, hand it to `deliver`, and mark it delivered only after
 * a true result. A false result or a throw means the sender reports that it
 * did not hand the message off, and the row goes back to `queued`. A row
 * left in `delivering` because the process died is finished on the next open
 * and is not sent again.
 */
export async function drainProactiveQueue(
  store: CompanionStore,
  now: number,
  deliver: ProactiveDeliverer,
): Promise<number> {
  const due = store.dueProactive(now);
  let delivered = 0;
  for (const item of due) {
    if (!store.claimProactive(item.id, now)) continue;
    let ok = false;
    try {
      ok = await deliver(item);
    } catch {
      ok = false;
    }
    if (!ok) {
      store.requeueProactive(item.id);
      continue;
    }
    store.finishProactive(item.id, now);
    delivered += 1;
  }
  return delivered;
}
