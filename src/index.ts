import Anthropic from "@anthropic-ai/sdk";
import { pino } from "pino";
import { respond } from "./agent.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import { startScheduler } from "./scheduler.js";
import { BaileysTransport } from "./transports/baileys.js";
import { CloudTransport } from "./transports/cloud.js";
import type { IncomingMessage, Transport } from "./transports/types.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const store = new Store(config.dataDir);

const transport: Transport =
  config.transport === "cloud"
    ? new CloudTransport({ ...config.cloud, log })
    : new BaileysTransport({
        authDir: config.baileys.authDir,
        pairingNumber: config.baileys.pairingNumber || undefined,
        groupTriggers: [config.botName.toLowerCase(), ...config.groupTriggers],
        log,
      });

// One turn at a time per chat, so replies stay in order and history stays consistent.
const queues = new Map<string, Promise<void>>();
function enqueue(chatId: string, job: () => Promise<void>): void {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev.then(job, job).finally(() => {
    if (queues.get(chatId) === next) queues.delete(chatId);
  });
  queues.set(chatId, next);
}

function allowed(msg: IncomingMessage): boolean {
  if (msg.isGroup || config.allowedNumbers.length === 0) return true;
  const digits = msg.senderId.split("@")[0].replace(/\D/g, "");
  return config.allowedNumbers.includes(digits);
}

async function handle(msg: IncomingMessage): Promise<void> {
  const text = msg.text.trim();
  if (text.toLowerCase() === "/reset") {
    store.clearHistory(msg.chatId);
    await transport.send(msg.chatId, "Conversation context cleared. Saved notes and reminders are kept.");
    return;
  }

  const typing = transport instanceof BaileysTransport ? transport : undefined;
  await typing?.setTyping(msg.chatId, true);
  try {
    const reply = await respond(msg, store);
    await transport.send(msg.chatId, reply);
  } catch (err) {
    log.error({ err, chat: msg.chatId }, "failed to respond");
    const busy = err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500);
    await transport
      .send(msg.chatId, busy ? "I'm a bit overloaded right now, please try again in a minute." : "Sorry, something went wrong on my side.")
      .catch(() => {});
  } finally {
    await typing?.setTyping(msg.chatId, false);
  }
}

await transport.start((msg) => {
  if (!msg.addressedToBot || !allowed(msg)) return;
  // Ignore backlog delivered on reconnect.
  if (Date.now() - msg.timestamp > 10 * 60_000) return;
  log.info({ chat: msg.chatId, from: msg.senderName, group: msg.isGroup }, "message");
  enqueue(msg.chatId, () => handle(msg));
});

startScheduler(store, transport, log);
setInterval(() => store.pruneHistory(config.historyTurns * 2), 3600_000).unref();
log.info({ transport: transport.name, timezone: config.timezone, model: config.model }, `${config.botName} is running`);
