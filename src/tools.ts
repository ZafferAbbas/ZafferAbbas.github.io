import { z } from "zod";
import { config } from "./config.js";
import type { Store } from "./db.js";
import { formatTime, nextOccurrence, parseWhen, RECURRENCES, type Recurrence } from "./time.js";
import type { IncomingMessage } from "./transports/types.js";

/** A provider-neutral tool: each LLM backend adapts these to its own tool format. */
export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<string>;
}

function tool<S extends z.ZodObject>(t: ToolSpec<S>): ToolSpec {
  return t as unknown as ToolSpec;
}

export const SYSTEM_PROMPT = `You are ${config.botName}, an assistant on a WhatsApp Business number. People message you directly or add you to WhatsApp groups. Your jobs: remember things, and remind people.

Tools:
- save_note / search_notes / delete_note: notes belong to the chat they were saved in. A group shares its notes; a direct chat's notes are private to that person.
- create_reminder / list_reminders / cancel_reminder: one-off or recurring (hourly, daily, weekdays, weekly, monthly, yearly). When due, the reminder is sent to this chat and tags the person who set it.

Rules:
- When someone asks you to remember, note, save or keep something, call save_note. When asked what was saved, call search_notes first. Never invent saved content.
- For a reminder, use the current local time shown at the top of each message. For "in 20 minutes" style requests use in_minutes. Otherwise give due_at as local time "YYYY-MM-DD HH:MM". If the time is unclear, ask a short question instead of guessing. After creating one, confirm what you will send and when.
- Before cancelling or deleting, look it up to get the right id. If several match, ask which.
- In groups, each message says who sent it.
- This is WhatsApp: keep replies short. Use only WhatsApp formatting (*bold*, _italic_, "- " lists). No markdown headings or tables.
- You can answer simple questions briefly, but you have no internet access.`;

/** Returns a warning if a reminder for this chat at `dueAt` might not be deliverable, else null. */
export type ReminderWarning = (chatId: string, dueAt: number) => string | null;

export function buildTools(msg: IncomingMessage, store: Store, reminderWarning?: ReminderWarning): ToolSpec[] {
  const tz = config.timezone;
  return [
    tool({
      name: "save_note",
      description: "Save a note to this chat's memory. Use for anything a user asks you to remember or keep.",
      schema: z.object({
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
    tool({
      name: "search_notes",
      description:
        "Search this chat's saved notes. Every word in the query must appear in the note or its tags. Omit the query to list the most recent notes.",
      schema: z.object({
        query: z.string().optional().describe("One or two distinctive keywords. Retry with other words if nothing matches."),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      run: async ({ query, limit }) => {
        let notes = store.searchNotes(msg.chatId, query, limit ?? 15);
        // Small models often over-specify the query; fall back to any-word matching.
        if (notes.length === 0 && query && query.trim().includes(" ")) {
          const seen = new Set<number>();
          notes = query
            .split(/\s+/)
            .filter((w) => w.length > 2)
            .flatMap((w) => store.searchNotes(msg.chatId, w, limit ?? 15))
            .filter((n) => !seen.has(n.id) && seen.add(n.id));
        }
        if (notes.length === 0) return JSON.stringify({ results: [], note: "No matching notes." });
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
    tool({
      name: "delete_note",
      description: "Delete a saved note by id. Find the id with search_notes first.",
      schema: z.object({ id: z.coerce.number().int() }),
      run: async ({ id }) => JSON.stringify({ deleted: store.deleteNote(msg.chatId, id) }),
    }),
    tool({
      name: "create_reminder",
      description:
        "Schedule a reminder message to this chat. Give either in_minutes (for 'in 2 hours' style requests) or due_at. The person who asked is tagged when it fires.",
      schema: z.object({
        text: z.string().min(1).describe("What to remind them of, phrased as the reminder message itself."),
        in_minutes: z.coerce.number().positive().optional().describe("Minutes from now. Use for relative times like 'in 30 minutes' or 'in 2 hours' (=120)."),
        due_at: z
          .string()
          .optional()
          .describe(`Local time in ${tz}, format "YYYY-MM-DD HH:MM". Use for clock times like 'tomorrow at 9am'.`),
        recurrence: z.enum(RECURRENCES as [Recurrence, ...Recurrence[]]).optional().describe("Omit for a one-off reminder."),
      }),
      run: async ({ text, in_minutes, due_at, recurrence }) => {
        let due: number;
        if (in_minutes !== undefined) due = Date.now() + Math.round(in_minutes * 60_000);
        else if (due_at) due = parseWhen(due_at, tz);
        else return JSON.stringify({ error: "Give in_minutes or due_at." });
        if (Number.isNaN(due)) return JSON.stringify({ error: `Could not read due_at "${due_at}". Use "YYYY-MM-DD HH:MM".` });
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
        const warning = reminderWarning?.(msg.chatId, first);
        return JSON.stringify({
          created: true,
          id: r.id,
          fires_at: formatTime(first, tz),
          recurrence: recurrence ?? "once",
          ...(warning ? { warning } : {}),
        });
      },
    }),
    tool({
      name: "list_reminders",
      description: "List the active reminders in this chat.",
      schema: z.object({}),
      run: async () => {
        const list = store.listReminders(msg.chatId);
        if (list.length === 0) return JSON.stringify({ results: [], note: "No active reminders." });
        return JSON.stringify(
          list.map((r) => ({
            id: r.id,
            text: r.text,
            next: formatTime(r.due_at, tz),
            recurrence: r.recurrence ?? "once",
            set_by: r.created_by_name || r.created_by,
          })),
        );
      },
    }),
    tool({
      name: "cancel_reminder",
      description: "Cancel an active reminder by id. Find the id with list_reminders first.",
      schema: z.object({ id: z.coerce.number().int() }),
      run: async ({ id }) => JSON.stringify({ cancelled: store.cancelReminder(msg.chatId, id) }),
    }),
  ];
}
