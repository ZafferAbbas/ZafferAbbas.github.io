import { config } from "./config.js";
import type { Store } from "./db.js";
import type { Attachment, LlmBackend } from "./llm/types.js";
import { buildTools, SYSTEM_PROMPT, type ReminderWarning, type ToolSpec } from "./tools.js";
import type { IncomingMessage } from "./transports/types.js";

export async function createBackend(): Promise<LlmBackend> {
  if (config.provider === "claude") {
    const { ClaudeBackend } = await import("./llm/claude.js");
    return new ClaudeBackend();
  }
  const { OllamaBackend } = await import("./llm/ollama.js");
  return new OllamaBackend();
}

export interface TurnOptions {
  reminderWarning?: ReminderWarning;
  /** Extra tools for this sender (e.g. purchase orders). */
  extraTools?: ToolSpec[];
  /** Photos or PDFs to show the model. */
  attachments?: Attachment[];
  /** Replaces msg.text, e.g. with a voice note's transcript. */
  text?: string;
  /** What the user sent, for the transcript, e.g. "photo" or "voice note". */
  sent?: string;
}

function userTurnText(msg: IncomingMessage, text: string, sent?: string): string {
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const header = [
    `[Current local time: ${local} (${config.timezone})]`,
    `[Chat: ${msg.isGroup ? "group" : "direct message"}]`,
    `[From: ${msg.senderName || "unknown"}]`,
  ];
  if (sent) header.push(`[Sent: ${sent}]`);
  if (msg.quotedText) header.push(`[Replying to: "${msg.quotedText.slice(0, 500)}"]`);
  return `${header.join(" ")}\n${text}`;
}

/** Runs one turn for an incoming message and returns the reply text. */
export async function respond(backend: LlmBackend, msg: IncomingMessage, store: Store, opts: TurnOptions = {}): Promise<string> {
  const history = store.recentHistory(msg.chatId, config.historyTurns * 2);
  while (history.length && history[0].role !== "user") history.shift();

  const userText = userTurnText(msg, opts.text ?? msg.text, opts.sent);
  const tools = buildTools(msg, store, opts.reminderWarning, opts.extraTools);
  const reply = (await backend.run(SYSTEM_PROMPT, history, { text: userText, attachments: opts.attachments ?? [] }, tools)) || "Done.";

  // Only plain text is stored, so history replays cleanly on any backend.
  store.addHistory(msg.chatId, "user", userText);
  store.addHistory(msg.chatId, "assistant", reply);
  return reply;
}
