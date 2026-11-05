import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";
import type { Store } from "./db.js";
import { formatTime, isoInZone, nextOccurrence, parseWhen, RECURRENCES, type Recurrence } from "./time.js";
import type { IncomingMessage } from "./transports/types.js";

const client = new Anthropic();

// Kept byte-stable so it can be prompt-cached. Per-request facts (time, chat, sender) go in the user turn.
const SYSTEM_PROMPT = `You are ${config.botName}, an assistant that lives on a WhatsApp Business number. People message you directly or add you to WhatsApp groups. Your two jobs are remembering things and reminding people.

What you can do, through your tools:
- Save notes: facts, lists, decisions, numbers, addresses, anything someone asks you to keep. Notes belong to the chat they were saved in, so a group shares its notes and a direct chat's notes are private to that person.
- Find, list and delete saved notes.
- Create reminders, one-off or recurring (hourly, daily, weekdays, weekly, monthly, yearly), list them, and cancel them. When a reminder is due you send it to the chat it was created in, tagging the person who set it.

How to behave:
- When someone asks you to remember, note, save or keep something, save it with save_note. When they ask what was saved, search before answering; never invent saved content.
- For a reminder, work out the exact time from the current time given with each message, in the stated time zone. If the time is genuinely unclear ("remind me later"), ask a short question instead of guessing. After creating one, confirm what you will send and when, in plain local time.
- To cancel or delete something, look it up first so you use the right id. If several match, ask which.
- In a group, several people talk to you. Each message says who sent it. Address people by name when it helps.
- This is WhatsApp: keep replies short and conversational. Use WhatsApp formatting only (*bold*, _italic_, ~strike~, \`\`\`mono\`\`\`, simple "- " lists). No markdown headings, tables or links in [text](url) form.
- You can also answer ordinary questions briefly, but you have no web access, so say so when a question needs current information.`;

interface ToolContext {
  msg: IncomingMessage;
  store: Store;
  /** Ids of reminders created during this turn, for logging. */
  created: number[];
}

function buildTools(ctx: ToolContext) {
  const { msg, store } = ctx;
  const tz = config.timezone;

  return [
    betaZodTool({
      name: "save_note",
      description: "Save a note to this chat's memory. Use for anything a user asks you to remember or keep.",
      inputSchema: z.object({
        content: z.string().min(1).describe("The full text to remember, written so it makes sense on its own later."),
        tags: z.array(z.string()).optional().describe("A few lowercase keywords to help find it later, e.g. ['wifi', 'office']."),
      }),
      run: async ({ content, tags }) => {
        const note = store.addNote({
          chat_id: msg.chatId,
          author_id: msg.senderId,
          author_name: msg.senderName,
          content,
          tags: (tags ?? []).map((t) => t.toLowerCase()).join(","),
        });
        return JSON.stringify({ saved: true, id: note.id });
      },
    }),
    betaZodTool({
      name: "search_notes",
      description:
        "Search this chat's saved notes. Every word in the query must appear in the note or its tags. Omit the query to list the most recent notes.",
      inputSchema: z.object({
        query: z.string().optional().describe("Keywords. Use one or two distinctive words; retry with synonyms if nothing matches."),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      run: async ({ query, limit }) => {
        const notes = store.searchNotes(msg.chatId, query, limit ?? 15);
        return JSON.stringify(
          notes.map((n) => ({
            id: n.id,
            content: n.content,
            tags: n.tags,
            saved_by: n.author_name || n.author_id,
            saved_at: formatTime(n.created_at, tz),
          })),
        );
      },
    }),
    betaZodTool({
      name: "delete_note",
      description: "Delete a saved note by id. Find the id with search_notes first.",
      inputSchema: z.object({ id: z.number().int() }),
      run: async ({ id }) => JSON.stringify({ deleted: store.deleteNote(msg.chatId, id) }),
    }),
    betaZodTool({
      name: "create_reminder",
      description:
        "Schedule a reminder message to be sent to this chat. The person who asked is tagged when it fires.",
      inputSchema: z.object({
        text: z.string().min(1).describe("What to remind them of, phrased as the reminder message itself."),
        due_at: z
          .string()
          .describe(`First time it fires, ISO-8601. Include a UTC offset, or omit it to mean local time in ${tz}.`),
        recurrence: z.enum(RECURRENCES as [Recurrence, ...Recurrence[]]).optional().describe("Omit for a one-off reminder."),
      }),
      run: async ({ text, due_at, recurrence }) => {
        const due = parseWhen(due_at, tz);
        if (Number.isNaN(due)) return JSON.stringify({ error: `Could not parse due_at "${due_at}". Use ISO-8601.` });
        let first = due;
        if (first <= Date.now()) {
          if (!recurrence) return JSON.stringify({ error: "That time is in the past. Pick a future time." });
          first = nextOccurrence(due, recurrence, tz);
        }
        const r = store.addReminder({
          chat_id: msg.chatId,
          created_by: msg.senderId,
          created_by_name: msg.senderName,
          text,
          due_at: first,
          recurrence: recurrence ?? null,
        });
        ctx.created.push(r.id);
        return JSON.stringify({ created: true, id: r.id, fires_at: formatTime(first, tz), recurrence: recurrence ?? "once" });
      },
    }),
    betaZodTool({
      name: "list_reminders",
      description: "List the active reminders in this chat.",
      inputSchema: z.object({}),
      run: async () =>
        JSON.stringify(
          store.listReminders(msg.chatId).map((r) => ({
            id: r.id,
            text: r.text,
            next: formatTime(r.due_at, tz),
            recurrence: r.recurrence ?? "once",
            set_by: r.created_by_name || r.created_by,
          })),
        ),
    }),
    betaZodTool({
      name: "cancel_reminder",
      description: "Cancel an active reminder by id. Find the id with list_reminders first.",
      inputSchema: z.object({ id: z.number().int() }),
      run: async ({ id }) => JSON.stringify({ cancelled: store.cancelReminder(msg.chatId, id) }),
    }),
  ];
}

function userTurnText(msg: IncomingMessage): string {
  const header = [
    `[now: ${isoInZone(Date.now(), config.timezone)} (${config.timezone})]`,
    `[chat: ${msg.isGroup ? "group" : "direct message"}]`,
    `[from: ${msg.senderName || "unknown"}]`,
  ];
  if (msg.quotedText) header.push(`[replying to: "${msg.quotedText.slice(0, 500)}"]`);
  return `${header.join(" ")}\n${msg.text}`;
}

/** Runs one turn for an incoming message and returns the reply text. */
export async function respond(msg: IncomingMessage, store: Store): Promise<string> {
  const history = store.recentHistory(msg.chatId, config.historyTurns * 2);
  while (history.length && history[0].role !== "user") history.shift();

  const userText = userTurnText(msg);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userText },
  ];

  const ctx: ToolContext = { msg, store, created: [] };
  const final = await client.beta.messages.toolRunner({
    model: config.model,
    max_tokens: 16000,
    output_config: { effort: config.effort },
    // Refusal fallback: if a safety classifier declines, the API retries on a suitable model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    system: SYSTEM_PROMPT,
    tools: buildTools(ctx),
    messages,
    max_iterations: 10,
  });

  let reply: string;
  if (final.stop_reason === "refusal") {
    reply = "Sorry, I can't help with that one.";
  } else {
    reply = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!reply) reply = "Done.";
  }

  // Only plain text goes into stored history, so replaying it never edits a thinking block.
  store.addHistory(msg.chatId, "user", userText);
  store.addHistory(msg.chatId, "assistant", reply);
  return reply;
}
