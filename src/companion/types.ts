/**
 * Types for the companion core. Emotion, diary, and vector scores stay out of
 * this module on purpose: those subsystems plug in through `stubs.ts`.
 *
 * @module dsh-companion/types
 */

export type TurnRole = "user" | "assistant";

/** One raw utterance. `content` is the original text, never a summary. */
export interface TurnRecord {
  id: number;
  channel: string;
  userId: string;
  chatId: string;
  sessionId: string;
  bridge: string;
  personId: string;
  ts: number;
  role: TurnRole;
  content: string;
  turnNo: number | null;
}

export interface TurnInput {
  channel: string;
  userId: string;
  chatId: string;
  sessionId: string;
  bridge: string;
  personId: string;
  ts: number;
  role: TurnRole;
  content: string;
  turnNo?: number;
}

export interface IdentityRecord {
  platform: string;
  platformUserId: string;
  personId: string;
  createdAt: number;
}

/** A retrieved window, already phrased for the model. */
export interface Snippet {
  focusId: number;
  score: number;
  text: string;
  turnIds: number[];
}
