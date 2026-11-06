import type { Logger } from "pino";
import { config } from "./config.js";
import type { Store } from "./db.js";
import { nextOccurrence } from "./time.js";
import { UndeliverableError, type Transport } from "./transports/types.js";

/** After this many failed sends in a row, a reminder occurrence is dropped instead of retried forever. */
const MAX_ATTEMPTS = 5;

/** Polls for due reminders and sends them. Missed one-off reminders (bot was offline) are still sent, late. */
export function startScheduler(store: Store, transport: Transport, log: Logger): () => void {
  let running = false;
  const failures = new Map<number, number>();

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const r of store.dueReminders(now)) {
        const next = r.recurrence ? nextOccurrence(r.due_at, r.recurrence, config.timezone, now) : null;
        const lateMin = Math.round((now - r.due_at) / 60000);
        const tag = transport.mentionTag(r.created_by);
        let text = `⏰ *Reminder*${tag ? ` for ${tag}` : ""}\n${r.text}`;
        if (lateMin >= 10) text += `\n_(this was due ${lateMin} min ago)_`;
        try {
          await transport.send(r.chat_id, text, { mentions: [r.created_by], reminderText: r.text });
          store.completeReminder(r.id, next);
          failures.delete(r.id);
          log.info({ reminder: r.id, chat: r.chat_id }, "reminder sent");
        } catch (err) {
          const attempts = (failures.get(r.id) ?? 0) + 1;
          if (err instanceof UndeliverableError || attempts >= MAX_ATTEMPTS) {
            // Skip this occurrence. A recurring reminder moves on to its next time.
            store.completeReminder(r.id, next);
            failures.delete(r.id);
            log.error({ err, reminder: r.id, chat: r.chat_id, attempts }, "reminder could not be delivered, skipped");
          } else {
            failures.set(r.id, attempts);
            log.warn({ err, reminder: r.id, attempts }, "failed to send reminder, will retry");
          }
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.schedulerIntervalMs);
  void tick();
  return () => clearInterval(timer);
}
