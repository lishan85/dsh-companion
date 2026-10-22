/**
 * Best-effort channel metadata.
 *
 * Community bridges route a platform message into a dsh agent session. Their
 * READMEs do not document a hook-visible metadata schema, and this package
 * does not pretend they do. The extractor accepts a few plausible shapes and
 * otherwise stores empty channel fields rather than guessing an identity.
 *
 * @module dsh-companion/channel
 */

export interface ChannelMeta {
  channel: string;
  userId: string;
  chatId: string;
  bridge: string;
  sessionId: string;
  ts: number;
}

export interface ParsedUtterance {
  role: "user" | "assistant";
  content: string;
  turnNo: number | null;
  skip: boolean;
  meta: ChannelMeta;
}

const CONTEXT_FORMS = new Set(["instructions", "catalog", "snapshot", "notice", "relay", "recall"]);
const SKIP_KINDS = new Set(["dsh-companion", "system-prompt", "tool"]);

export function parseSessionEvent(session: unknown, event: unknown, now: number): ParsedUtterance | undefined {
  if (!event || typeof event !== "object") return undefined;
  const type = (event as { type?: unknown }).type;
  const data = (event as { data?: unknown }).data;
  const time = numberOr((event as { time?: unknown }).time, now);
  const sessionId = sessionIdOf(session);
  if (type === "user/message") return parseUser(data, sessionId, time);
  if (type === "assistant/message") return parseAssistant(data, sessionId, time);
  return undefined;
}

export function shouldSkipUserMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return true;
  const source = (message as { source?: unknown }).source;
  const kind = source && typeof source === "object" ? (source as { kind?: unknown }).kind : undefined;
  const form = source && typeof source === "object" ? (source as { form?: unknown }).form : undefined;
  if (typeof kind === "string" && SKIP_KINDS.has(kind)) return true;
  if (typeof form === "string" && CONTEXT_FORMS.has(form)) return true;
  const content = textOf((message as { content?: unknown }).content);
  return content.startsWith("\u2060");
}

function parseUser(data: unknown, sessionId: string, ts: number): ParsedUtterance | undefined {
  const content = textOf(data && typeof data === "object" ? (data as { content?: unknown }).content : undefined);
  if (content.length === 0) return undefined;
  return {
    role: "user",
    content,
    turnNo: null,
    skip: shouldSkipUserMessage(data),
    meta: { ...channelOf(data), sessionId, ts },
  };
}

function parseAssistant(data: unknown, sessionId: string, ts: number): ParsedUtterance | undefined {
  const message = data && typeof data === "object" ? (data as { message?: unknown; turn?: unknown }).message : undefined;
  const content = textOf(message && typeof message === "object" ? (message as { content?: unknown }).content : undefined);
  if (content.length === 0) return undefined;
  const turn = data && typeof data === "object" ? (data as { turn?: unknown }).turn : undefined;
  return {
    role: "assistant",
    content,
    turnNo: typeof turn === "number" && Number.isInteger(turn) ? turn : null,
    skip: false,
    meta: {
      channel: "",
      userId: "",
      chatId: "",
      bridge: "",
      sessionId,
      ts,
    },
  };
}

export function channelOf(message: unknown): Omit<ChannelMeta, "sessionId" | "ts"> {
  const bags = bagsOf(message);
  return {
    channel: first(bags, ["channel", "platform", "transport"]),
    userId: first(bags, ["userId", "user_id", "senderId", "sender_id", "openid", "fromUser"]),
    chatId: first(bags, ["chatId", "chat_id", "groupId", "group_id", "conversationId"]),
    bridge: first(bags, ["bridge", "plugin", "provider"]),
  };
}

function bagsOf(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const source = (message as { source?: unknown }).source;
  const bags: unknown[] = [message];
  if (source && typeof source === "object") {
    bags.push(source);
    const nested = ["meta", "channel", "companion", "attribution"] as const;
    for (const key of nested) {
      const value = (source as Record<string, unknown>)[key];
      if (value && typeof value === "object") bags.push(value);
    }
  }
  return bags;
}

function first(bags: unknown[], keys: readonly string[]): string {
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    for (const key of keys) {
      const value = (bag as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return "";
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) parts.push(text.trim());
  }
  return parts.join("\n").trim();
}

function sessionIdOf(session: unknown): string {
  if (!session || typeof session !== "object") return "";
  const id = (session as { id?: unknown }).id;
  if (typeof id === "string" && id.length > 0) return id;
  const header = (session as { header?: unknown }).header;
  if (header && typeof header === "object") {
    const headerId = (header as { id?: unknown }).id;
    if (typeof headerId === "string") return headerId;
  }
  return "";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
