import type { Logger } from "pino";
import { config } from "./config.js";
import type { Store } from "./db.js";
import { nextOccurrence } from "./time.js";
import type { Transport } from "./transports/types.js";

/** Polls for due reminders and sends them. Missed one-off reminders (bot was offline) are still sent, late. */
export function startScheduler(store: Store, transport: Transport, log: Logger): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const r of store.dueReminders(now)) {
        const lateMin = Math.round((now - r.due_at) / 60000);
        const tag = transport.mentionTag(r.created_by);
        let text = `⏰ *Reminder*${tag ? ` for ${tag}` : ""}\n${r.text}`;
        if (lateMin >= 10) text += `\n_(this was due ${lateMin} min ago)_`;
        try {
          await transport.send(r.chat_id, text, { mentions: [r.created_by], isReminder: true });
          store.completeReminder(r.id, r.recurrence ? nextOccurrence(r.due_at, r.recurrence, config.timezone, now) : null);
          log.info({ reminder: r.id, chat: r.chat_id }, "reminder sent");
        } catch (err) {
          // Leave it active; it is retried on the next tick.
          log.error({ err, reminder: r.id }, "failed to send reminder");
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
